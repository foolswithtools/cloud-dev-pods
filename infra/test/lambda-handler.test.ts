// Validates the input-validation surface of the Lambda dispatcher. Action bodies
// are integration-tested against AWS in a sandbox account; here we only test the
// guard behavior so a malformed event is rejected before any SDK call.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The handler reads env at module load (via env.ts). Mock those so import works.
beforeEach(() => {
  vi.resetModules();
  process.env.AWS_REGION = 'us-west-2';
  process.env.AWS_ACCOUNT_ID = '123456789012';
  process.env.REGISTRY_TABLE_NAME = 't';
  process.env.CLUSTER_NAME = 'c';
  process.env.EFS_FILESYSTEM_ID = 'fs-x';
  process.env.ALB_LISTENER_ARN = 'arn:aws:elbv2:us-west-2:123456789012:listener/x';
  process.env.ALB_LISTENER_PROTOCOL = 'HTTPS';
  process.env.ALB_DNS_NAME = 'alb.example.com';
  process.env.BROWSER_TASK_DEF_FAMILY = 'b';
  process.env.TUNNEL_TASK_DEF_FAMILY = 't';
  process.env.BROWSER_TASK_ROLE_ARN = 'arn:aws:iam::123456789012:role/B';
  process.env.TUNNEL_TASK_ROLE_ARN = 'arn:aws:iam::123456789012:role/T';
  process.env.EXECUTION_ROLE_ARN = 'arn:aws:iam::123456789012:role/E';
  process.env.PODS_LOG_GROUP_NAME = '/cloud-dev-pods/dev/pods';
  process.env.VPC_ID = 'vpc-x';
  process.env.PRIVATE_SUBNET_IDS = 'subnet-1,subnet-2';
  process.env.TASKS_SECURITY_GROUP_ID = 'sg-x';
  process.env.BASE_DOMAIN = '';
  process.env.DOMAIN_STRATEGY = 'alb-default';
  process.env.BROWSER_REPO_URI = '123456789012.dkr.ecr.us-west-2.amazonaws.com/cloud-dev-pods/vscode-browser';
  process.env.TUNNEL_REPO_URI = '123456789012.dkr.ecr.us-west-2.amazonaws.com/cloud-dev-pods/vscode-tunnel';
  process.env.BROWSER_REPO_NAME = 'cloud-dev-pods/vscode-browser';
  process.env.TUNNEL_REPO_NAME = 'cloud-dev-pods/vscode-tunnel';
});

describe('handler input validation', () => {
  it('rejects unknown action', async () => {
    const { handler } = await import('../lambda/pod-manager/handler');
    const r = await handler({ action: 'sandwich' });
    expect(r.ok).toBe(false);
    expect(r.status).toBe('invalid-input');
  });

  it('rejects up without a podName', async () => {
    const { handler } = await import('../lambda/pod-manager/handler');
    const r = await handler({ action: 'up', mode: 'browser' });
    expect(r.ok).toBe(false);
    expect(r.status).toBe('invalid-input');
  });

  it('rejects up with an invalid podName', async () => {
    const { handler } = await import('../lambda/pod-manager/handler');
    const r = await handler({ action: 'up', podName: 'BadName!', mode: 'browser' });
    expect(r.ok).toBe(false);
    expect(r.status).toBe('invalid-input');
  });

  it('rejects up with an invalid mode', async () => {
    const { handler } = await import('../lambda/pod-manager/handler');
    const r = await handler({ action: 'up', podName: 'ok', mode: 'spaceship' });
    expect(r.ok).toBe(false);
    expect(r.status).toBe('invalid-input');
  });

  it('rejects status without a podName', async () => {
    const { handler } = await import('../lambda/pod-manager/handler');
    const r = await handler({ action: 'status' });
    expect(r.ok).toBe(false);
    expect(r.status).toBe('invalid-input');
  });

  it('accepts list with no extra fields', async () => {
    // We don't actually want the Lambda to hit DDB here. Mock the actions module
    // before loading handler so we never call into AWS SDK paths.
    vi.doMock('../lambda/pod-manager/actions', () => ({
      podUp: vi.fn(),
      podDown: vi.fn(),
      podList: vi.fn(async () => ({ ok: true, status: 'ok', pods: [] })),
      podStatus: vi.fn(),
    }));
    const { handler } = await import('../lambda/pod-manager/handler');
    const r = await handler({ action: 'list' });
    expect(r.ok).toBe(true);
    expect(r.status).toBe('ok');
    expect(r.pods).toEqual([]);
    vi.doUnmock('../lambda/pod-manager/actions');
  });
});

