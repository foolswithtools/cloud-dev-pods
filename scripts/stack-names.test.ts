import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { parseStackNamesArgs, resolveStackNames } from './stack-names.js';

const REPO = resolve(import.meta.dirname, '..');
const SCRIPT = resolve(import.meta.dirname, 'stack-names.ts');
const TSX = resolve(REPO, 'node_modules/.bin/tsx');

// Write config.example.yaml with naming.prefix overridden (or removed, for
// the schema default) and run the CLI against it, as the workflows do.
function runCli(args: string[], prefix: string | undefined) {
  const example = parse(readFileSync(resolve(REPO, 'config/config.example.yaml'), 'utf8')) as Record<string, unknown>;
  example.naming = prefix === undefined ? {} : { prefix };
  const dir = mkdtempSync(join(tmpdir(), 'stack-names-'));
  const path = join(dir, 'config.yaml');
  writeFileSync(path, stringify(example));
  return spawnSync(TSX, [SCRIPT, ...args], {
    cwd: REPO,
    env: { ...process.env, CDPODS_CONFIG: path },
    encoding: 'utf8',
  });
}

describe('parseStackNamesArgs', () => {
  it.each([
    ['--cluster', 'cluster'],
    ['--bootstrap', 'bootstrap'],
    ['--cluster-stack', 'cluster-stack'],
    ['--all', 'all'],
    ['--prefix', 'prefix'],
  ])('%s selects %s', (flag, mode) => {
    expect(parseStackNamesArgs([flag])).toEqual({ mode });
  });

  it.each([[[]], [['--nope']], [['--cluster', '--all']]])('rejects %j', (argv) => {
    expect(parseStackNamesArgs(argv)).toHaveProperty('error');
  });
});

describe('resolveStackNames', () => {
  it('lists the cluster stacks in deploy order', async () => {
    expect(await resolveStackNames('Acme', 'cluster')).toEqual({
      names: ['Acme-Network', 'Acme-Cluster', 'Acme-PodTaskFamily', 'Acme-PodManager', 'Acme-IdleReaper'],
    });
  });

  it('returns the bootstrap stack alone', async () => {
    expect(await resolveStackNames('Acme', 'bootstrap')).toEqual({ names: ['Acme-Bootstrap'] });
  });

  it('returns the Cluster stack alone', async () => {
    expect(await resolveStackNames('Acme', 'cluster-stack')).toEqual({ names: ['Acme-Cluster'] });
  });

  it.each(['', 'has space', 'under_score', '9starts-with-digit'])(
    'refuses prefix %j, which CloudFormation would reject',
    async (prefix) => {
      expect(await resolveStackNames(prefix, 'cluster')).toHaveProperty('error');
    },
  );
});

describe('stack-names CLI', () => {
  it('prints the default-prefix cluster stacks', () => {
    const r = runCli(['--cluster'], undefined);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe(
      'CloudDevPods-Network CloudDevPods-Cluster CloudDevPods-PodTaskFamily CloudDevPods-PodManager CloudDevPods-IdleReaper',
    );
  });

  it('follows a custom prefix', () => {
    const r = runCli(['--bootstrap'], 'AcmePods');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe('AcmePods-Bootstrap');
  });

  it('fails with nothing on stdout for an invalid prefix', () => {
    const r = runCli(['--cluster'], 'bad prefix');
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('::error::');
  });
});
