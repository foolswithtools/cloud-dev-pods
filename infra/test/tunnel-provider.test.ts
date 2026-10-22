// Tunnel account provider (issue #140): auth.tunnel.provider reaches the
// tunnel container as TUNNEL_PROVIDER, and pod-up can override it per pod.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  Object.assign(process.env, {
    AWS_REGION: 'us-west-2',
    AWS_ACCOUNT_ID: '123456789012',
    REGISTRY_TABLE_NAME: 't',
    CLUSTER_NAME: 'c',
    EFS_FILESYSTEM_ID: 'fs-x',
    ALB_LISTENER_ARN: 'arn:aws:elbv2:us-west-2:123456789012:listener/x',
    ALB_LISTENER_PROTOCOL: 'HTTPS',
    ALB_DNS_NAME: 'alb.example.com',
    BROWSER_TASK_DEF_FAMILY: 'b',
    TUNNEL_TASK_DEF_FAMILY: 't',
    BROWSER_TASK_ROLE_ARN: 'arn:aws:iam::123456789012:role/B',
    TUNNEL_TASK_ROLE_ARN: 'arn:aws:iam::123456789012:role/T',
    EXECUTION_ROLE_ARN: 'arn:aws:iam::123456789012:role/E',
    PODS_LOG_GROUP_NAME: '/cloud-dev-pods/dev/pods',
    VPC_ID: 'vpc-x',
    PRIVATE_SUBNET_IDS: 'subnet-1',
    TASKS_SECURITY_GROUP_ID: 'sg-x',
    BROWSER_REPO_URI: 'r/b',
    TUNNEL_REPO_URI: 'r/t',
    BROWSER_REPO_NAME: 'b',
    TUNNEL_REPO_NAME: 't',
  });
});

afterEach(() => {
  vi.doUnmock('../lambda/pod-manager/aws');
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function mockAws() {
  const m = {
    registryGet: vi.fn(async () => undefined),
    registryPut: vi.fn(async () => undefined),
    registryScan: vi.fn(async () => []),
    registryDelete: vi.fn(),
    resolveLatestImageTag: vi.fn(async () => 'sha-abc'),
    findExistingAccessPoint: vi.fn(async () => undefined),
    allocatePosixUid: vi.fn(async () => 12345),
    createAccessPoint: vi.fn(async () => 'fsap-NEW'),
    deleteAccessPoint: vi.fn(),
    registerTaskDef: vi.fn(async (_args: Record<string, unknown>) => 'arn:aws:ecs:us-west-2:123456789012:task-definition/t:1'),
    createTargetGroup: vi.fn(),
    createListenerRule: vi.fn(),
    registerTarget: vi.fn(),
    runTask: vi.fn(async () => 'arn:aws:ecs:us-west-2:123456789012:task/c/t1'),
    waitForTaskRunning: vi.fn(async () => ({
      taskArn: 'arn:aws:ecs:us-west-2:123456789012:task/c/t1',
      lastStatus: 'RUNNING',
      desiredStatus: 'RUNNING',
    })),
    deleteListenerRule: vi.fn(),
    deregisterAndDeleteTargetGroup: vi.fn(),
    stopTask: vi.fn(),
    describeTasks: vi.fn(async () => []),
  };
  vi.doMock('../lambda/pod-manager/aws', () => m);
  return m;
}

describe('pod-up tunnel provider resolution', () => {
  it('defaults to github when neither config nor event sets a provider', async () => {
    const aws = mockAws();
    const { handler } = await import('../lambda/pod-manager/handler');
    const r = await handler({ action: 'up', podName: 'hello', mode: 'tunnel' });

    expect(r.ok).toBe(true);
    expect(r.tunnelProvider).toBe('github');
    expect(aws.registerTaskDef.mock.calls[0]![0]).toMatchObject({ tunnelProvider: 'github' });
  });

  it('uses auth.tunnel.provider from the Lambda environment', async () => {
    vi.stubEnv('AUTH_TUNNEL_PROVIDER', 'microsoft');
    const aws = mockAws();
    const { handler } = await import('../lambda/pod-manager/handler');
    const r = await handler({ action: 'up', podName: 'hello', mode: 'tunnel' });

    expect(r.tunnelProvider).toBe('microsoft');
    expect(aws.registerTaskDef.mock.calls[0]![0]).toMatchObject({ tunnelProvider: 'microsoft' });
  });

  it('a per-pod tunnelProvider overrides the config', async () => {
    vi.stubEnv('AUTH_TUNNEL_PROVIDER', 'github');
    const aws = mockAws();
    const { handler } = await import('../lambda/pod-manager/handler');
    const r = await handler({ action: 'up', podName: 'hello', mode: 'tunnel', tunnelProvider: 'microsoft' });

    expect(r.tunnelProvider).toBe('microsoft');
    expect(aws.registerTaskDef.mock.calls[0]![0]).toMatchObject({ tunnelProvider: 'microsoft' });
  });

  it('rejects an unknown tunnelProvider before any AWS call', async () => {
    const aws = mockAws();
    const { handler } = await import('../lambda/pod-manager/handler');
    const r = await handler({ action: 'up', podName: 'hello', mode: 'tunnel', tunnelProvider: 'okta' });

    expect(r.ok).toBe(false);
    expect(r.status).toBe('invalid-input');
    expect(aws.registryGet).not.toHaveBeenCalled();
  });

  it('does not report a tunnel provider for browser pods', async () => {
    vi.stubEnv('AUTH_BROWSER_ALLOWED_USERS', '["alice"]');
    mockAws();
    const { handler } = await import('../lambda/pod-manager/handler');
    const r = await handler({ action: 'up', podName: 'hello', mode: 'browser', tunnelProvider: 'microsoft' });

    expect(r.ok).toBe(true);
    expect(r.tunnelProvider).toBeUndefined();
  });
});

describe('registerTaskDef tunnel container environment', () => {
  async function registeredTunnelEnv(tunnelProvider: 'github' | 'microsoft') {
    const { ECSClient } = await import('@aws-sdk/client-ecs');
    const sent: { input: { containerDefinitions?: { name?: string; environment?: unknown[] }[] } }[] = [];
    vi.spyOn(ECSClient.prototype, 'send').mockImplementation(async (cmd: unknown) => {
      sent.push(cmd as (typeof sent)[number]);
      return { taskDefinition: { taskDefinitionArn: 'arn:td:1' } } as never;
    });
    const { registerTaskDef } = await import('../lambda/pod-manager/aws');
    await registerTaskDef({
      family: 't',
      imageUri: 'r/t:abc',
      accessPointId: 'fsap-1',
      podName: 'hello',
      cpu: '1024',
      memory: '2048',
      mode: 'tunnel',
      tunnelProvider,
      owner: 'alice',
    });
    const defs = sent[0]!.input.containerDefinitions!;
    expect(defs).toHaveLength(1);
    expect(defs[0]!.name).toBe('vscode-tunnel');
    return defs[0]!.environment;
  }

  it.each(['github', 'microsoft'] as const)('sets TUNNEL_PROVIDER=%s', async (p) => {
    expect(await registeredTunnelEnv(p)).toEqual([
      { name: 'POD_NAME', value: 'hello' },
      { name: 'TUNNEL_PROVIDER', value: p },
    ]);
  });
});
