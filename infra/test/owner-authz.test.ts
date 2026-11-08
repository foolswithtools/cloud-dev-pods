import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContainerDefinition } from '@aws-sdk/client-ecs';
import {
  CENTRAL_AUTH_COOKIE_NAME,
  buildCentralAuthHostContainer,
  buildOauth2ProxyContainer,
  type Oauth2ProxyAuthConfig,
  type Oauth2ProxyOptions,
  type Oauth2ProxySecretArns,
} from '../lambda/pod-manager/oauth2-proxy';
import {
  OWNER_AUTHZ_COOKIE_SECRET_PATH,
  OWNER_AUTHZ_DIR,
  OWNER_AUTHZ_EMAILS_PATH,
  OWNER_AUTHZ_INIT_CONTAINER,
  OWNER_AUTHZ_TEMPLATES_DIR,
  OWNER_AUTHZ_VOLUME,
  buildBrowserAuthTaskParts,
  buildOwnerAuthorization,
  validateOwnerAuthorization,
} from '../lambda/pod-manager/owner-authz';
import { SIGN_IN_RD_SCRIPT, SIGN_IN_STOCK_SHA256, SIGN_IN_TEMPLATE } from '../lambda/pod-manager/sign-in-template';

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

const initImage = '123456789012.dkr.ecr.us-west-2.amazonaws.com/cloud-dev-pods/vscode-browser:sha-abc';

const sidecarOf = (parts: { containers: ContainerDefinition[] }) =>
  parts.containers.find((c) => c.name === 'oauth2-proxy')!;

const envMap = (env: { name?: string; value?: string }[] | undefined) =>
  Object.fromEntries((env ?? []).map((e) => [e.name, e.value]));

