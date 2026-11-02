import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Runs runtime/vscode-tunnel/entrypoint.sh against a stub `code` binary on
// PATH. The stub appends its argv to a log file; `tunnel user show` exits 1
// ("not logged in", as the real CLI does) unless STUB_LOGGED_IN=1. With
// STUB_BLOCK=1 the serving `code tunnel` blocks until it is signalled, and
// `tunnel unregister` exits STUB_UNREGISTER_RC (default 0).

const ENTRYPOINT = resolve(import.meta.dirname, '../runtime/vscode-tunnel/entrypoint.sh');

const STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$STUB_LOG"
if [ "$*" = "tunnel user show" ]; then
  if [ "\${STUB_LOGGED_IN:-0}" = "1" ]; then echo "logged in"; exit 0; fi
  echo "not logged in"; exit 1
fi
if [ "$1 $2" = "tunnel --accept-server-license-terms" ] && [ "\${STUB_BLOCK:-0}" = "1" ]; then
  exec sleep 60
fi
if [ "$*" = "tunnel unregister" ]; then exit "\${STUB_UNREGISTER_RC:-0}"; fi
exit 0
`;

// Stands in for GNU coreutils `timeout`, which macOS lacks: drops `-k N` and
// the duration, then runs the rest. Keeps the SIGTERM tests host-independent.
const TIMEOUT_STUB = `#!/usr/bin/env bash
if [ "$1" = "-k" ]; then shift 2; fi
shift
exec "$@"
`;

// ssh-mode stubs log with a program-name prefix so they never collide with
// the bare `code` argv lines the tunnel cases assert on. The `sshd` stub
// blocks until SIGTERM when STUB_BLOCK=1 and records that it was signalled.
// The `ssh-keygen` stub writes placeholder key files at its `-f` path.
const SSHD_STUB = `#!/usr/bin/env bash
printf 'sshd %s\\n' "$*" >> "$STUB_LOG"
if [ "\${STUB_BLOCK:-0}" = "1" ]; then
  trap 'printf "sshd got TERM\\n" >> "$STUB_LOG"; exit 0' TERM
  sleep 60 &
  wait $!
fi
exit 0
`;

const SSH_KEYGEN_STUB = `#!/usr/bin/env bash
printf 'ssh-keygen %s\\n' "$*" >> "$STUB_LOG"
f=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-f" ]; then f="$2"; shift; fi
  shift
