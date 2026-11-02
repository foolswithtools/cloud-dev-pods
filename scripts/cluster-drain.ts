#!/usr/bin/env node
/**
 * cluster-drain: the pod pre-flight for `cluster-down.yml`. Decides whether
 * it is safe to run `cdk destroy`, and with `--force` drains registered pods
 * first. It fails closed: any list error, malformed list, failed `down` or
 * pod still registered after the drain means "do not destroy" (#209).
 *
 * Usage:
 *   tsx scripts/cluster-drain.ts [--force]
 *
 * Exits 0 when the cluster can be destroyed, 1 when it can't, 2 on bad
 * arguments. When `$GITHUB_STEP_SUMMARY` is set, the outcome is appended to
 * it either way.
 *
 * Draining only ever calls the pod-manager Lambda's `down` action: the
 * Lambda owns the ALB rule and EFS access-point cleanup (CLAUDE.md hard
 * rule 2), so this never stops ECS tasks itself.
 */

import { appendFileSync } from 'node:fs';
import { isInvokedAsCli } from './lib/cli-entry.js';
import { invokePodManager, type InvokeOutcome } from './pod-cli.js';

export type { InvokeOutcome };

export interface DrainResult {
  /** True only when no pods are registered (after the drain, with force). */
  proceed: boolean;
  reason: string;
  /** Pods that block the destroy: registered (no force), failed to stop, or still registered after the drain. */
  podNames: string[];
}

export interface DrainOptions {
  force: boolean;
  invoke: (event: Record<string, unknown>) => Promise<InvokeOutcome>;
  log: (line: string) => void;
}

type ListCheck = { ok: true; podNames: string[] } | { ok: false; problem: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Describes a Lambda `{ ok: false, status, message }` payload for a reason string. */
function describeLambdaFailure(payload: Record<string, unknown>): string {
  const status = typeof payload.status === 'string' ? payload.status : 'unknown';
  const message = typeof payload.message === 'string' ? payload.message : JSON.stringify(payload);
  return `the pod-manager Lambda returned ok: false (status ${status}): ${message}`;
}

/** Validates a `list` outcome: invoke ok, payload `ok === true`, `pods` an array of named pods. */
function checkList(outcome: InvokeOutcome): ListCheck {
  if (!outcome.ok) {
    return { ok: false, problem: `invoking the pod-manager Lambda failed: ${outcome.error}` };
  }
  const payload = outcome.payload;
  if (!isRecord(payload)) {
    return { ok: false, problem: `the pod-manager Lambda returned a non-object response: ${JSON.stringify(payload)}` };
  }
  if (payload.ok !== true) {
    return { ok: false, problem: describeLambdaFailure(payload) };
  }
  if (!Array.isArray(payload.pods)) {
    return {
      ok: false,
      problem: `the pod-manager Lambda response has a missing or invalid "pods" (expected an array, got ${JSON.stringify(payload.pods) ?? 'undefined'})`,
    };
  }
  const podNames: string[] = [];
  for (const pod of payload.pods) {
    if (!isRecord(pod) || typeof pod.podName !== 'string' || pod.podName === '') {
      return {
        ok: false,
        problem: `the pod-manager Lambda response has an invalid "pods" entry: ${JSON.stringify(pod)}`,
      };
    }
    podNames.push(pod.podName);
  }
  return { ok: true, podNames };
}

/** Why a `down` outcome is not a clean stop, or undefined when it is. */
function downProblem(outcome: InvokeOutcome): string | undefined {
  if (!outcome.ok) return `invoke failed: ${outcome.error}`;
  const payload = outcome.payload;
  if (!isRecord(payload)) return `non-object response: ${JSON.stringify(payload)}`;
  if (payload.ok !== true) return describeLambdaFailure(payload);
  return undefined;
}

export async function drainForClusterDown(opts: DrainOptions): Promise<DrainResult> {
  const { force, invoke, log } = opts;

  log('Listing registered pods...');
  const first = checkList(await invoke({ action: 'list' }));
  if (!first.ok) {
    return { proceed: false, reason: `Pod pre-flight failed: ${first.problem}.`, podNames: [] };
  }

  const pods = first.podNames;
  if (pods.length === 0) {
    return { proceed: true, reason: 'No pods registered; safe to destroy the cluster.', podNames: [] };
  }
  log(`${pods.length} pod(s) registered: ${pods.join(', ')}`);

  if (!force) {
    return {
      proceed: false,
      reason: `${pods.length} pod(s) still registered: ${pods.join(', ')}. Re-run cluster-down with force=true to stop them first.`,
      podNames: pods,
    };
  }

  const failed: string[] = [];
  for (const podName of pods) {
    log(`Stopping ${podName} (workspace kept)...`);
    const problem = downProblem(await invoke({ action: 'down', podName, keepWorkspace: true }));
    if (problem) {
      log(`Failed to stop ${podName}: ${problem}`);
      failed.push(podName);
    } else {
      log(`Stopped ${podName}.`);
    }
  }
  if (failed.length > 0) {
    return {
      proceed: false,
      reason: `Forced drain failed to stop ${failed.length} pod(s): ${failed.join(', ')}. Not destroying the cluster: the pod-manager Lambda must clean these up first.`,
      podNames: failed,
    };
  }

  log('Re-listing pods to confirm the drain...');
  const after = checkList(await invoke({ action: 'list' }));
  if (!after.ok) {
    return { proceed: false, reason: `Post-drain pod check failed: ${after.problem}.`, podNames: [] };
  }
  if (after.podNames.length > 0) {
    return {
      proceed: false,
      reason: `${after.podNames.length} pod(s) still registered after the drain: ${after.podNames.join(', ')}.`,
      podNames: after.podNames,
    };
  }
  return {
    proceed: true,
    reason: `Drained ${pods.length} pod(s) (${pods.join(', ')}); safe to destroy the cluster.`,
    podNames: [],
  };
}

const USAGE = 'Usage: cluster-drain [--force]';

/** Parses argv; returns an error string for anything but an optional `--force`. */
export function parseDrainArgs(argv: string[]): { force: boolean } | { error: string } {
  let force = false;
  for (const arg of argv) {
    if (arg === '--force') force = true;
    else return { error: `Unknown argument "${arg}".` };
  }
  return { force };
}

function writeStepSummary(result: DrainResult): void {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  const lines = [
    result.proceed ? '## Pod pre-flight passed' : '## Pod pre-flight refused cluster-down',
    '',
    result.reason,
    '',
  ];
  if (!result.proceed) {
    lines.push('See "cluster-down refuses: pod pre-flight failed" in `docs/troubleshooting.md`.', '');
  }
  appendFileSync(path, lines.join('\n'));
}

async function main() {
  // Arguments are parsed before anything touches AWS.
  const parsed = parseDrainArgs(process.argv.slice(2));
  if ('error' in parsed) {
    console.error(parsed.error);
    console.error(USAGE);
    process.exit(2);
  }

  const result = await drainForClusterDown({
    force: parsed.force,
    invoke: (event) => invokePodManager(event),
    log: (line) => console.log(line),
  });
  writeStepSummary(result);
  if (result.proceed) {
    console.log(result.reason);
  } else {
    // Workflow commands are one line: escape so a multi-line Lambda error stays in the annotation.
    const annotation = result.reason.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
    console.error(`::error::${annotation}`);
    process.exit(1);
  }
}

// Only run main() when invoked as a CLI (not when imported by tests).
if (isInvokedAsCli(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