describe('buildBrowserAuthTaskParts', () => {
  it('ownerOnly: false produces exactly the #131 builder output and nothing else', () => {
    const auth: Oauth2ProxyAuthConfig = { provider: 'github', allowedOrg: 'acme', allowedUsers: ['alice', 'bob'] };
    const parts = buildBrowserAuthTaskParts(
      { ...auth, ownerOnly: false, adminUsers: ['ops'] },
      'carol',
      secretArns,
      { ...opts, initImage },
    );
    expect(parts.containers).toEqual([buildOauth2ProxyContainer(auth, secretArns, opts)]);
    expect(parts.volumes).toEqual([]);
  });

  it('github + ownerOnly + adminUsers: [ops] emits GITHUB_USERS=<owner>,ops', () => {
    const parts = buildBrowserAuthTaskParts(
      { provider: 'github', allowedUsers: ['alice', 'bob'], ownerOnly: true, adminUsers: ['ops'] },
      'carol',
      secretArns,
      { ...opts, initImage },
    );
    const env = envMap(sidecarOf(parts).environment);
    expect(env.OAUTH2_PROXY_GITHUB_USERS).toBe('carol,ops');
    expect(env).not.toHaveProperty('OAUTH2_PROXY_GITHUB_USER');
    expect(env).not.toHaveProperty('OAUTH2_PROXY_GITHUB_ORG');
    expect(env).not.toHaveProperty('OAUTH2_PROXY_ALLOWED_GROUPS');
  });

  it('github + ownerOnly keeps allowedOrg as an AND check (allowed group), not GITHUB_ORG', () => {
    // oauth2-proxy ORs GITHUB_USERS with GITHUB_ORG: any org member would pass.
    // ALLOWED_GROUPS is checked on every request in addition to GITHUB_USERS.
    const parts = buildBrowserAuthTaskParts(
      { provider: 'github', allowedOrg: 'acme', allowedUsers: [], ownerOnly: true, adminUsers: [] },
      'carol',
      secretArns,
      { ...opts, initImage },
    );
    const env = envMap(sidecarOf(parts).environment);
    expect(env.OAUTH2_PROXY_GITHUB_USERS).toBe('carol');
    expect(env.OAUTH2_PROXY_ALLOWED_GROUPS).toBe('acme');
    expect(env).not.toHaveProperty('OAUTH2_PROXY_GITHUB_ORG');
  });

  it('github + ownerOnly drops a duplicate admin equal to the owner', () => {
    const parts = buildBrowserAuthTaskParts(
      { provider: 'github', allowedUsers: [], ownerOnly: true, adminUsers: ['carol', 'ops'] },
      'carol',
      secretArns,
      { ...opts, initImage },
    );
    expect(envMap(sidecarOf(parts).environment).OAUTH2_PROXY_GITHUB_USERS).toBe('carol,ops');
  });

  // #156: GITHUB_USERS is only checked at sign-in, so a session cookie from
  // another pod must not decrypt here. Each owner-only pod gets its own
  // task-scoped cookie secret.
  it('github + ownerOnly emits the init container, the shared volume and COOKIE_SECRET_FILE, and no COOKIE_SECRET secret', () => {
    const parts = buildBrowserAuthTaskParts(
      { provider: 'github', allowedUsers: ['alice', 'bob'], ownerOnly: true, adminUsers: ['ops'] },
      'carol',
      secretArns,
      { ...opts, initImage },
    );
    expect(parts.containers.map((c) => c.name)).toEqual([OWNER_AUTHZ_INIT_CONTAINER, 'oauth2-proxy']);
    expect(parts.volumes).toEqual([{ name: OWNER_AUTHZ_VOLUME }]);

    const init = parts.containers[0]!;
    expect(init.essential).toBe(false);
    expect(init.image).toBe(initImage);
    expect(init.mountPoints).toEqual([
      { sourceVolume: OWNER_AUTHZ_VOLUME, containerPath: OWNER_AUTHZ_DIR, readOnly: false },
    ]);
    // github has no emails file.
    expect(envMap(init.environment)).not.toHaveProperty('OWNER_AUTHZ_EMAILS');

    const sidecar = sidecarOf(parts);
    expect(envMap(sidecar.environment).OAUTH2_PROXY_COOKIE_SECRET_FILE).toBe(OWNER_AUTHZ_COOKIE_SECRET_PATH);
    // cookie_secret wins over cookie_secret_file when both are set.
    expect(sidecar.secrets?.map((s) => s.name)).toEqual(['OAUTH2_PROXY_CLIENT_ID', 'OAUTH2_PROXY_CLIENT_SECRET']);
    expect(sidecar.mountPoints).toEqual([
      { sourceVolume: OWNER_AUTHZ_VOLUME, containerPath: OWNER_AUTHZ_DIR, readOnly: true },
    ]);
    expect(sidecar.dependsOn).toEqual([
      { containerName: 'vscode', condition: 'HEALTHY' },
      { containerName: OWNER_AUTHZ_INIT_CONTAINER, condition: 'SUCCESS' },
    ]);
  });

  it('oidc + ownerOnly writes both the emails file and the cookie secret file with a single init container', () => {
    const o = buildOwnerAuthorization(
      { provider: 'oidc', allowedUsers: [], ownerOnly: true, adminUsers: ['ops@example.com'] },
      'owner@example.com',
      { ...opts, initImage },
    );
    expect(o.volumes).toEqual([{ name: OWNER_AUTHZ_VOLUME }]);
    const script = o.initContainer!.command!.join(' ');
    expect(script).toContain(OWNER_AUTHZ_EMAILS_PATH);
    expect(script).toContain(OWNER_AUTHZ_COOKIE_SECRET_PATH);
    expect(o.sidecarDependsOn).toEqual([{ containerName: OWNER_AUTHZ_INIT_CONTAINER, condition: 'SUCCESS' }]);
    const env = envMap(o.sidecarEnvironment);
    expect(env.OAUTH2_PROXY_AUTHENTICATED_EMAILS_FILE).toBe(OWNER_AUTHZ_EMAILS_PATH);
    expect(env.OAUTH2_PROXY_COOKIE_SECRET_FILE).toBe(OWNER_AUTHZ_COOKIE_SECRET_PATH);
  });

  it('entra-id + ownerOnly: one init container, the emails file and COOKIE_SECRET_FILE, and no COOKIE_SECRET secret', () => {
    const parts = buildBrowserAuthTaskParts(
      {
        provider: 'entra-id',
        issuerUrl: 'https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/v2.0',
        allowedUsers: [],
        ownerOnly: true,
        adminUsers: [],
      },
      'owner@example.com',
      secretArns,
      { ...opts, initImage },
    );
    expect(parts.containers.map((c) => c.name)).toEqual([OWNER_AUTHZ_INIT_CONTAINER, 'oauth2-proxy']);
    expect(parts.volumes).toEqual([{ name: OWNER_AUTHZ_VOLUME }]);
    const env = envMap(sidecarOf(parts).environment);
    expect(env.OAUTH2_PROXY_AUTHENTICATED_EMAILS_FILE).toBe(OWNER_AUTHZ_EMAILS_PATH);
    expect(env.OAUTH2_PROXY_COOKIE_SECRET_FILE).toBe(OWNER_AUTHZ_COOKIE_SECRET_PATH);
    expect(sidecarOf(parts).secrets?.map((s) => s.name)).not.toContain('OAUTH2_PROXY_COOKIE_SECRET');
  });
});

// Port of oauth2-proxy v7.15.5 pkg/encryption/utils.go SecretBytes: the file
// content is used verbatim (no trimming) by Cookie.GetSecret.
function secretBytes(secret: string): Buffer {
  const trimmed = secret.replace(/=+$/, '');
  if (/^[A-Za-z0-9_-]*$/.test(trimmed) && trimmed.length % 4 !== 1) {
    const b = Buffer.from(trimmed, 'base64url');
    if ([16, 24, 32].includes(b.length)) return b;
  }
  return Buffer.from(secret);
}

// Runs the init container's script for real, with the volume mapped to a tmpdir.
function runInit(init: ContainerDefinition): string {
  const dir = mkdtempSync(join(tmpdir(), 'owner-authz-'));
  const script = init.command![0]!.split(OWNER_AUTHZ_DIR).join(dir);
  execFileSync('sh', ['-c', script], {
    env: { PATH: process.env.PATH, ...envMap(init.environment) } as NodeJS.ProcessEnv,
  });
  return dir;
}

