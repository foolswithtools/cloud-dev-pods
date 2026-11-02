import { describe, expect, it } from 'vitest';
import {
  buildOauth2ProxyContainer,
  type Oauth2ProxyAuthConfig,
  type Oauth2ProxyOptions,
  type Oauth2ProxySecretArns,
} from '../lambda/pod-manager/oauth2-proxy';
import { buildBrowserAuthTaskParts } from '../lambda/pod-manager/owner-authz';

const ISSUER = 'https://acme.okta.com';

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

const oidc = (over: Partial<Oauth2ProxyAuthConfig> = {}): Oauth2ProxyAuthConfig => ({
  provider: 'oidc',
  issuerUrl: ISSUER,
  allowedUsers: [],
  allowedGroups: [],
  allowedEmailDomains: [],
  ...over,
});

const envOf = (auth: Oauth2ProxyAuthConfig) =>
  Object.fromEntries(
    (buildOauth2ProxyContainer(auth, secretArns, opts).environment ?? []).map((e) => [e.name, e.value]),
  );

describe('buildOauth2ProxyContainer (oidc provider)', () => {
  it('emits provider oidc, the issuer, the default scope, and EMAIL_DOMAINS=*', () => {
    const env = envOf(oidc());
    expect(env.OAUTH2_PROXY_PROVIDER).toBe('oidc');
    expect(env.OAUTH2_PROXY_OIDC_ISSUER_URL).toBe(ISSUER);
    expect(env.OAUTH2_PROXY_SCOPE).toBe('openid email profile');
    expect(env.OAUTH2_PROXY_EMAIL_DOMAINS).toBe('*');
  });

  it('allowedEmailDomains [acme.com] emits OAUTH2_PROXY_EMAIL_DOMAINS=acme.com', () => {
    expect(envOf(oidc({ allowedEmailDomains: ['acme.com'] })).OAUTH2_PROXY_EMAIL_DOMAINS).toBe('acme.com');
  });

  // OIDC group names are case-sensitive, unlike Entra object IDs.
  it('allowedGroups [Dev-Team] emits OAUTH2_PROXY_ALLOWED_GROUPS=Dev-Team, case preserved', () => {
    expect(envOf(oidc({ allowedGroups: ['Dev-Team'] })).OAUTH2_PROXY_ALLOWED_GROUPS).toBe('Dev-Team');
  });

  it('emits no ALLOWED_GROUPS when allowedGroups is empty', () => {
    expect(envOf(oidc())).not.toHaveProperty('OAUTH2_PROXY_ALLOWED_GROUPS');
  });

  it('groupsClaim emits OAUTH2_PROXY_OIDC_GROUPS_CLAIM; unset emits nothing', () => {
    expect(envOf(oidc({ groupsClaim: 'roles' })).OAUTH2_PROXY_OIDC_GROUPS_CLAIM).toBe('roles');
    expect(envOf(oidc())).not.toHaveProperty('OAUTH2_PROXY_OIDC_GROUPS_CLAIM');
  });

  it('a custom scope replaces the default', () => {
    expect(envOf(oidc({ scope: 'openid email profile groups' })).OAUTH2_PROXY_SCOPE).toBe(
      'openid email profile groups',
    );
  });

  // Unset keeps an explicit scope: with allowed groups and no scope,
  // oauth2-proxy would request a "groups" scope many IdPs do not have.
  it('allowed groups with no scope still emit the default scope', () => {
    expect(envOf(oidc({ allowedGroups: ['Dev-Team'] })).OAUTH2_PROXY_SCOPE).toBe('openid email profile');
  });

  it('insecureAllowUnverifiedEmail true emits the opt-in; unset or false emits nothing', () => {
    expect(
      envOf(oidc({ insecureAllowUnverifiedEmail: true })).OAUTH2_PROXY_INSECURE_OIDC_ALLOW_UNVERIFIED_EMAIL,
    ).toBe('true');
    expect(envOf(oidc())).not.toHaveProperty('OAUTH2_PROXY_INSECURE_OIDC_ALLOW_UNVERIFIED_EMAIL');
    expect(envOf(oidc({ insecureAllowUnverifiedEmail: false }))).not.toHaveProperty(
      'OAUTH2_PROXY_INSECURE_OIDC_ALLOW_UNVERIFIED_EMAIL',
    );
  });

  // oauth2-proxy requires the discovery document's issuer to match the
  // configured URL exactly. Auth0's ends in "/", Okta's does not.
  it('keeps the issuer verbatim, trailing slash or not', () => {
    expect(envOf(oidc({ issuerUrl: 'https://acme.us.auth0.com/' })).OAUTH2_PROXY_OIDC_ISSUER_URL).toBe(
      'https://acme.us.auth0.com/',
    );
    expect(envOf(oidc({ issuerUrl: 'https://acme.us.auth0.com' })).OAUTH2_PROXY_OIDC_ISSUER_URL).toBe(
      'https://acme.us.auth0.com',
    );
  });

  it('throws when the issuer is missing, empty, or not https://', () => {
    expect(() => envOf(oidc({ issuerUrl: undefined }))).toThrow(/issuerUrl/);
    expect(() => envOf(oidc({ issuerUrl: '' }))).toThrow(/issuerUrl/);
    expect(() => envOf(oidc({ issuerUrl: 'http://acme.okta.com' }))).toThrow(/https/);
  });

  it('never emits entra-id-only settings', () => {
    const env = envOf(oidc({ allowedTenants: ['t1'] }));
    expect(env).not.toHaveProperty('OAUTH2_PROXY_ENTRA_ID_ALLOWED_TENANTS');
    expect(env).not.toHaveProperty('OAUTH2_PROXY_INSECURE_OIDC_SKIP_ISSUER_VERIFICATION');
  });
});

describe('buildBrowserAuthTaskParts with provider oidc', () => {
  const sidecarOf = (ownerOnly: boolean) => {
    const { containers } = buildBrowserAuthTaskParts(
      { ...oidc({ allowedEmailDomains: ['acme.com'], allowedGroups: ['Dev-Team'] }), ownerOnly, adminUsers: ['ops@acme.com'] },
      'alice@acme.com',
      secretArns,
      { ...opts, initImage: 'r/b:abc' },
    );
    return containers.find((c) => c.name === 'oauth2-proxy')!;
  };

  it('without ownerOnly, builds the oidc sidecar', () => {
    const env = Object.fromEntries((sidecarOf(false).environment ?? []).map((e) => [e.name, e.value]));
    expect(env.OAUTH2_PROXY_PROVIDER).toBe('oidc');
    expect(env.OAUTH2_PROXY_OIDC_ISSUER_URL).toBe(ISSUER);
    expect(env.OAUTH2_PROXY_EMAIL_DOMAINS).toBe('acme.com');
  });

  it('with ownerOnly, mounts the emails file and drops EMAIL_DOMAINS', () => {
    const sidecar = sidecarOf(true);
    const env = Object.fromEntries((sidecar.environment ?? []).map((e) => [e.name, e.value]));
    expect(env.OAUTH2_PROXY_PROVIDER).toBe('oidc');
    expect(env).toHaveProperty('OAUTH2_PROXY_AUTHENTICATED_EMAILS_FILE');
    expect(env).not.toHaveProperty('OAUTH2_PROXY_EMAIL_DOMAINS');
    expect(env.OAUTH2_PROXY_ALLOWED_GROUPS).toBe('Dev-Team');
    expect(sidecar.mountPoints?.length ?? 0).toBeGreaterThan(0);
  });
});
