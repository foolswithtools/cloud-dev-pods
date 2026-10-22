import { describe, expect, it } from 'vitest';
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

  it('rejection: an unknown provider fails validation', () => {
    expect(() =>
      resolveConfig(baseConfig({ auth: { browser: { provider: 'okta' } } })),
    ).toThrow();
  });

  it('rejection: tunnel provider microsoft fails validation in this slice', () => {
    expect(() =>
      resolveConfig(baseConfig({ auth: { tunnel: { provider: 'microsoft' } } })),
    ).toThrow(/#129/);
  });
});
