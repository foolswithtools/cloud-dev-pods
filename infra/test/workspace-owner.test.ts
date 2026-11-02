// Workspace owner binding and fresh paths for released workspaces (#191,
// ADR 0009 scope change 11).
//
//   1. createAccessPoint gives every new access point a unique root path
//      (/pods/<podName>-<8 hex>) and records an Owner tag when one was given.
//   2. findExistingAccessPoint returns the Owner tag of the reused AP.
//   3. With AUTH_BROWSER_CENTRAL_AUTH_HOST=true, pod-up refuses to reuse an
//      AP whose recorded owner differs or is missing, before any task, rule
//      or target group is created. With it unset, reuse is unchanged.
//   4. pod-down keep_workspace=false no longer claims the files are deleted.

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
});

afterEach(() => {
  vi.doUnmock('../lambda/pod-manager/aws');
  vi.doUnmock('@aws-sdk/client-efs');
  vi.resetModules();
  delete process.env.AUTH_BROWSER_CENTRAL_AUTH_HOST;
});

// ---- EFS client mock (exercises the real aws.ts helpers) ----

type Sent = { name: string; input: Record<string, unknown> };

function mockEfs(accessPoints: unknown[] = []): Sent[] {
  const sent: Sent[] = [];
  vi.doMock('@aws-sdk/client-efs', async () => {
    const actual = await vi.importActual<typeof import('@aws-sdk/client-efs')>('@aws-sdk/client-efs');
    class MockEFSClient {
      async send(cmd: { constructor: { name: string }; input: Record<string, unknown> }) {
        const name = cmd.constructor.name;
        sent.push({ name, input: cmd.input });
        if (name === 'CreateAccessPointCommand') return { AccessPointId: `fsap-${sent.length}` };
        if (name === 'DescribeAccessPointsCommand') return { AccessPoints: accessPoints };
        if (name === 'DeleteAccessPointCommand') return {};
        throw new Error(`unexpected command: ${name}`);
      }
    }
    return { ...actual, EFSClient: MockEFSClient };
  });
  return sent;
}

function createInputs(sent: Sent[]) {
  return sent
    .filter((c) => c.name === 'CreateAccessPointCommand')
    .map((c) => c.input as {
      RootDirectory: { Path: string };
      Tags: Array<{ Key: string; Value: string }>;
    });
}

describe('createAccessPoint (#191)', () => {
  it('uses a unique /pods/<podName>-<8 hex> root path on every creation', async () => {
    const sent = mockEfs();
    const { createAccessPoint } = await import('../lambda/pod-manager/aws');
    await createAccessPoint('hello', 10000, 'alice');
    await createAccessPoint('hello', 10000, 'alice');

    const [a, b] = createInputs(sent).map((i) => i.RootDirectory.Path);
    expect(a).toMatch(/^\/pods\/hello-[0-9a-f]{8}$/);
    expect(b).toMatch(/^\/pods\/hello-[0-9a-f]{8}$/);
    expect(a).not.toBe(b);
  });

  it('tags the access point with the explicit owner', async () => {
    const sent = mockEfs();
    const { createAccessPoint } = await import('../lambda/pod-manager/aws');
    await createAccessPoint('hello', 10000, 'alice');

    expect(createInputs(sent)[0]!.Tags).toEqual([
      { Key: 'Project', Value: 'cloud-dev-pods' },
      { Key: 'Pod', Value: 'hello' },
      { Key: 'Owner', Value: 'alice' },
    ]);
  });

  it('writes no Owner tag when no owner was given', async () => {
    const sent = mockEfs();
    const { createAccessPoint } = await import('../lambda/pod-manager/aws');
    await createAccessPoint('hello', 10000, undefined);

    const tags = createInputs(sent)[0]!.Tags;
    expect(tags.map((t) => t.Key)).not.toContain('Owner');
  });
});

