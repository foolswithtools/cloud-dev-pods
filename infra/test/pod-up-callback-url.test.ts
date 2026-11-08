// pod-up's OAuth callback URL in the result (#262 follow-up). pod-up.yml
// prints it in the run summary, so it must be the callback the IdP needs:
// the pod's own /oauth2/callback per pod, or the single
// https://auth.<baseDomain>/oauth2/callback with the central auth host.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  process.env.AWS_REGION = 'us-west-2';
  process.env.AWS_ACCOUNT_ID = '123456789012';
  process.env.REGISTRY_TABLE_NAME = 't';
  process.env.CLUSTER_NAME = 'c';
  process.env.EFS_FILESYSTEM_ID = 'fs-x';
  process.env.ALB_LISTENER_ARN = 'arn:aws:elbv2:us-west-2:123456789012:listener/x';
  process.env.ALB_LISTENER_PROTOCOL = 'HTTP';
  process.env.ALB_DNS_NAME = 'alb.example.com';
  process.env.BROWSER_TASK_DEF_FAMILY = 'b';
  process.env.TUNNEL_TASK_DEF_FAMILY = 't';
  process.env.BROWSER_TASK_ROLE_ARN = 'arn:aws:iam::123456789012:role/B';
  process.env.TUNNEL_TASK_ROLE_ARN = 'arn:aws:iam::123456789012:role/T';
  process.env.SSH_TASK_DEF_FAMILY = 'cloud-dev-pods-ssh';
  process.env.SSH_TASK_ROLE_ARN = 'arn:aws:iam::123456789012:role/S';
  process.env.SSH_EXECUTION_ROLE_ARN = 'arn:aws:iam::123456789012:role/SE';
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
  process.env.AUTH_BROWSER_ALLOWED_USERS = '["alice","bob"]';
  delete process.env.AUTH_BROWSER_CENTRAL_AUTH_HOST;
  delete process.env.AUTH_BROWSER_OWNER_ONLY;
});

afterEach(() => {
  vi.doUnmock('../lambda/pod-manager/aws');
  vi.doUnmock('@aws-sdk/client-efs');
  vi.resetModules();
  delete process.env.AUTH_BROWSER_CENTRAL_AUTH_HOST;
  delete process.env.AUTH_BROWSER_OWNER_ONLY;
});

function mockAws(found: { accessPointId: string; posixUid: number; owner?: string } | undefined) {
  const m = {
    registryGet: vi.fn(async () => undefined),
    registryPut: vi.fn(async () => undefined),
    registryScan: vi.fn(async () => []),
    registryDelete: vi.fn(async () => undefined),
    resolveLatestImageTag: vi.fn(async () => 'sha-abc'),
    findExistingAccessPoint: vi.fn(async () => found),
    allocatePosixUid: vi.fn(async () => 12345),
    createAccessPoint: vi.fn(async () => 'fsap-NEW'),
    deleteAccessPoint: vi.fn(async () => undefined),
    registerTaskDef: vi.fn(async () => 'arn:aws:ecs:us-west-2:123456789012:task-definition/b:1'),
    runTask: vi.fn(async () => 'arn:aws:ecs:us-west-2:123456789012:task/c/t1'),
    waitForTaskRunning: vi.fn(async () => ({
      taskArn: 'arn:aws:ecs:us-west-2:123456789012:task/c/t1',
      lastStatus: 'RUNNING',
      desiredStatus: 'RUNNING',
      privateIp: '10.0.0.5',
    })),
    createTargetGroup: vi.fn(async () => 'arn:aws:elasticloadbalancing:us-west-2:123456789012:targetgroup/x/1'),
    createListenerRule: vi.fn(async () => 'arn:aws:elasticloadbalancing:us-west-2:123456789012:listener-rule/x/1'),
    registerTarget: vi.fn(async () => undefined),
    deleteListenerRule: vi.fn(async () => undefined),
    deregisterAndDeleteTargetGroup: vi.fn(async () => undefined),
    stopTask: vi.fn(async () => undefined),
    describeTasks: vi.fn(async () => []),
  };
  vi.doMock('../lambda/pod-manager/aws', () => m);
  return m;
}

describe('podUp oauthCallbackUrl', () => {
  it('central host off: browser pod reports its own callback and no central flag', async () => {
    process.env.BASE_DOMAIN = 'pods.example.com';
    process.env.ALB_LISTENER_PROTOCOL = 'HTTPS';
    mockAws(undefined);
    const { podUp } = await import('../lambda/pod-manager/actions');
    const r = await podUp({ action: 'up', podName: 'hello', mode: 'browser', owner: 'alice' });
    expect(r.ok).toBe(true);
    expect(r.url).toBe('https://hello.pods.example.com');
    expect(r.oauthCallbackUrl).toBe('https://hello.pods.example.com/oauth2/callback');
    expect(r.centralAuthHost).toBeUndefined();
  });

  it('central host on: browser pod reports the single auth.<baseDomain> callback', async () => {
    process.env.AUTH_BROWSER_CENTRAL_AUTH_HOST = 'true';
    process.env.BASE_DOMAIN = 'pods.example.com';
    process.env.DOMAIN_STRATEGY = 'byo';
    process.env.ALB_LISTENER_PROTOCOL = 'HTTPS';
    process.env.AUTH_BROWSER_OWNER_ONLY = 'true';
    mockAws(undefined);
    const { podUp } = await import('../lambda/pod-manager/actions');
    const r = await podUp({ action: 'up', podName: 'hello', mode: 'browser', owner: 'alice@example.com' });
    expect(r.ok, r.message).toBe(true);
    expect(r.url).toBe('https://hello.pods.example.com');
    expect(r.oauthCallbackUrl).toBe('https://auth.pods.example.com/oauth2/callback');
    expect(r.centralAuthHost).toBe(true);
  });

  it('tunnel pods report neither', async () => {
    process.env.AUTH_BROWSER_CENTRAL_AUTH_HOST = 'true';
    process.env.BASE_DOMAIN = 'pods.example.com';
    mockAws(undefined);
    const { podUp } = await import('../lambda/pod-manager/actions');
    const r = await podUp({ action: 'up', podName: 'hello', mode: 'tunnel', owner: 'alice@example.com' });
    expect(r.ok, r.message).toBe(true);
    expect(r.oauthCallbackUrl).toBeUndefined();
    expect(r.centralAuthHost).toBeUndefined();
  });
});
