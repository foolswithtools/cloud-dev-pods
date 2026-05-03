// Action handlers. The handler.ts dispatcher passes the validated event here.

import type { PodEvent, PodResult } from './handler';
import { env } from './env';
import {
  allocatePosixUid,
  createAccessPoint,
  createListenerRule,
  createTargetGroup,
  deleteAccessPoint,
  deleteListenerRule,
  deregisterAndDeleteTargetGroup,
  describeTasks,
  registerTarget,
  registerTaskDef,
  registryDelete,
  registryGet,
  registryPut,
  registryScan,
  resolveLatestImageTag,
  runTask,
  stopTask,
  waitForTaskRunning,
} from './aws';

export async function podUp(e: Extract<PodEvent, { action: 'up' }>): Promise<PodResult> {
  const { podName, mode, owner = 'unknown', cpu = 1024, memory = 2048, idleMinutes = 60 } = e;

  const existing = await registryGet(podName);
  if (existing) {
    return {
      ok: false,
      status: 'conflict',
      podName,
      message: `Pod "${podName}" already registered (status: ${existing.taskArn ? 'running' : 'unknown'}).`,
    };
  }

  // Fail-fast safety: refuse to launch a browser pod without an oauth allowlist
  // (oauth2-proxy would otherwise accept any GitHub user).
  if (mode === 'browser' && !env.oauthAllowedOrg && !env.oauthAllowedUsers) {
    return {
      ok: false,
      status: 'error',
      podName,
      message:
        'Refusing browser-mode pod-up: neither github.oauthAllowedOrg nor github.oauthAllowedUsers is set in config. Set at least one and re-deploy CloudDevPods-PodManager.',
    };
  }

  const repoName = mode === 'browser' ? env.browserRepoName : env.tunnelRepoName;
  const repoUri = mode === 'browser' ? env.browserRepoUri : env.tunnelRepoUri;
  const resolvedTag = e.imageTag ?? (await resolveLatestImageTag(repoName));
  if (!resolvedTag) {
    return {
      ok: false,
      status: 'error',
      message: `No image found in ECR repo ${repoName}. Run build-runtime workflow first.`,
    };
  }
  const imageUri = `${repoUri}:${resolvedTag}`;

  const uid = await allocatePosixUid();
  const accessPointId = await createAccessPoint(podName, uid);

  let taskDefArn: string;
  let targetGroupArn: string | undefined;
  let ruleArn: string | undefined;
  let taskArn: string | undefined;
  let url: string | undefined;
  let hostHeader: string | undefined;

  try {
    taskDefArn = await registerTaskDef({
      family: mode === 'browser' ? env.browserTaskDefFamily : env.tunnelTaskDefFamily,
      imageUri,
      accessPointId,
      podName,
      cpu: String(cpu),
      memory: String(memory),
      mode,
    });

    if (mode === 'browser') {
      targetGroupArn = await createTargetGroup(podName);
      hostHeader = env.baseDomain ? `${podName}.${env.baseDomain}` : `${podName}.${env.albDnsName}`;
      ruleArn = await createListenerRule({ podName, targetGroupArn, hostHeader });
      const proto = env.albListenerProtocol.toLowerCase();
      url = `${proto}://${hostHeader}`;
    }

    taskArn = await runTask(taskDefArn, podName, owner);
    const taskState = await waitForTaskRunning(taskArn);

    if (mode === 'browser' && targetGroupArn && taskState.privateIp) {
      await registerTarget(targetGroupArn, taskState.privateIp);
    }

    const now = new Date().toISOString();
    await registryPut({
      podName,
      mode,
      taskArn,
      taskDefArn,
      accessPointId,
      posixUid: uid,
      targetGroupArn,
      ruleArn,
      owner,
      createdAt: now,
      lastActivityAt: now,
      idleMinutes,
      url,
      imageTag: resolvedTag,
    });

    return {
      ok: true,
      status: 'ok',
      podName,
      url,
      tunnelName: mode === 'tunnel' ? podName : undefined,
      message: mode === 'browser'
        ? `Pod is up at ${url}.`
        : `Tunnel pod started; check CloudWatch Logs (/aws/lambda/pod-manager + /cloud-dev-pods/<env>/pods) for the device-code URL.`,
    };
  } catch (err) {
    // Best-effort rollback.
    console.error('pod-up failed; attempting rollback', err);
    if (taskArn) await stopTask(taskArn, 'pod-up rollback');
    if (ruleArn) await deleteListenerRule(ruleArn);
    if (targetGroupArn) await deregisterAndDeleteTargetGroup({ targetGroupArn });
    if (accessPointId) await deleteAccessPoint(accessPointId);
    return {
      ok: false,
      status: 'error',
      podName,
      message: `pod-up failed: ${(err as Error).message}`,
    };
  }
}

