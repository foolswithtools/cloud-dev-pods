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

// Central auth host (#144, ADR 0009). These settings must be identical on
// the central host and on every pod sidecar: the sidecar sets the CSRF cookie
// when it starts a login and the central host reads it at the callback.
export interface CentralAuthHostOptions {
  baseDomain: string;
  // Pod sidecars only: the directory holding the sign_in.html that sends an
  // absolute rd (sign-in-template.ts). The central host never starts a login.
  customTemplatesDir?: string;
}

// The pod name handler.ts reserves for it, and the cookie name both sides
// use. Not the default _oauth2_proxy: browsers still hold host-only
// _oauth2_proxy cookies from per-pod sign-in, and oauth2-proxy would read
// one, fail to decode it and loop (ADR 0009 scope change 4).
export const CENTRAL_AUTH_HOST_LABEL = 'auth';
export const CENTRAL_AUTH_COOKIE_NAME = '_cdp_central';

const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

export function centralAuthHostName(baseDomain: string): string {
  return `${CENTRAL_AUTH_HOST_LABEL}.${baseDomain}`;
}

function centralAuthEnvironment(central: CentralAuthHostOptions): EnvVar[] {
  // A malformed domain would widen the cookie domain or the redirect
  // whitelist, so refuse it rather than emit it.
  if (!HOSTNAME.test(central.baseDomain)) {
    throw new Error(`oauth2-proxy central auth host: baseDomain must be a hostname such as pods.example.com; got "${central.baseDomain}".`);
  }
  const parent = `.${central.baseDomain}`;
  return [
    { name: 'OAUTH2_PROXY_REDIRECT_URL', value: `https://${centralAuthHostName(central.baseDomain)}/oauth2/callback` },
    { name: 'OAUTH2_PROXY_COOKIE_NAME', value: CENTRAL_AUTH_COOKIE_NAME },
    { name: 'OAUTH2_PROXY_COOKIE_DOMAINS', value: parent },
    { name: 'OAUTH2_PROXY_COOKIE_CSRF_PER_REQUEST', value: 'true' },
    // Load-bearing on the sidecar too: it is the first check on the rd the
    // sign-in template sends (#256 Q4).
    { name: 'OAUTH2_PROXY_WHITELIST_DOMAINS', value: parent },
    ...(central.customTemplatesDir
      ? [{ name: 'OAUTH2_PROXY_CUSTOM_TEMPLATES_DIR', value: central.customTemplatesDir }]
      : []),
  ];
}

export interface Oauth2ProxyOptions {
  podName: string;
  listenerProtocol: 'HTTP' | 'HTTPS';
  logGroupName: string;
  region: string;
  // Set on pod sidecars when auth.browser.centralAuthHost is on.
  centralAuthHost?: CentralAuthHostOptions;
}

export function buildOauth2ProxyContainer(
  auth: Oauth2ProxyAuthConfig,
  secretArns: Oauth2ProxySecretArns,
  opts: Oauth2ProxyOptions,
): ContainerDefinition {
  const providerEnv = providerEnvironment(auth);
  const centralEnv = opts.centralAuthHost ? centralAuthEnvironment(opts.centralAuthHost) : [];
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
      ...centralEnv,
    ],
    secrets: [
      { name: 'OAUTH2_PROXY_CLIENT_ID', valueFrom: secretArns.clientId },
      { name: 'OAUTH2_PROXY_CLIENT_SECRET', valueFrom: secretArns.clientSecret },
      { name: 'OAUTH2_PROXY_COOKIE_SECRET', valueFrom: secretArns.cookieSecret },
    ],
    dependsOn: [{ containerName: 'vscode', condition: 'HEALTHY' }],
  };
}

export interface CentralAuthHostContainerOptions {
  baseDomain: string;
  logGroupName: string;
  region: string;
}

/**
 * The oauth2-proxy container of the central auth host (#144, ADR 0009 item
 * 4): the pod sidecar built with ownerOnly off, so it enforces the
 * deployment-wide allowlist, plus the shared central-host settings. It
 * proxies to nothing (static 202), waits for no vscode container and logs
 * without a pod name. Always HTTPS: centralAuthHost requires strategy byo.
 */
export function buildCentralAuthHostContainer(
  auth: Oauth2ProxyAuthConfig,
  secretArns: Oauth2ProxySecretArns,
  opts: CentralAuthHostContainerOptions,
): ContainerDefinition {
  const { dependsOn: _dependsOn, ...base } = buildOauth2ProxyContainer(auth, secretArns, {
    podName: CENTRAL_AUTH_HOST_LABEL,
    listenerProtocol: 'HTTPS',
    logGroupName: opts.logGroupName,
    region: opts.region,
    centralAuthHost: { baseDomain: opts.baseDomain },
  });
  return {
    ...base,
    logConfiguration: {
      logDriver: 'awslogs',
      options: {
        'awslogs-group': opts.logGroupName,
        'awslogs-region': opts.region,
        'awslogs-stream-prefix': 'central-auth-host/oauth2-proxy',
      },
    },
    environment: (base.environment ?? []).map((e) =>
      e.name === 'OAUTH2_PROXY_UPSTREAMS' ? { ...e, value: 'static://202' } : e,
    ),
  };
}
