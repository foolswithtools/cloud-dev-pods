import { z } from 'zod';
import { ENTRA_GUID, ENTRA_ISSUER_HINT, parseEntraIssuer } from '../../lambda/pod-manager/entra-id';

// Providers the schema knows about vs. the ones wired at runtime today. The
// rest arrive with later slices of the pluggable-identity epic.
const EPIC_POINTER =
  'foolswithtools/cloud-dev-pods#129 (docs/specs/pluggable-identity-remote-access.md)';

const stringList = z.array(z.string()).default([]);

export const AuthBrowserSchema = z
  .object({
    provider: z.enum(['github', 'entra-id', 'oidc']).default('github'),
    issuerUrl: z.url().optional(),
    allowedOrg: z.string().optional(),
    allowedUsers: stringList,
    allowedGroups: stringList,
    allowedEmailDomains: stringList,
    allowedTenants: stringList,
    // Per-pod owner authorization (spec F4). Opt-in; enforced by the
    // pod-manager (infra/lambda/pod-manager/owner-authz.ts).
    ownerOnly: z.boolean().default(false),
    adminUsers: stringList,
    // entra-id only: request User.Read so oauth2-proxy can read group
    // memberships from Microsoft Graph for users in more than 200 groups.
    entraGroupOverage: z.boolean().default(false),
  })
  .superRefine((b, ctx) => {
    if (b.provider === 'oidc') {
      ctx.addIssue({
        code: 'custom',
        path: ['provider'],
        message: `auth.browser.provider "${b.provider}" is not supported yet; only "github" and "entra-id" are wired at runtime. Other providers land with the pluggable identity epic, ${EPIC_POINTER}.`,
      });
    }
    if (b.provider !== 'entra-id') {
      if (b.entraGroupOverage) {
        ctx.addIssue({
          code: 'custom',
          path: ['entraGroupOverage'],
          message: 'auth.browser.entraGroupOverage only applies to provider "entra-id".',
        });
      }
      return;
    }
    refineEntraId(b, ctx);
  });

// Rules for provider entra-id (spec A2, docs/setup-entra.md).
function refineEntraId(
  b: { issuerUrl?: string; allowedTenants: string[]; allowedGroups: string[] },
  ctx: z.RefinementCtx,
): void {
  const issuer = parseEntraIssuer(b.issuerUrl);
  if (!issuer) {
    ctx.addIssue({
      code: 'custom',
      path: ['issuerUrl'],
      message: `${ENTRA_ISSUER_HINT}; got ${b.issuerUrl === undefined ? 'nothing' : `"${b.issuerUrl}"`}.`,
    });
  } else if (issuer.multiTenant && b.allowedTenants.length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['allowedTenants'],
      message: `auth.browser.issuerUrl uses "/${issuer.tenant}/", which accepts accounts from any Microsoft tenant; list the tenant IDs to admit in auth.browser.allowedTenants.`,
    });
  }
  for (const key of ['allowedTenants', 'allowedGroups'] as const) {
    const bad = b[key].find((v) => !ENTRA_GUID.test(v.trim()));
    if (bad !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: [key],
        message: `auth.browser.${key} entries must be Entra object IDs (GUIDs); got "${bad}".`,
      });
    }
  }
}

// Account type the tunnel CLI logs in with (`code tunnel user login --provider`).
export const AuthTunnelSchema = z.object({
  provider: z.enum(['github', 'microsoft']).default('github'),
});

export type AuthBrowser = z.infer<typeof AuthBrowserSchema>;
export type AuthTunnel = z.infer<typeof AuthTunnelSchema>;

