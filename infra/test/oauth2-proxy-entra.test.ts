import { describe, expect, it } from 'vitest';
import { assertBrowserAuthRestricted } from '../lambda/pod-manager/auth-guard';
import {
  buildOauth2ProxyContainer,
  type Oauth2ProxyAuthConfig,
  type Oauth2ProxyOptions,
  type Oauth2ProxySecretArns,
} from '../lambda/pod-manager/oauth2-proxy';
import { buildBrowserAuthTaskParts } from '../lambda/pod-manager/owner-authz';
import { resolveConfig } from '../lib/config/schema';

const TENANT = '11111111-2222-3333-4444-555555555555';
const OTHER_TENANT = '66666666-7777-8888-9999-000000000000';
const G1 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const G2 = 'ffffffff-0000-1111-2222-333333333333';
const ISSUER = `https://login.microsoftonline.com/${TENANT}/v2.0`;

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

const entra = (over: Partial<Oauth2ProxyAuthConfig> = {}): Oauth2ProxyAuthConfig => ({
  provider: 'entra-id',
  issuerUrl: ISSUER,
  allowedUsers: [],
  allowedGroups: [],
  allowedEmailDomains: [],
  allowedTenants: [TENANT],
  entraGroupOverage: false,
  ...over,
});

const envOf = (auth: Oauth2ProxyAuthConfig) =>
  Object.fromEntries(
    (buildOauth2ProxyContainer(auth, secretArns, opts).environment ?? []).map((e) => [e.name, e.value]),
  );

describe('buildOauth2ProxyContainer (entra-id provider)', () => {
  it('emits provider entra-id, the issuer URL, and the allowed tenants', () => {
    const env = envOf(entra({ allowedTenants: [TENANT, OTHER_TENANT] }));
    expect(env.OAUTH2_PROXY_PROVIDER).toBe('entra-id');
    expect(env.OAUTH2_PROXY_OIDC_ISSUER_URL).toBe(ISSUER);
    expect(env.OAUTH2_PROXY_ENTRA_ID_ALLOWED_TENANTS).toBe(`${TENANT},${OTHER_TENANT}`);
  });

  it('allowedGroups [g1, g2] emits OAUTH2_PROXY_ALLOWED_GROUPS=g1,g2', () => {
    expect(envOf(entra({ allowedGroups: [G1, G2] })).OAUTH2_PROXY_ALLOWED_GROUPS).toBe(`${G1},${G2}`);
  });

  // oauth2-proxy appends a "groups" scope when allowed_groups is set and no
  // scope is given; Entra has no such scope, so the scope is always explicit.
  it('always emits an explicit scope; entraGroupOverage adds User.Read', () => {
    expect(envOf(entra({ allowedGroups: [G1] })).OAUTH2_PROXY_SCOPE).toBe('openid email profile');
    expect(envOf(entra({ entraGroupOverage: true })).OAUTH2_PROXY_SCOPE).toBe('openid email profile User.Read');
  });

  it('allowedEmailDomains become EMAIL_DOMAINS; empty falls back to *', () => {
    expect(envOf(entra({ allowedEmailDomains: ['example.com', 'example.org'] })).OAUTH2_PROXY_EMAIL_DOMAINS).toBe(
      'example.com,example.org',
    );
    expect(envOf(entra()).OAUTH2_PROXY_EMAIL_DOMAINS).toBe('*');
  });

  it('a single-tenant issuer keeps issuer verification on', () => {
    expect(envOf(entra())).not.toHaveProperty('OAUTH2_PROXY_INSECURE_OIDC_SKIP_ISSUER_VERIFICATION');
  });

  // Multi-tenant discovery documents report a tenant-specific issuer, so
  // oauth2-proxy refuses to start unless issuer verification is skipped; the
  // entra-id provider then checks the token issuer shape and the tenant list.
  for (const segment of ['common', 'organizations', 'consumers']) {
    it(`a /${segment}/ issuer skips the generic issuer check`, () => {
      const env = envOf(entra({ issuerUrl: `https://login.microsoftonline.com/${segment}/v2.0` }));
      expect(env.OAUTH2_PROXY_INSECURE_OIDC_SKIP_ISSUER_VERIFICATION).toBe('true');
    });
  }

  // Entra issues lowercase IDs and oauth2-proxy compares exactly; its issuer
  // check is exact too, and Entra's published issuer has no trailing slash.
  it('normalizes the issuer and IDs to the form Entra issues', () => {
    const env = envOf(
      entra({
        issuerUrl: `https://login.microsoftonline.com/${TENANT.toUpperCase()}/v2.0/`,
        allowedTenants: [TENANT.toUpperCase()],
        allowedGroups: [` ${G1.toUpperCase()} `],
      }),
    );
    expect(env.OAUTH2_PROXY_OIDC_ISSUER_URL).toBe(ISSUER);
    expect(env.OAUTH2_PROXY_ENTRA_ID_ALLOWED_TENANTS).toBe(TENANT);
    expect(env.OAUTH2_PROXY_ALLOWED_GROUPS).toBe(G1);
  });

  it('omits empty allowlists instead of emitting empty values', () => {
    const env = envOf(entra({ allowedTenants: [], allowedGroups: [G1] }));
    expect(env).not.toHaveProperty('OAUTH2_PROXY_ENTRA_ID_ALLOWED_TENANTS');
    expect(envOf(entra())).not.toHaveProperty('OAUTH2_PROXY_ALLOWED_GROUPS');
  });

  it('emits no GitHub-only settings', () => {
    const env = envOf(entra({ allowedOrg: 'acme', allowedUsers: ['alice'] }));
    expect(env).not.toHaveProperty('OAUTH2_PROXY_GITHUB_ORG');
    expect(env).not.toHaveProperty('OAUTH2_PROXY_GITHUB_USERS');
  });

  it('keeps the shared client-id / client-secret / cookie-secret paths', () => {
    const c = buildOauth2ProxyContainer(entra(), secretArns, opts);
    expect(c.secrets).toEqual([
      { name: 'OAUTH2_PROXY_CLIENT_ID', valueFrom: secretArns.clientId },
      { name: 'OAUTH2_PROXY_CLIENT_SECRET', valueFrom: secretArns.clientSecret },
      { name: 'OAUTH2_PROXY_COOKIE_SECRET', valueFrom: secretArns.cookieSecret },
    ]);
  });

  it('refuses to build without a valid Entra issuer URL', () => {
    expect(() => envOf(entra({ issuerUrl: undefined }))).toThrow(/issuerUrl/);
    expect(() => envOf(entra({ issuerUrl: 'https://accounts.google.com' }))).toThrow(/issuerUrl/);
  });

  it('refuses a multi-tenant issuer without allowedTenants', () => {
    expect(() =>
      envOf(entra({ issuerUrl: 'https://login.microsoftonline.com/common/v2.0', allowedTenants: [], allowedGroups: [G1] })),
    ).toThrow(/allowedTenants/);
  });
});

