import { z } from 'zod';

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
    // oauth2-proxy auth allowlists. Set at least one. If both empty,
    // oauth2-proxy will accept any authenticated GitHub user (insecure).
    oauthAllowedOrg: z.string().optional(),
    oauthAllowedUsers: z.string().optional(),  // comma-separated GitHub logins
  }),
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

export type Config = z.infer<typeof ConfigSchema>;
