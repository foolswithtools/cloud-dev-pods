// ssh delivery mode (issue #145): the pod-side base that the remote-access
// backends (#146 ssm, #147 cloudflare, #148 tailscale) build on. The container
// contract asserted here is shared with the runtime image (#181): container
// `vscode-ssh`, port 2222, log prefix `ssh/<pod>/vscode-ssh`, env POD_MODE /
// REMOTE_BACKEND / SSH_AUTHORIZED_KEYS. Change both sides together or not at all.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl alice@laptop';

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
    BROWSER_TASK_DEF_FAMILY: 'cloud-dev-pods-browser',
    TUNNEL_TASK_DEF_FAMILY: 'cloud-dev-pods-tunnel',
    SSH_TASK_DEF_FAMILY: 'cloud-dev-pods-ssh',
    BROWSER_TASK_ROLE_ARN: 'arn:aws:iam::123456789012:role/B',
    TUNNEL_TASK_ROLE_ARN: 'arn:aws:iam::123456789012:role/T',
    SSH_TASK_ROLE_ARN: 'arn:aws:iam::123456789012:role/S',
    EXECUTION_ROLE_ARN: 'arn:aws:iam::123456789012:role/E',
    SSH_EXECUTION_ROLE_ARN: 'arn:aws:iam::123456789012:role/SE',
    PODS_LOG_GROUP_NAME: '/cloud-dev-pods/dev/pods',
    VPC_ID: 'vpc-x',
    PRIVATE_SUBNET_IDS: 'subnet-1',
    TASKS_SECURITY_GROUP_ID: 'sg-x',
    BROWSER_REPO_URI: 'r/b',
    TUNNEL_REPO_URI: 'r/t',
    BROWSER_REPO_NAME: 'b',
    TUNNEL_REPO_NAME: 't',
    AUTH_BROWSER_PROVIDER: 'github',
    AUTH_BROWSER_ALLOWED_ORG: 'acme',
  });
  // Every real deploy has REMOTE_BACKEND='' in this slice (the config rejects
  // every backend); tests opt into a backend with vi.stubEnv.
  delete process.env.REMOTE_BACKEND;
});

