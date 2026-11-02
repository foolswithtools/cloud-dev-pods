import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drainForClusterDown, writeProceedOutput, type DrainResult } from './cluster-drain.js';
import type { InvokeOutcome } from './pod-cli.js';

// A fake pod-manager invoke: answers each call from a scripted queue and
// records every event it receives. No AWS calls, no mocking library.
function fakeInvoke(script: InvokeOutcome[]) {
  const events: Record<string, unknown>[] = [];
  const queue = [...script];
  const invoke = async (event: Record<string, unknown>): Promise<InvokeOutcome> => {
    events.push(event);
    const next = queue.shift();
    if (!next) throw new Error(`fakeInvoke: unexpected call ${JSON.stringify(event)}`);
    return next;
  };
  return { invoke, events };
}

const ok = (payload: unknown): InvokeOutcome => ({ ok: true, payload });
const listOf = (...names: string[]) =>
  ok({ ok: true, status: 'ok', pods: names.map((podName) => ({ podName, mode: 'tunnel' })) });
const downOk = (podName: string) => ok({ ok: true, status: 'ok', podName, message: 'stopped' });

async function run(force: boolean, script: InvokeOutcome[]) {
  const { invoke, events } = fakeInvoke(script);
  const lines: string[] = [];
  const result = await drainForClusterDown({ force, invoke, log: (l) => lines.push(l) });
  return { result, events, lines };
}

describe('drainForClusterDown', () => {
  it('proceeds with no pods and calls no down', async () => {
    const { result, events } = await run(false, [ok({ ok: true, status: 'ok', pods: [] })]);
    expect(result.proceed).toBe(true);
    expect(result.podNames).toEqual([]);
    expect(events).toEqual([{ action: 'list' }]);
  });

  it('refuses when the list invoke errors (Lambda not found)', async () => {
    const err = 'Function not found: arn:aws:lambda:us-west-2:123456789012:function:pod-manager';
    const { result, events } = await run(false, [{ ok: false, error: err }]);
    expect(result.proceed).toBe(false);
    expect(result.reason).toContain(err);
    expect(events).toHaveLength(1);
  });

  it('refuses when list returns ok:false (today this destroys without force)', async () => {
    const { result, events } = await run(false, [ok({ ok: false, status: 'error', message: 'boom' })]);
    expect(result.proceed).toBe(false);
    expect(result.reason).toContain('boom');
    expect(events).toHaveLength(1);
  });

  it('refuses when list has no pods key', async () => {
    const { result } = await run(false, [ok({ ok: true })]);
    expect(result.proceed).toBe(false);
    expect(result.reason).toMatch(/pods/);
  });

  it('refuses when list pods is not an array', async () => {
    const { result } = await run(true, [ok({ ok: true, pods: 'x' })]);
    expect(result.proceed).toBe(false);
    expect(result.reason).toMatch(/pods/);
  });

  it('refuses two pods without force, naming both and force=true', async () => {
    const { result, events } = await run(false, [listOf('alpha', 'beta')]);
    expect(result.proceed).toBe(false);
    expect(result.reason).toContain('alpha');
    expect(result.reason).toContain('beta');
    expect(result.reason).toContain('force=true');
    expect(result.podNames).toEqual(['alpha', 'beta']);
    expect(events.filter((e) => e.action === 'down')).toEqual([]);
  });

  it('drains two pods with force and proceeds once the re-list is empty', async () => {
    const { result, events } = await run(true, [
      listOf('alpha', 'beta'),
      downOk('alpha'),
      downOk('beta'),
      listOf(),
    ]);
    expect(result.proceed).toBe(true);
    expect(events).toEqual([
      { action: 'list' },
      { action: 'down', podName: 'alpha', keepWorkspace: true },
      { action: 'down', podName: 'beta', keepWorkspace: true },
      { action: 'list' },
    ]);
  });

  it('keeps draining after a failed down, then refuses naming the failed pod', async () => {
    const { result, events } = await run(true, [
      listOf('alpha', 'beta'),
      ok({ ok: false, status: 'error', message: 'ecs said no' }),
      downOk('beta'),
    ]);
    expect(result.proceed).toBe(false);
    expect(result.reason).toContain('alpha');
    expect(result.reason).not.toContain('beta');
    expect(events).toEqual([
      { action: 'list' },
      { action: 'down', podName: 'alpha', keepWorkspace: true },
      { action: 'down', podName: 'beta', keepWorkspace: true },
    ]);
  });

  it('treats a down invoke error as a failed down', async () => {
    const { result, events } = await run(true, [
      listOf('alpha', 'beta'),
      downOk('alpha'),
      { ok: false, error: 'Lambda error (Unhandled)' },
    ]);
    expect(result.proceed).toBe(false);
    expect(result.reason).toContain('beta');
    expect(events).toHaveLength(3);
  });

  it('refuses when the re-list still shows a pod, naming it', async () => {
    const { result } = await run(true, [
      listOf('alpha', 'beta'),
      downOk('alpha'),
      downOk('beta'),
      listOf('beta'),
    ]);
    expect(result.proceed).toBe(false);
    expect(result.reason).toContain('beta');
    expect(result.podNames).toEqual(['beta']);
  });

  it('refuses when the re-list fails', async () => {
    const { result } = await run(true, [
      listOf('alpha', 'beta'),
      downOk('alpha'),
      downOk('beta'),
      ok({ ok: false, status: 'error', message: 'registry scan failed' }),
    ]);
    expect(result.proceed).toBe(false);
    expect(result.reason).toContain('registry scan failed');
  });
});

