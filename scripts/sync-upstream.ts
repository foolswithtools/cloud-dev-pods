#!/usr/bin/env node
/**
 * Sync from foolswithtools/cloud-dev-pods into the user's fork.
 *
 * Algorithm (see docs/adr/0006-tracked-merged-user-sync-taxonomy.md):
 *   1. Read .upstream-sync.toml -> tracked / merged / user globs.
 *   2. Fetch upstream/main; record its SHA.
 *   3. Read .upstream-sync.state to find LAST_SYNCED_SHA. If absent,
 *      use `git merge-base HEAD upstream/main`.
 *   4. Diff LAST_SYNCED -> upstream/main. For each changed path:
 *        [user]    skip
 *        [tracked] git checkout upstream/main -- <path>
 *        [merged]  three-way merge via git merge-file
 *        unmatched default to [tracked] with a warning.
 *   5. Write the new SHA to .upstream-sync.state.
 *   6. Emit a JSON summary on stdout for the workflow to consume.
 *
 * The script only modifies the working tree and writes the state file;
 * peter-evans/create-pull-request then commits + opens the PR.
 *
 * Edge cases handled:
 *   - Path added in upstream (not in HEAD or LAST_SYNCED): tracked behavior.
 *   - Path deleted in upstream (HEAD unchanged from LAST_SYNCED): delete locally.
 *   - Path deleted in upstream (HEAD modified): keep local, warn.
 *
 * Usage:
 *   tsx scripts/sync-upstream.ts [--upstream-url <url>] [--upstream-branch <name>]
 *
 * Output (stdout, JSON):
 *   {
 *     fromSha, toSha, filesChanged, conflicted, versionBump,
 *     tracked, merged, skipped, deleted
 *   }
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { minimatch } from 'minimatch';
import { parse as parseToml } from 'smol-toml';

const REPO_ROOT = process.cwd();
const TOML_PATH = join(REPO_ROOT, '.upstream-sync.toml');
const STATE_PATH = join(REPO_ROOT, '.upstream-sync.state');
const DEFAULT_UPSTREAM_URL = 'https://github.com/foolswithtools/cloud-dev-pods.git';
const DEFAULT_UPSTREAM_BRANCH = 'main';

export interface SyncToml {
  tracked: string[];
  merged: string[];
  user: string[];
}

export type Classification = 'tracked' | 'merged' | 'user' | 'unmatched';

interface SyncResult {
  fromSha: string;
  toSha: string;
  filesChanged: number;
  tracked: string[];
  merged: string[];
  conflicted: string[];
  skipped: string[];
  deleted: string[];
  unmatched: string[];
  versionBump: VersionBump;
}

export interface VersionBump {
  kind: 'patch' | 'minor' | 'major' | 'none';
  from: string;
  to: string;
}

function git(args: string[], opts: { allowFail?: boolean; encoding?: 'utf8' | 'buffer' } = {}): string {
  try {
    return execFileSync('git', args, {
      cwd: REPO_ROOT,
      encoding: opts.encoding ?? 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as string;
  } catch (err) {
    if (opts.allowFail) return '';
    throw err;
  }
}

function loadToml(): SyncToml {
  if (!existsSync(TOML_PATH)) {
    throw new Error(`Missing ${TOML_PATH}`);
  }
  const raw = readFileSync(TOML_PATH, 'utf8');
  const parsed = parseToml(raw) as Record<string, { paths?: string[] }>;
  return {
    tracked: parsed.tracked?.paths ?? [],
    merged: parsed.merged?.paths ?? [],
    user: parsed.user?.paths ?? [],
  };
}

function ensureUpstreamRemote(url: string): void {
  const remotes = git(['remote'], { allowFail: true })
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!remotes.includes('upstream')) {
    git(['remote', 'add', 'upstream', url]);
  } else {
    // Re-set the URL in case the user changed upstream-url.
    git(['remote', 'set-url', 'upstream', url]);
  }
}

function fetchUpstream(branch: string): string {
  git(['fetch', '--quiet', 'upstream', branch]);
  return git(['rev-parse', `upstream/${branch}`]).trim();
}

function getLastSyncedSha(branch: string): string {
  if (existsSync(STATE_PATH)) {
    const raw = readFileSync(STATE_PATH, 'utf8').trim();
    if (raw) return raw;
  }
  // First-ever sync: use merge-base as a baseline so we don't try to
  // re-replay the entire history.
  return git(['merge-base', 'HEAD', `upstream/${branch}`]).trim();
}

interface ChangeEntry {
  status: 'A' | 'M' | 'D' | string; // A=added, M=modified, D=deleted (from upstream's POV)
  path: string;
}

function getChangedFiles(fromSha: string, toSha: string): ChangeEntry[] {
  const out = git(['diff', '--name-status', '-z', fromSha, toSha]);
  const entries: ChangeEntry[] = [];
  const tokens = out.split('\0').filter(Boolean);
  for (let i = 0; i < tokens.length; i += 2) {
    const status = tokens[i];
    const path = tokens[i + 1];
    if (status && path) entries.push({ status: status[0] ?? 'M', path });
  }
  return entries;
}

export function classify(path: string, toml: SyncToml): Classification {
  for (const pattern of toml.user) if (matches(path, pattern)) return 'user';
  for (const pattern of toml.merged) if (matches(path, pattern)) return 'merged';
  for (const pattern of toml.tracked) if (matches(path, pattern)) return 'tracked';
  return 'unmatched';
}

export function matches(path: string, pattern: string): boolean {
  return minimatch(path, pattern, { matchBase: false, dot: true, nocase: false });
}

function applyTracked(path: string, toSha: string): void {
  // Use git's checkout-from-commit to overwrite the working tree.
  // If the path doesn't exist at toSha (i.e., upstream deletion), we need
  // a different code path (handled by caller's status check).
  git(['checkout', toSha, '--', path]);
}

function deleteIfPresent(path: string): void {
  if (existsSync(join(REPO_ROOT, path))) {
    git(['rm', '-f', '--quiet', '--', path], { allowFail: true });
  }
}

function gitShowOrEmpty(sha: string, path: string): string {
  const out = execFileSync('git', ['show', `${sha}:${path}`], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return out;
}

function tryGitShow(sha: string, path: string): string | null {
  try {
    return gitShowOrEmpty(sha, path);
  } catch {
    return null;
  }
}

interface MergeOutcome {
  conflicted: boolean;
  written: boolean;
}

function mergeFile(path: string, fromSha: string, toSha: string): MergeOutcome {
  const ours = tryGitShow('HEAD', path);
  const base = tryGitShow(fromSha, path);
  const theirs = tryGitShow(toSha, path);

  // If the path doesn't exist at HEAD, just take upstream (treat as tracked).
  if (ours === null) {
    if (theirs !== null) {
      writeFileSync(join(REPO_ROOT, path), theirs);
      return { conflicted: false, written: true };
    }
    return { conflicted: false, written: false };
  }

  // If upstream deleted the file: keep ours if user modified vs base; else drop.
  if (theirs === null) {
    if (base !== null && ours === base) {
      deleteIfPresent(path);
      return { conflicted: false, written: true };
    }
    return { conflicted: false, written: false }; // user has changes, keep them
  }

  // No base: degenerate case. Pick upstream's content.
  if (base === null) {
    writeFileSync(join(REPO_ROOT, path), theirs);
    return { conflicted: false, written: true };
  }

  // True three-way merge.
  const tmp = mkdtempSync(join(tmpdir(), 'cdp-sync-'));
  const oursPath = join(tmp, 'ours');
  const basePath = join(tmp, 'base');
  const theirsPath = join(tmp, 'theirs');
  writeFileSync(oursPath, ours);
  writeFileSync(basePath, base);
  writeFileSync(theirsPath, theirs);

  let conflict = false;
  try {
    // -p prints to stdout; non-zero exit indicates conflict count.
    const merged = execFileSync(
      'git',
      ['merge-file', '-p', '--diff3', oursPath, basePath, theirsPath],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    writeFileSync(join(REPO_ROOT, path), merged);
  } catch (err) {
    // Exit code > 0 = conflicts (output still on stdout via err.stdout).
    const stdout = (err as { stdout?: Buffer | string }).stdout;
    if (stdout) {
      const merged = typeof stdout === 'string' ? stdout : stdout.toString('utf8');
      writeFileSync(join(REPO_ROOT, path), merged);
      conflict = true;
    } else {
      throw err;
    }
  } finally {
    try { unlinkSync(oursPath); unlinkSync(basePath); unlinkSync(theirsPath); } catch { /* noop */ }
  }

  return { conflicted: conflict, written: true };
}

