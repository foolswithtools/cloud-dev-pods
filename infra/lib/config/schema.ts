import { z } from 'zod';

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
    // Per-pod owner authorization (spec F4). Opt-in; not enforced yet.
    ownerOnly: z.boolean().default(false),
    adminUsers: stringList,
  })
  .superRefine((b, ctx) => {
    if (b.provider !== 'github') {
      ctx.addIssue({
        code: 'custom',
        path: ['provider'],
        message: `auth.browser.provider "${b.provider}" is not supported yet; only "github" is wired at runtime. Other providers land with the pluggable identity epic, ${EPIC_POINTER}.`,
      });
    }
  });

export const AuthTunnelSchema = z
  .object({
    provider: z.enum(['github', 'microsoft']).default('github'),
  })
  .superRefine((t, ctx) => {
    if (t.provider !== 'github') {
      ctx.addIssue({
        code: 'custom',
        path: ['provider'],
        message: `auth.tunnel.provider "${t.provider}" is not supported yet; only "github" is wired at runtime. Microsoft tunnel login lands with the pluggable identity epic, ${EPIC_POINTER}.`,
      });
    }
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
  auth: z
    .object({
      browser: AuthBrowserSchema.optional(),
      tunnel: AuthTunnelSchema.optional(),
    })
    .optional(),
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
