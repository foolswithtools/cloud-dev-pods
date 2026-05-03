// AWS SDK v3 helpers used by the action handlers. All clients are singletons
// initialized once per Lambda warm container.

import {
  DescribeImagesCommand,
  ECRClient,
} from '@aws-sdk/client-ecr';
import {
  DescribeTasksCommand,
  ECSClient,
  RegisterTaskDefinitionCommand,
  RunTaskCommand,
  StopTaskCommand,
} from '@aws-sdk/client-ecs';
import {
  CreateAccessPointCommand,
  DeleteAccessPointCommand,
  EFSClient,
} from '@aws-sdk/client-efs';
import {
  CreateRuleCommand,
  CreateTargetGroupCommand,
  DeleteRuleCommand,
  DeleteTargetGroupCommand,
  DeregisterTargetsCommand,
  ElasticLoadBalancingV2Client,
  RegisterTargetsCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';

import { env } from './env';
import { priorityForPod } from './priority';

const ecs = new ECSClient({ region: env.region });
const ecr = new ECRClient({ region: env.region });
const efs = new EFSClient({ region: env.region });
const elbv2 = new ElasticLoadBalancingV2Client({ region: env.region });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: env.region }));

// ---- Registry (DynamoDB) ----

export interface PodRecord {
  podName: string;
  mode: 'browser' | 'tunnel';
  taskArn?: string;
  taskDefArn: string;
  accessPointId: string;
  posixUid: number;
  targetGroupArn?: string;
  ruleArn?: string;
  owner: string;
  createdAt: string;
  lastActivityAt: string;
  idleMinutes: number;
  url?: string;
  imageTag: string;
}

export async function registryGet(podName: string): Promise<PodRecord | undefined> {
  const r = await ddb.send(new GetCommand({
    TableName: env.registryTableName,
    Key: { podName },
  }));
  return r.Item as PodRecord | undefined;
}

export async function registryPut(record: PodRecord): Promise<void> {
  await ddb.send(new PutCommand({
    TableName: env.registryTableName,
    Item: record,
    ConditionExpression: 'attribute_not_exists(podName)',
  }));
}

export async function registryDelete(podName: string): Promise<void> {
  await ddb.send(new DeleteCommand({
    TableName: env.registryTableName,
    Key: { podName },
  }));
}

export async function registryScan(): Promise<PodRecord[]> {
  const out: PodRecord[] = [];
  let lek: Record<string, unknown> | undefined;
  do {
    const r = await ddb.send(new ScanCommand({
      TableName: env.registryTableName,
      ExclusiveStartKey: lek,
    }));
    out.push(...((r.Items ?? []) as PodRecord[]));
    lek = r.LastEvaluatedKey;
  } while (lek);
  return out;
}

// ---- POSIX UID allocation ----

export async function allocatePosixUid(): Promise<number> {
  const records = await registryScan();
  const used = new Set(records.map((r) => r.posixUid));
  for (let uid = 10_000; uid < 65_000; uid++) {
    if (!used.has(uid)) return uid;
  }
  throw new Error('No free POSIX UID in [10000, 65000)');
}

// ---- ECR ----

export async function resolveLatestImageTag(repoName: string): Promise<string | undefined> {
  const r = await ecr.send(new DescribeImagesCommand({
    repositoryName: repoName,
    maxResults: 1000,
  }));
  const images = (r.imageDetails ?? []).filter((i) => i.imagePushedAt && (i.imageTags?.length ?? 0) > 0);
  images.sort((a, b) => (b.imagePushedAt!.getTime() - a.imagePushedAt!.getTime()));
  const newest = images[0];
  return newest?.imageTags?.[0];
}

// ---- EFS ----

export async function createAccessPoint(podName: string, uid: number): Promise<string> {
  const r = await efs.send(new CreateAccessPointCommand({
    FileSystemId: env.efsFsId,
    PosixUser: { Uid: uid, Gid: uid },
    RootDirectory: {
      Path: `/pods/${podName}`,
      CreationInfo: { OwnerUid: uid, OwnerGid: uid, Permissions: '0700' },
    },
    Tags: [
      { Key: 'Project', Value: 'cloud-dev-pods' },
      { Key: 'Pod', Value: podName },
    ],
  }));
  if (!r.AccessPointId) throw new Error('CreateAccessPoint returned no id');
  return r.AccessPointId;
}

