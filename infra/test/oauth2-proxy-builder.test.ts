import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OAUTH2_PROXY_IMAGE,
  OAUTH2_PROXY_VERSION,
  buildOauth2ProxyContainer,
  type Oauth2ProxyAuthConfig,
  type Oauth2ProxyOptions,
  type Oauth2ProxySecretArns,
} from '../lambda/pod-manager/oauth2-proxy';

const secretArns: Oauth2ProxySecretArns = {
  clientId: 'arn:aws:secretsmanager:us-west-2:123456789012:secret:/cloud-dev-pods/oauth/client-id-AbCdEf',
  clientSecret: 'arn:aws:secretsmanager:us-west-2:123456789012:secret:/cloud-dev-pods/oauth/client-secret-GhIjKl',
  cookieSecret: 'arn:aws:secretsmanager:us-west-2:123456789012:secret:/cloud-dev-pods/oauth/cookie-secret-MnOpQr',
};

const opts: Oauth2ProxyOptions = {
  podName: 'hello',
  listenerProtocol: 'HTTPS',
  logGroupName: '/cloud-dev-pods/dev/pods',
  region: 'us-west-2',
};

const envOf = (auth: Oauth2ProxyAuthConfig, o = opts) =>
  Object.fromEntries(
    (buildOauth2ProxyContainer(auth, secretArns, o).environment ?? []).map((e) => [e.name, e.value]),
  );

describe('buildOauth2ProxyContainer (github provider)', () => {
  it('allowedOrg emits PROVIDER=github and GITHUB_ORG, and no GITHUB_USERS', () => {
    const env = envOf({ provider: 'github', allowedOrg: 'acme', allowedUsers: [] });
    expect(env.OAUTH2_PROXY_PROVIDER).toBe('github');
    expect(env.OAUTH2_PROXY_GITHUB_ORG).toBe('acme');
    expect(env).not.toHaveProperty('OAUTH2_PROXY_GITHUB_USERS');
  });

  it('allowedUsers emits GITHUB_USERS as a comma-separated list, and no GITHUB_ORG', () => {
    const env = envOf({ provider: 'github', allowedUsers: ['alice', 'bob'] });
    expect(env.OAUTH2_PROXY_GITHUB_USERS).toBe('alice,bob');
    expect(env).not.toHaveProperty('OAUTH2_PROXY_GITHUB_ORG');
  });

  it('an empty allowedOrg string is treated as unset', () => {
    const env = envOf({ provider: 'github', allowedOrg: '', allowedUsers: ['alice'] });
    expect(env).not.toHaveProperty('OAUTH2_PROXY_GITHUB_ORG');
  });

  it('COOKIE_SECURE is false only when the listener protocol is HTTP', () => {
    const auth: Oauth2ProxyAuthConfig = { provider: 'github', allowedOrg: 'acme', allowedUsers: [] };
    expect(envOf(auth, { ...opts, listenerProtocol: 'HTTP' }).OAUTH2_PROXY_COOKIE_SECURE).toBe('false');
    expect(envOf(auth, { ...opts, listenerProtocol: 'HTTPS' }).OAUTH2_PROXY_COOKIE_SECURE).toBe('true');
  });

  // oauth2-proxy reads OAUTH2_PROXY_<cfg name upper-cased> and silently
  // ignores anything else. These are the cfg tags (v7.15.5,
  // pkg/apis/options) of every setting the sidecar uses; the user list is
  // `github_users`, so OAUTH2_PROXY_GITHUB_USER (singular) would be dropped.
  it('emits only environment names oauth2-proxy actually reads', () => {
    const known = new Set(
      [
        'provider', 'http_address', 'upstreams', 'reverse_proxy', 'pass_authorization_header',
        'cookie_secure', 'email_domains', 'github_org', 'github_users', 'allowed_groups',
        'authenticated_emails_file', 'client_id', 'client_secret', 'cookie_secret',
        'oidc_issuer_url', 'entra_id_allowed_tenants', 'scope', 'insecure_oidc_skip_issuer_verification',
      ].map((n) => `OAUTH2_PROXY_${n.toUpperCase()}`),
    );
    const github = buildOauth2ProxyContainer({ provider: 'github', allowedOrg: 'acme', allowedUsers: ['alice'] }, secretArns, opts);
    const entra = buildOauth2ProxyContainer(
      {
        provider: 'entra-id',
        issuerUrl: 'https://login.microsoftonline.com/common/v2.0',
        allowedUsers: [],
        allowedTenants: ['11111111-2222-3333-4444-555555555555'],
        allowedGroups: ['aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'],
        allowedEmailDomains: ['example.com'],
        entraGroupOverage: true,
      },
      secretArns,
      opts,
    );
    for (const c of [github, entra]) for (const name of [...(c.environment ?? []), ...(c.secrets ?? [])].map((e) => e.name!)) {
      expect(known.has(name), name).toBe(true);
    }
  });

  it('image is v7.8.0 or later and pinned by digest', () => {
    const c = buildOauth2ProxyContainer({ provider: 'github', allowedOrg: 'acme', allowedUsers: [] }, secretArns, opts);
    expect(c.image).toBe(OAUTH2_PROXY_IMAGE);
    expect(c.image).toMatch(/^quay\.io\/oauth2-proxy\/oauth2-proxy@sha256:[0-9a-f]{64}$/);
    const [, major, minor] = /^v(\d+)\.(\d+)\.\d+$/.exec(OAUTH2_PROXY_VERSION)!.map(Number);
    expect(major).toBe(7);
    expect(minor).toBeGreaterThanOrEqual(8);
  });

  it('rejects provider oidc (not wired yet)', () => {
    expect(() =>
      buildOauth2ProxyContainer({ provider: 'oidc', allowedUsers: [] }, secretArns, opts),
    ).toThrow(/oidc/);
  });

  // Golden copy of the definition registerTaskDef emitted before the builder
  // was extracted (v0.4.0). Only the image reference and the user-list env
  // name may differ: v0.4.0 emitted OAUTH2_PROXY_GITHUB_USER, which
  // oauth2-proxy ignores (#133 fixed it to OAUTH2_PROXY_GITHUB_USERS).
  it('matches the pre-extraction container definition, apart from the image and the user-list name', () => {
    const c = buildOauth2ProxyContainer(
      { provider: 'github', allowedOrg: 'acme', allowedUsers: ['alice', 'bob'] },
      secretArns,
      opts,
    );
    expect(c).toEqual({
      name: 'oauth2-proxy',
      image: OAUTH2_PROXY_IMAGE,
      essential: true,
      portMappings: [{ containerPort: 4180, protocol: 'tcp' }],
      logConfiguration: {
        logDriver: 'awslogs',
        options: {
          'awslogs-group': '/cloud-dev-pods/dev/pods',
          'awslogs-region': 'us-west-2',
          'awslogs-stream-prefix': 'browser/hello/oauth2-proxy',
        },
      },
      environment: [
        { name: 'OAUTH2_PROXY_PROVIDER', value: 'github' },
        { name: 'OAUTH2_PROXY_HTTP_ADDRESS', value: '0.0.0.0:4180' },
        { name: 'OAUTH2_PROXY_UPSTREAMS', value: 'http://127.0.0.1:3000' },
        { name: 'OAUTH2_PROXY_REVERSE_PROXY', value: 'true' },
        { name: 'OAUTH2_PROXY_PASS_AUTHORIZATION_HEADER', value: 'true' },
        { name: 'OAUTH2_PROXY_COOKIE_SECURE', value: 'true' },
        { name: 'OAUTH2_PROXY_EMAIL_DOMAINS', value: '*' },
        { name: 'OAUTH2_PROXY_GITHUB_ORG', value: 'acme' },
        { name: 'OAUTH2_PROXY_GITHUB_USERS', value: 'alice,bob' },
      ],
      secrets: [
        { name: 'OAUTH2_PROXY_CLIENT_ID', valueFrom: secretArns.clientId },
        { name: 'OAUTH2_PROXY_CLIENT_SECRET', valueFrom: secretArns.clientSecret },
        { name: 'OAUTH2_PROXY_COOKIE_SECRET', valueFrom: secretArns.cookieSecret },
      ],
      dependsOn: [{ containerName: 'vscode', condition: 'HEALTHY' }],
    });
  });
});

