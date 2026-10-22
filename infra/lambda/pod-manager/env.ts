// Lambda env vars wired by PodManagerStack. Read once at module load.

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Required env var ${name} is unset`);
  return v;
}

// List-valued AUTH_* vars are JSON arrays (see infra/lib/config/auth-env.ts).
function jsonList(name: string): string[] {
  const v = process.env[name];
  if (!v) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(v);
  } catch {
    throw new Error(`Env var ${name} must be a JSON array of strings`);
  }
  if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === 'string')) {
    throw new Error(`Env var ${name} must be a JSON array of strings`);
  }
  return parsed;
}

function oneOf<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const v = process.env[name] || fallback;
  if (!(allowed as readonly string[]).includes(v)) {
    throw new Error(`Env var ${name} must be one of ${allowed.join(', ')}; got "${v}"`);
  }
  return v as T;
}

export const env = {
  region: process.env.AWS_REGION ?? 'us-west-2',
  accountId: req('AWS_ACCOUNT_ID'),
  registryTableName: req('REGISTRY_TABLE_NAME'),
  clusterName: req('CLUSTER_NAME'),
  efsFsId: req('EFS_FILESYSTEM_ID'),
  albListenerArn: req('ALB_LISTENER_ARN'),
  albListenerProtocol: req('ALB_LISTENER_PROTOCOL') as 'HTTP' | 'HTTPS',
  albDnsName: req('ALB_DNS_NAME'),
  browserTaskDefFamily: req('BROWSER_TASK_DEF_FAMILY'),
  tunnelTaskDefFamily: req('TUNNEL_TASK_DEF_FAMILY'),
  browserTaskRoleArn: req('BROWSER_TASK_ROLE_ARN'),
  tunnelTaskRoleArn: req('TUNNEL_TASK_ROLE_ARN'),
  executionRoleArn: req('EXECUTION_ROLE_ARN'),
  podsLogGroupName: req('PODS_LOG_GROUP_NAME'),
  vpcId: req('VPC_ID'),
  privateSubnetIds: req('PRIVATE_SUBNET_IDS').split(',').filter(Boolean),
  tasksSecurityGroupId: req('TASKS_SECURITY_GROUP_ID'),
  baseDomain: process.env.BASE_DOMAIN ?? '',
  domainStrategy: (process.env.DOMAIN_STRATEGY ?? 'alb-default') as 'byo' | 'alb-default',
  browserRepoUri: req('BROWSER_REPO_URI'),
  tunnelRepoUri: req('TUNNEL_REPO_URI'),
  browserRepoName: req('BROWSER_REPO_NAME'),
  tunnelRepoName: req('TUNNEL_REPO_NAME'),
  // Resolved provider-neutral auth config (ADR 0008). Only provider "github"
  // is wired at runtime so far. Both the oauth2-proxy sidecar builder and the
  // browser auth guard (auth-guard.ts) read this.
  auth: {
    browser: {
      provider: oneOf('AUTH_BROWSER_PROVIDER', ['github', 'entra-id', 'oidc'], 'github'),
      issuerUrl: process.env.AUTH_BROWSER_ISSUER_URL ?? '',
      allowedOrg: process.env.AUTH_BROWSER_ALLOWED_ORG ?? '',
      allowedUsers: jsonList('AUTH_BROWSER_ALLOWED_USERS'),
      allowedGroups: jsonList('AUTH_BROWSER_ALLOWED_GROUPS'),
      allowedEmailDomains: jsonList('AUTH_BROWSER_ALLOWED_EMAIL_DOMAINS'),
      allowedTenants: jsonList('AUTH_BROWSER_ALLOWED_TENANTS'),
      ownerOnly: process.env.AUTH_BROWSER_OWNER_ONLY === 'true',
      adminUsers: jsonList('AUTH_BROWSER_ADMIN_USERS'),
    },
    tunnel: {
      provider: oneOf('AUTH_TUNNEL_PROVIDER', ['github', 'microsoft'], 'github'),
    },
  },
};
