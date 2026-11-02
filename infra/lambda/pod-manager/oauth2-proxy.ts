// The single definition of the oauth2-proxy sidecar container (ADR 0002,
// ADR 0008). Pure: no env reads, no SDK calls, so it can be unit-tested and
// imported outside a Lambda. buildBrowserAuthTaskParts in owner-authz.ts is
// the only caller; it layers per-pod owner authorization on top.

import type { ContainerDefinition } from '@aws-sdk/client-ecs';
import { ENTRA_ISSUER_HINT, entraIssuerUrl, parseEntraIssuer } from './entra-id';

// Pinned by the multi-arch image index digest of OAUTH2_PROXY_VERSION. ECS
// documents only `repo:tag` or `repo@digest` for `image`, so the reference is
// digest-only; bump the version and the digest together.
export const OAUTH2_PROXY_VERSION = 'v7.15.5';
export const OAUTH2_PROXY_IMAGE =
  'quay.io/oauth2-proxy/oauth2-proxy@sha256:8498b0d0ef0a7b29686414000a08aee467f02d0299c9ed1e006a8f33fc017916';

export interface Oauth2ProxyAuthConfig {
  provider: 'github' | 'entra-id' | 'oidc';
  // github only.
  allowedOrg?: string;
  allowedUsers: readonly string[];
  // entra-id and oidc.
  issuerUrl?: string;
  allowedGroups?: readonly string[];
  allowedEmailDomains?: readonly string[];
  // entra-id only.
  allowedTenants?: readonly string[];
  entraGroupOverage?: boolean;
  // oidc only. Unset means "use the default"; see providerEnvironment.
  scope?: string;
  groupsClaim?: string;
  insecureAllowUnverifiedEmail?: boolean;
}

export const OIDC_ISSUER_HINT =
  'auth.browser.issuerUrl must be an https:// URL that matches the "issuer" in your IdP\'s ' +
  '/.well-known/openid-configuration exactly, including any trailing slash';

const DEFAULT_OIDC_SCOPE = 'openid email profile';

type EnvVar = { name: string; value: string };

const list = (values: readonly string[] | undefined) =>
  (values ?? []).map((v) => v.trim()).filter(Boolean).join(',');

// Provider-specific sidecar environment, appended after the shared settings.
function providerEnvironment(auth: Oauth2ProxyAuthConfig): EnvVar[] {
  if (auth.provider === 'github') {
    // Auth allowlists: a listed user is admitted without the org check;
    // anyone else must be in the org. If both are empty, oauth2-proxy will
    // accept any GitHub user (which is why podUp refuses a browser pod when
    // neither is configured). The env name follows the cfg tag
    // `github_users`; the singular OAUTH2_PROXY_GITHUB_USER is ignored.
    const allowedUsers = auth.allowedUsers.join(',');
    return [
      { name: 'OAUTH2_PROXY_EMAIL_DOMAINS', value: '*' },
      ...(auth.allowedOrg ? [{ name: 'OAUTH2_PROXY_GITHUB_ORG', value: auth.allowedOrg }] : []),
      ...(allowedUsers ? [{ name: 'OAUTH2_PROXY_GITHUB_USERS', value: allowedUsers }] : []),
    ];
  }
  if (auth.provider === 'entra-id') {
    // The schema enforces these too; re-checked so a bad Lambda env can
    // never produce a sidecar that skips issuer checks with no tenant list.
    const issuer = parseEntraIssuer(auth.issuerUrl);
    if (!issuer) throw new Error(`oauth2-proxy entra-id: ${ENTRA_ISSUER_HINT}; got "${auth.issuerUrl ?? ''}".`);
    // Entra issues lowercase object IDs and oauth2-proxy matches exactly.
    const tenants = list(auth.allowedTenants).toLowerCase();
    if (issuer.multiTenant && !tenants) {
      throw new Error(`oauth2-proxy entra-id: issuer "${issuer.tenant}" spans many tenants; set auth.browser.allowedTenants.`);
    }
    const groups = list(auth.allowedGroups).toLowerCase();
    return [
      { name: 'OAUTH2_PROXY_OIDC_ISSUER_URL', value: entraIssuerUrl(issuer) },
      ...(issuer.multiTenant ? [{ name: 'OAUTH2_PROXY_INSECURE_OIDC_SKIP_ISSUER_VERIFICATION', value: 'true' }] : []),
      ...(tenants ? [{ name: 'OAUTH2_PROXY_ENTRA_ID_ALLOWED_TENANTS', value: tenants }] : []),
      ...(groups ? [{ name: 'OAUTH2_PROXY_ALLOWED_GROUPS', value: groups }] : []),
      // Always explicit: with allowed groups and no scope, oauth2-proxy
      // requests a "groups" scope that Entra does not have. User.Read lets
      // the provider read group memberships from Microsoft Graph when a
      // user is in more than 200 groups (token group overage).
      { name: 'OAUTH2_PROXY_SCOPE', value: auth.entraGroupOverage ? 'openid email profile User.Read' : 'openid email profile' },
      { name: 'OAUTH2_PROXY_EMAIL_DOMAINS', value: list(auth.allowedEmailDomains) || '*' },
    ];
  }
  if (auth.provider === 'oidc') {
    // The schema enforces this too; re-checked so a bad Lambda env can never
    // produce a sidecar with no issuer or a plain-http one. The issuer is
    // passed verbatim: oauth2-proxy compares it to the discovery document's
    // "issuer" character for character.
    if (!auth.issuerUrl?.startsWith('https://')) {
      throw new Error(`oauth2-proxy oidc: ${OIDC_ISSUER_HINT}; got "${auth.issuerUrl ?? ''}".`);
    }
    // OIDC group names are case-sensitive, so no lowercasing (unlike Entra).
    const groups = list(auth.allowedGroups);
    return [
      { name: 'OAUTH2_PROXY_OIDC_ISSUER_URL', value: auth.issuerUrl },
      // Always explicit: with allowed groups and no scope, oauth2-proxy
      // requests a "groups" scope that many IdPs do not have.
      { name: 'OAUTH2_PROXY_SCOPE', value: auth.scope ?? DEFAULT_OIDC_SCOPE },
      { name: 'OAUTH2_PROXY_EMAIL_DOMAINS', value: list(auth.allowedEmailDomains) || '*' },
      ...(groups ? [{ name: 'OAUTH2_PROXY_ALLOWED_GROUPS', value: groups }] : []),
      ...(auth.groupsClaim ? [{ name: 'OAUTH2_PROXY_OIDC_GROUPS_CLAIM', value: auth.groupsClaim }] : []),
      ...((auth.insecureAllowUnverifiedEmail ?? false)
        ? [{ name: 'OAUTH2_PROXY_INSECURE_OIDC_ALLOW_UNVERIFIED_EMAIL', value: 'true' }]
        : []),
    ];
  }
  // Exhaustiveness guard: the provider type admits nothing else.
  throw new Error(`oauth2-proxy: unknown provider "${(auth as { provider: string }).provider}".`);
}