export const ConfigSchema = z.object({
  project: z.object({
    name: z.string().default('cloud-dev-pods'),
    env: z.enum(['dev', 'prod']).default('dev'),
  }),
  aws: z.object({
    accountId: z.string().regex(/^\d{12}$/),
    region: z.string().default('us-west-2'),
  }),
  github: z.object({
    org: z.string(),
    repo: z.string(),
    // DEPRECATED: use auth.browser.allowedOrg / auth.browser.allowedUsers.
    // Still honored when auth.browser is absent (see resolveConfig + ADR 0008).
    oauthAllowedOrg: z.string().optional(),
    oauthAllowedUsers: z.string().optional(),  // comma-separated GitHub logins
  }),
  // Provider-neutral identity config (ADR 0008). Optional; resolveConfig
  // fills defaults and maps the deprecated github.oauthAllowed* keys.
  // nullish: a bare `auth:` / `browser:` key in YAML parses as null.
  auth: z
    .object({
      browser: AuthBrowserSchema.nullish(),
      tunnel: AuthTunnelSchema.nullish(),
    })
    .nullish(),
  domain: z.object({
    strategy: z.enum(['byo', 'alb-default']).default('alb-default'),
    baseDomain: z.string().optional(),
    hostedZoneId: z.string().optional(),
  }),
  network: z.object({
    vpcCidr: z.string().default('10.0.0.0/16'),
    natGateways: z.union([z.literal(1), z.literal(2)]).default(1),
    useVpcEndpoints: z.boolean().default(false),
  }),
  pods: z.object({
    defaultCpu: z.number().int().default(1024),
    defaultMemory: z.number().int().default(2048),
    spotPercentage: z.number().int().min(0).max(100).default(100),
    idleMinutes: z.number().int().default(60),
  }),
  naming: z.object({
    prefix: z.string().default('CloudDevPods'),
  }),
  efs: z
    .object({
      // When true, ClusterStack keeps RemovalPolicy.RETAIN on the EFS
      // filesystem so `cluster-down` leaves it (and any /workspace data)
      // behind. Default `false` flips the policy to DESTROY so the
      // filesystem disappears with the cluster — see ADR 0007.
      retainOnClusterDown: z.boolean().optional().default(false),
    })
    .optional(),
});

export type RawConfig = z.infer<typeof ConfigSchema>;

/** Validated config with the `auth` block fully resolved. */
export type Config = Omit<RawConfig, 'auth'> & {
  auth: { browser: AuthBrowser; tunnel: AuthTunnel };
};

/**
 * Validate a parsed config document and resolve `auth`.
 *
 * When `auth.browser` is absent, the deprecated `github.oauthAllowedOrg` /
 * `github.oauthAllowedUsers` keys are mapped into `auth.browser.allowedOrg` /
 * `allowedUsers`. When both are present, `auth.browser` wins. Either way a
 * single deprecation warning is returned for the caller to print.
 */
export function resolveConfig(input: unknown): { config: Config; warnings: string[] } {
  const raw = ConfigSchema.parse(input);
  // Entra accepts only https redirect URIs (localhost aside), and the
  // alb-default strategy serves pods over plain HTTP.
  if (raw.auth?.browser?.provider === 'entra-id' && raw.domain.strategy !== 'byo') {
    throw new Error(
      'auth.browser.provider "entra-id" requires domain.strategy "byo": Entra ID only accepts https redirect URIs, and "alb-default" serves pods over HTTP. See docs/setup-entra.md.',
    );
  }
  const { oauthAllowedOrg, oauthAllowedUsers } = raw.github;
  const legacyKeys = [
    ...(oauthAllowedOrg !== undefined ? ['github.oauthAllowedOrg'] : []),
    ...(oauthAllowedUsers !== undefined ? ['github.oauthAllowedUsers'] : []),
  ];
  const warnings: string[] = [];

  let browser = raw.auth?.browser;
  if (browser) {
    if (legacyKeys.length > 0) {
      warnings.push(
        `${legacyKeys.join(' and ')} ${legacyKeys.length > 1 ? 'are' : 'is'} deprecated and ignored because auth.browser is set; auth.browser wins. Remove the github.oauthAllowed* keys. See docs/adr/0008-pluggable-browser-idp.md.`,
      );
    }
  } else {
    browser = AuthBrowserSchema.parse({
      allowedOrg: oauthAllowedOrg,
      allowedUsers: splitCsv(oauthAllowedUsers),
    });
    if (legacyKeys.length > 0) {
      warnings.push(
        `${legacyKeys.join(' and ')} ${legacyKeys.length > 1 ? 'are' : 'is'} deprecated; move to auth.browser.allowedOrg / auth.browser.allowedUsers. See docs/adr/0008-pluggable-browser-idp.md.`,
      );
    }
  }

  const tunnel = raw.auth?.tunnel ?? AuthTunnelSchema.parse({});
  return { config: { ...raw, auth: { browser, tunnel } }, warnings };
}

function splitCsv(value: string | undefined): string[] {
  return (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}
