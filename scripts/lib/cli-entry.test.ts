import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isInvokedAsCli } from './cli-entry.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Realpath the temp dir: on macOS os.tmpdir() itself lives under a symlink
// (/var -> /private/var), and the "real" side of each comparison must be real.
let tmp: string;
let realFile: string;
let otherFile: string;
let linkFile: string;
let linkDir: string;
let linkRoot: string;

beforeAll(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cli-entry-')));
  mkdirSync(join(tmp, 'real'));
  realFile = join(tmp, 'real', 'file.ts');
  otherFile = join(tmp, 'real', 'other.ts');
  writeFileSync(realFile, '');
  writeFileSync(otherFile, '');
  linkFile = join(tmp, 'link-file.ts');
  symlinkSync(realFile, linkFile);
  linkDir = join(tmp, 'link-dir');
  symlinkSync(join(tmp, 'real'), linkDir, 'dir');
  linkRoot = join(tmp, 'repo');
  symlinkSync(repoRoot, linkRoot, 'dir');
});

afterAll(() => {
  // Unlink the symlinks explicitly before removing the dir, so nothing can
  // ever recurse through the repo-root link into the checkout.
  for (const link of [linkRoot, linkDir, linkFile]) {
    try {
      unlinkSync(link);
    } catch {
      // already gone
    }
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe('isInvokedAsCli', () => {
  it('returns true when argv1 is a symlink to the module file', () => {
    expect(isInvokedAsCli(pathToFileURL(realFile).href, linkFile)).toBe(true);
  });

  it('returns true when argv1 goes through a symlinked directory', () => {
    expect(isInvokedAsCli(pathToFileURL(realFile).href, join(linkDir, 'file.ts'))).toBe(true);
  });

  it('returns true when argv1 is the real path itself', () => {
    expect(isInvokedAsCli(pathToFileURL(realFile).href, realFile)).toBe(true);
  });

  it('returns false for a different file', () => {
    expect(isInvokedAsCli(pathToFileURL(realFile).href, otherFile)).toBe(false);
  });

  it('returns false without throwing when argv1 is undefined', () => {
    expect(() => isInvokedAsCli(pathToFileURL(realFile).href, undefined)).not.toThrow();
    expect(isInvokedAsCli(pathToFileURL(realFile).href, undefined)).toBe(false);
  });

  it('returns false without throwing when argv1 does not exist', () => {
    const missing = join(tmp, 'does-not-exist.ts');
    expect(() => isInvokedAsCli(pathToFileURL(realFile).href, missing)).not.toThrow();
    expect(isInvokedAsCli(pathToFileURL(realFile).href, missing)).toBe(false);
  });
});

describe('symlinked CLI invocation (end-to-end)', () => {
  it('runs main() when a script is invoked through a symlinked repo root', () => {
    const tsx = join(repoRoot, 'node_modules', '.bin', 'tsx');
    const result = spawnSync(tsx, [join(linkRoot, 'scripts', 'tunnel-poll-logs.ts')], {
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Required: --log-group');
  }, 60_000);
});