done
[ -n "$f" ] || exit 2
printf 'PRIVATE\\n' > "$f"
printf 'ssh-ed25519 AAAAstub host\\n' > "$f.pub"
exit 0
`;

let dir: string;
let log: string;
let home: string;
let workspace: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tunnel-entrypoint-'));
  log = join(dir, 'calls.log');
  home = join(dir, 'home');
  workspace = join(dir, 'workspace');
  mkdirSync(home);
  mkdirSync(workspace);
  for (const [name, body] of [
    ['code', STUB],
    ['timeout', TIMEOUT_STUB],
    ['sshd', SSHD_STUB],
    ['ssh-keygen', SSH_KEYGEN_STUB],
  ] as const) {
    writeFileSync(join(dir, name), body);
    chmodSync(join(dir, name), 0o755);
  }
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function readCallsFrom(path: string): string[] {
  try {
    return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
  } catch {
    return []; // no calls recorded
  }
}

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
  return { status: r.status, stderr: r.stderr, calls: readCallsFrom(log) };
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

  // Starts a logged-in, blocking tunnel, waits until it is serving (so the
  // trap is installed), sends SIGTERM and returns the exit code and stdout.
  async function runUntilSigterm(env: Record<string, string> = {}) {
    const child = spawn('bash', [ENTRYPOINT], {
      env: {
        PATH: `${dir}:${process.env.PATH ?? ''}`,
        HOME: dir,
        STUB_LOG: log,
        STUB_LOGGED_IN: '1',
        STUB_BLOCK: '1',
        POD_NAME: 'hello',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    const exited = new Promise<number | null>((res) => child.on('close', (code) => res(code)));

    const deadline = Date.now() + 5000;
    while (!readCallsFrom(log).includes('tunnel --accept-server-license-terms --name hello')) {
      if (Date.now() > deadline) {
        child.kill('SIGKILL');
        throw new Error(`tunnel never started: ${readCallsFrom(log).join(', ')}`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    child.kill('SIGTERM');
    return { status: await exited, stdout, calls: readCallsFrom(log) };
  }

  it('unregisters the tunnel on SIGTERM and logs the exit code before exiting', async () => {
    const r = await runUntilSigterm();
    expect(r.status, r.stdout).toBe(0);
    expect(r.calls).toEqual([
      'tunnel user show',
      'tunnel --accept-server-license-terms --name hello',
      'tunnel unregister',
    ]);
    const lines = r.stdout.split('\n');
    const start = lines.indexOf('on_term: unregistering tunnel hello');
    expect(start, r.stdout).toBeGreaterThanOrEqual(0);
    expect(lines.indexOf('on_term: code tunnel unregister exited 0'), r.stdout).toBeGreaterThan(
      start,
    );
  }, 15_000);

  it('logs a failed unregister and still exits 0 on SIGTERM', async () => {
    const r = await runUntilSigterm({ STUB_UNREGISTER_RC: '3' });
    expect(r.status, r.stdout).toBe(0);
    expect(r.calls.at(-1)).toBe('tunnel unregister');
    expect(r.stdout).toContain('on_term: code tunnel unregister exited 3');
  }, 15_000);
});

const TEST_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestKeyOnly user@laptop';
const SSHD_CALL = 'sshd -D -e -f /etc/ssh/cloud-dev-pods/sshd_config';

function sshEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    POD_MODE: 'ssh',
    REMOTE_BACKEND: 'ssm',
    SSH_AUTHORIZED_KEYS: TEST_KEY,
    CDP_HOME_DIR: home,
    CDP_WORKSPACE_DIR: workspace,
    ...extra,
  };
}

const mode = (p: string) => statSync(p).mode & 0o777;

describe('POD_MODE dispatch', () => {
  it('POD_MODE=tunnel produces exactly the unset-mode call sequence', () => {
    const r = run({ POD_MODE: 'tunnel' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls).toEqual([
      'tunnel user show',
      'tunnel user login --provider github',
      'tunnel --accept-server-license-terms --name hello',
    ]);
  });

  it('exits 64 for an unknown POD_MODE without calling anything', () => {
    const r = run({ POD_MODE: 'bogus' });
    expect(r.status).toBe(64);
    expect(r.stderr).toMatch(/POD_MODE/);
    expect(r.stderr).toMatch(/bogus/);
    expect(r.calls).toEqual([]);
  });
});

describe('ssh entrypoint', () => {
  it('starts sshd with the cloud-dev-pods config and never invokes code', () => {
    const r = run(sshEnv());
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls).toContain(SSHD_CALL);
    expect(r.calls.filter((c) => !c.startsWith('sshd ') && !c.startsWith('ssh-keygen '))).toEqual(
      [],
    );
  });

  it.each(['SSH_AUTHORIZED_KEYS', 'REMOTE_BACKEND'])(
    'exits 64 without starting sshd when %s is empty',
    (name) => {
      const r = run(sshEnv({ [name]: '' }));
      expect(r.status).toBe(64);
      expect(r.stderr).toMatch(name);
      expect(r.calls).toEqual([]);
    },
  );

  it('exits 64 for an unknown REMOTE_BACKEND without starting sshd', () => {
    const r = run(sshEnv({ REMOTE_BACKEND: 'bogus' }));
    expect(r.status).toBe(64);
    expect(r.stderr).toMatch(/REMOTE_BACKEND/);
    expect(r.calls).toEqual([]);
  });

  it.each(['ssm', 'cloudflare', 'tailscale'])('REMOTE_BACKEND=%s starts sshd', (backend) => {
    const r = run(sshEnv({ REMOTE_BACKEND: backend }));
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls.at(-1)).toBe(SSHD_CALL);
  });

  it('writes the authorized key with mode 0600 in a 0700 .ssh dir', () => {
    const r = run(sshEnv());
    expect(r.status, r.stderr).toBe(0);
    const ak = join(home, '.ssh', 'authorized_keys');
    expect(readFileSync(ak, 'utf8')).toBe(`${TEST_KEY}\n`);
    expect(mode(ak)).toBe(0o600);
    expect(mode(join(home, '.ssh'))).toBe(0o700);
  });

  it('generates the host key on the workspace when missing and copies it with mode 0600', () => {
    const r = run(sshEnv());
    expect(r.status, r.stderr).toBe(0);
    const canonical = join(workspace, '.cloud-dev-pods', 'ssh', 'ssh_host_ed25519_key');
    expect(r.calls).toContain(`ssh-keygen -q -t ed25519 -N  -f ${canonical}`);
    expect(existsSync(canonical)).toBe(true);
    expect(existsSync(`${canonical}.pub`)).toBe(true);
    const copy = join(home, '.ssh', 'sshd', 'ssh_host_ed25519_key');
    expect(readFileSync(copy, 'utf8')).toBe(readFileSync(canonical, 'utf8'));
    expect(readFileSync(`${copy}.pub`, 'utf8')).toBe(readFileSync(`${canonical}.pub`, 'utf8'));
    expect(mode(copy)).toBe(0o600);
  });

  it('reuses an existing workspace host key without regenerating it', () => {
    const keyDir = join(workspace, '.cloud-dev-pods', 'ssh');
    mkdirSync(keyDir, { recursive: true });
    writeFileSync(join(keyDir, 'ssh_host_ed25519_key'), 'EXISTING\n', { mode: 0o644 });
    writeFileSync(join(keyDir, 'ssh_host_ed25519_key.pub'), 'ssh-ed25519 AAAAexisting\n');
    const r = run(sshEnv());
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls.some((c) => c.startsWith('ssh-keygen '))).toBe(false);
    const copy = join(home, '.ssh', 'sshd', 'ssh_host_ed25519_key');
    expect(readFileSync(copy, 'utf8')).toBe('EXISTING\n');
    expect(mode(copy)).toBe(0o600);
  });

  it('exits 0 on SIGTERM after signalling the sshd child', async () => {
    const child = spawn('bash', [ENTRYPOINT], {
      env: {
        PATH: `${dir}:${process.env.PATH ?? ''}`,
        HOME: dir,
        STUB_LOG: log,
        STUB_BLOCK: '1',
        POD_NAME: 'hello',
        ...sshEnv(),
      },
      stdio: 'ignore',
    });
    const exited = new Promise<number | null>((res) => child.on('exit', (code) => res(code)));

    const deadline = Date.now() + 5000;
    while (!readCallsFrom(log).includes(SSHD_CALL)) {
      if (Date.now() > deadline) throw new Error(`sshd never started: ${readCallsFrom(log).join(', ')}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    // Give the stub a moment to install its TERM trap.
    await new Promise((r) => setTimeout(r, 200));
    child.kill('SIGTERM');

    expect(await exited).toBe(0);
    const calls = readCallsFrom(log);
    expect(calls).toContain('sshd got TERM');
    expect(calls.some((c) => !c.startsWith('sshd') && !c.startsWith('ssh-keygen'))).toBe(false);
  }, 15_000);
});
