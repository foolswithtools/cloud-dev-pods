#!/usr/bin/env node
/**
 * Pod-cli: thin wrapper over `lambda:Invoke` for the pod-manager Lambda.
 *
 * Used by both GitHub Actions workflows (pod-up, pod-down, pod-list) and
 * developers running locally. Validates inputs, invokes the function, and
 * pretty-prints the response.
 *
 * Usage:
 *   tsx scripts/pod-cli.ts up   --pod <name> --mode browser|tunnel|ssh [--cpu 1024] [--memory 2048] [--idle 60] [--image-tag <sha>] [--owner <login-or-email>] [--tunnel-provider github|microsoft] [--ssh-public-key <key>]
 *   tsx scripts/pod-cli.ts down --pod <name> [--keep-workspace]
 *   tsx scripts/pod-cli.ts list
 *   tsx scripts/pod-cli.ts status --pod <name>
 *
 * The Lambda holds all ECS/ALB/EFS write permissions; this CLI's role only
 * has `lambda:InvokeFunction` on `pod-manager` (ADR 0003).
 */

import { LambdaClient, InvokeCommand, type InvokeCommandInput } from '@aws-sdk/client-lambda';
import { isInvokedAsCli } from './lib/cli-entry.js';

interface CliArgs {
  action: string;
  flags: Map<string, string | true>;
}

export function parseArgs(argv: string[]): CliArgs {
  const [action = '', ...rest] = argv;
  const flags = new Map<string, string | true>();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg || !arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = rest[i + 1];
    if (next && !next.startsWith('--')) {
      flags.set(key, next);
      i++;
    } else {
      flags.set(key, true);
    }
  }
  return { action, flags };
}

export function buildEvent(action: string, flags: Map<string, string | true>): Record<string, unknown> {
  const get = (key: string) => flags.get(key);
  const getStr = (key: string) => {
    const v = get(key);
    return typeof v === 'string' ? v : undefined;
  };
  const getNum = (key: string) => {
    const v = getStr(key);
    return v !== undefined ? Number(v) : undefined;
  };

  switch (action) {
    case 'up':
      return {
        action: 'up',
        podName: getStr('pod'),
        mode: getStr('mode'),
        cpu: getNum('cpu'),
        memory: getNum('memory'),
        imageTag: getStr('image-tag'),
        idleMinutes: getNum('idle'),
        owner: getStr('owner') ?? process.env.GITHUB_ACTOR,
        tunnelProvider: getStr('tunnel-provider'),
        // ssh mode only; the Lambda validates the key and the mode pairing.
        sshPublicKey: getStr('ssh-public-key'),
      };
    case 'down':
      return {
        action: 'down',
        podName: getStr('pod'),
        keepWorkspace: get('keep-workspace') === true,
      };
    case 'list':
      return { action: 'list' };
    case 'status':
      return { action: 'status', podName: getStr('pod') };
    default:
      throw new Error(`Unknown action "${action}". Expected: up | down | list | status.`);
  }
}

/**
 * Outcome of one pod-manager invoke. `ok: false` means the invoke itself
 * failed (SDK error, or the Lambda raised a `FunctionError`); `error` is the
 * text pod-cli prints to stderr. `ok: true` only means the Lambda returned:
 * the payload can still be `{ ok: false, ... }`, which callers must check.
 */
export type InvokeOutcome = { ok: true; payload: unknown } | { ok: false; error: string };

/** The slice of `LambdaClient.send` that `invokePodManager` needs; injectable for tests. */
export type InvokeSend = (input: InvokeCommandInput) => Promise<{ Payload?: Uint8Array; FunctionError?: string }>;

export interface InvokeOptions {
  /** Defaults to `$AWS_REGION`, then `us-west-2`. */
  region?: string;
  /** Defaults to `$POD_MANAGER_FN`, then `pod-manager`. */
  functionName?: string;
  /** Override the Lambda call (tests). Defaults to a real `LambdaClient`. */
  send?: InvokeSend;
}

export async function invokePodManager(
  event: Record<string, unknown>,
  opts: InvokeOptions = {},
): Promise<InvokeOutcome> {
  const region = opts.region ?? process.env.AWS_REGION ?? 'us-west-2';
  const fnName = opts.functionName ?? process.env.POD_MANAGER_FN ?? 'pod-manager';
  const send: InvokeSend =
    opts.send ??
    ((input) => {
      const client = new LambdaClient({ region });
      return client.send(new InvokeCommand(input));
    });

  let result: Awaited<ReturnType<InvokeSend>>;
  try {
    result = await send({
      FunctionName: fnName,
      Payload: Buffer.from(JSON.stringify(event)),
      InvocationType: 'RequestResponse',
    });
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const payload = result.Payload ? new TextDecoder().decode(result.Payload) : '{}';
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    parsed = payload;
  }

  if (result.FunctionError) {
    return { ok: false, error: `Lambda error (${result.FunctionError}):\n${JSON.stringify(parsed, null, 2)}` };
  }
  return { ok: true, payload: parsed };
}

async function main() {
  const { action, flags } = parseArgs(process.argv.slice(2));
  if (!action) {
    console.error('Usage: pod-cli <up|down|list|status> [flags]');
    process.exit(2);
  }

  const event = buildEvent(action, flags);
  const outcome = await invokePodManager(event);
  if (!outcome.ok) {
    console.error(outcome.error);
    process.exit(1);
  }

  const parsed = outcome.payload;
  console.log(JSON.stringify(parsed, null, 2));
  if (parsed && typeof parsed === 'object' && 'ok' in parsed && parsed.ok === false) {
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
