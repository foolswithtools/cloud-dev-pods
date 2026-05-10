// Verifies access-point reuse semantics on `pod-up` (#30 fix; see ADR 0004
// "Reuse semantics" + ADR 0007).
//
// What we test here:
//   1. When `findExistingAccessPoint` returns a hit, podUp reuses its
//      accessPointId + posixUid, and does NOT call `allocatePosixUid` or
//      `createAccessPoint`.
//   2. When podUp's task launch fails AFTER reusing a persistent AP, the
//      rollback handler does NOT delete that AP. (Erasing user /workspace
//      data on rollback is the worst-case footgun this PR is fighting.)
//   3. `findExistingAccessPoint` returns the newest of multiple matching
//      APs and schedules deletion of the older duplicates.
//
// We mock the entire `aws.ts` module — these tests are about wiring, not
// AWS round-trips. Real-AWS verification lives in the Validator Protocol
// in the PR body.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Pod-manager env vars need to be set before any module that pulls `env`
// loads. `actions.ts` imports `env` transitively via `aws.ts`, so set
// these in beforeEach to keep tests independent.
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
  // Need at least one of these set or the browser-mode fail-fast will trip.
  process.env.OAUTH_ALLOWED_USERS = 'tester';
  process.env.OAUTH_ALLOWED_ORG = '';
});

afterEach(() => {
  vi.doUnmock('../lambda/pod-manager/aws');
  vi.resetModules();
});