describe('owner-authz init container script', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const fileIn = (dir: string, path: string) => join(dir, path.slice(OWNER_AUTHZ_DIR.length));

  it('github: writes a valid oauth2-proxy cookie secret and no emails file', () => {
    const o = buildOwnerAuthorization(
      { provider: 'github', allowedUsers: [], ownerOnly: true, adminUsers: [] },
      'carol',
      { ...opts, initImage },
    );
    expect(o.initContainer?.entryPoint).toEqual(['sh', '-c']);
    const dir = runInit(o.initContainer!);
    dirs.push(dir);
    const secret = readFileSync(fileIn(dir, OWNER_AUTHZ_COOKIE_SECRET_PATH), 'utf8');
    expect(secret).not.toMatch(/\s/);
    expect([16, 24, 32]).toContain(secretBytes(secret).length);
    expect(existsSync(fileIn(dir, OWNER_AUTHZ_EMAILS_PATH))).toBe(false);
  });

  it('oidc: writes the emails file and a cookie secret', () => {
    const o = buildOwnerAuthorization(
      { provider: 'oidc', allowedUsers: [], ownerOnly: true, adminUsers: ['ops@example.com'] },
      'owner@example.com',
      { ...opts, initImage },
    );
    const dir = runInit(o.initContainer!);
    dirs.push(dir);
    expect(readFileSync(fileIn(dir, OWNER_AUTHZ_EMAILS_PATH), 'utf8')).toBe('owner@example.com\nops@example.com\n');
    const secret = readFileSync(fileIn(dir, OWNER_AUTHZ_COOKIE_SECRET_PATH), 'utf8');
    expect([16, 24, 32]).toContain(secretBytes(secret).length);
  });

  it('generates a different secret on every run', () => {
    const o = buildOwnerAuthorization(
      { provider: 'github', allowedUsers: [], ownerOnly: true, adminUsers: [] },
      'carol',
      { ...opts, initImage },
    );
    const a = runInit(o.initContainer!);
    const b = runInit(o.initContainer!);
    dirs.push(a, b);
    expect(readFileSync(fileIn(a, OWNER_AUTHZ_COOKIE_SECRET_PATH), 'utf8')).not.toBe(
      readFileSync(fileIn(b, OWNER_AUTHZ_COOKIE_SECRET_PATH), 'utf8'),
    );
  });
});

// Same list as oauth2-proxy-builder.test.ts: cfg tags (v7.15.5) of the
// settings the sidecar uses. oauth2-proxy ignores unknown env names.
const KNOWN_ENV = new Set(
  [
    'provider', 'http_address', 'upstreams', 'reverse_proxy', 'pass_authorization_header',
    'cookie_secure', 'email_domains', 'github_org', 'github_users', 'allowed_groups',
    'authenticated_emails_file', 'client_id', 'client_secret', 'cookie_secret', 'cookie_secret_file',
  ].map((n) => `OAUTH2_PROXY_${n.toUpperCase()}`),
);

describe('owner-only sidecar env names', () => {
  it('are all settings oauth2-proxy actually reads', () => {
    const github = sidecarOf(buildBrowserAuthTaskParts(
      { provider: 'github', allowedOrg: 'acme', allowedUsers: ['alice'], ownerOnly: true, adminUsers: ['ops'] },
      'carol',
      secretArns,
      { ...opts, initImage },
    ));
    const oidc = buildOwnerAuthorization(
      { provider: 'oidc', allowedUsers: [], ownerOnly: true, adminUsers: [] },
      'owner@example.com',
      { ...opts, initImage },
    );
    const names = [
      ...[...(github.environment ?? []), ...(github.secrets ?? [])].map((e) => e.name!),
      ...oidc.sidecarEnvironment.map((e) => e.name!),
      ...oidc.removeSidecarEnvironment,
      ...oidc.removeSidecarSecrets,
    ];
    for (const name of names) expect(KNOWN_ENV.has(name), name).toBe(true);
  });
});

describe('buildOwnerAuthorization (oidc / entra-id)', () => {
  for (const provider of ['oidc', 'entra-id'] as const) {
    it(`${provider} + ownerOnly emits an init container, a shared volume, and AUTHENTICATED_EMAILS_FILE`, () => {
      const o = buildOwnerAuthorization(
        { provider, allowedUsers: [], ownerOnly: true, adminUsers: ['Ops@Example.com'] },
        'Owner@Example.com',
        { ...opts, initImage },
      );

      expect(o.volumes).toEqual([{ name: OWNER_AUTHZ_VOLUME }]);

      const init = o.initContainer!;
      expect(init.name).toBe(OWNER_AUTHZ_INIT_CONTAINER);
      expect(init.essential).toBe(false);
      expect(init.image).toBe(initImage);
      expect(init.mountPoints).toEqual([
        { sourceVolume: OWNER_AUTHZ_VOLUME, containerPath: '/authz', readOnly: false },
      ]);
      // Emails travel by env var (never interpolated into the script), lowercased.
      expect(envMap(init.environment).OWNER_AUTHZ_EMAILS).toBe('owner@example.com,ops@example.com');
      expect(init.logConfiguration?.options?.['awslogs-stream-prefix']).toBe('browser/hello/owner-authz-init');

      const env = envMap(o.sidecarEnvironment);
      expect(env.OAUTH2_PROXY_AUTHENTICATED_EMAILS_FILE).toBe(OWNER_AUTHZ_EMAILS_PATH);
      expect(env.OAUTH2_PROXY_COOKIE_SECRET_FILE).toBe(OWNER_AUTHZ_COOKIE_SECRET_PATH);
      expect(o.removeSidecarSecrets).toEqual(['OAUTH2_PROXY_COOKIE_SECRET']);
      // EMAIL_DOMAINS (even "*" or configured domains) is ORed with the file
      // by oauth2-proxy, so it must be removed.
      expect(o.removeSidecarEnvironment).toContain('OAUTH2_PROXY_EMAIL_DOMAINS');
      expect(o.sidecarMountPoints).toEqual([
        { sourceVolume: OWNER_AUTHZ_VOLUME, containerPath: '/authz', readOnly: true },
      ]);
      expect(o.sidecarDependsOn).toEqual([{ containerName: OWNER_AUTHZ_INIT_CONTAINER, condition: 'SUCCESS' }]);
    });
  }

  it('ownerOnly: false is a no-op', () => {
    const o = buildOwnerAuthorization(
      { provider: 'oidc', allowedUsers: [], ownerOnly: false, adminUsers: [] },
      'owner@example.com',
      { ...opts, initImage },
    );
    expect(o.initContainer).toBeUndefined();
    expect(o.volumes).toEqual([]);
    expect(o.sidecarEnvironment).toEqual([]);
    expect(o.removeSidecarEnvironment).toEqual([]);
    expect(o.removeSidecarSecrets).toEqual([]);
  });
});