export async function deleteAccessPoint(apId: string): Promise<void> {
  await efs.send(new DeleteAccessPointCommand({ AccessPointId: apId }));
}

// ---- ECS ----

export interface TaskDefArgs {
  family: string;
  imageUri: string;
  accessPointId: string;
  podName: string;
  cpu: string;
  memory: string;
  mode: 'browser' | 'tunnel';
}

export async function registerTaskDef(args: TaskDefArgs): Promise<string> {
  const taskRoleArn = args.mode === 'browser' ? env.browserTaskRoleArn : env.tunnelTaskRoleArn;

  const containerDefs: Record<string, unknown>[] = [];
  const logConfig = (streamPrefix: string) => ({
    logDriver: 'awslogs',
    options: {
      'awslogs-group': env.podsLogGroupName,
      'awslogs-region': env.region,
      'awslogs-stream-prefix': streamPrefix,
    },
  });

  if (args.mode === 'browser') {
    containerDefs.push({
      name: 'vscode',
      image: args.imageUri,
      essential: true,
      portMappings: [{ containerPort: 3000, protocol: 'tcp' }],
      mountPoints: [{ sourceVolume: 'workspace', containerPath: '/workspace', readOnly: false }],
      logConfiguration: logConfig(`browser/${args.podName}/vscode`),
      healthCheck: {
        command: ['CMD-SHELL', 'curl -fsS http://127.0.0.1:3000/ >/dev/null || exit 1'],
        interval: 30, timeout: 5, retries: 3, startPeriod: 20,
      },
    });
    containerDefs.push({
      name: 'oauth2-proxy',
      image: 'quay.io/oauth2-proxy/oauth2-proxy:v7.7.1',
      essential: true,
      portMappings: [{ containerPort: 4180, protocol: 'tcp' }],
      logConfiguration: logConfig(`browser/${args.podName}/oauth2-proxy`),
      environment: [
        { name: 'OAUTH2_PROXY_PROVIDER', value: 'github' },
        { name: 'OAUTH2_PROXY_HTTP_ADDRESS', value: '0.0.0.0:4180' },
        { name: 'OAUTH2_PROXY_UPSTREAMS', value: 'http://127.0.0.1:3000' },
        { name: 'OAUTH2_PROXY_REVERSE_PROXY', value: 'true' },
        { name: 'OAUTH2_PROXY_PASS_AUTHORIZATION_HEADER', value: 'true' },
        { name: 'OAUTH2_PROXY_COOKIE_SECURE', value: env.albListenerProtocol === 'HTTPS' ? 'true' : 'false' },
        { name: 'OAUTH2_PROXY_EMAIL_DOMAINS', value: '*' },
        // Auth allowlists: org takes precedence if set; user list applies on
        // top. If both empty, oauth2-proxy will accept any GitHub user (which
        // is why we error out below if neither is configured).
        ...(env.oauthAllowedOrg ? [{ name: 'OAUTH2_PROXY_GITHUB_ORG', value: env.oauthAllowedOrg }] : []),
        ...(env.oauthAllowedUsers ? [{ name: 'OAUTH2_PROXY_GITHUB_USER', value: env.oauthAllowedUsers }] : []),
      ],
      secrets: [
        {
          name: 'OAUTH2_PROXY_CLIENT_ID',
          valueFrom: `arn:aws:secretsmanager:${env.region}:${env.accountId}:secret:/cloud-dev-pods/oauth/client-id`,
        },
        {
          name: 'OAUTH2_PROXY_CLIENT_SECRET',
          valueFrom: `arn:aws:secretsmanager:${env.region}:${env.accountId}:secret:/cloud-dev-pods/oauth/client-secret`,
        },
        {
          name: 'OAUTH2_PROXY_COOKIE_SECRET',
          valueFrom: `arn:aws:secretsmanager:${env.region}:${env.accountId}:secret:/cloud-dev-pods/oauth/cookie-secret`,
        },
      ],
      dependsOn: [{ containerName: 'vscode', condition: 'HEALTHY' }],
    });
  } else {
    containerDefs.push({
      name: 'vscode-tunnel',
      image: args.imageUri,
      essential: true,
      mountPoints: [{ sourceVolume: 'workspace', containerPath: '/workspace', readOnly: false }],
      logConfiguration: logConfig(`tunnel/${args.podName}/vscode-tunnel`),
      environment: [{ name: 'POD_NAME', value: args.podName }],
    });
  }

  const r = await ecs.send(new RegisterTaskDefinitionCommand({
    family: args.family,
    cpu: args.cpu,
    memory: args.memory,
    networkMode: 'awsvpc',
    requiresCompatibilities: ['FARGATE'],
    runtimePlatform: { cpuArchitecture: 'X86_64', operatingSystemFamily: 'LINUX' },
    executionRoleArn: env.executionRoleArn,
    taskRoleArn,
    volumes: [{
      name: 'workspace',
      efsVolumeConfiguration: {
        fileSystemId: env.efsFsId,
        transitEncryption: 'ENABLED',
        authorizationConfig: { accessPointId: args.accessPointId, iam: 'ENABLED' },
      },
    }],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    containerDefinitions: containerDefs as any,
    tags: [
      { key: 'Project', value: 'cloud-dev-pods' },
      { key: 'Pod', value: args.podName },
    ],
  }));
  if (!r.taskDefinition?.taskDefinitionArn) throw new Error('RegisterTaskDefinition returned no ARN');
  return r.taskDefinition.taskDefinitionArn;
}

