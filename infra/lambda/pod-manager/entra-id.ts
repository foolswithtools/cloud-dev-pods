// Microsoft Entra ID issuer and identifier rules (spec A2). Pure and
// dependency-free: the config schema (infra/lib/config/schema.ts) validates
// with these at synth time, and the oauth2-proxy sidecar builder re-checks
// them before a task definition is registered.

// Entra tenant and group object IDs.
export const ENTRA_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Tenant of personal Microsoft accounts (outlook.com, hotmail.com, ...).
// Anyone can create one, so on its own it restricts nothing.
export const ENTRA_PERSONAL_ACCOUNTS_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';

// Issuer segments that span many tenants. Their discovery documents report a
// tenant-specific issuer, so oauth2-proxy must skip its generic issuer check;
// its entra-id provider still checks the token issuer's shape and the
// allowed tenants list.
const MULTI_TENANT_SEGMENTS = ['common', 'organizations', 'consumers'] as const;

const ISSUER = /^https:\/\/login\.microsoftonline\.com\/([^/]+)\/v2\.0\/?$/;

export type EntraIssuer = { tenant: string; multiTenant: boolean };

export const ENTRA_ISSUER_HINT =
  'auth.browser.issuerUrl must be https://login.microsoftonline.com/<tenant-id>/v2.0 (tenant ID as a GUID), ' +
  'or use common, organizations, or consumers in place of the tenant ID together with auth.browser.allowedTenants';

/**
 * Parse an Entra v2.0 issuer URL, or return undefined if it is not one.
 * `tenant` is lowercased: Entra publishes lowercase GUIDs, and oauth2-proxy
 * compares issuers exactly.
 */
export function parseEntraIssuer(url: string | undefined): EntraIssuer | undefined {
  const tenant = ISSUER.exec(url?.trim() ?? '')?.[1]?.toLowerCase();
  if (!tenant) return undefined;
  if ((MULTI_TENANT_SEGMENTS as readonly string[]).includes(tenant)) return { tenant, multiTenant: true };
  return ENTRA_GUID.test(tenant) ? { tenant, multiTenant: false } : undefined;
}

/** The issuer exactly as Entra publishes it (no trailing slash). */
export function entraIssuerUrl(issuer: EntraIssuer): string {
  return `https://login.microsoftonline.com/${issuer.tenant}/v2.0`;
}