describe('validateOwnerAuthorization', () => {
  const base = { allowedUsers: [] as string[], adminUsers: [] as string[], ownerOnly: true };

  it('oidc + ownerOnly + owner "octocat" (not an email) is refused', () => {
    const r = validateOwnerAuthorization({ ...base, provider: 'oidc' }, 'octocat');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toMatch(/octocat/);
    expect(!r.ok && r.message).toMatch(/email/);
  });

  it('entra-id + ownerOnly + an email owner is accepted', () => {
    expect(validateOwnerAuthorization({ ...base, provider: 'entra-id' }, 'owner@example.com').ok).toBe(true);
  });

  it('github + ownerOnly + an email owner is refused (GitHub login expected)', () => {
    const r = validateOwnerAuthorization({ ...base, provider: 'github' }, 'owner@example.com');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toMatch(/GitHub login/);
  });

  it('github + ownerOnly + a login owner is accepted', () => {
    expect(validateOwnerAuthorization({ ...base, provider: 'github' }, 'octo-cat').ok).toBe(true);
  });

  it('ownerOnly + missing owner is refused for every provider', () => {
    for (const provider of ['github', 'entra-id', 'oidc'] as const) {
      const r = validateOwnerAuthorization({ ...base, provider }, undefined);
      expect(r.ok, provider).toBe(false);
      expect(!r.ok && r.message).toMatch(/owner/);
    }
  });

  it('ownerOnly + an invalid admin entry is refused', () => {
    const r = validateOwnerAuthorization({ ...base, provider: 'oidc', adminUsers: ['ops'] }, 'owner@example.com');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toMatch(/adminUsers/);
  });

  it('github + ownerOnly refuses an owner outside a non-empty allowedUsers (admins count)', () => {
    const auth = { ...base, provider: 'github' as const, allowedUsers: ['alice'], adminUsers: ['ops'] };
    expect(validateOwnerAuthorization(auth, 'mallory').ok).toBe(false);
    expect(validateOwnerAuthorization(auth, 'alice').ok).toBe(true);
    expect(validateOwnerAuthorization(auth, 'ops').ok).toBe(true);
  });

  it('oidc + ownerOnly refuses an owner outside non-empty allowedEmailDomains', () => {
    const auth = { ...base, provider: 'oidc' as const, allowedEmailDomains: ['example.com'] };
    expect(validateOwnerAuthorization(auth, 'owner@evil.test').ok).toBe(false);
    expect(validateOwnerAuthorization(auth, 'owner@Example.com').ok).toBe(true);
  });

  it('ownerOnly: false accepts anything, including no owner', () => {
    expect(validateOwnerAuthorization({ ...base, ownerOnly: false, provider: 'oidc' }, undefined).ok).toBe(true);
    expect(validateOwnerAuthorization({ ...base, ownerOnly: false, provider: 'oidc' }, 'octocat').ok).toBe(true);
  });
});

