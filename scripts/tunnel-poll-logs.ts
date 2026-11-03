#!/usr/bin/env node
/**
 * Poll CloudWatch Logs for the VS Code tunnel device-code prompt and emit
 * the URL + code as JSON on stdout. Used by pod-up.yml's tunnel-mode path.
 *
 * Usage:
 *   tsx scripts/tunnel-poll-logs.ts --log-group <group> --pod <name> --task-arn <arn> [--timeout 180]
 *
 * Reads only the started task's own stream (see tunnelLogStreamName). The poller
 * never matches on a stream prefix: any stream under tunnel/<pod>/ that this
 * task didn't write is untrusted.
 *
 * Exit codes:
 *   0 — success (URL + code found, OR timeout reached without finding; emits empty JSON in the timeout case so callers can decide).
 *   1 — invocation error (bad args, AWS API failure).
 */

import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { isInvokedAsCli } from './lib/cli-entry.js';

export interface Args {
  logGroup: string;
  logStream: string;
  timeoutSeconds: number;
}

export function parseArgs(argv: string[]): Args {
  const get = (key: string): string | undefined => {
    const idx = argv.indexOf(`--${key}`);
    return idx >= 0 ? argv[idx + 1] : undefined;
  };
  const logGroup = get('log-group');
  const pod = get('pod');
  const taskArn = get('task-arn');
  const timeoutStr = get('timeout');
  if (!logGroup || !pod || !taskArn) {
    throw new Error('Required: --log-group <group> --pod <name> --task-arn <arn>');
  }
  return {
    logGroup,
    logStream: tunnelLogStreamName(pod, taskArn),
    timeoutSeconds: timeoutStr ? Number(timeoutStr) : 180,
  };
}

// awslogs names a container's stream <awslogs-stream-prefix>/<container>/<task-id>.
// pod-manager (infra/lambda/pod-manager/aws.ts) sets the tunnel prefix to
// tunnel/<pod>/vscode-tunnel, and the container is named vscode-tunnel.
const TASK_ARN_RE = /^arn:aws[a-z-]*:ecs:[a-z0-9-]+:\d{12}:task\/[A-Za-z0-9_-]+\/([a-f0-9]{32})$/;

export function tunnelLogStreamName(podName: string, taskArn: string): string {
  const taskId = TASK_ARN_RE.exec(taskArn)?.[1];
  if (!taskId) throw new Error(`Not an ECS task ARN: "${taskArn}"`);
  return `tunnel/${podName}/vscode-tunnel/vscode-tunnel/${taskId}`;
}

export interface DeviceCode {
  url: string;
  code: string;
}

// VS Code CLI 1.143.0 prints the prompt (`code tunnel user login --provider <p>`) as:
//   github:    "To grant access to the server, please log into https://github.com/login/device and use code CC3A-5101"
//   microsoft: "To sign in, use a web browser to open the page https://login.microsoft.com/device and enter the code FHLARZB9J to authenticate."
// Older CLI builds pointed Microsoft logins at https://microsoft.com/devicelogin; still matched.
// The CLI version is pinned in runtime/vscode-tunnel/Dockerfile (VSCODE_CLI_COMMIT). Whenever
// the pin moves, re-capture both prompt lines above from the new CLI, update this comment and
// the verbatim lines in tunnel-poll-logs.test.ts, and adjust the patterns if the wording changed.
const URL_RE = /(https:\/\/(?:github\.com\/login\/device|login\.microsoft\.com\/device|microsoft\.com\/devicelogin)\b)/;
const CODE_RE = /\bcode\s+([A-Z0-9]{4,}(?:-[A-Z0-9]{4,})?)/;

// CloudWatch Logs filter: each `?"term"` is a substring alternative.
export const FILTER_PATTERN =
  '?"github.com/login/device" ?"login.microsoft.com/device" ?"microsoft.com/devicelogin"';

export function extractDeviceCode(message: string): DeviceCode | undefined {
  const url = URL_RE.exec(message)?.[1];
  const code = CODE_RE.exec(message)?.[1];
  if (url && code) return { url, code };
  return undefined;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const region = process.env.AWS_REGION ?? 'us-west-2';
  const client = new CloudWatchLogsClient({ region });

  const startTime = Date.now() - 5 * 60 * 1000;  // look back 5 min
  const deadline = Date.now() + args.timeoutSeconds * 1000;

  while (Date.now() < deadline) {
    try {
      const r = await client.send(new FilterLogEventsCommand({
        logGroupName: args.logGroup,
        logStreamNames: [args.logStream],
        filterPattern: FILTER_PATTERN,
        startTime,
      }));
      for (const event of r.events ?? []) {
        const found = extractDeviceCode(event.message ?? '');
        if (found) {
          process.stdout.write(JSON.stringify(found) + '\n');
          return;
        }
      }
    } catch (err) {
      // Log group may not exist yet on a brand-new pod; tolerate ResourceNotFound.
      const code = (err as { name?: string }).name;
      if (code !== 'ResourceNotFoundException') {
        process.stderr.write(`tunnel-poll-logs: ${(err as Error).message}\n`);
      }
    }
    await new Promise((res) => setTimeout(res, 5_000));
  }

  // Timeout: emit empty JSON so callers can branch.
  process.stdout.write('{}\n');
}

// Only run main() when invoked as a CLI (not when imported by tests).
if (isInvokedAsCli(import.meta.url)) {
  main().catch((err: unknown) => {
    process.stderr.write(`tunnel-poll-logs: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
