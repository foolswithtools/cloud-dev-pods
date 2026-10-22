import { afterEach, describe, expect, it, vi } from 'vitest';
import { authLambdaEnvironment } from '../lib/config/auth-env';
import { resolveConfig } from '../lib/config/schema';

// Minimal valid config: every required top-level block present, auth omitted.
function baseConfig(overrides: { github?: Record<string, unknown>; auth?: unknown } = {}) {
  return {
    project: {},
    aws: { accountId: '123456789012' },
    github: { org: 'acme', repo: 'cloud-dev-pods', ...overrides.github },
    domain: {},
    network: {},
    pods: {},
    naming: {},
    ...(overrides.auth === undefined ? {} : { auth: overrides.auth }),
  };
}

describe('auth config resolution', () => {
  it('defaults: empty auth resolves to github provider, ownerOnly false, tunnel github', () => {
    const { config, warnings } = resolveConfig(baseConfig({ auth: {} }));
    expect(config.auth.browser.provider).toBe('github');
    expect(config.auth.browser.ownerOnly).toBe(false);
    expect(config.auth.browser.allowedUsers).toEqual([]);
    expect(config.auth.browser.allowedGroups).toEqual([]);
    expect(config.auth.browser.allowedEmailDomains).toEqual([]);
    expect(config.auth.browser.allowedTenants).toEqual([]);
    expect(config.auth.browser.adminUsers).toEqual([]);
    expect(config.auth.browser.allowedOrg).toBeUndefined();
    expect(config.auth.tunnel.provider).toBe('github');
    expect(warnings).toEqual([]);
  });

  it('defaults: auth block omitted entirely resolves to the same defaults', () => {
    const { config, warnings } = resolveConfig(baseConfig());
    expect(config.auth.browser.provider).toBe('github');
    expect(config.auth.tunnel.provider).toBe('github');
    expect(warnings).toEqual([]);
  });

  it('a bare `auth:` / `browser:` key (YAML null) is treated as absent', () => {
    const nullAuth = resolveConfig(baseConfig({ github: { oauthAllowedOrg: 'acme' }, auth: null }));
    expect(nullAuth.config.auth.browser.allowedOrg).toBe('acme');
    const nullBrowser = resolveConfig(
      baseConfig({ github: { oauthAllowedOrg: 'acme' }, auth: { browser: null, tunnel: null } }),
    );
    expect(nullBrowser.config.auth.browser.allowedOrg).toBe('acme');
    expect(nullBrowser.config.auth.tunnel.provider).toBe('github');
  });

  it('legacy mapping: github.oauthAllowedOrg maps to auth.browser.allowedOrg with one deprecation warning', () => {
    const { config, warnings } = resolveConfig(
      baseConfig({ github: { oauthAllowedOrg: 'acme' } }),
    );
    expect(config.auth.browser.allowedOrg).toBe('acme');
    expect(config.auth.browser.provider).toBe('github');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/deprecat/i);
    expect(warnings[0]).toContain('github.oauthAllowedOrg');
    expect(warnings[0]).toContain('auth.browser.allowedOrg');
  });

  it('legacy mapping: comma-separated github.oauthAllowedUsers becomes a trimmed list', () => {
    const { config, warnings } = resolveConfig(
      baseConfig({ github: { oauthAllowedUsers: 'alice, bob,,carol ' } }),
    );
    expect(config.auth.browser.allowedUsers).toEqual(['alice', 'bob', 'carol']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('github.oauthAllowedUsers');
  });

  it('legacy mapping still applies when auth is present but auth.browser is absent', () => {
    const { config, warnings } = resolveConfig(
      baseConfig({ github: { oauthAllowedOrg: 'acme' }, auth: { tunnel: { provider: 'github' } } }),
    );
    expect(config.auth.browser.allowedOrg).toBe('acme');
    expect(warnings).toHaveLength(1);
  });

  it('precedence: when both legacy and new keys are set, the new keys win and the warning says so', () => {
    const { config, warnings } = resolveConfig(
      baseConfig({
        github: { oauthAllowedOrg: 'legacy-org', oauthAllowedUsers: 'legacy-user' },
        auth: { browser: { allowedOrg: 'new-org', allowedUsers: ['new-user'] } },
      }),
    );
    expect(config.auth.browser.allowedOrg).toBe('new-org');
    expect(config.auth.browser.allowedUsers).toEqual(['new-user']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/deprecat/i);
    expect(warnings[0]).toMatch(/auth\.browser.*(wins|takes precedence)/i);
  });

  it('precedence: an auth.browser block without allowlists still ignores legacy keys', () => {
    const { config, warnings } = resolveConfig(
      baseConfig({
        github: { oauthAllowedOrg: 'legacy-org' },
        auth: { browser: { allowedGroups: ['g1'] } },
      }),
    );
    expect(config.auth.browser.allowedOrg).toBeUndefined();
    expect(config.auth.browser.allowedGroups).toEqual(['g1']);
    expect(warnings).toHaveLength(1);
  });

  it('rejection: provider entra-id fails validation with a message naming the epic', () => {
    expect(() =>
      resolveConfig(baseConfig({ auth: { browser: { provider: 'entra-id' } } })),
    ).toThrow(/#129/);
  });

  it('rejection: provider oidc fails validation with a message naming the epic', () => {
    expect(() =>
      resolveConfig(baseConfig({ auth: { browser: { provider: 'oidc' } } })),
    ).toThrow(/pluggable-identity-remote-access/);
  });

  it('ownerOnly true is accepted now that owner authorization is enforced (#133)', () => {
    const { config } = resolveConfig(
      baseConfig({ auth: { browser: { allowedOrg: 'acme', ownerOnly: true, adminUsers: ['ops'] } } }),
    );
    expect(config.auth.browser.ownerOnly).toBe(true);
    expect(config.auth.browser.adminUsers).toEqual(['ops']);
  });

  it('rejection: an unknown provider fails validation', () => {
    expect(() =>
      resolveConfig(baseConfig({ auth: { browser: { provider: 'okta' } } })),
    ).toThrow();
  });

  it('accepts tunnel provider microsoft (wired by #140)', () => {
    const { config } = resolveConfig(baseConfig({ auth: { tunnel: { provider: 'microsoft' } } }));
    expect(config.auth.tunnel.provider).toBe('microsoft');
  });

  it('rejection: an unknown tunnel provider fails validation', () => {
    expect(() =>
      resolveConfig(baseConfig({ auth: { tunnel: { provider: 'okta' } } })),
    ).toThrow();
  });
});

describe('PodManager Lambda auth environment', () => {
  it('a legacy-only config yields the resolved auth.browser values', () => {
    const { config } = resolveConfig(
      baseConfig({ github: { oauthAllowedOrg: 'acme', oauthAllowedUsers: 'alice, bob' } }),
    );
    expect(authLambdaEnvironment(config)).toEqual({
      AUTH_BROWSER_PROVIDER: 'github',
      AUTH_BROWSER_ISSUER_URL: '',
      AUTH_BROWSER_ALLOWED_ORG: 'acme',
      AUTH_BROWSER_ALLOWED_USERS: '["alice","bob"]',
      AUTH_BROWSER_ALLOWED_GROUPS: '[]',
      AUTH_BROWSER_ALLOWED_EMAIL_DOMAINS: '[]',
      AUTH_BROWSER_ALLOWED_TENANTS: '[]',
      AUTH_BROWSER_OWNER_ONLY: 'false',
      AUTH_BROWSER_ADMIN_USERS: '[]',
      AUTH_TUNNEL_PROVIDER: 'github',
    });
  });

  it('a new-keys config drives every AUTH_BROWSER_* var', () => {
    const { config } = resolveConfig(
      baseConfig({
        auth: {
          browser: {
            allowedOrg: 'acme',
            allowedUsers: ['alice'],
            allowedGroups: ['g1', 'g2'],
            adminUsers: ['root'],
          },
        },
      }),
    );
    config.auth.browser.ownerOnly = true;
    const vars = authLambdaEnvironment(config);
    expect(vars.AUTH_BROWSER_ALLOWED_ORG).toBe('acme');
    expect(vars.AUTH_BROWSER_ALLOWED_USERS).toBe('["alice"]');
    expect(vars.AUTH_BROWSER_ALLOWED_GROUPS).toBe('["g1","g2"]');
    expect(vars.AUTH_BROWSER_OWNER_ONLY).toBe('true');
    expect(vars.AUTH_BROWSER_ADMIN_USERS).toBe('["root"]');
  });
});

describe('pod-manager env.ts auth parsing', () => {
  const required = {
    AWS_ACCOUNT_ID: '123456789012',
    REGISTRY_TABLE_NAME: 't',
    CLUSTER_NAME: 'c',
    EFS_FILESYSTEM_ID: 'fs-x',
    ALB_LISTENER_ARN: 'arn',
    ALB_LISTENER_PROTOCOL: 'HTTP',
    ALB_DNS_NAME: 'alb',
    BROWSER_TASK_DEF_FAMILY: 'b',
    TUNNEL_TASK_DEF_FAMILY: 't',
    BROWSER_TASK_ROLE_ARN: 'r',
    TUNNEL_TASK_ROLE_ARN: 'r',
    EXECUTION_ROLE_ARN: 'r',
    PODS_LOG_GROUP_NAME: 'l',
    VPC_ID: 'v',
    PRIVATE_SUBNET_IDS: 's',
    TASKS_SECURITY_GROUP_ID: 'sg',
    BROWSER_REPO_URI: 'u',
    TUNNEL_REPO_URI: 'u',
    BROWSER_REPO_NAME: 'n',
    TUNNEL_REPO_NAME: 'n',
  };

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function loadEnv(extra: Record<string, string>) {
    vi.resetModules();
    for (const [k, v] of Object.entries({ ...required, ...extra })) vi.stubEnv(k, v);
    return (await import('../lambda/pod-manager/env')).env;
  }

  it('round-trips the values authLambdaEnvironment produces', async () => {
    const { config } = resolveConfig(
      baseConfig({
        auth: { browser: { allowedOrg: 'acme', allowedUsers: ['alice'], allowedTenants: ['t1'] } },
      }),
    );
    config.auth.browser.ownerOnly = true;
    const env = await loadEnv(authLambdaEnvironment(config));
    expect(env.auth).toEqual({
      browser: {
        provider: 'github',
        issuerUrl: '',
        allowedOrg: 'acme',
        allowedUsers: ['alice'],
        allowedGroups: [],
        allowedEmailDomains: [],
        allowedTenants: ['t1'],
        ownerOnly: true,
        adminUsers: [],
      },
      tunnel: { provider: 'github' },
    });
    expect(env).not.toHaveProperty('oauthAllowedOrg');
    expect(env).not.toHaveProperty('oauthAllowedUsers');
  });

  it('defaults when the AUTH_* vars are unset', async () => {
    const env = await loadEnv({});
    expect(env.auth.browser.provider).toBe('github');
    expect(env.auth.browser.allowedUsers).toEqual([]);
    expect(env.auth.browser.ownerOnly).toBe(false);
    expect(env.auth.tunnel.provider).toBe('github');
  });

  it('rejects an unknown browser provider value', async () => {
    await expect(loadEnv({ AUTH_BROWSER_PROVIDER: 'okta' })).rejects.toThrow(/AUTH_BROWSER_PROVIDER/);
  });

  it('rejects an unknown tunnel provider value', async () => {
    await expect(loadEnv({ AUTH_TUNNEL_PROVIDER: 'gitlab' })).rejects.toThrow(/AUTH_TUNNEL_PROVIDER/);
  });

  it('rejects a list var that is not a JSON array of strings', async () => {
    await expect(loadEnv({ AUTH_BROWSER_ALLOWED_GROUPS: 'g1,g2' })).rejects.toThrow(
      /AUTH_BROWSER_ALLOWED_GROUPS/,
    );
  });
});