export async function runTask(taskDefArn: string, podName: string, owner: string): Promise<string> {
  const r = await ecs.send(new RunTaskCommand({
    cluster: env.clusterName,
    taskDefinition: taskDefArn,
    launchType: 'FARGATE',
    networkConfiguration: {
      awsvpcConfiguration: {
        subnets: env.privateSubnetIds,
        securityGroups: [env.tasksSecurityGroupId],
        assignPublicIp: 'DISABLED',
      },
    },
    enableExecuteCommand: false,
    tags: [
      { key: 'Project', value: 'cloud-dev-pods' },
      { key: 'Pod', value: podName },
      { key: 'Owner', value: owner },
    ],
    propagateTags: 'TASK_DEFINITION',
  }));
  const arn = r.tasks?.[0]?.taskArn;
  if (!arn) {
    const failures = r.failures?.map((f) => `${f.arn}: ${f.reason}`).join('; ') ?? 'no tasks returned';
    throw new Error(`RunTask failed: ${failures}`);
  }
  return arn;
}

export async function stopTask(taskArn: string, reason = 'pod-down'): Promise<void> {
  try {
    await ecs.send(new StopTaskCommand({
      cluster: env.clusterName,
      task: taskArn,
      reason,
    }));
  } catch (err) {
    // already stopped, etc. — non-fatal
    console.warn(`StopTask ${taskArn} failed: ${(err as Error).message}`);
  }
}

export interface TaskStatus {
  taskArn: string;
  lastStatus: string;
  desiredStatus: string;
  privateIp?: string;
}

export async function describeTasks(taskArns: string[]): Promise<TaskStatus[]> {
  if (taskArns.length === 0) return [];
  const r = await ecs.send(new DescribeTasksCommand({
    cluster: env.clusterName,
    tasks: taskArns,
  }));
  return (r.tasks ?? []).map((t) => ({
    taskArn: t.taskArn ?? '',
    lastStatus: t.lastStatus ?? 'UNKNOWN',
    desiredStatus: t.desiredStatus ?? 'UNKNOWN',
    privateIp: t.attachments?.[0]?.details?.find((d) => d.name === 'privateIPv4Address')?.value,
  }));
}