function detectVersionBump(fromSha: string, toSha: string): VersionBump {
  const fromPkg = tryGitShow(fromSha, 'package.json');
  const toPkg = tryGitShow(toSha, 'package.json');
  if (!fromPkg || !toPkg) return { kind: 'none', from: '', to: '' };
  const fromV = (JSON.parse(fromPkg) as { version?: string }).version ?? '';
  const toV = (JSON.parse(toPkg) as { version?: string }).version ?? '';
  if (fromV === toV) return { kind: 'none', from: fromV, to: toV };
  return { kind: semverBump(fromV, toV), from: fromV, to: toV };
}

export function semverBump(a: string, b: string): VersionBump['kind'] {
  const parse = (v: string): [number, number, number] => {
    const parts = v.split('.').map((p) => Number.parseInt(p, 10));
    const ints: [number, number, number] = [
      Number.isFinite(parts[0] ?? NaN) ? (parts[0] as number) : 0,
      Number.isFinite(parts[1] ?? NaN) ? (parts[1] as number) : 0,
      Number.isFinite(parts[2] ?? NaN) ? (parts[2] as number) : 0,
    ];
    return ints;
  };
  const [aMaj, aMin, aPat] = parse(a);
  const [bMaj, bMin, bPat] = parse(b);
  if (bMaj > aMaj) return 'major';
  if (bMin > aMin) return 'minor';
  if (bPat > aPat) return 'patch';
  return 'none';
}

