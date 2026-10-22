import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Runs runtime/vscode-tunnel/entrypoint.sh against a stub `code` binary on
// PATH. The stub appends its argv to a log file; `tunnel user show` exits 1
// ("not logged in", as the real CLI does) unless STUB_LOGGED_IN=1.

const ENTRYPOINT = resolve(import.meta.dirname, '../runtime/vscode-tunnel/entrypoint.sh');

const STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$STUB_LOG"
if [ "$*" = "tunnel user show" ]; then
  if [ "\${STUB_LOGGED_IN:-0}" = "1" ]; then echo "logged in"; exit 0; fi
  echo "not logged in"; exit 1
fi
exit 0
`;

let dir: string;
let log: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tunnel-entrypoint-'));
  log = join(dir, 'calls.log');
  writeFileSync(join(dir, 'code'), STUB);
  chmodSync(join(dir, 'code'), 0o755);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(env: Record<string, string>) {
  const r = spawnSync('bash', [ENTRYPOINT], {
    env: {
      PATH: `${dir}:${process.env.PATH ?? ''}`,
      HOME: dir,
      STUB_LOG: log,
      POD_NAME: 'hello',
      ...env,
    },
    encoding: 'utf8',
  });
  let calls: string[] = [];
  try {
    calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
  } catch {
    // no calls recorded
  }
  return { status: r.status, stderr: r.stderr, calls };
}

describe('tunnel entrypoint', () => {
  it('logs in with --provider microsoft when TUNNEL_PROVIDER=microsoft, then starts the tunnel', () => {
    const r = run({ TUNNEL_PROVIDER: 'microsoft' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls).toEqual([
      'tunnel user show',
      'tunnel user login --provider microsoft',
      'tunnel --accept-server-license-terms --name hello',
    ]);
  });

  it('logs in with --provider github by default', () => {
    const r = run({});
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls).toContain('tunnel user login --provider github');
    expect(r.calls.at(-1)).toBe('tunnel --accept-server-license-terms --name hello');
  });

  it('treats an empty TUNNEL_PROVIDER as the github default', () => {
    const r = run({ TUNNEL_PROVIDER: '' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls).toContain('tunnel user login --provider github');
  });

  it('skips login when the CLI is already logged in', () => {
    const r = run({ TUNNEL_PROVIDER: 'microsoft', STUB_LOGGED_IN: '1' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls).toEqual([
      'tunnel user show',
      'tunnel --accept-server-license-terms --name hello',
    ]);
  });

  it('exits non-zero for an unknown provider without calling the CLI', () => {
    const r = run({ TUNNEL_PROVIDER: 'okta' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/TUNNEL_PROVIDER/);
    expect(r.calls).toEqual([]);
  });

  it('exits non-zero when POD_NAME is missing', () => {
    const r = run({ POD_NAME: '' });
    expect(r.status).not.toBe(0);
    expect(r.calls).toEqual([]);
  });
});
