// Tunnel slot hygiene (issue #141): an account may register 10 dev tunnels,
// and an eleventh makes the CLI evict a random unused one. pod-up warns when
// the owner already has 10 tunnel pods in the registry, and the tunnel
// container gets time to unregister on stop.

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

function record(podName: string, owner: string, mode: 'browser' | 'tunnel') {
  return {
    podName,
    mode,
    taskDefArn: 'arn:td',
    accessPointId: `fsap-${podName}`,
    posixUid: 10000,
    owner,
    createdAt: '2026-01-01T00:00:00Z',
    lastActivityAt: '2026-01-01T00:00:00Z',
    idleMinutes: 60,
    imageTag: 'sha-abc',
  };
}

// `count` tunnel pods for alice, plus pods that must not count: alice's
// browser pods and bob's tunnel pods.
function registry(count: number) {
  return [
    ...Array.from({ length: count }, (_, i) => record(`a-tun-${i}`, 'alice', 'tunnel')),
    ...Array.from({ length: 5 }, (_, i) => record(`a-web-${i}`, 'alice', 'browser')),
    ...Array.from({ length: 5 }, (_, i) => record(`b-tun-${i}`, 'bob', 'tunnel')),
  ];
}

function mockAws(scan: unknown[]) {
  const m = {
    registryGet: vi.fn(async () => undefined),
    registryPut: vi.fn(async () => undefined),
    registryScan: vi.fn(async () => scan),
    registryDelete: vi.fn(),
    resolveLatestImageTag: vi.fn(async () => 'sha-abc'),
    findExistingAccessPoint: vi.fn(async () => undefined),
    allocatePosixUid: vi.fn(async () => 12345),
    createAccessPoint: vi.fn(async () => 'fsap-NEW'),
    deleteAccessPoint: vi.fn(),
    registerTaskDef: vi.fn(async () => 'arn:aws:ecs:us-west-2:123456789012:task-definition/t:1'),
    createTargetGroup: vi.fn(async () => 'arn:tg'),
    createListenerRule: vi.fn(async () => 'arn:rule'),
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

describe('pod-up tunnel cap warning', () => {
  it('warns, and still launches, when the owner already has 10 tunnel pods', async () => {
    const aws = mockAws(registry(10));
    const { handler } = await import('../lambda/pod-manager/handler');
    const r = await handler({ action: 'up', podName: 'new', mode: 'tunnel', owner: 'alice' });

    expect(r.ok).toBe(true);
    expect(r.warning).toMatch(/10 tunnel pods/);
    expect(r.warning).toMatch(/random/);
    expect(aws.runTask).toHaveBeenCalled();
  });

  it('does not warn at 9 tunnel pods for the owner', async () => {
    mockAws(registry(9));
    const { handler } = await import('../lambda/pod-manager/handler');
    const r = await handler({ action: 'up', podName: 'new', mode: 'tunnel', owner: 'alice' });

    expect(r.ok).toBe(true);
    expect(r.warning).toBeUndefined();
  });

  it('does not warn for browser pods', async () => {
    vi.stubEnv('AUTH_BROWSER_ALLOWED_USERS', '["alice"]');
    mockAws(registry(12));
    const { handler } = await import('../lambda/pod-manager/handler');
    const r = await handler({ action: 'up', podName: 'new', mode: 'browser', owner: 'alice' });

    expect(r.ok).toBe(true);
    expect(r.warning).toBeUndefined();
  });

  it('launches without a warning when the registry scan fails', async () => {
    const aws = mockAws([]);
    aws.registryScan.mockRejectedValueOnce(new Error('ddb down'));
    const { handler } = await import('../lambda/pod-manager/handler');
    const r = await handler({ action: 'up', podName: 'new', mode: 'tunnel', owner: 'alice' });

    expect(r.ok).toBe(true);
    expect(r.warning).toBeUndefined();
  });
});

describe('tunnel container stop timeout', () => {
  it('gives the entrypoint 30 seconds to unregister the tunnel', async () => {
    const { ECSClient } = await import('@aws-sdk/client-ecs');
    const sent: { input: { containerDefinitions?: { name?: string; stopTimeout?: number }[] } }[] = [];
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
      tunnelProvider: 'github',
      owner: 'alice',
    });
    const [def] = sent[0]!.input.containerDefinitions!;
    expect(def!.name).toBe('vscode-tunnel');
    expect(def!.stopTimeout).toBe(30);
  });
});