export interface Oauth2ProxySecretArns {
  clientId: string;
  clientSecret: string;
  cookieSecret: string;
}

export interface Oauth2ProxyOptions {
  podName: string;
  listenerProtocol: 'HTTP' | 'HTTPS';
  logGroupName: string;
  region: string;
}

export function buildOauth2ProxyContainer(
  auth: Oauth2ProxyAuthConfig,
  secretArns: Oauth2ProxySecretArns,
  opts: Oauth2ProxyOptions,
): ContainerDefinition {
  const providerEnv = providerEnvironment(auth);
  return {
    name: 'oauth2-proxy',
    image: OAUTH2_PROXY_IMAGE,
    essential: true,
    portMappings: [{ containerPort: 4180, protocol: 'tcp' }],
    logConfiguration: {
      logDriver: 'awslogs',
      options: {
        'awslogs-group': opts.logGroupName,
        'awslogs-region': opts.region,
        'awslogs-stream-prefix': `browser/${opts.podName}/oauth2-proxy`,
      },
    },
    environment: [
      { name: 'OAUTH2_PROXY_PROVIDER', value: auth.provider },
      { name: 'OAUTH2_PROXY_HTTP_ADDRESS', value: '0.0.0.0:4180' },
      { name: 'OAUTH2_PROXY_UPSTREAMS', value: 'http://127.0.0.1:3000' },
      { name: 'OAUTH2_PROXY_REVERSE_PROXY', value: 'true' },
      { name: 'OAUTH2_PROXY_PASS_AUTHORIZATION_HEADER', value: 'true' },
      { name: 'OAUTH2_PROXY_COOKIE_SECURE', value: opts.listenerProtocol === 'HTTPS' ? 'true' : 'false' },
      ...providerEnv,
    ],
    secrets: [
      { name: 'OAUTH2_PROXY_CLIENT_ID', valueFrom: secretArns.clientId },
      { name: 'OAUTH2_PROXY_CLIENT_SECRET', valueFrom: secretArns.clientSecret },
      { name: 'OAUTH2_PROXY_COOKIE_SECRET', valueFrom: secretArns.cookieSecret },
    ],
    dependsOn: [{ containerName: 'vscode', condition: 'HEALTHY' }],
  };
}