describe('cluster-drain CLI', () => {
  const SCRIPT = resolve(import.meta.dirname, 'cluster-drain.ts');

  it('rejects an unknown flag with usage before any AWS call', { timeout: 60_000 }, () => {
    // Point the SDK at an unroutable endpoint and strip credentials, so an
    // invoke attempt would surface as a different error, not the usage line.
    const r = spawnSync(process.execPath, ['--import', 'tsx', SCRIPT, '--bogus'], {
      env: {
        PATH: process.env.PATH,
        AWS_REGION: 'us-west-2',
        AWS_ENDPOINT_URL_LAMBDA: 'http://127.0.0.1:9',
        AWS_ACCESS_KEY_ID: '',
        AWS_SECRET_ACCESS_KEY: '',
      },
      encoding: 'utf8',
    });
    expect(r.status).not.toBe(0);
    expect(r.status).not.toBeNull();
    expect(r.stderr).toContain('Usage: cluster-drain [--force]');
    expect(r.stderr).toContain('--bogus');
    expect(r.stdout).toBe('');
  });
});

describe('writeProceedOutput', () => {
  let dir: string;
  beforeAll(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'drain-output-')));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const result = (proceed: boolean): DrainResult => ({ proceed, reason: 'r', podNames: [] });

  it('writes proceed=true when the drain decided to proceed', () => {
    const out = join(dir, 'proceed');
    writeProceedOutput(result(true), out);
    expect(readFileSync(out, 'utf8')).toBe('proceed=true\n');
  });

  it('writes nothing when the drain refused', () => {
    const out = join(dir, 'refused');
    writeProceedOutput(result(false), out);
    expect(existsSync(out)).toBe(false);
  });

  it('does nothing when no output path is set', () => {
    expect(() => writeProceedOutput(result(true), undefined)).not.toThrow();
  });
});

// End-to-end: run the real script through a symlinked repo root (the #194
// shape) against a fake pod-manager Lambda on localhost. Nothing reaches AWS.
describe('cluster-drain CLI proceed marker (symlinked path, fake Lambda)', () => {
  const repoRoot = resolve(import.meta.dirname, '..');
  let tmp: string;
  let linkRoot: string;
  let server: Server;
  let port: number;
  let listPayload: unknown;

  beforeAll(async () => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'drain-cli-')));
    linkRoot = join(tmp, 'repo');
    symlinkSync(repoRoot, linkRoot, 'dir');
    // Every Invoke gets the current list payload; the SDK reads the body as the Lambda Payload.
    server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(listPayload));
      });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    // Unlink the repo-root symlink before removing the dir, so rmSync can never recurse into the checkout.
    try {
      unlinkSync(linkRoot);
    } catch {
      // already gone
    }
    rmSync(tmp, { recursive: true, force: true });
    await new Promise<void>((done) => server.close(() => done()));
  });

  // Async spawn (not spawnSync): the fake Lambda lives in this process's event loop.
  function runCli(outputFile: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
    const tsx = join(repoRoot, 'node_modules', '.bin', 'tsx');
    return new Promise((done, fail) => {
      const child = spawn(tsx, [join(linkRoot, 'scripts', 'cluster-drain.ts')], {
        env: {
          PATH: process.env.PATH,
          AWS_REGION: 'us-west-2',
          AWS_ENDPOINT_URL_LAMBDA: `http://127.0.0.1:${port}`,
          AWS_ACCESS_KEY_ID: 'test',
          AWS_SECRET_ACCESS_KEY: 'test',
          AWS_EC2_METADATA_DISABLED: 'true',
          GITHUB_OUTPUT: outputFile,
        },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      child.on('error', fail);
      child.on('close', (status) => done({ status, stdout, stderr }));
    });
  }

  it('writes proceed=true to $GITHUB_OUTPUT when no pods are registered', { timeout: 60_000 }, async () => {
    listPayload = { ok: true, status: 'ok', pods: [] };
    const out = join(tmp, 'output-proceed');
    const r = await runCli(out);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('No pods registered');
    expect(readFileSync(out, 'utf8')).toBe('proceed=true\n');
  });

  it('writes no marker when a pod is registered and force is off', { timeout: 60_000 }, async () => {
    listPayload = { ok: true, status: 'ok', pods: [{ podName: 'alpha', mode: 'tunnel' }] };
    const out = join(tmp, 'output-refused');
    const r = await runCli(out);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('alpha');
    expect(existsSync(out) ? readFileSync(out, 'utf8') : '').not.toContain('proceed');
  });
});
