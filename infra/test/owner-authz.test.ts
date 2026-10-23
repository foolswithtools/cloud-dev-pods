import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContainerDefinition } from '@aws-sdk/client-ecs';
import {
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
  OWNER_AUTHZ_VOLUME,
  buildBrowserAuthTaskParts,
  buildOwnerAuthorization,
  validateOwnerAuthorization,
} from '../lambda/pod-manager/owner-authz';

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