function ensureDir(path: string): void {
  const dir = dirname(path);
  if (dir && dir !== '.' && !existsSync(dir)) {
    execFileSync('mkdir', ['-p', dir], { cwd: REPO_ROOT });
  }
}

function parseArgs(argv: string[]): { upstreamUrl: string; upstreamBranch: string } {
  const get = (key: string, fallback: string): string => {
    const idx = argv.indexOf(`--${key}`);
    return idx >= 0 && argv[idx + 1] ? (argv[idx + 1] as string) : fallback;
  };
  return {
    upstreamUrl: get('upstream-url', DEFAULT_UPSTREAM_URL),
    upstreamBranch: get('upstream-branch', DEFAULT_UPSTREAM_BRANCH),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const toml = loadToml();
  ensureUpstreamRemote(args.upstreamUrl);
  const toSha = fetchUpstream(args.upstreamBranch);
  const fromSha = getLastSyncedSha(args.upstreamBranch);

  if (toSha === fromSha) {
    console.log(JSON.stringify({
      fromSha, toSha, filesChanged: 0, tracked: [], merged: [],
      conflicted: [], skipped: [], deleted: [], unmatched: [],
      versionBump: { kind: 'none', from: '', to: '' } as VersionBump,
    }));
    return;
  }

  const changes = getChangedFiles(fromSha, toSha);
  const result: SyncResult = {
    fromSha, toSha, filesChanged: changes.length,
    tracked: [], merged: [], conflicted: [], skipped: [], deleted: [], unmatched: [],
    versionBump: detectVersionBump(fromSha, toSha),
  };

  for (const { status, path } of changes) {
    const klass = classify(path, toml);
    if (klass === 'user') {
      result.skipped.push(path);
      continue;
    }
    if (klass === 'unmatched') {
      result.unmatched.push(path);
    }

    if (status === 'D') {
      // Deleted upstream — only delete locally if HEAD matches base.
      const ours = tryGitShow('HEAD', path);
      const base = tryGitShow(fromSha, path);
      if (ours !== null && base !== null && ours === base) {
        deleteIfPresent(path);
        result.deleted.push(path);
      } else {
        result.skipped.push(path);
      }
      continue;
    }

    ensureDir(join(REPO_ROOT, path));

    if (klass === 'tracked' || klass === 'unmatched') {
      applyTracked(path, toSha);
      result.tracked.push(path);
    } else {
      // merged
      const outcome = mergeFile(path, fromSha, toSha);
      if (outcome.written) {
        result.merged.push(path);
        if (outcome.conflicted) result.conflicted.push(path);
      } else {
        result.skipped.push(path);
      }
    }
  }

  // Stage state file. peter-evans picks up working-tree changes; explicit
  // write so the next run starts from this SHA.
  writeFileSync(STATE_PATH, `${toSha}\n`);

  console.log(JSON.stringify(result, null, 2));
  void resolve;  // unused import guard removed below
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
    process.stderr.write(`sync-upstream: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  });
}