export async function waitForTaskRunning(taskArn: string, timeoutMs = 180_000): Promise<TaskStatus> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const [t] = await describeTasks([taskArn]);
    if (t && t.lastStatus === 'RUNNING') return t;
    if (t && (t.lastStatus === 'STOPPED' || t.desiredStatus === 'STOPPED')) {
      throw new Error(`Task ${taskArn} stopped before reaching RUNNING`);
    }
    await new Promise((res) => setTimeout(res, 5_000));
  }
  throw new Error(`Timeout waiting for task ${taskArn} to reach RUNNING`);
}

// ---- ALB ----

export async function createTargetGroup(podName: string): Promise<string> {
  const r = await elbv2.send(new CreateTargetGroupCommand({
    Name: `cdp-${podName}`.slice(0, 32),
    Protocol: 'HTTP',
    Port: 4180,
    TargetType: 'ip',
    VpcId: env.vpcId,
    HealthCheckProtocol: 'HTTP',
    HealthCheckPath: '/ping',
    HealthCheckIntervalSeconds: 15,
    HealthyThresholdCount: 2,
    UnhealthyThresholdCount: 3,
    Matcher: { HttpCode: '200,302' },
    Tags: [
      { Key: 'Project', Value: 'cloud-dev-pods' },
      { Key: 'Pod', Value: podName },
    ],
  }));
  const arn = r.TargetGroups?.[0]?.TargetGroupArn;
  if (!arn) throw new Error('CreateTargetGroup returned no ARN');
  // Tighten deregistration delay to 30s.
  // (ModifyTargetGroupAttributes is on the same client; skipping for v1 — defaults are fine.)
  return arn;
}

export async function createListenerRule(args: {
  podName: string;
  targetGroupArn: string;
  hostHeader: string;
  priority?: number;
}): Promise<string> {
  let priority = args.priority ?? priorityForPod(args.podName);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const r = await elbv2.send(new CreateRuleCommand({
        ListenerArn: env.albListenerArn,
        Priority: priority,
        Conditions: [{ Field: 'host-header', Values: [args.hostHeader] }],
        Actions: [{ Type: 'forward', TargetGroupArn: args.targetGroupArn }],
        Tags: [
          { Key: 'Project', Value: 'cloud-dev-pods' },
          { Key: 'Pod', Value: args.podName },
        ],
      }));
      const ruleArn = r.Rules?.[0]?.RuleArn;
      if (!ruleArn) throw new Error('CreateRule returned no ARN');
      return ruleArn;
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('PriorityInUse')) {
        priority = (priority + 1) % 49000 + 1000;
        continue;
      }
      throw err;
    }
  }
  throw new Error(`Could not allocate ALB listener rule priority for ${args.podName}`);
}

export async function registerTarget(targetGroupArn: string, ip: string): Promise<void> {
  await elbv2.send(new RegisterTargetsCommand({
    TargetGroupArn: targetGroupArn,
    Targets: [{ Id: ip, Port: 4180 }],
  }));
}

export async function deleteListenerRule(ruleArn: string): Promise<void> {
  try {
    await elbv2.send(new DeleteRuleCommand({ RuleArn: ruleArn }));
  } catch (err) {
    console.warn(`DeleteRule ${ruleArn} failed: ${(err as Error).message}`);
  }
}

export async function deregisterAndDeleteTargetGroup(args: {
  targetGroupArn: string;
  ip?: string;
}): Promise<void> {
  if (args.ip) {
    try {
      await elbv2.send(new DeregisterTargetsCommand({
        TargetGroupArn: args.targetGroupArn,
        Targets: [{ Id: args.ip, Port: 4180 }],
      }));
    } catch (err) {
      console.warn(`DeregisterTargets failed: ${(err as Error).message}`);
    }
  }
  // Brief settle delay before deletion (ALB may be still draining).
  await new Promise((r) => setTimeout(r, 5_000));
  try {
    await elbv2.send(new DeleteTargetGroupCommand({ TargetGroupArn: args.targetGroupArn }));
  } catch (err) {
    console.warn(`DeleteTargetGroup failed: ${(err as Error).message}`);
  }
}