// registerTaskDef wiring: the task definition ECS receives.
describe('registerTaskDef with owner authorization', () => {
  beforeEach(() => {
    vi.resetModules();
    for (const [k, v] of Object.entries({
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
      BROWSER_TASK_ROLE_ARN: 'arn:aws:iam::123456789012:role/B',
      TUNNEL_TASK_ROLE_ARN: 'arn:aws:iam::123456789012:role/T',
      SSH_TASK_DEF_FAMILY: 'cloud-dev-pods-ssh',
      SSH_TASK_ROLE_ARN: 'arn:aws:iam::123456789012:role/S',
      SSH_EXECUTION_ROLE_ARN: 'arn:aws:iam::123456789012:role/SE',
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
      AUTH_BROWSER_ADMIN_USERS: '["ops"]',
    })) vi.stubEnv(k, v);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  async function register(): Promise<{ containerDefinitions: { name: string; environment?: { name?: string; value?: string }[]; secrets?: { name?: string }[] }[]; volumes: { name: string }[] }> {
    const { ECSClient } = await import('@aws-sdk/client-ecs');
    const { SecretsManagerClient } = await import('@aws-sdk/client-secrets-manager');
    const sent: { input: unknown }[] = [];
    vi.spyOn(ECSClient.prototype, 'send').mockImplementation(async (cmd: unknown) => {
      sent.push(cmd as { input: unknown });
      return { taskDefinition: { taskDefinitionArn: 'arn:td:1' } } as never;
    });
    vi.spyOn(SecretsManagerClient.prototype, 'send').mockImplementation(async (cmd: unknown) => {
      const key = (cmd as { input: { SecretId: string } }).input.SecretId.split('/').pop()!;
      const arns: Record<string, string> = {
        'client-id': secretArns.clientId,
        'client-secret': secretArns.clientSecret,
        'cookie-secret': secretArns.cookieSecret,
      };
      return { ARN: arns[key] } as never;
    });
    const { registerTaskDef } = await import('../lambda/pod-manager/aws');
    await registerTaskDef({
      family: 'cloud-dev-pods-browser',
      imageUri: 'r/b:abc',
      accessPointId: 'fsap-1',
      podName: 'hello',
      cpu: '1024',
      memory: '2048',
      mode: 'browser',
      owner: 'carol',
    });
    return sent[0]!.input as never;
  }

  it('ownerOnly false: vscode + the #131 sidecar, and only the workspace volume', async () => {
    const input = await register();
    expect(input.containerDefinitions.map((c) => c.name)).toEqual(['vscode', 'oauth2-proxy']);
    expect(input.containerDefinitions[1]).toEqual(
      buildOauth2ProxyContainer({ provider: 'github', allowedOrg: 'acme', allowedUsers: [] }, secretArns, opts),
    );
    expect(input.volumes.map((v) => v.name)).toEqual(['workspace']);
  });

  it('ownerOnly true (github): sidecar gets the owner plus admins, org kept as an allowed group', async () => {
    vi.stubEnv('AUTH_BROWSER_OWNER_ONLY', 'true');
    const input = await register();
    expect(input.containerDefinitions.map((c) => c.name)).toEqual(['vscode', OWNER_AUTHZ_INIT_CONTAINER, 'oauth2-proxy']);
    const sidecar = input.containerDefinitions[2]!;
    expect(sidecar.secrets?.map((s) => s.name)).not.toContain('OAUTH2_PROXY_COOKIE_SECRET');
    const env = envMap(sidecar.environment);
    expect(env.OAUTH2_PROXY_COOKIE_SECRET_FILE).toBe(OWNER_AUTHZ_COOKIE_SECRET_PATH);
    expect(env.OAUTH2_PROXY_GITHUB_USERS).toBe('carol,ops');
    expect(env.OAUTH2_PROXY_ALLOWED_GROUPS).toBe('acme');
    expect(env).not.toHaveProperty('OAUTH2_PROXY_GITHUB_ORG');
    expect(input.volumes.map((v) => v.name)).toEqual(['workspace', OWNER_AUTHZ_VOLUME]);
  });
});

// ---- Central auth host (#144, ADR 0009 scope changes 2, 3, 5 and 6) ----

const BASE = 'pods.example.com';
const ENTRA_ISSUER = 'https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/v2.0';
const centralOpts = { ...opts, initImage, baseDomain: BASE };

// One deployment per provider, as the synth guard would accept it.
const CENTRAL_DEPLOYMENTS = {
  github: { provider: 'github', allowedOrg: 'acme', allowedUsers: ['alice', 'bob'] },
  'entra-id': {
    provider: 'entra-id',
    issuerUrl: ENTRA_ISSUER,
    allowedUsers: [],
    allowedGroups: ['aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'],
    allowedEmailDomains: ['example.com'],
  },
  oidc: { provider: 'oidc', issuerUrl: 'https://acme.okta.com', allowedUsers: [], allowedEmailDomains: ['example.com'] },
} as const satisfies Record<string, Oauth2ProxyAuthConfig>;

const OWNER = 'Carol@Example.com';
const centralAuth = (provider: keyof typeof CENTRAL_DEPLOYMENTS) => ({
  ...CENTRAL_DEPLOYMENTS[provider],
  ownerOnly: true,
  adminUsers: [] as string[],
  centralAuthHost: true,
});
const centralParts = (provider: keyof typeof CENTRAL_DEPLOYMENTS) =>
  buildBrowserAuthTaskParts(centralAuth(provider), OWNER, secretArns, centralOpts);
const initOf = (parts: { containers: ContainerDefinition[] }) =>
  parts.containers.find((c) => c.name === OWNER_AUTHZ_INIT_CONTAINER)!;

// ADR 0009 item 5: settings that let a request past the per-request owner
// check, forward a token to the owner's code, or bypass the sign-in template.
const FORBIDDEN_SIDECAR_ENV = [
  'OAUTH2_PROXY_PASS_ACCESS_TOKEN',
  'OAUTH2_PROXY_SKIP_JWT_BEARER_TOKENS',
  'OAUTH2_PROXY_HTPASSWD_FILE',
  'OAUTH2_PROXY_SKIP_AUTH_ROUTES',
  'OAUTH2_PROXY_SKIP_AUTH_REGEX',
  'OAUTH2_PROXY_TRUSTED_IPS',
  'OAUTH2_PROXY_SKIP_AUTH_PREFLIGHT',
  'OAUTH2_PROXY_SKIP_PROVIDER_BUTTON',
];

describe.each(['github', 'entra-id', 'oidc'] as const)('centralAuthHost sidecar (%s)', (provider) => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('checks the owner per request through the emails file, with no EMAIL_DOMAINS', () => {
    const sidecar = sidecarOf(centralParts(provider));
    const env = envMap(sidecar.environment);
    expect(env.OAUTH2_PROXY_AUTHENTICATED_EMAILS_FILE).toBe(OWNER_AUTHZ_EMAILS_PATH);
    // Any EMAIL_DOMAINS (for github: "*", which admits every email) ORs with
    // the emails file and would cancel the owner check.
    expect((sidecar.environment ?? []).map((e) => e.name)).not.toContain('OAUTH2_PROXY_EMAIL_DOMAINS');
    expect(sidecar.mountPoints).toEqual([{ sourceVolume: OWNER_AUTHZ_VOLUME, containerPath: OWNER_AUTHZ_DIR, readOnly: true }]);
  });

  it('writes the lowercased owner as the only emails-file entry', () => {
    const dir = runInit(initOf(centralParts(provider)));
    dirs.push(dir);
    expect(readFileSync(join(dir, 'emails.txt'), 'utf8')).toBe('carol@example.com\n');
  });

  it('keeps the shared cookie secret: no per-task secret file is written or mounted', () => {
    const parts = centralParts(provider);
    const sidecar = sidecarOf(parts);
    expect(sidecar.secrets).toContainEqual({ name: 'OAUTH2_PROXY_COOKIE_SECRET', valueFrom: secretArns.cookieSecret });
    expect(envMap(sidecar.environment)).not.toHaveProperty('OAUTH2_PROXY_COOKIE_SECRET_FILE');
    expect(initOf(parts).command![0]).not.toContain('cookie-secret');
    const dir = runInit(initOf(parts));
    dirs.push(dir);
    expect(existsSync(join(dir, 'cookie-secret'))).toBe(false);
  });

  it('sets none of the forbidden settings', () => {
    for (const c of centralParts(provider).containers) {
      const names = (c.environment ?? []).map((e) => e.name);
      for (const f of FORBIDDEN_SIDECAR_ENV) expect(names, `${c.name}: ${f}`).not.toContain(f);
    }
  });

  it('points CUSTOM_TEMPLATES_DIR at the rd-rewriting sign_in.html the init container writes', () => {
    const parts = centralParts(provider);
    expect(envMap(sidecarOf(parts).environment).OAUTH2_PROXY_CUSTOM_TEMPLATES_DIR).toBe(OWNER_AUTHZ_TEMPLATES_DIR);
    const dir = runInit(initOf(parts));
    dirs.push(dir);
    const html = readFileSync(join(dir, OWNER_AUTHZ_TEMPLATES_DIR.slice(OWNER_AUTHZ_DIR.length), 'sign_in.html'), 'utf8');
    expect(html).toBe(SIGN_IN_TEMPLATE);
    expect(html).toContain('new URL(');
  });

  it('shares cookie name, cookie domains, CSRF-per-request and cookie-secret ARN with the central host', () => {
    const sidecar = sidecarOf(centralParts(provider));
    const host = buildCentralAuthHostContainer(CENTRAL_DEPLOYMENTS[provider], secretArns, {
      baseDomain: BASE,
      logGroupName: '/cloud-dev-pods/dev/cluster',
      region: 'us-west-2',
    });
    const shared = (c: ContainerDefinition) => {
      const env = envMap(c.environment);
      return {
        cookieName: env.OAUTH2_PROXY_COOKIE_NAME,
        cookieDomains: env.OAUTH2_PROXY_COOKIE_DOMAINS,
        csrfPerRequest: env.OAUTH2_PROXY_COOKIE_CSRF_PER_REQUEST,
        redirectUrl: env.OAUTH2_PROXY_REDIRECT_URL,
        whitelist: env.OAUTH2_PROXY_WHITELIST_DOMAINS,
        cookieSecret: c.secrets?.find((x) => x.name === 'OAUTH2_PROXY_COOKIE_SECRET')?.valueFrom,
        cookieSecretFile: env.OAUTH2_PROXY_COOKIE_SECRET_FILE,
      };
    };
    expect(shared(sidecar)).toEqual(shared(host));
    expect(shared(sidecar)).toEqual({
      cookieName: CENTRAL_AUTH_COOKIE_NAME,
      cookieDomains: `.${BASE}`,
      csrfPerRequest: 'true',
      redirectUrl: `https://auth.${BASE}/oauth2/callback`,
      whitelist: `.${BASE}`,
      cookieSecret: secretArns.cookieSecret,
      cookieSecretFile: undefined,
    });
  });
});

describe('centralAuthHost github sidecar', () => {
  it('keeps GITHUB_ORG / GITHUB_USERS at the deployment-wide values, never the owner, and the org as ALLOWED_GROUPS', () => {
    const env = envMap(sidecarOf(centralParts('github')).environment);
    expect(env.OAUTH2_PROXY_GITHUB_ORG).toBe('acme');
    expect(env.OAUTH2_PROXY_GITHUB_USERS).toBe('alice,bob');
    expect(env.OAUTH2_PROXY_ALLOWED_GROUPS).toBe('acme');
    for (const v of [env.OAUTH2_PROXY_GITHUB_ORG, env.OAUTH2_PROXY_GITHUB_USERS]) {
      expect(v!.toLowerCase()).not.toContain('carol');
    }
  });

  it('fails if EMAIL_DOMAINS=* survives', () => {
    const env = sidecarOf(centralParts('github')).environment ?? [];
    expect(env.filter((e) => e.name === 'OAUTH2_PROXY_EMAIL_DOMAINS' && e.value === '*')).toEqual([]);
  });

  it('with only allowedUsers: no ALLOWED_GROUPS and GITHUB_USERS stays deployment-wide', () => {
    const parts = buildBrowserAuthTaskParts(
      { provider: 'github', allowedUsers: ['alice'], ownerOnly: true, adminUsers: [], centralAuthHost: true },
      'carol@example.com',
      secretArns,
      centralOpts,
    );
    const env = envMap(sidecarOf(parts).environment);
    expect(env.OAUTH2_PROXY_GITHUB_USERS).toBe('alice');
    expect(env).not.toHaveProperty('OAUTH2_PROXY_ALLOWED_GROUPS');
    expect(env).not.toHaveProperty('OAUTH2_PROXY_GITHUB_ORG');
  });
});

describe('centralAuthHost fails closed', () => {
  it('refuses to build a sidecar with ownerOnly off', () => {
    expect(() =>
      buildBrowserAuthTaskParts({ ...centralAuth('github'), ownerOnly: false }, OWNER, secretArns, centralOpts),
    ).toThrow(/ownerOnly/);
  });

  it('refuses to build a sidecar without a baseDomain', () => {
    expect(() => buildBrowserAuthTaskParts(centralAuth('oidc'), OWNER, secretArns, { ...centralOpts, baseDomain: '' })).toThrow(
      /baseDomain/,
    );
  });

  it('ignores a centralAuthHost option passed without auth.centralAuthHost', () => {
    const parts = buildBrowserAuthTaskParts(
      { provider: 'github', allowedOrg: 'acme', allowedUsers: [], ownerOnly: false, adminUsers: [] },
      'carol',
      secretArns,
      { ...centralOpts, centralAuthHost: { baseDomain: BASE } },
    );
    const env = envMap(sidecarOf(parts).environment);
    expect(env).not.toHaveProperty('OAUTH2_PROXY_COOKIE_DOMAINS');
    expect(env).not.toHaveProperty('OAUTH2_PROXY_COOKIE_NAME');
  });

  it('refuses to build a sidecar with adminUsers', () => {
    expect(() =>
      buildBrowserAuthTaskParts({ ...centralAuth('oidc'), adminUsers: ['ops@example.com'] }, OWNER, secretArns, centralOpts),
    ).toThrow(/adminUsers/);
  });
});

describe('sign_in.html', () => {
  it('is the stock v7.15.5 template plus exactly the #256 rd script', () => {
    expect(SIGN_IN_TEMPLATE.split(SIGN_IN_RD_SCRIPT)).toHaveLength(2);
    const stock = SIGN_IN_TEMPLATE.replace(SIGN_IN_RD_SCRIPT, '');
    expect(createHash('sha256').update(stock).digest('hex')).toBe(SIGN_IN_STOCK_SHA256);
    expect(SIGN_IN_RD_SCRIPT).toContain("new URL(inputs[i].value || '/', window.location.href).href");
    // Inserted right after the stock hash-preserving script.
    expect(SIGN_IN_TEMPLATE).toContain(`inputs[i].value += window.location.hash;\n        }\n      })();\n    }\n  </script>\n${SIGN_IN_RD_SCRIPT}`);
  });
});

describe('validateOwnerAuthorization with centralAuthHost', () => {
  const github = { ...centralAuth('github') };

  it('github accepts an email owner', () => {
    expect(validateOwnerAuthorization(github, 'carol@example.com')).toEqual({ ok: true });
  });

  it('github refuses a login, asking for an explicit verified primary GitHub email owner=', () => {
    const r = validateOwnerAuthorization(github, 'carol');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain('verified primary GitHub email');
    expect(r.message).toContain('owner=');
  });

  it('github refuses a missing owner with the same hint', () => {
    const r = validateOwnerAuthorization(github, undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('verified primary GitHub email');
  });

  it('github skips the login-based allowedUsers check and ignores allowedEmailDomains', () => {
    expect(validateOwnerAuthorization({ ...github, allowedUsers: ['alice'] }, 'carol@example.com')).toEqual({ ok: true });
    expect(
      validateOwnerAuthorization({ ...github, allowedEmailDomains: ['other.org'] }, 'carol@example.com'),
    ).toEqual({ ok: true });
  });

  it('entra-id / oidc still check allowedEmailDomains', () => {
    expect(validateOwnerAuthorization(centralAuth('oidc'), 'carol@other.org').ok).toBe(false);
    expect(validateOwnerAuthorization(centralAuth('entra-id'), 'carol@example.com')).toEqual({ ok: true });
  });

  it('refuses any adminUsers', () => {
    const r = validateOwnerAuthorization({ ...centralAuth('oidc'), adminUsers: ['ops@example.com'] }, 'carol@example.com');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('adminUsers');
  });

  it('without centralAuthHost, github still wants a login', () => {
    expect(validateOwnerAuthorization({ ...github, centralAuthHost: false }, 'carol@example.com').ok).toBe(false);
    expect(validateOwnerAuthorization({ ...github, centralAuthHost: false, allowedUsers: [] }, 'carol')).toEqual({ ok: true });
  });
});

describe('centralAuthHost off is unchanged', () => {
  it.each(['github', 'entra-id', 'oidc'] as const)('%s: centralAuthHost false equals the field absent', (provider) => {
    const { centralAuthHost: _c, ...withoutField } = centralAuth(provider);
    const owner = provider === 'github' ? 'carol' : 'carol@example.com';
    expect(buildBrowserAuthTaskParts({ ...withoutField, centralAuthHost: false }, owner, secretArns, centralOpts)).toEqual(
      buildBrowserAuthTaskParts(withoutField, owner, secretArns, { ...opts, initImage }),
    );
  });
});

// The registered browser task definition (ADR 0009 item 5 and scope change 6).
describe('registerTaskDef with centralAuthHost', () => {
  beforeEach(() => {
    vi.resetModules();
    for (const [k, v] of Object.entries({
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
      BROWSER_TASK_ROLE_ARN: 'arn:aws:iam::123456789012:role/B',
      TUNNEL_TASK_ROLE_ARN: 'arn:aws:iam::123456789012:role/T',
      SSH_TASK_DEF_FAMILY: 'cloud-dev-pods-ssh',
      SSH_TASK_ROLE_ARN: 'arn:aws:iam::123456789012:role/S',
      SSH_EXECUTION_ROLE_ARN: 'arn:aws:iam::123456789012:role/SE',
      EXECUTION_ROLE_ARN: 'arn:aws:iam::123456789012:role/E',
      PODS_LOG_GROUP_NAME: '/cloud-dev-pods/dev/pods',
      VPC_ID: 'vpc-x',
      PRIVATE_SUBNET_IDS: 'subnet-1',
      TASKS_SECURITY_GROUP_ID: 'sg-x',
      BROWSER_REPO_URI: 'r/b',
      TUNNEL_REPO_URI: 'r/t',
      BROWSER_REPO_NAME: 'b',
      TUNNEL_REPO_NAME: 't',
      BASE_DOMAIN: BASE,
      DOMAIN_STRATEGY: 'byo',
      AUTH_BROWSER_PROVIDER: 'github',
      AUTH_BROWSER_ALLOWED_ORG: 'acme',
      AUTH_BROWSER_OWNER_ONLY: 'true',
    })) vi.stubEnv(k, v);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  type Def = ContainerDefinition & { name: string };
  async function register(mode: 'browser' | 'tunnel' = 'browser', owner = 'carol@example.com') {
    const { ECSClient } = await import('@aws-sdk/client-ecs');
    const { SecretsManagerClient } = await import('@aws-sdk/client-secrets-manager');
    const sent: { input: unknown }[] = [];
    vi.spyOn(ECSClient.prototype, 'send').mockImplementation(async (cmd: unknown) => {
      sent.push(cmd as { input: unknown });
      return { taskDefinition: { taskDefinitionArn: 'arn:td:1' } } as never;
    });
    vi.spyOn(SecretsManagerClient.prototype, 'send').mockImplementation(async (cmd: unknown) => {
      const key = (cmd as { input: { SecretId: string } }).input.SecretId.split('/').pop()!;
      const arns: Record<string, string> = {
        'client-id': secretArns.clientId,
        'client-secret': secretArns.clientSecret,
        'cookie-secret': secretArns.cookieSecret,
      };
      return { ARN: arns[key] } as never;
    });
    const { registerTaskDef } = await import('../lambda/pod-manager/aws');
    await registerTaskDef({
      family: `cloud-dev-pods-${mode}`,
      imageUri: 'r/b:abc',
      accessPointId: 'fsap-1',
      podName: 'hello',
      cpu: '1024',
      memory: '2048',
      mode,
      owner,
    });
    return sent[0]!.input as { containerDefinitions: Def[]; pidMode?: string };
  }

  it('drops NET_RAW from the vscode container and sets no pidMode', async () => {
    vi.stubEnv('AUTH_BROWSER_CENTRAL_AUTH_HOST', 'true');
    const input = await register();
    const vscode = input.containerDefinitions.find((c) => c.name === 'vscode')!;
    const drop = vscode.linuxParameters?.capabilities?.drop ?? [];
    expect(drop.includes('NET_RAW') || drop.includes('ALL')).toBe(true);
    expect(input).not.toHaveProperty('pidMode');
  });

  it('wires the central-host sidecar: shared cookie, emails file, sign-in template', async () => {
    vi.stubEnv('AUTH_BROWSER_CENTRAL_AUTH_HOST', 'true');
    const input = await register();
    expect(input.containerDefinitions.map((c) => c.name)).toEqual(['vscode', OWNER_AUTHZ_INIT_CONTAINER, 'oauth2-proxy']);
    const sidecar = input.containerDefinitions[2]!;
    const env = envMap(sidecar.environment);
    expect(env.OAUTH2_PROXY_REDIRECT_URL).toBe(`https://auth.${BASE}/oauth2/callback`);
    expect(env.OAUTH2_PROXY_AUTHENTICATED_EMAILS_FILE).toBe(OWNER_AUTHZ_EMAILS_PATH);
    expect(env.OAUTH2_PROXY_CUSTOM_TEMPLATES_DIR).toBe(OWNER_AUTHZ_TEMPLATES_DIR);
    expect(env).not.toHaveProperty('OAUTH2_PROXY_EMAIL_DOMAINS');
    expect(sidecar.secrets?.map((x) => x.name)).toContain('OAUTH2_PROXY_COOKIE_SECRET');
  });

  it('leaves the vscode container alone when centralAuthHost is off', async () => {
    const input = await register('browser', 'carol');
    const vscode = input.containerDefinitions.find((c) => c.name === 'vscode')!;
    expect(vscode).not.toHaveProperty('linuxParameters');
  });
});
