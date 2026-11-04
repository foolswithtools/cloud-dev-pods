#!/usr/bin/env node
/**
 * cluster-workspace-guard: the workspace pre-flight for `cluster-down.yml`
 * (#227). Refuses to let `cdk destroy` delete pod workspaces the user hasn't
 * agreed to lose.
 *
 * The EFS file system's removal policy is set at deploy time from
 * `efs.retainOnClusterDown` (ADR 0007), and `cdk destroy` applies the policy
 * in the *deployed* template, not the one in config/config.yaml. So the guard
 * reads the deployed `DeletionPolicy` of the Cluster stack's
 * `AWS::EFS::FileSystem` and uses config only to explain a mismatch (config
 * says retain, but cluster-up hasn't been re-run since).
 *
 *   - Deployed policy RETAIN: proceed; the file system survives.
 *   - Deployed policy DESTROY, no access points: proceed.
 *   - Deployed policy DESTROY, access points present: refuse unless
 *     `--delete-workspaces` (the workflow's `delete_workspaces` input).
 *   - No Cluster stack, no EFS resource in it, or EFS says the file system
 *     doesn't exist: proceed; there is nothing left to protect.
 *   - Any other error: refuse (fail closed), unless `--delete-workspaces`,
 *     since the user already agreed to lose the workspaces.
 *
 * Detection limit: workspaces are counted by their EFS access points. Each
 * pod gets one on pod-up, and it survives `pod-down` with keep_workspace=true,
 * so a kept workspace shows up. A directory on the file system with no access
 * point (its access point was deleted by pod-down keep_workspace=false, which
 * leaves the files, or removed by hand) is invisible without mounting the file
 * system, and the guard does not see it. See docs/teardown.md.
 *
 * The file-system ID comes from the Cluster stack's own resources rather than
 * the `cluster/efs-id` SSM parameter: the parameter lives in the same stack
 * and is deleted first, so after a teardown that failed on the file system
 * the parameter is gone while the file system is still there.
 *
 * Usage:
 *   tsx scripts/cluster-workspace-guard.ts [--delete-workspaces]
 *
 * Exits 0 to proceed, 1 to refuse, 2 on bad arguments. Like
 * scripts/cluster-drain.ts (#194, #211), exit 0 alone is not proof: on
 * proceed, and only then, it appends `proceed=true` (plus `efs_action` and
 * `efs_id` for the job summary) to `$GITHUB_OUTPUT`.
 */

import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CloudFormationClient,
  GetTemplateCommand,
  paginateListStackResources,
} from '@aws-sdk/client-cloudformation';
import { EFSClient, paginateDescribeAccessPoints } from '@aws-sdk/client-efs';
import { isInvokedAsCli } from './lib/cli-entry.js';
import { resolveStackNames } from './stack-names.js';

export interface StackResource {
  logicalId: string;
  type: string;
  physicalId?: string;
  status?: string;
}

export interface AccessPointInfo {
  accessPointId: string;
  /** The `Pod` tag pod-manager sets on the access point. */
  pod?: string;
  path?: string;
}

/** The AWS reads the guard needs; injectable for tests. Errors propagate. */
export interface GuardCalls {
  getTemplateBody: (stackName: string) => Promise<string>;
  listStackResources: (stackName: string) => Promise<StackResource[]>;
  describeAccessPoints: (fileSystemId: string) => Promise<AccessPointInfo[]>;
}

export interface GuardOptions {
  /** The Cluster stack (holds the EFS file system). */
  stackName: string;
  /** `efs.retainOnClusterDown` from config/config.yaml; used to explain a mismatch. */
  configRetain: boolean;
  /** The workflow's `delete_workspaces` input. */
  deleteWorkspaces: boolean;
  calls: GuardCalls;
  log: (line: string) => void;
}

export type EfsAction = 'retain' | 'destroy' | 'absent';

