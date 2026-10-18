// Verifies the tunnel-mode container definition persists the VS Code CLI
// login onto the EFS workspace (#68). Real-AWS verification (does a
// pod-down/pod-up actually skip the device-code flow?) lives in the
// Validator Protocol in the PR body.

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
  process.env.OAUTH_ALLOWED_USERS = 'tester';
  process.env.OAUTH_ALLOWED_ORG = '';
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('registerTaskDef (tunnel mode, issue #68)', () => {
  it('points the VS Code CLI data dir at the EFS workspace with a file keychain', async () => {
    const { ECSClient } = await import('@aws-sdk/client-ecs');
    const send = vi.spyOn(ECSClient.prototype, 'send').mockImplementation(async () => ({
      taskDefinition: { taskDefinitionArn: 'arn:aws:ecs:us-west-2:123456789012:task-definition/t:1' },
    }));
    const { registerTaskDef, TUNNEL_CLI_DATA_DIR } = await import('../lambda/pod-manager/aws');

    await registerTaskDef({
      family: 't',
      imageUri: 'img:sha-abc',
      accessPointId: 'fsap-x',
      podName: 'hello',
      cpu: '1024',
      memory: '2048',
      mode: 'tunnel',
    });

    const input = (send.mock.calls[0]![0] as unknown as { input: Record<string, unknown> }).input;
    const [container] = input.containerDefinitions as {
      name: string;
      mountPoints: { containerPath: string }[];
      environment: { name: string; value: string }[];
    }[];
    const envMap = Object.fromEntries(container!.environment.map((e) => [e.name, e.value]));

    expect(container!.name).toBe('vscode-tunnel');
    expect(envMap).toMatchObject({
      POD_NAME: 'hello',
      VSCODE_CLI_DATA_DIR: TUNNEL_CLI_DATA_DIR,
      VSCODE_CLI_USE_FILE_KEYCHAIN: '1',
    });
    // The data dir must sit on the persistent mount, not the ephemeral layer.
    const workspace = container!.mountPoints[0]!.containerPath;
    expect(TUNNEL_CLI_DATA_DIR.startsWith(`${workspace}/`)).toBe(true);
    // Encryption stays on unless the smoke test proves it must be disabled.
    expect(envMap).not.toHaveProperty('VSCODE_CLI_DISABLE_KEYCHAIN_ENCRYPT');
  });
});
