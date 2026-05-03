// Idle reaper Lambda. Two-phase shutdown:
//   1. First idle detection writes idleSince=now and emits SNS notification.
//   2. Second consecutive detection invokes pod-manager `down`.
// Also handles ECS Task State Change (STOPPED) events: if a pod's task stops
// for any reason (crash, manual `aws ecs stop-task`, capacity reclaim), invoke
// pod-manager `down` to clean up the orphaned ALB rule + target group.
//
// Tunnel-mode pods are NOT idle-reaped in v1 — `code tunnel` doesn't emit a
// useful idle signal. Manual `pod-down` is the path. Phase 8 polish: CW Logs
// Insights heuristic on the agent's heartbeat lines.

import {
  CloudWatchClient,
  GetMetricStatisticsCommand,
} from '@aws-sdk/client-cloudwatch';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';

const region = process.env.AWS_REGION ?? 'us-west-2';
const tableName = required('REGISTRY_TABLE_NAME');
const podManagerFnName = required('POD_MANAGER_FN_NAME');
const snsTopicArn = required('IDLE_TOPIC_ARN');
const albNameDimension = required('ALB_NAME_DIMENSION');
const idleMinutesDefault = Number(process.env.IDLE_MINUTES_DEFAULT ?? '60');

const cw = new CloudWatchClient({ region });
const lambda = new LambdaClient({ region });
const sns = new SNSClient({ region });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Required env var ${name} is unset`);
  return v;
}

interface PodRecord {
  podName: string;
  mode: 'browser' | 'tunnel';
  taskArn?: string;
  targetGroupArn?: string;
  owner?: string;
  idleMinutes?: number;
  idleSince?: string;
}

async function listPods(): Promise<PodRecord[]> {
  const out: PodRecord[] = [];
  let lek: Record<string, unknown> | undefined;
  do {
    const r = await ddb.send(new ScanCommand({
      TableName: tableName,
      ExclusiveStartKey: lek,
    }));
    out.push(...((r.Items ?? []) as PodRecord[]));
    lek = r.LastEvaluatedKey;
  } while (lek);
  return out;
}

async function browserIdleSince(
  targetGroupArn: string,
  minutes: number,
): Promise<boolean> {
  // AWS/ApplicationELB metrics are stored under the (TargetGroup, LoadBalancer)
  // dimension pair. Querying with TargetGroup alone returns 0 datapoints,
  // which would be incorrectly interpreted as "no traffic = idle".
  const tgDimension = targetGroupArn.split('targetgroup/')[1]
    ? `targetgroup/${targetGroupArn.split('targetgroup/')[1]}`
    : targetGroupArn;
  const r = await cw.send(new GetMetricStatisticsCommand({
    Namespace: 'AWS/ApplicationELB',
    MetricName: 'RequestCount',
    Dimensions: [
      { Name: 'TargetGroup', Value: tgDimension },
      { Name: 'LoadBalancer', Value: albNameDimension },
    ],
    StartTime: new Date(Date.now() - minutes * 60_000),
    EndTime: new Date(),
    Period: minutes * 60,
    Statistics: ['Sum'],
  }));
  const datapoints = r.Datapoints ?? [];
  // Brand-new target groups may have no metrics yet — treat as "active"
  // (assume not idle) to avoid false positives during the warmup window.
  if (datapoints.length === 0) return false;
  const sum = datapoints[0]?.Sum ?? 0;
  return sum === 0;
}

async function setIdleSince(podName: string, isoNow: string): Promise<void> {
  await ddb.send(new UpdateCommand({
    TableName: tableName,
    Key: { podName },
    UpdateExpression: 'SET idleSince = :s',
    ExpressionAttributeValues: { ':s': isoNow },
  }));
}

async function clearIdleSince(podName: string): Promise<void> {
  await ddb.send(new UpdateCommand({
    TableName: tableName,
    Key: { podName },
    UpdateExpression: 'REMOVE idleSince',
  }));
}

async function notifyIdle(pod: PodRecord, minutes: number): Promise<void> {
  await sns.send(new PublishCommand({
    TopicArn: snsTopicArn,
    Subject: `cloud-dev-pods: pod "${pod.podName}" is idle`,
    Message: [
      `Pod ${pod.podName}`,
      `  mode:      ${pod.mode}`,
      `  owner:     ${pod.owner ?? 'unknown'}`,
      `  no requests in last ${minutes} minutes.`,
      ``,
      `If still idle on the next reaper cycle (~5 min), pod-manager will stop it`,
      `(EFS workspace retained). To override, run pod-up with --idle 0.`,
    ].join('\n'),
  }));
}

async function invokeDown(podName: string): Promise<void> {
  await lambda.send(new InvokeCommand({
    FunctionName: podManagerFnName,
    Payload: Buffer.from(JSON.stringify({
      action: 'down',
      podName,
      keepWorkspace: true,
    })),
    InvocationType: 'RequestResponse',
  }));
}

async function runIdleScan(): Promise<{ checked: number; stopped: string[]; warned: string[] }> {
  const pods = await listPods();
  const now = new Date().toISOString();
  const stopped: string[] = [];
  const warned: string[] = [];
  let checked = 0;

  for (const pod of pods) {
    if (pod.mode !== 'browser') continue;            // tunnel idle: phase 8 polish
    if (!pod.targetGroupArn) continue;
    const minutes = pod.idleMinutes && pod.idleMinutes > 0 ? pod.idleMinutes : idleMinutesDefault;
    if (pod.idleMinutes === 0) continue;             // user disabled idle for this pod
    checked++;

    const idle = await browserIdleSince(pod.targetGroupArn, minutes);
    if (!idle) {
      if (pod.idleSince) await clearIdleSince(pod.podName);
      continue;
    }
    if (!pod.idleSince) {
      await setIdleSince(pod.podName, now);
      await notifyIdle(pod, minutes);
      warned.push(pod.podName);
    } else {
      console.log(`Stopping idle pod ${pod.podName} (idleSince=${pod.idleSince})`);
      await invokeDown(pod.podName);
      stopped.push(pod.podName);
    }
  }

  return { checked, stopped, warned };
}

interface TaskStateChangeEvent {
  source?: string;
  'detail-type'?: string;
  detail?: {
    taskArn?: string;
    lastStatus?: string;
    desiredStatus?: string;
  };
}

async function handleTaskStateChange(event: TaskStateChangeEvent): Promise<{ cleaned?: string }> {
  const taskArn = event.detail?.taskArn;
  if (!taskArn || event.detail?.lastStatus !== 'STOPPED') {
    return {};
  }
  const pods = await listPods();
  const pod = pods.find((p) => p.taskArn === taskArn);
  if (!pod) {
    console.log(`task-state-change: no pod registered for ${taskArn}; nothing to clean.`);
    return {};
  }
  console.log(`task-state-change: cleaning up pod ${pod.podName} (task ${taskArn} stopped).`);
  await invokeDown(pod.podName);
  return { cleaned: pod.podName };
}

interface InvocationEvent {
  source?: string;
  'detail-type'?: string;
  detail?: TaskStateChangeEvent['detail'];
}

export const handler = async (event: InvocationEvent) => {
  console.log('idle-reaper invoked', JSON.stringify(event));
  try {
    if (event.source === 'aws.ecs' && event['detail-type'] === 'ECS Task State Change') {
      return { ok: true, ...(await handleTaskStateChange(event)) };
    }
    return { ok: true, ...(await runIdleScan()) };
  } catch (err) {
    console.error('idle-reaper error', err);
    return { ok: false, message: (err as Error).message };
  }
};