describe('handler browser auth guard (issue #132)', () => {
  // Every pod-up SDK wrapper as a spy, so a refusal can be shown to create
  // nothing. registryGet returns undefined so the conflict check passes.
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
      registerTaskDef: vi.fn(async () => 'arn:aws:ecs:us-west-2:123456789012:task-definition/x:1'),
      createTargetGroup: vi.fn(async () => 'arn:aws:elasticloadbalancing:us-west-2:123456789012:targetgroup/x/1'),
      createListenerRule: vi.fn(async () => 'arn:aws:elasticloadbalancing:us-west-2:123456789012:listener-rule/x/1'),
      registerTarget: vi.fn(),
      runTask: vi.fn(async () => 'arn:aws:ecs:us-west-2:123456789012:task/c/t1'),
      waitForTaskRunning: vi.fn(async () => ({
        taskArn: 'arn:aws:ecs:us-west-2:123456789012:task/c/t1',
        lastStatus: 'RUNNING',
        desiredStatus: 'RUNNING',
        privateIp: '10.0.0.5',
      })),
      deleteListenerRule: vi.fn(),
      deregisterAndDeleteTargetGroup: vi.fn(),
      stopTask: vi.fn(),
      describeTasks: vi.fn(async () => []),
    };
    vi.doMock('../lambda/pod-manager/aws', () => m);
    return m;
  }

  afterEach(() => {
    vi.doUnmock('../lambda/pod-manager/aws');
    vi.unstubAllEnvs();
  });

  it('refuses browser up with an unrestricted config and creates no AWS resources', async () => {
    vi.stubEnv('AUTH_BROWSER_PROVIDER', 'github');
    vi.stubEnv('AUTH_BROWSER_ALLOWED_ORG', '');
    vi.stubEnv('AUTH_BROWSER_ALLOWED_USERS', '[]');
    const aws = mockAws();
    const { handler } = await import('../lambda/pod-manager/handler');
    const r = await handler({ action: 'up', podName: 'hello', mode: 'browser' });

    expect(r.ok).toBe(false);
    expect(r.status).toBe('error');
    expect(r.message).toContain('auth.browser.allowedOrg');
    expect(r.message).toContain('auth.browser.allowedUsers');
    for (const fn of [
      'allocatePosixUid',
      'createAccessPoint',
      'registerTaskDef',
      'createTargetGroup',
      'createListenerRule',
      'runTask',
      'registryPut',
    ] as const) {
      expect(aws[fn], fn).not.toHaveBeenCalled();
    }
  });

  it('refuses browser up when the only email domain is "*"', async () => {
    vi.stubEnv('AUTH_BROWSER_ALLOWED_EMAIL_DOMAINS', '["*"]');
    const aws = mockAws();
    const { handler } = await import('../lambda/pod-manager/handler');
    const r = await handler({ action: 'up', podName: 'hello', mode: 'browser' });

    expect(r.status).toBe('error');
    expect(aws.createAccessPoint).not.toHaveBeenCalled();
  });

  it('never refuses tunnel up, even with an unrestricted browser config', async () => {
    const aws = mockAws();
    const { handler } = await import('../lambda/pod-manager/handler');
    const r = await handler({ action: 'up', podName: 'hello', mode: 'tunnel' });

    expect(r.ok).toBe(true);
    expect(r.status).toBe('ok');
    expect(aws.runTask).toHaveBeenCalledTimes(1);
  });

  it('launches browser up when auth.browser.allowedUsers is set', async () => {
    vi.stubEnv('AUTH_BROWSER_ALLOWED_USERS', '["alice"]');
    const aws = mockAws();
    const { handler } = await import('../lambda/pod-manager/handler');
    const r = await handler({ action: 'up', podName: 'hello', mode: 'browser' });

    expect(r.ok).toBe(true);
    expect(aws.createListenerRule).toHaveBeenCalledTimes(1);
  });
});
