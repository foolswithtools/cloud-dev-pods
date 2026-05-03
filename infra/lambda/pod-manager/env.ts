// Lambda env vars wired by PodManagerStack. Read once at module load.

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Required env var ${name} is unset`);
  return v;
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
  oauthAllowedOrg: process.env.OAUTH_ALLOWED_ORG ?? '',
  oauthAllowedUsers: process.env.OAUTH_ALLOWED_USERS ?? '',
};