describe('podUp access-point reuse (issue #30)', () => {
  it('reuses an existing AP — does not allocate UID or create a new AP', async () => {
    const allocatePosixUid = vi.fn(async () => 12345);
    const createAccessPoint = vi.fn(async () => 'fsap-NEW');
    const findExistingAccessPoint = vi.fn(async () => ({
      accessPointId: 'fsap-EXISTING',
      posixUid: 11111,
    }));
    const deleteAccessPoint = vi.fn(async () => undefined);

    vi.doMock('../lambda/pod-manager/aws', () => ({
      registryGet: vi.fn(async () => undefined),
      registryPut: vi.fn(async () => undefined),
      registryScan: vi.fn(async () => []),
      resolveLatestImageTag: vi.fn(async () => 'sha-abc'),
      findExistingAccessPoint,
      allocatePosixUid,
      createAccessPoint,
      deleteAccessPoint,
      registerTaskDef: vi.fn(async () => 'arn:aws:ecs:us-west-2:123456789012:task-definition/cloud-dev-pods-tunnel:1'),
      runTask: vi.fn(async () => 'arn:aws:ecs:us-west-2:123456789012:task/c/t1'),
      waitForTaskRunning: vi.fn(async () => ({
        taskArn: 'arn:aws:ecs:us-west-2:123456789012:task/c/t1',
        lastStatus: 'RUNNING',
        desiredStatus: 'RUNNING',
        privateIp: '10.0.0.5',
      })),
      // Unused on the happy path for tunnel-mode (no ALB), but the
      // module-level export must still resolve:
      createTargetGroup: vi.fn(),
      createListenerRule: vi.fn(),
      registerTarget: vi.fn(),
      deleteListenerRule: vi.fn(),
      deregisterAndDeleteTargetGroup: vi.fn(),
      stopTask: vi.fn(),
      describeTasks: vi.fn(async () => []),
      registryDelete: vi.fn(),
    }));

    const { podUp } = await import('../lambda/pod-manager/actions');
    const result = await podUp({
      action: 'up',
      podName: 'hello',
      mode: 'tunnel',
    });

    expect(result.ok).toBe(true);
    expect(findExistingAccessPoint).toHaveBeenCalledWith('hello');
    expect(allocatePosixUid).not.toHaveBeenCalled();
    expect(createAccessPoint).not.toHaveBeenCalled();
    expect(deleteAccessPoint).not.toHaveBeenCalled();
  });

  it('falls through to allocate+create when no existing AP matches', async () => {
    const allocatePosixUid = vi.fn(async () => 12345);
    const createAccessPoint = vi.fn(async () => 'fsap-NEW');
    const findExistingAccessPoint = vi.fn(async () => undefined);

    vi.doMock('../lambda/pod-manager/aws', () => ({
      registryGet: vi.fn(async () => undefined),
      registryPut: vi.fn(async () => undefined),
      registryScan: vi.fn(async () => []),
      resolveLatestImageTag: vi.fn(async () => 'sha-abc'),
      findExistingAccessPoint,
      allocatePosixUid,
      createAccessPoint,
      deleteAccessPoint: vi.fn(),
      registerTaskDef: vi.fn(async () => 'arn:aws:ecs:us-west-2:123456789012:task-definition/cloud-dev-pods-tunnel:1'),
      runTask: vi.fn(async () => 'arn:aws:ecs:us-west-2:123456789012:task/c/t1'),
      waitForTaskRunning: vi.fn(async () => ({
        taskArn: 'arn:aws:ecs:us-west-2:123456789012:task/c/t1',
        lastStatus: 'RUNNING',
        desiredStatus: 'RUNNING',
        privateIp: '10.0.0.5',
      })),
      createTargetGroup: vi.fn(),
      createListenerRule: vi.fn(),
      registerTarget: vi.fn(),
      deleteListenerRule: vi.fn(),
      deregisterAndDeleteTargetGroup: vi.fn(),
      stopTask: vi.fn(),
      describeTasks: vi.fn(async () => []),
      registryDelete: vi.fn(),
    }));

    const { podUp } = await import('../lambda/pod-manager/actions');
    const result = await podUp({
      action: 'up',
      podName: 'fresh',
      mode: 'tunnel',
    });

    expect(result.ok).toBe(true);
    expect(findExistingAccessPoint).toHaveBeenCalledWith('fresh');
    expect(allocatePosixUid).toHaveBeenCalledTimes(1);
    expect(createAccessPoint).toHaveBeenCalledWith('fresh', 12345);
  });

  it('rollback after reuse does NOT delete the persistent AP (issue #29 + #30 interaction)', async () => {
    const findExistingAccessPoint = vi.fn(async () => ({
      accessPointId: 'fsap-EXISTING',
      posixUid: 11111,
    }));
    const deleteAccessPoint = vi.fn(async () => undefined);
    const stopTask = vi.fn(async () => undefined);

    vi.doMock('../lambda/pod-manager/aws', () => ({
      registryGet: vi.fn(async () => undefined),
      registryPut: vi.fn(async () => undefined),
      registryScan: vi.fn(async () => []),
      resolveLatestImageTag: vi.fn(async () => 'sha-abc'),
      findExistingAccessPoint,
      allocatePosixUid: vi.fn(async () => {
        throw new Error('should not have been called when reusing');
      }),
      createAccessPoint: vi.fn(async () => {
        throw new Error('should not have been called when reusing');
      }),
      deleteAccessPoint,
      registerTaskDef: vi.fn(async () => 'arn:aws:ecs:us-west-2:123456789012:task-definition/cloud-dev-pods-tunnel:1'),
      // Force a rollback by failing on runTask AFTER reuse.
      runTask: vi.fn(async () => {
        throw new Error('synthetic RunTask failure for rollback test');
      }),
      waitForTaskRunning: vi.fn(),
      createTargetGroup: vi.fn(),
      createListenerRule: vi.fn(),
      registerTarget: vi.fn(),
      deleteListenerRule: vi.fn(),
      deregisterAndDeleteTargetGroup: vi.fn(),
      stopTask,
      describeTasks: vi.fn(async () => []),
      registryDelete: vi.fn(),
    }));

    const { podUp } = await import('../lambda/pod-manager/actions');
    const result = await podUp({
      action: 'up',
      podName: 'hello',
      mode: 'tunnel',
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('error');
    // Critically: the persistent AP must survive rollback.
    expect(deleteAccessPoint).not.toHaveBeenCalled();
  });

  it('rollback after creating a new AP DOES delete it', async () => {
    const findExistingAccessPoint = vi.fn(async () => undefined);
    const allocatePosixUid = vi.fn(async () => 12345);
    const createAccessPoint = vi.fn(async () => 'fsap-NEW');
    const deleteAccessPoint = vi.fn(async () => undefined);

    vi.doMock('../lambda/pod-manager/aws', () => ({
      registryGet: vi.fn(async () => undefined),
      registryPut: vi.fn(async () => undefined),
      registryScan: vi.fn(async () => []),
      resolveLatestImageTag: vi.fn(async () => 'sha-abc'),
      findExistingAccessPoint,
      allocatePosixUid,
      createAccessPoint,
      deleteAccessPoint,
      registerTaskDef: vi.fn(async () => 'arn:aws:ecs:us-west-2:123456789012:task-definition/cloud-dev-pods-tunnel:1'),
      runTask: vi.fn(async () => {
        throw new Error('synthetic RunTask failure for rollback test');
      }),
      waitForTaskRunning: vi.fn(),
      createTargetGroup: vi.fn(),
      createListenerRule: vi.fn(),
      registerTarget: vi.fn(),
      deleteListenerRule: vi.fn(),
      deregisterAndDeleteTargetGroup: vi.fn(),
      stopTask: vi.fn(),
      describeTasks: vi.fn(async () => []),
      registryDelete: vi.fn(),
    }));

    const { podUp } = await import('../lambda/pod-manager/actions');
    const result = await podUp({
      action: 'up',
      podName: 'fresh',
      mode: 'tunnel',
    });

    expect(result.ok).toBe(false);
    expect(deleteAccessPoint).toHaveBeenCalledWith('fsap-NEW');
  });
});

describe('findExistingAccessPoint (issue #30)', () => {
  it('returns the newest matching AP and schedules deletion of older duplicates', async () => {
    // Mock the EFS client at the @aws-sdk layer. This exercises the
    // helper's actual implementation, not a stub.
    const sentCommands: Array<{ name: string; input: Record<string, unknown> }> = [];

    vi.doMock('@aws-sdk/client-efs', async () => {
      const actual = await vi.importActual<typeof import('@aws-sdk/client-efs')>(
        '@aws-sdk/client-efs',
      );
      class MockEFSClient {
        async send(cmd: { constructor: { name: string }; input: Record<string, unknown> }) {
          const name = cmd.constructor.name;
          sentCommands.push({ name, input: cmd.input });
          if (name === 'DescribeAccessPointsCommand') {
            return {
              AccessPoints: [
                {
                  AccessPointId: 'fsap-OLD',
                  LifeCycleState: 'available',
                  Tags: [
                    { Key: 'Project', Value: 'cloud-dev-pods' },
                    { Key: 'Pod', Value: 'hello' },
                  ],
                  PosixUser: { Uid: 10001, Gid: 10001 },
                  CreationTime: new Date('2026-01-01T00:00:00Z'),
                },
                {
                  AccessPointId: 'fsap-NEW',
                  LifeCycleState: 'available',
                  Tags: [
                    { Key: 'Project', Value: 'cloud-dev-pods' },
                    { Key: 'Pod', Value: 'hello' },
                  ],
                  PosixUser: { Uid: 10001, Gid: 10001 },
                  CreationTime: new Date('2026-04-01T00:00:00Z'),
                },
                {
                  // Different pod — must be ignored.
                  AccessPointId: 'fsap-OTHER',
                  LifeCycleState: 'available',
                  Tags: [
                    { Key: 'Project', Value: 'cloud-dev-pods' },
                    { Key: 'Pod', Value: 'someone-else' },
                  ],
                  PosixUser: { Uid: 10002, Gid: 10002 },
                  CreationTime: new Date('2026-04-15T00:00:00Z'),
                },
                {
                  // Right pod, but not available — must be skipped.
                  AccessPointId: 'fsap-DELETING',
                  LifeCycleState: 'deleting',
                  Tags: [{ Key: 'Pod', Value: 'hello' }],
                  PosixUser: { Uid: 10001 },
                  CreationTime: new Date('2026-04-10T00:00:00Z'),
                },
              ],
            };
          }
          if (name === 'DeleteAccessPointCommand') {
            return {};
          }
          throw new Error(`unexpected command: ${name}`);
        }
      }
      return {
        ...actual,
        EFSClient: MockEFSClient,
      };
    });

    const { findExistingAccessPoint } = await import('../lambda/pod-manager/aws');
    const result = await findExistingAccessPoint('hello');

    expect(result).toEqual({
      accessPointId: 'fsap-NEW',
      posixUid: 10001,
    });

    const deletes = sentCommands.filter((c) => c.name === 'DeleteAccessPointCommand');
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.input).toEqual({ AccessPointId: 'fsap-OLD' });

    vi.doUnmock('@aws-sdk/client-efs');
  });

  it('returns undefined when no AP matches the pod name', async () => {
    vi.doMock('@aws-sdk/client-efs', async () => {
      const actual = await vi.importActual<typeof import('@aws-sdk/client-efs')>(
        '@aws-sdk/client-efs',
      );
      class MockEFSClient {
        async send(cmd: { constructor: { name: string } }) {
          if (cmd.constructor.name === 'DescribeAccessPointsCommand') {
            return {
              AccessPoints: [
                {
                  AccessPointId: 'fsap-OTHER',
                  LifeCycleState: 'available',
                  Tags: [{ Key: 'Pod', Value: 'someone-else' }],
                  PosixUser: { Uid: 10001 },
                  CreationTime: new Date('2026-04-01T00:00:00Z'),
                },
              ],
            };
          }
          return {};
        }
      }
      return { ...actual, EFSClient: MockEFSClient };
    });

    const { findExistingAccessPoint } = await import('../lambda/pod-manager/aws');
    const result = await findExistingAccessPoint('nonexistent');
    expect(result).toBeUndefined();

    vi.doUnmock('@aws-sdk/client-efs');
  });
});