export interface GuardResult {
  proceed: boolean;
  reason: string;
  efs: {
    /** What `cdk destroy` will do to the file system. */
    action: EfsAction;
    fileSystemId?: string;
    /** Pods (or access points) with a workspace on the file system. */
    workspaces: string[];
  };
}

const TROUBLESHOOTING = 'See "cluster-down refuses: workspaces would be deleted" in docs/troubleshooting.md.';
const RETAIN_POLICIES = new Set(['Retain', 'RetainExceptOnCreate']);

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : '';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** CloudFormation answers a missing stack with a generic ValidationError. */
function isStackGone(err: unknown): boolean {
  return errorName(err) === 'ValidationError' && /does not exist/.test(errorMessage(err));
}

/** The `AWS::EFS::FileSystem` resources and their `DeletionPolicy` in a deployed template. */
function efsResources(templateBody: string): { logicalId: string; deletionPolicy?: string }[] {
  let doc: unknown;
  try {
    doc = JSON.parse(templateBody);
  } catch {
    throw new Error('the deployed Cluster stack template is not JSON');
  }
  const resources = (doc as { Resources?: unknown } | null)?.Resources;
  if (typeof resources !== 'object' || resources === null) {
    throw new Error('the deployed Cluster stack template has no Resources');
  }
  return Object.entries(resources as Record<string, { Type?: unknown; DeletionPolicy?: unknown }>)
    .filter(([, r]) => r?.Type === 'AWS::EFS::FileSystem')
    .map(([logicalId, r]) => ({
      logicalId,
      deletionPolicy: typeof r.DeletionPolicy === 'string' ? r.DeletionPolicy : undefined,
    }));
}

function label(ap: AccessPointInfo): string {
  if (ap.pod) return ap.pod;
  return ap.path ? `${ap.accessPointId} (${ap.path})` : ap.accessPointId;
}

function refusalGuidance(fileSystemId: string, configRetain: boolean): string {
  const mismatch = configRetain
    ? ' config/config.yaml sets efs.retainOnClusterDown: true, but the deployed stack still has DESTROY: cluster-up has not run since the change.'
    : '';
  return (
    `${mismatch} To delete them, re-run cluster-down with delete_workspaces=true. ` +
    `To keep them, set efs.retainOnClusterDown: true in config/config.yaml, commit it, re-run cluster-up ` +
    `(it updates the removal policy), then re-run cluster-down; ${fileSystemId} stays, and its storage stays billed. ` +
    `Or back them up first (docs/teardown.md). ${TROUBLESHOOTING}`
  );
}