// registerTaskDef must hand the builder's output to ECS unchanged.
describe('registerTaskDef uses the oauth2-proxy builder', () => {
  beforeEach(() => {
    vi.resetModules();
    Object.assign(process.env, {
      AWS_REGION: 'us-west-2',
      AWS_ACCOUNT_ID: '123456789012',
      REGISTRY_TABLE_NAME: 't',
      CLUSTER_NAME: 'c',
      EFS_FILESYSTEM_ID: 'fs-x',
      ALB_LISTENER_ARN: 'arn:aws:elbv2:us-west-2:123456789012:listener/x',
      ALB_LISTENER_PROTOCOL: 'HTTP',
      ALB_DNS_NAME: 'alb.example.com',
      BROWSER_TASK_DEF_FAMILY: 'cloud-dev-pods-browser',
      TUNNEL_TASK_DEF_FAMILY: 'cloud-dev-pods-tunnel',
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
      AUTH_BROWSER_PROVIDER: 'github',
      AUTH_BROWSER_ALLOWED_ORG: 'acme',
      AUTH_BROWSER_ALLOWED_USERS: '["alice"]',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registers the builder output as the oauth2-proxy container', async () => {
    const { ECSClient } = await import('@aws-sdk/client-ecs');
    const { SecretsManagerClient } = await import('@aws-sdk/client-secrets-manager');
    const sent: { input: { containerDefinitions?: unknown[] } }[] = [];
    vi.spyOn(ECSClient.prototype, 'send').mockImplementation(async (cmd: unknown) => {
      sent.push(cmd as (typeof sent)[number]);
      return { taskDefinition: { taskDefinitionArn: 'arn:td:1' } } as never;
    });
    vi.spyOn(SecretsManagerClient.prototype, 'send').mockImplementation(async (cmd: unknown) => {
      const id = (cmd as { input: { SecretId: string } }).input.SecretId;
      const key = id.split('/').pop()!;
      const arns: Record<string, string> = {
        'client-id': secretArns.clientId,
        'client-secret': secretArns.clientSecret,
        'cookie-secret': secretArns.cookieSecret,
      };
      return { ARN: arns[key] } as never;
    });

    const { registerTaskDef } = await import('../lambda/pod-manager/aws');
    const arn = await registerTaskDef({
      family: 'cloud-dev-pods-browser',
      imageUri: 'r/b:abc',
      accessPointId: 'fsap-1',
      podName: 'hello',
      cpu: '1024',
      memory: '2048',
      mode: 'browser',
      owner: 'alice',
    });
    expect(arn).toBe('arn:td:1');

    const defs = sent[0]!.input.containerDefinitions!;
    expect(defs).toHaveLength(2);
    expect(defs[1]).toEqual(
      buildOauth2ProxyContainer(
        { provider: 'github', allowedOrg: 'acme', allowedUsers: ['alice'] },
        secretArns,
        { podName: 'hello', listenerProtocol: 'HTTP', logGroupName: '/cloud-dev-pods/dev/pods', region: 'us-west-2' },
      ),
    );
  });
});
