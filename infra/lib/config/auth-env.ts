import type { Config } from './schema';

/**
 * Lambda environment variables carrying the resolved `auth` block to the
 * pod-manager (parsed by `infra/lambda/pod-manager/env.ts`). List values are
 * JSON-encoded arrays. Optional keys with no schema default are passed as ''
 * when unset, so the pod-manager can tell "unset" from an explicit value.
 */
export function authLambdaEnvironment(config: Config): Record<string, string> {
  const { browser, tunnel } = config.auth;
  return {
    AUTH_BROWSER_PROVIDER: browser.provider,
    AUTH_BROWSER_ISSUER_URL: browser.issuerUrl ?? '',
    AUTH_BROWSER_ALLOWED_ORG: browser.allowedOrg ?? '',
    AUTH_BROWSER_ALLOWED_USERS: JSON.stringify(browser.allowedUsers),
    AUTH_BROWSER_ALLOWED_GROUPS: JSON.stringify(browser.allowedGroups),
    AUTH_BROWSER_ALLOWED_EMAIL_DOMAINS: JSON.stringify(browser.allowedEmailDomains),
    AUTH_BROWSER_ALLOWED_TENANTS: JSON.stringify(browser.allowedTenants),
    AUTH_BROWSER_OWNER_ONLY: String(browser.ownerOnly),
    AUTH_BROWSER_ADMIN_USERS: JSON.stringify(browser.adminUsers),
    AUTH_BROWSER_ENTRA_GROUP_OVERAGE: String(browser.entraGroupOverage),
    // oidc only; '' when unset (env.ts parses it back to undefined).
    AUTH_BROWSER_SCOPE: browser.scope ?? '',
    AUTH_BROWSER_GROUPS_CLAIM: browser.groupsClaim ?? '',
    AUTH_BROWSER_INSECURE_ALLOW_UNVERIFIED_EMAIL:
      browser.insecureAllowUnverifiedEmail === undefined ? '' : String(browser.insecureAllowUnverifiedEmail),
    AUTH_TUNNEL_PROVIDER: tunnel.provider,
  };
}