describe('buildBrowserAuthTaskParts forwards the entra-id settings to the sidecar', () => {
  const owner = {
    ...entra({ allowedGroups: [G1], entraGroupOverage: true }),
    ownerOnly: false,
    adminUsers: [],
  };

  const sidecarEnv = (auth: typeof owner) => {
    const { containers } = buildBrowserAuthTaskParts(auth, 'owner@example.com', secretArns, {
      ...opts,
      initImage: 'r/b:abc',
    });
    const sidecar = containers.find((c) => c.name === 'oauth2-proxy')!;
    return Object.fromEntries((sidecar.environment ?? []).map((e) => [e.name, e.value]));
  };

  it('without ownerOnly', () => {
    const env = sidecarEnv(owner);
    expect(env.OAUTH2_PROXY_PROVIDER).toBe('entra-id');
    expect(env.OAUTH2_PROXY_OIDC_ISSUER_URL).toBe(ISSUER);
    expect(env.OAUTH2_PROXY_ENTRA_ID_ALLOWED_TENANTS).toBe(TENANT);
    expect(env.OAUTH2_PROXY_ALLOWED_GROUPS).toBe(G1);
    expect(env.OAUTH2_PROXY_SCOPE).toBe('openid email profile User.Read');
  });

  it('with ownerOnly, tenants and groups still apply alongside the emails file', () => {
    const env = sidecarEnv({ ...owner, ownerOnly: true });
    expect(env.OAUTH2_PROXY_ENTRA_ID_ALLOWED_TENANTS).toBe(TENANT);
    expect(env.OAUTH2_PROXY_ALLOWED_GROUPS).toBe(G1);
    expect(env).toHaveProperty('OAUTH2_PROXY_AUTHENTICATED_EMAILS_FILE');
    expect(env).not.toHaveProperty('OAUTH2_PROXY_EMAIL_DOMAINS');
  });
});

// Minimal valid config for an entra-id deployment (byo domain: Entra only
// accepts https redirect URIs, and alb-default listens on plain HTTP).
function entraConfig(browser: Record<string, unknown>, domain: Record<string, unknown> = byoDomain) {
  return {
    project: {},
    aws: { accountId: '123456789012' },
    github: { org: 'acme', repo: 'cloud-dev-pods' },
    domain,
    network: {},
    pods: {},
    naming: {},
    auth: { browser: { provider: 'entra-id', ...browser } },
  };
}
const byoDomain = { strategy: 'byo', baseDomain: 'pods.example.com', hostedZoneId: 'Z123' };