export async function podDown(e: Extract<PodEvent, { action: 'down' }>): Promise<PodResult> {
  const { podName, keepWorkspace = true } = e;
  const entry = await registryGet(podName);
  if (!entry) {
    return { ok: false, status: 'not-found', podName, message: `Pod "${podName}" not in registry.` };
  }

  if (entry.taskArn) await stopTask(entry.taskArn);
  if (entry.ruleArn) await deleteListenerRule(entry.ruleArn);
  if (entry.targetGroupArn) {
    let ip: string | undefined;
    if (entry.taskArn) {
      const [t] = await describeTasks([entry.taskArn]);
      ip = t?.privateIp;
    }
    await deregisterAndDeleteTargetGroup({ targetGroupArn: entry.targetGroupArn, ip });
  }
  if (!keepWorkspace) {
    await deleteAccessPoint(entry.accessPointId);
  }
  await registryDelete(podName);

  return {
    ok: true,
    status: 'ok',
    podName,
    message: keepWorkspace
      ? `Pod "${podName}" stopped; EFS workspace retained.`
      : `Pod "${podName}" stopped and EFS workspace deleted.`,
  };
}

export async function podList(): Promise<PodResult> {
  const entries = await registryScan();
  if (entries.length === 0) {
    return { ok: true, status: 'ok', pods: [] };
  }
  const taskArns = entries.map((e) => e.taskArn).filter((x): x is string => Boolean(x));
  const tasks = await describeTasks(taskArns);
  const byArn = new Map(tasks.map((t) => [t.taskArn, t]));

  return {
    ok: true,
    status: 'ok',
    pods: entries.map((e) => ({
      podName: e.podName,
      mode: e.mode,
      url: e.url,
      tunnelName: e.mode === 'tunnel' ? e.podName : undefined,
      owner: e.owner,
      imageTag: e.imageTag,
      createdAt: e.createdAt,
      idleMinutes: e.idleMinutes,
      taskStatus: e.taskArn ? byArn.get(e.taskArn)?.lastStatus ?? 'UNKNOWN' : 'NO_TASK',
    })),
  };
}

export async function podStatus(e: Extract<PodEvent, { action: 'status' }>): Promise<PodResult> {
  const entry = await registryGet(e.podName);
  if (!entry) {
    return { ok: false, status: 'not-found', podName: e.podName };
  }
  const [task] = entry.taskArn ? await describeTasks([entry.taskArn]) : [];
  return {
    ok: true,
    status: 'ok',
    podName: e.podName,
    url: entry.url,
    tunnelName: entry.mode === 'tunnel' ? entry.podName : undefined,
    pods: [{
      podName: entry.podName,
      mode: entry.mode,
      taskStatus: task?.lastStatus ?? 'NO_TASK',
      desiredStatus: task?.desiredStatus,
      privateIp: task?.privateIp,
      owner: entry.owner,
      imageTag: entry.imageTag,
      createdAt: entry.createdAt,
      idleMinutes: entry.idleMinutes,
    }],
  };
}
