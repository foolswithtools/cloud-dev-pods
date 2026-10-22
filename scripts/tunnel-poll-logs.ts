#!/usr/bin/env node
/**
 * Poll CloudWatch Logs for the VS Code tunnel device-code prompt and emit
 * the URL + code as JSON on stdout. Used by pod-up.yml's tunnel-mode path.
 *
 * Usage:
 *   tsx scripts/tunnel-poll-logs.ts --log-group <group> --stream-prefix <prefix> [--timeout 180]
 *
 * Exit codes:
 *   0 — success (URL + code found, OR timeout reached without finding; emits empty JSON in the timeout case so callers can decide).
 *   1 — invocation error (bad args, AWS API failure).
 */

import { fileURLToPath } from 'node:url';
import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
} from '@aws-sdk/client-cloudwatch-logs';

interface Args {
  logGroup: string;
  streamPrefix: string;
  timeoutSeconds: number;
}

function parseArgs(argv: string[]): Args {
  const get = (key: string): string | undefined => {
    const idx = argv.indexOf(`--${key}`);
    return idx >= 0 ? argv[idx + 1] : undefined;
  };
  const logGroup = get('log-group');
  const streamPrefix = get('stream-prefix');
  const timeoutStr = get('timeout');
  if (!logGroup || !streamPrefix) {
    throw new Error('Required: --log-group <group> --stream-prefix <prefix>');
  }
  return {
    logGroup,
    streamPrefix,
    timeoutSeconds: timeoutStr ? Number(timeoutStr) : 180,
  };
}

export interface DeviceCode {
  url: string;
  code: string;
}

// VS Code CLI 1.143.0 prints the prompt (`code tunnel user login --provider <p>`) as:
//   github:    "To grant access to the server, please log into https://github.com/login/device and use code CC3A-5101"
//   microsoft: "To sign in, use a web browser to open the page https://login.microsoft.com/device and enter the code FHLARZB9J to authenticate."
// Older CLI builds pointed Microsoft logins at https://microsoft.com/devicelogin; still matched.
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
        logStreamNamePrefix: args.streamPrefix,
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
function isInvokedAsCli(): boolean {
  try {
    return fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
}

if (isInvokedAsCli()) {
  main().catch((err: unknown) => {
    process.stderr.write(`tunnel-poll-logs: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