export async function guardWorkspaces(opts: GuardOptions): Promise<GuardResult> {
  const { stackName, configRetain, deleteWorkspaces, calls, log } = opts;
  const confirmed = ' delete_workspaces=true was given, so cluster-down goes ahead.';

  // Fail closed on unexpected errors, unless the user already agreed to lose the workspaces.
  const failed = (what: string, err: unknown): GuardResult => {
    const problem = `Workspace pre-flight failed: ${what}: ${errorMessage(err)}.`;
    if (deleteWorkspaces) {
      return { proceed: true, reason: problem + confirmed, efs: { action: 'destroy', workspaces: [] } };
    }
    return {
      proceed: false,
      reason: `${problem} Not destroying: can't confirm the EFS workspaces are safe. To delete them anyway, re-run cluster-down with delete_workspaces=true. ${TROUBLESHOOTING}`,
      efs: { action: 'destroy', workspaces: [] },
    };
  };

  log(`Reading the EFS removal policy from the deployed ${stackName} template...`);
  let fsResources: { logicalId: string; deletionPolicy?: string }[];
  try {
    fsResources = efsResources(await calls.getTemplateBody(stackName));
  } catch (err) {
    if (isStackGone(err)) {
      return {
        proceed: true,
        reason: `${stackName} is not deployed, so cluster-down deletes no EFS file system.`,
        efs: { action: 'absent', workspaces: [] },
      };
    }
    return failed(`reading the ${stackName} template`, err);
  }
  const fsResource = fsResources[0];
  if (!fsResource) {
    return {
      proceed: true,
      reason: `${stackName} has no EFS file system, so cluster-down deletes none.`,
      efs: { action: 'absent', workspaces: [] },
    };
  }

  let resources: StackResource[];
  try {
    resources = await calls.listStackResources(stackName);
  } catch (err) {
    if (isStackGone(err)) {
      return {
        proceed: true,
        reason: `${stackName} is not deployed, so cluster-down deletes no EFS file system.`,
        efs: { action: 'absent', workspaces: [] },
      };
    }
    return failed(`listing the ${stackName} resources`, err);
  }
  const live = resources.find((r) => r.logicalId === fsResource.logicalId);
  const fileSystemId = live?.physicalId;
  if (!fileSystemId || live.status === 'DELETE_COMPLETE') {
    return {
      proceed: true,
      reason: `The EFS file system in ${stackName} no longer exists, so cluster-down deletes none.`,
      efs: { action: 'absent', workspaces: [] },
    };
  }

  const policy = fsResource.deletionPolicy ?? 'Delete';
  if (RETAIN_POLICIES.has(policy)) {
    const note = configRetain
      ? ''
      : ' (config/config.yaml now sets efs.retainOnClusterDown: false, but cluster-up has not run since; the deployed RETAIN applies)';
    return {
      proceed: true,
      reason: `The deployed removal policy for ${fileSystemId} is RETAIN${note}: cluster-down keeps it and every workspace on it. Its storage stays billed until you delete it.`,
      efs: { action: 'retain', fileSystemId, workspaces: [] },
    };
  }

  log(`Removal policy for ${fileSystemId} is DESTROY. Listing its access points...`);
  let accessPoints: AccessPointInfo[];
  try {
    accessPoints = await calls.describeAccessPoints(fileSystemId);
  } catch (err) {
    if (errorName(err) === 'FileSystemNotFound') {
      return {
        proceed: true,
        reason: `EFS file system ${fileSystemId} no longer exists, so cluster-down deletes no workspaces.`,
        efs: { action: 'absent', fileSystemId, workspaces: [] },
      };
    }
    return failed(`listing the access points on ${fileSystemId}`, err);
  }

  const workspaces = accessPoints.map(label);
  if (workspaces.length === 0) {
    return {
      proceed: true,
      reason: `EFS file system ${fileSystemId} has no access points (no pod workspaces found); cluster-down deletes it.`,
      efs: { action: 'destroy', fileSystemId, workspaces },
    };
  }
  const what = `EFS file system ${fileSystemId} holds ${workspaces.length} pod workspace(s) (${workspaces.join(', ')}), and its deployed removal policy is DESTROY.`;
  if (deleteWorkspaces) {
    return {
      proceed: true,
      reason: `${what}${confirmed}`,
      efs: { action: 'destroy', fileSystemId, workspaces },
    };
  }
  return {
    proceed: false,
    reason: `${what} Not destroying.${refusalGuidance(fileSystemId, configRetain)}`,
    efs: { action: 'destroy', fileSystemId, workspaces },
  };
}

const USAGE = 'Usage: cluster-workspace-guard [--delete-workspaces]';

export function parseGuardArgs(argv: string[]): { deleteWorkspaces: boolean } | { error: string } {
  let deleteWorkspaces = false;
  for (const arg of argv) {
    if (arg === '--delete-workspaces') deleteWorkspaces = true;
    else return { error: `Unknown argument "${arg}".` };
  }
  return { deleteWorkspaces };
}

/**
 * Appends `efs_action`, `efs_id` and `proceed=true` to the step-output file
 * (`$GITHUB_OUTPUT` by default) when the guard decided to proceed. Writes
 * nothing otherwise, so a missing marker always means "do not destroy".
 */
