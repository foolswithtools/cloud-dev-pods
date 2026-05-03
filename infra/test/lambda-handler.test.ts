// Validates the input-validation surface of the Lambda dispatcher. Action bodies
// are integration-tested against AWS in a sandbox account; here we only test the
// guard behavior so a malformed event is rejected before any SDK call.

import { describe, expect, it, vi, beforeEach } from 'vitest';

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
