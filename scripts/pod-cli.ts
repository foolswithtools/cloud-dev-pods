#!/usr/bin/env node
/**
 * Pod-cli: thin wrapper over `lambda:Invoke` for the pod-manager Lambda.
 *
 * Used by both GitHub Actions workflows (pod-up, pod-down, pod-list) and
 * developers running locally. Validates inputs, invokes the function, and
 * pretty-prints the response.
 *
 * Usage:
 *   tsx scripts/pod-cli.ts up   --pod <name> --mode browser|tunnel [--cpu 1024] [--memory 2048] [--idle 60] [--image-tag <sha>]
 *   tsx scripts/pod-cli.ts down --pod <name> [--keep-workspace]
 *   tsx scripts/pod-cli.ts list
 *   tsx scripts/pod-cli.ts status --pod <name>
 *
 * The Lambda holds all ECS/ALB/EFS write permissions; this CLI's role only
 * has `lambda:InvokeFunction` on `pod-manager` (ADR 0003).
 */

import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

interface CliArgs {
  action: string;
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): CliArgs {
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

function buildEvent(action: string, flags: Map<string, string | true>): Record<string, unknown> {
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

async function main() {
  const { action, flags } = parseArgs(process.argv.slice(2));
  if (!action) {
    console.error('Usage: pod-cli <up|down|list|status> [flags]');
    process.exit(2);
  }

  const event = buildEvent(action, flags);
  const region = process.env.AWS_REGION ?? 'us-west-2';
  const fnName = process.env.POD_MANAGER_FN ?? 'pod-manager';

  const client = new LambdaClient({ region });
  const result = await client.send(
    new InvokeCommand({
      FunctionName: fnName,
      Payload: Buffer.from(JSON.stringify(event)),
      InvocationType: 'RequestResponse',
    }),
  );

  const payload = result.Payload ? new TextDecoder().decode(result.Payload) : '{}';
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    parsed = payload;
  }

  if (result.FunctionError) {
    console.error(`Lambda error (${result.FunctionError}):`);
    console.error(JSON.stringify(parsed, null, 2));
    process.exit(1);
  }

  console.log(JSON.stringify(parsed, null, 2));
  if (parsed && typeof parsed === 'object' && 'ok' in parsed && parsed.ok === false) {
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