afterEach(() => {
  vi.doUnmock('../lambda/pod-manager/aws');
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function mockAws() {
  const m = {
    registryGet: vi.fn(async () => undefined),
    registryPut: vi.fn(async (_r: Record<string, unknown>) => undefined),
    registryScan: vi.fn(async () => []),
    registryDelete: vi.fn(),
    resolveLatestImageTag: vi.fn(async (_repo: string) => 'sha-abc'),
    findExistingAccessPoint: vi.fn(async () => undefined),
    allocatePosixUid: vi.fn(async () => 12345),
    createAccessPoint: vi.fn(async () => 'fsap-NEW'),
    deleteAccessPoint: vi.fn(),
    registerTaskDef: vi.fn(async (_args: Record<string, unknown>) => 'arn:aws:ecs:us-west-2:123456789012:task-definition/s:1'),
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

function expectNoAwsCalls(aws: ReturnType<typeof mockAws>) {
  for (const [name, fn] of Object.entries(aws)) {
    expect(fn, `${name} must not be called`).not.toHaveBeenCalled();
  }
}

describe('pod-up mode ssh (pod-manager actions)', () => {
  it('with a backend, launches into the ssh family from the tunnel repo with no ALB wiring', async () => {
    vi.stubEnv('REMOTE_BACKEND', 'ssm');
    const aws = mockAws();
    const { handler } = await import('../lambda/pod-manager/handler');
    const r = await handler({ action: 'up', podName: 'shelly', mode: 'ssh', sshPublicKey: KEY, owner: 'alice' });

    expect(r.ok).toBe(true);
    expect(r.status).toBe('ok');
    expect(r.remoteBackend).toBe('ssm');
    expect(r.tunnelName).toBeUndefined();
    expect(r.tunnelProvider).toBeUndefined();
    expect(r.url).toBeUndefined();
    expect(r.warning).toBeUndefined();
    // Not the tunnel device-code text.
    expect(r.message).not.toMatch(/device-code/i);
    expect(r.message).toMatch(/ssh/i);

    expect(aws.resolveLatestImageTag).toHaveBeenCalledWith('t');
    expect(aws.registerTaskDef).toHaveBeenCalledTimes(1);
    expect(aws.registerTaskDef.mock.calls[0]![0]).toMatchObject({
      family: 'cloud-dev-pods-ssh',
      imageUri: 'r/t:sha-abc',
      mode: 'ssh',
      sshPublicKey: KEY,
      podName: 'shelly',
    });
    expect(aws.registerTaskDef.mock.calls[0]![0].tunnelProvider).toBeUndefined();
    expect(aws.createTargetGroup).not.toHaveBeenCalled();
    expect(aws.createListenerRule).not.toHaveBeenCalled();
    expect(aws.registerTarget).not.toHaveBeenCalled();
    // The tunnel cap warning scans the registry; ssh pods skip it.
    expect(aws.registryScan).not.toHaveBeenCalled();
    expect(aws.runTask).toHaveBeenCalledTimes(1);
  });

  it('writes mode ssh and the public key to the registry record', async () => {
    vi.stubEnv('REMOTE_BACKEND', 'ssm');
    const aws = mockAws();
    const { handler } = await import('../lambda/pod-manager/handler');
    await handler({ action: 'up', podName: 'shelly', mode: 'ssh', sshPublicKey: KEY });

    expect(aws.registryPut).toHaveBeenCalledTimes(1);
    const rec = aws.registryPut.mock.calls[0]![0];
    expect(rec).toMatchObject({ podName: 'shelly', mode: 'ssh', sshPublicKey: KEY });
    expect(rec.targetGroupArn).toBeUndefined();
    expect(rec.ruleArn).toBeUndefined();
  });

  it('without a backend, fails naming remote.backend before any AWS call', async () => {
    const aws = mockAws();
    const { handler } = await import('../lambda/pod-manager/handler');
    const r = await handler({ action: 'up', podName: 'shelly', mode: 'ssh', sshPublicKey: KEY });

    expect(r.ok).toBe(false);
    expect(r.status).toBe('error');
    expect(r.message).toContain('remote.backend');
    expect(aws.registerTaskDef).not.toHaveBeenCalled();
    expect(aws.createAccessPoint).not.toHaveBeenCalled();
    expect(aws.runTask).not.toHaveBeenCalled();
    expectNoAwsCalls(aws);
  });

  it('rejects mode ssh without sshPublicKey before any AWS call', async () => {
    vi.stubEnv('REMOTE_BACKEND', 'ssm');
    const aws = mockAws();
    const { handler } = await import('../lambda/pod-manager/handler');
    const r = await handler({ action: 'up', podName: 'shelly', mode: 'ssh' });

    expect(r.ok).toBe(false);
    expect(['invalid-input', 'error']).toContain(r.status);
    expect(r.message).toContain('sshPublicKey');
    expectNoAwsCalls(aws);
  });

  it.each(['browser', 'tunnel'] as const)('rejects sshPublicKey on a %s pod before any AWS call', async (mode) => {
    vi.stubEnv('REMOTE_BACKEND', 'ssm');
    const aws = mockAws();
    const { handler } = await import('../lambda/pod-manager/handler');
    const r = await handler({ action: 'up', podName: 'shelly', mode, sshPublicKey: KEY });

    expect(r.ok).toBe(false);
    expect(['invalid-input', 'error']).toContain(r.status);
    expect(r.message).toContain('sshPublicKey');
    expectNoAwsCalls(aws);
  });
});

describe('sshPublicKey handler schema', () => {
  it.each([
    ['a newline', `${KEY}\nssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEXTRA`],
    ['a trailing newline', `${KEY}\n`],
    ['a non-ssh key type', 'ssh-dss AAAAB3NzaC1kc3MAAACBAP alice'],
    ['a PEM private key', '-----BEGIN OPENSSH PRIVATE KEY-----'],
    ['spaces in the comment', 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMq alice laptop'],
    ['an over-long key', `ssh-rsa ${'A'.repeat(2048)}`],
  ])('rejects a key with %s as invalid-input', async (_label, key) => {
    vi.stubEnv('REMOTE_BACKEND', 'ssm');
    const aws = mockAws();
    const { handler } = await import('../lambda/pod-manager/handler');
    const r = await handler({ action: 'up', podName: 'shelly', mode: 'ssh', sshPublicKey: key });

    expect(r.ok).toBe(false);
    expect(r.status).toBe('invalid-input');
    expectNoAwsCalls(aws);
  });

  it.each([
    'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl',
    'ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTY= bob@host',
    'sk-ssh-ed25519@openssh.com AAAAGnNrLXNzaC1lZDI1NTE5QG9wZW5zc2guY29t yubikey',
    'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQ== carol',
  ])('accepts %s', async (key) => {
    vi.stubEnv('REMOTE_BACKEND', 'ssm');
    mockAws();
    const { handler } = await import('../lambda/pod-manager/handler');
    const r = await handler({ action: 'up', podName: 'shelly', mode: 'ssh', sshPublicKey: key });
    expect(r.status).toBe('ok');
  });
});

// Direct registerTaskDef tests against a mocked ECS client: what ECS sees.
describe('registerTaskDef per-mode roles and the ssh container', () => {
  interface SentInput {
    family: string;
    executionRoleArn: string;
    taskRoleArn: string;
    containerDefinitions: Array<Record<string, unknown>>;
  }

  async function capture(): Promise<SentInput[]> {
    const { ECSClient } = await import('@aws-sdk/client-ecs');
    const { SecretsManagerClient } = await import('@aws-sdk/client-secrets-manager');
    const sent: SentInput[] = [];
    vi.spyOn(ECSClient.prototype, 'send').mockImplementation(async (cmd: unknown) => {
      sent.push((cmd as { input: SentInput }).input);
      return { taskDefinition: { taskDefinitionArn: 'arn:td:1' } } as never;
    });
    vi.spyOn(SecretsManagerClient.prototype, 'send').mockImplementation(async (cmd: unknown) => {
      const id = (cmd as { input: { SecretId: string } }).input.SecretId;
      return { ARN: `arn:aws:secretsmanager:us-west-2:123456789012:secret:${id}-AbCdEf` } as never;
    });
    return sent;
  }

  const base = { imageUri: 'r/t:sha-abc', accessPointId: 'fsap-1', podName: 'shelly', cpu: '1024', memory: '2048', owner: 'alice' };

  it('ssh: ssh family, ssh task + execution roles, one vscode-ssh container per the #181 contract', async () => {
    vi.stubEnv('REMOTE_BACKEND', 'ssm');
    const sent = await capture();
    const { registerTaskDef } = await import('../lambda/pod-manager/aws');
    await registerTaskDef({ ...base, family: 'cloud-dev-pods-ssh', mode: 'ssh', sshPublicKey: KEY });

    const input = sent[0]!;
    expect(input.family).toBe('cloud-dev-pods-ssh');
    expect(input.taskRoleArn).toBe('arn:aws:iam::123456789012:role/S');
    expect(input.executionRoleArn).toBe('arn:aws:iam::123456789012:role/SE');
    expect(input.containerDefinitions).toHaveLength(1);
    const c = input.containerDefinitions[0]!;
    expect(c).toMatchObject({
      name: 'vscode-ssh',
      image: 'r/t:sha-abc',
      essential: true,
      portMappings: [{ containerPort: 2222, protocol: 'tcp' }],
      mountPoints: [{ sourceVolume: 'workspace', containerPath: '/workspace', readOnly: false }],
      stopTimeout: 30,
      healthCheck: {
        command: ['CMD-SHELL', 'pgrep -x sshd >/dev/null || exit 1'],
        interval: 30, timeout: 5, retries: 3, startPeriod: 30,
      },
      logConfiguration: {
        logDriver: 'awslogs',
        options: { 'awslogs-stream-prefix': 'ssh/shelly/vscode-ssh' },
      },
    });
    expect(c.environment).toEqual(expect.arrayContaining([
      { name: 'POD_NAME', value: 'shelly' },
      { name: 'POD_MODE', value: 'ssh' },
      { name: 'REMOTE_BACKEND', value: 'ssm' },
      { name: 'SSH_AUTHORIZED_KEYS', value: KEY },
    ]));
    expect(c.environment).toHaveLength(4);
  });

  it('tunnel: keeps the tunnel task role and the shared execution role', async () => {
    const sent = await capture();
    const { registerTaskDef } = await import('../lambda/pod-manager/aws');
    await registerTaskDef({ ...base, family: 'cloud-dev-pods-tunnel', mode: 'tunnel', tunnelProvider: 'github' });

    const input = sent[0]!;
    expect(input.taskRoleArn).toBe('arn:aws:iam::123456789012:role/T');
    expect(input.executionRoleArn).toBe('arn:aws:iam::123456789012:role/E');
    expect(input.containerDefinitions.map((c) => c.name)).toEqual(['vscode-tunnel']);
  });

  it('browser: keeps the browser task role and the shared execution role', async () => {
    const sent = await capture();
    const { registerTaskDef } = await import('../lambda/pod-manager/aws');
    await registerTaskDef({ ...base, imageUri: 'r/b:sha-abc', family: 'cloud-dev-pods-browser', mode: 'browser' });

    const input = sent[0]!;
    expect(input.taskRoleArn).toBe('arn:aws:iam::123456789012:role/B');
    expect(input.executionRoleArn).toBe('arn:aws:iam::123456789012:role/E');
    expect(input.containerDefinitions[0]!.name).toBe('vscode');
  });
});

describe('pod-manager env.ts remoteBackend', () => {
  it.each(['', 'ssm', 'cloudflare', 'tailscale'])('accepts REMOTE_BACKEND=%j', async (v) => {
    vi.stubEnv('REMOTE_BACKEND', v);
    const { env } = await import('../lambda/pod-manager/env');
    expect(env.remoteBackend).toBe(v);
    expect(env.sshTaskDefFamily).toBe('cloud-dev-pods-ssh');
    expect(env.sshTaskRoleArn).toBe('arn:aws:iam::123456789012:role/S');
    expect(env.sshExecutionRoleArn).toBe('arn:aws:iam::123456789012:role/SE');
  });

  it('defaults to "" when REMOTE_BACKEND is unset', async () => {
    const { env } = await import('../lambda/pod-manager/env');
    expect(env.remoteBackend).toBe('');
  });

  it('throws on an unknown REMOTE_BACKEND', async () => {
    vi.stubEnv('REMOTE_BACKEND', 'wireguard');
    await expect(import('../lambda/pod-manager/env')).rejects.toThrow(/REMOTE_BACKEND/);
  });

  it.each(['SSH_TASK_DEF_FAMILY', 'SSH_TASK_ROLE_ARN', 'SSH_EXECUTION_ROLE_ARN'])('requires %s', async (name) => {
    vi.stubEnv(name, '');
    await expect(import('../lambda/pod-manager/env')).rejects.toThrow(name);
  });
});