export function writeGuardOutputs(result: GuardResult, outputPath: string | undefined = process.env.GITHUB_OUTPUT): void {
  if (!result.proceed || !outputPath) return;
  appendFileSync(
    outputPath,
    `efs_action=${result.efs.action}\nefs_id=${result.efs.fileSystemId ?? ''}\nproceed=true\n`,
  );
}

function writeStepSummary(result: GuardResult): void {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  const lines = [
    result.proceed ? '## Workspace pre-flight passed' : '## Workspace pre-flight refused cluster-down',
    '',
    result.reason,
    '',
  ];
  appendFileSync(path, lines.join('\n'));
}

function realCalls(region: string): GuardCalls {
  const cfn = new CloudFormationClient({ region });
  const efs = new EFSClient({ region });
  return {
    getTemplateBody: async (stackName) => {
      const r = await cfn.send(new GetTemplateCommand({ StackName: stackName }));
      if (!r.TemplateBody) throw new Error('GetTemplate returned no TemplateBody');
      return r.TemplateBody;
    },
    listStackResources: async (stackName) => {
      const out: StackResource[] = [];
      for await (const page of paginateListStackResources({ client: cfn }, { StackName: stackName })) {
        for (const r of page.StackResourceSummaries ?? []) {
          out.push({
            logicalId: r.LogicalResourceId ?? '',
            type: r.ResourceType ?? '',
            physicalId: r.PhysicalResourceId,
            status: r.ResourceStatus,
          });
        }
      }
      return out;
    },
    describeAccessPoints: async (fileSystemId) => {
      const out: AccessPointInfo[] = [];
      for await (const page of paginateDescribeAccessPoints({ client: efs }, { FileSystemId: fileSystemId })) {
        for (const ap of page.AccessPoints ?? []) {
          out.push({
            accessPointId: ap.AccessPointId ?? '',
            pod: ap.Tags?.find((t) => t.Key === 'Pod')?.Value,
            path: ap.RootDirectory?.Path,
          });
        }
      }
      return out;
    },
  };
}

interface GuardConfig {
  naming: { prefix: string };
  efs?: { retainOnClusterDown?: boolean };
}

// Dynamic import: a static `import '../infra/...'` fails `tsc -b scripts`
// with TS6059 because the file sits outside scripts/'s rootDir.
async function loadGuardConfig(): Promise<GuardConfig> {
  const { loadConfig } = (await import(
    pathToFileURL(resolve(import.meta.dirname, '../infra/lib/config/config.ts')).href
  )) as { loadConfig: () => GuardConfig };
  return loadConfig();
}

async function main() {
  // Arguments are parsed before anything touches AWS.
  const parsed = parseGuardArgs(process.argv.slice(2));
  if ('error' in parsed) {
    console.error(parsed.error);
    console.error(USAGE);
    process.exit(2);
  }

  const config = await loadGuardConfig();
  const names = await resolveStackNames(config.naming.prefix, 'cluster-stack');
  if ('error' in names) throw new Error(names.error);
  const stackName = names.names[0]!;

  const result = await guardWorkspaces({
    stackName,
    configRetain: config.efs?.retainOnClusterDown === true,
    deleteWorkspaces: parsed.deleteWorkspaces,
    calls: realCalls(process.env.AWS_REGION ?? 'us-west-2'),
    log: (line) => console.log(line),
  });
  writeStepSummary(result);
  if (result.proceed) {
    writeGuardOutputs(result);
    console.log(result.reason);
  } else {
    // Workflow commands are one line: escape so a multi-line error stays in the annotation.
    const annotation = result.reason.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
    console.error(`::error::${annotation}`);
    process.exit(1);
  }
}

// Only run main() when invoked as a CLI (not when imported by tests).
if (isInvokedAsCli(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(`::error::Workspace pre-flight failed: ${errorMessage(err)}`);
    process.exit(1);
  });
}