describe('findExistingAccessPoint owner (#191)', () => {
  const ap = (tags: Array<{ Key: string; Value: string }>) => ({
    AccessPointId: 'fsap-A',
    LifeCycleState: 'available',
    Tags: tags,
    PosixUser: { Uid: 10001, Gid: 10001 },
    CreationTime: new Date('2026-04-01T00:00:00Z'),
  });

  it('returns the Owner tag of the reused access point', async () => {
    mockEfs([ap([{ Key: 'Pod', Value: 'hello' }, { Key: 'Owner', Value: 'alice' }])]);
    const { findExistingAccessPoint } = await import('../lambda/pod-manager/aws');
    const found = await findExistingAccessPoint('hello');
    expect(found).toEqual({ accessPointId: 'fsap-A', posixUid: 10001, owner: 'alice' });
  });

  it('returns owner undefined when the access point has no Owner tag', async () => {
    mockEfs([ap([{ Key: 'Pod', Value: 'hello' }])]);
    const { findExistingAccessPoint } = await import('../lambda/pod-manager/aws');
    const found = await findExistingAccessPoint('hello');
    expect(found?.accessPointId).toBe('fsap-A');
    expect(found?.owner).toBeUndefined();
  });
});

// ---- podUp / podDown wiring (aws.ts mocked) ----

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

function expectNothingLaunched(m: ReturnType<typeof mockAws>) {
  expect(m.registerTaskDef).not.toHaveBeenCalled();
  expect(m.runTask).not.toHaveBeenCalled();
  expect(m.createListenerRule).not.toHaveBeenCalled();
  expect(m.createTargetGroup).not.toHaveBeenCalled();
  expect(m.registryPut).not.toHaveBeenCalled();
}

describe('podUp workspace owner check (#191)', () => {
  it('passes the explicit owner to createAccessPoint for a new workspace', async () => {
    const m = mockAws(undefined);
    const { podUp } = await import('../lambda/pod-manager/actions');
    const r = await podUp({ action: 'up', podName: 'fresh', mode: 'browser', owner: 'alice' });
    expect(r.ok).toBe(true);
    expect(m.createAccessPoint).toHaveBeenCalledWith('fresh', 12345, 'alice');
  });

  it("never passes the 'unknown' fallback to createAccessPoint", async () => {
    const m = mockAws(undefined);
    const { podUp } = await import('../lambda/pod-manager/actions');
    const r = await podUp({ action: 'up', podName: 'fresh', mode: 'tunnel' });
    expect(r.ok).toBe(true);
    expect(m.createAccessPoint).toHaveBeenCalledWith('fresh', 12345, undefined);
  });

  it('enforcement on: refuses an access point owned by someone else, before launching anything', async () => {
    process.env.AUTH_BROWSER_CENTRAL_AUTH_HOST = 'true';
    const m = mockAws({ accessPointId: 'fsap-OLD', posixUid: 11111, owner: 'bob' });
    const { podUp } = await import('../lambda/pod-manager/actions');
    const r = await podUp({ action: 'up', podName: 'hello', mode: 'browser', owner: 'alice' });

    expect(r.ok).toBe(false);
    expect(r.status).toBe('error');
    expect(r.message).toContain('keep_workspace=false');
    expectNothingLaunched(m);
    expect(m.deleteAccessPoint).not.toHaveBeenCalled();
  });

  it('enforcement on: refuses an access point with no Owner tag the same way', async () => {
    process.env.AUTH_BROWSER_CENTRAL_AUTH_HOST = 'true';
    const m = mockAws({ accessPointId: 'fsap-OLD', posixUid: 11111 });
    const { podUp } = await import('../lambda/pod-manager/actions');
    const r = await podUp({ action: 'up', podName: 'hello', mode: 'browser', owner: 'alice' });

    expect(r.ok).toBe(false);
    expect(r.status).toBe('error');
    expect(r.message).toContain('keep_workspace=false');
    expectNothingLaunched(m);
    expect(m.deleteAccessPoint).not.toHaveBeenCalled();
  });

  it('enforcement on: a matching owner reuses the access point as today', async () => {
    process.env.AUTH_BROWSER_CENTRAL_AUTH_HOST = 'true';
    const m = mockAws({ accessPointId: 'fsap-OLD', posixUid: 11111, owner: 'alice' });
    const { podUp } = await import('../lambda/pod-manager/actions');
    const r = await podUp({ action: 'up', podName: 'hello', mode: 'browser', owner: 'alice' });

    expect(r.ok).toBe(true);
    expect(m.createAccessPoint).not.toHaveBeenCalled();
    expect(m.allocatePosixUid).not.toHaveBeenCalled();
    expect(m.registerTaskDef).toHaveBeenCalledWith(expect.objectContaining({ accessPointId: 'fsap-OLD' }));
  });

  it.each([
    ['a different owner', 'bob'],
    ['no owner', undefined],
  ])('enforcement off: %s is reused as today', async (_label, recorded) => {
    const m = mockAws({ accessPointId: 'fsap-OLD', posixUid: 11111, owner: recorded });
    const { podUp } = await import('../lambda/pod-manager/actions');
    const r = await podUp({ action: 'up', podName: 'hello', mode: 'browser', owner: 'alice' });

    expect(r.ok).toBe(true);
    expect(m.createAccessPoint).not.toHaveBeenCalled();
    expect(m.registerTaskDef).toHaveBeenCalledWith(expect.objectContaining({ accessPointId: 'fsap-OLD' }));
  });

  it("enforcement off: any value other than 'true' leaves it off", async () => {
    process.env.AUTH_BROWSER_CENTRAL_AUTH_HOST = 'TRUE';
    const m = mockAws({ accessPointId: 'fsap-OLD', posixUid: 11111, owner: 'bob' });
    const { podUp } = await import('../lambda/pod-manager/actions');
    const r = await podUp({ action: 'up', podName: 'hello', mode: 'browser', owner: 'alice' });
    expect(r.ok).toBe(true);
    expect(m.runTask).toHaveBeenCalled();
  });
});