describe('entra-id config validation', () => {
  it('accepts a single-tenant issuer with groups and overage', () => {
    const { config } = resolveConfig(
      entraConfig({ issuerUrl: ISSUER, allowedGroups: [G1], entraGroupOverage: true }),
    );
    expect(config.auth.browser.provider).toBe('entra-id');
    expect(config.auth.browser.issuerUrl).toBe(ISSUER);
    expect(config.auth.browser.entraGroupOverage).toBe(true);
  });

  it('entraGroupOverage defaults to false', () => {
    const { config } = resolveConfig(entraConfig({ issuerUrl: ISSUER, allowedTenants: [TENANT] }));
    expect(config.auth.browser.entraGroupOverage).toBe(false);
  });

  it('requires issuerUrl', () => {
    expect(() => resolveConfig(entraConfig({ allowedTenants: [TENANT] }))).toThrow(/issuerUrl/);
  });

  it('rejects an issuer that is not https://login.microsoftonline.com/<tenant-id>/v2.0', () => {
    for (const issuerUrl of [
      'https://accounts.google.com',
      `https://login.microsoftonline.com/${TENANT}`,
      `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0`,
      'https://login.microsoftonline.com/contoso.onmicrosoft.com/v2.0',
      `http://login.microsoftonline.com/${TENANT}/v2.0`,
    ]) {
      expect(() => resolveConfig(entraConfig({ issuerUrl, allowedTenants: [TENANT] })), issuerUrl).toThrow(
        /issuerUrl/,
      );
    }
  });

  for (const segment of ['common', 'organizations']) {
    it(`a /${segment}/ issuer without allowedTenants fails validation`, () => {
      expect(() =>
        resolveConfig(
          entraConfig({ issuerUrl: `https://login.microsoftonline.com/${segment}/v2.0`, allowedGroups: [G1] }),
        ),
      ).toThrow(/allowedTenants/);
    });

    it(`a /${segment}/ issuer with allowedTenants is accepted`, () => {
      const { config } = resolveConfig(
        entraConfig({ issuerUrl: `https://login.microsoftonline.com/${segment}/v2.0`, allowedTenants: [TENANT] }),
      );
      expect(config.auth.browser.allowedTenants).toEqual([TENANT]);
    });
  }

  it('allowedTenants and allowedGroups must be object IDs (GUIDs)', () => {
    expect(() => resolveConfig(entraConfig({ issuerUrl: ISSUER, allowedTenants: ['contoso'] }))).toThrow(
      /allowedTenants/,
    );
    expect(() => resolveConfig(entraConfig({ issuerUrl: ISSUER, allowedGroups: ['Developers'] }))).toThrow(
      /allowedGroups/,
    );
  });

  it('requires domain.strategy byo (Entra refuses http redirect URIs)', () => {
    expect(() =>
      resolveConfig(entraConfig({ issuerUrl: ISSUER, allowedTenants: [TENANT] }, { strategy: 'alb-default' })),
    ).toThrow(/byo/);
  });

  // The builder ignores GitHub allowlists for entra-id; refuse them so a
  // switched config cannot look stricter than it is.
  it('refuses the GitHub-only allowedOrg / allowedUsers keys', () => {
    expect(() =>
      resolveConfig(entraConfig({ issuerUrl: ISSUER, allowedTenants: [TENANT], allowedUsers: ['alice'] })),
    ).toThrow(/allowedUsers/);
    expect(() =>
      resolveConfig(entraConfig({ issuerUrl: ISSUER, allowedTenants: [TENANT], allowedOrg: 'acme' })),
    ).toThrow(/allowedOrg/);
  });

  it('entraGroupOverage is refused for other providers', () => {
    expect(() =>
      resolveConfig({
        ...entraConfig({}),
        auth: { browser: { provider: 'github', allowedOrg: 'acme', entraGroupOverage: true } },
      }),
    ).toThrow(/entraGroupOverage/);
  });
});

describe('the #132 guard with provider entra-id', () => {
  const restrictions = (over: Record<string, unknown> = {}) => ({
    provider: 'entra-id' as const,
    allowedUsers: [],
    allowedGroups: [],
    allowedEmailDomains: [],
    allowedTenants: [],
    ownerOnly: false,
    ...over,
  });

  it('refuses an entra-id pod with no restriction', () => {
    expect(assertBrowserAuthRestricted(restrictions()).ok).toBe(false);
  });

  // The personal Microsoft account tenant admits anyone with a free
  // outlook.com account, so on its own it is no restriction.
  it('does not count the personal Microsoft account tenant as a restriction', () => {
    const r = assertBrowserAuthRestricted(
      restrictions({ allowedTenants: ['9188040d-6c67-4c5b-b112-36a304b66dad'] }),
    );
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.message).toMatch(/personal Microsoft account/);
  });

  // oauth2-proxy admits a token from any listed tenant, so listing the
  // personal account tenant anywhere opens the pod, like "*" in email domains.
  it('does not count allowedTenants that include the personal account tenant', () => {
    expect(
      assertBrowserAuthRestricted(
        restrictions({ allowedTenants: [TENANT, '9188040D-6C67-4C5B-B112-36A304B66DAD'] }),
      ).ok,
    ).toBe(false);
    expect(
      assertBrowserAuthRestricted(
        restrictions({ allowedTenants: [TENANT, '9188040d-6c67-4c5b-b112-36a304b66dad'], allowedGroups: [G1] }),
      ).ok,
    ).toBe(true);
  });

  it('accepts a real tenant on its own', () => {
    expect(assertBrowserAuthRestricted(restrictions({ allowedTenants: [TENANT] })).ok).toBe(true);
  });
});