describe('checkWorkspaceOwner (#191)', () => {
  const found = (owner?: string) => ({ accessPointId: 'fsap-A', posixUid: 10001, owner });

  it('allows everything when enforcement is off', async () => {
    mockAws(undefined);
    const { checkWorkspaceOwner } = await import('../lambda/pod-manager/actions');
    expect(checkWorkspaceOwner(found('bob'), 'alice', false)).toEqual({ ok: true });
    expect(checkWorkspaceOwner(found(undefined), undefined, false)).toEqual({ ok: true });
  });

  it('allows a matching owner and refuses a different, missing, or absent one', async () => {
    mockAws(undefined);
    const { checkWorkspaceOwner } = await import('../lambda/pod-manager/actions');
    expect(checkWorkspaceOwner(found('alice'), 'alice', true)).toEqual({ ok: true });
    expect(checkWorkspaceOwner(found('bob'), 'alice', true).ok).toBe(false);
    expect(checkWorkspaceOwner(found(undefined), 'alice', true).ok).toBe(false);
    // No owner in the event never matches, even an untagged access point.
    expect(checkWorkspaceOwner(found(undefined), undefined, true).ok).toBe(false);
  });
});

describe('podDown keep_workspace=false message (#191)', () => {
  it('says the workspace is released, not deleted', async () => {
    const m = mockAws(undefined);
    m.registryGet.mockResolvedValue({
      podName: 'hello',
      mode: 'tunnel',
      taskArn: 'arn:aws:ecs:us-west-2:123456789012:task/c/t1',
      accessPointId: 'fsap-A',
      posixUid: 10001,
    } as never);
    const { podDown } = await import('../lambda/pod-manager/actions');
    const r = await podDown({ action: 'down', podName: 'hello', keepWorkspace: false });

    expect(r.ok).toBe(true);
    expect(m.deleteAccessPoint).toHaveBeenCalledWith('fsap-A');
    expect(r.message).not.toMatch(/deleted\.?$/);
    expect(r.message).not.toContain('workspace deleted');
    expect(r.message).toContain('workspace released');
  });
});
