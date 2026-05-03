import { describe, expect, it } from 'vitest';
import { classify, matches, semverBump, type SyncToml } from './sync-upstream.js';

const TOML: SyncToml = {
  tracked: [
    'infra/lib/**',
    'runtime/**',
    'scripts/**',
    '.github/workflows/ci-*.yml',
    'CLAUDE.md',
    'README.md',
  ],
  merged: [
    '.github/workflows/*pod*.yml',
    '.github/workflows/cluster-*.yml',
    '.github/workflows/bootstrap-aws.yml',
    'package.json',
    'package-lock.json',
  ],
  user: [
    'infra/config.local.ts',
    'infra/extensions.local.ts',
    'config/config.yaml',
    '*.local.*',
    '.github/CODEOWNERS',
  ],
};

describe('classify', () => {
  it('classes infra/lib paths as tracked', () => {
    expect(classify('infra/lib/stacks/foo.ts', TOML)).toBe('tracked');
    expect(classify('infra/lib/constructs/bar.ts', TOML)).toBe('tracked');
  });

  it('classes runtime + scripts as tracked', () => {
    expect(classify('runtime/vscode-browser/Dockerfile', TOML)).toBe('tracked');
    expect(classify('scripts/pod-cli.ts', TOML)).toBe('tracked');
  });

  it('classes ci-* workflows as tracked', () => {
    expect(classify('.github/workflows/ci-lint.yml', TOML)).toBe('tracked');
    expect(classify('.github/workflows/ci-test.yml', TOML)).toBe('tracked');
  });

  it('classes pod-* workflows as merged', () => {
    expect(classify('.github/workflows/pod-up.yml', TOML)).toBe('merged');
    expect(classify('.github/workflows/pod-down.yml', TOML)).toBe('merged');
    expect(classify('.github/workflows/pod-list.yml', TOML)).toBe('merged');
  });

  it('classes cluster-* workflows as merged', () => {
    expect(classify('.github/workflows/cluster-up.yml', TOML)).toBe('merged');
    expect(classify('.github/workflows/cluster-down.yml', TOML)).toBe('merged');
  });

  it('classes package.json as merged', () => {
    expect(classify('package.json', TOML)).toBe('merged');
    expect(classify('package-lock.json', TOML)).toBe('merged');
  });

  it('classes user-only paths as user', () => {
    expect(classify('infra/config.local.ts', TOML)).toBe('user');
    expect(classify('infra/extensions.local.ts', TOML)).toBe('user');
    expect(classify('config/config.yaml', TOML)).toBe('user');
    expect(classify('.github/CODEOWNERS', TOML)).toBe('user');
  });

  it('user takes precedence over tracked/merged', () => {
    // infra/config.local.ts could match infra/lib/** with looser patterns;
    // user check runs first, so it wins.
    expect(classify('infra/config.local.ts', TOML)).toBe('user');
  });

  it('returns unmatched for unknown paths', () => {
    expect(classify('totally/random/path.txt', TOML)).toBe('unmatched');
    expect(classify('docs/random.md', TOML)).toBe('unmatched');
  });

  it('classifies CLAUDE.md as tracked', () => {
    expect(classify('CLAUDE.md', TOML)).toBe('tracked');
  });
});

describe('matches', () => {
  it('does globstar matching', () => {
    expect(matches('infra/lib/foo/bar.ts', 'infra/lib/**')).toBe(true);
  });

  it('does single-segment wildcard matching', () => {
    expect(matches('.github/workflows/pod-up.yml', '.github/workflows/*pod*.yml')).toBe(true);
    expect(matches('.github/workflows/ci-pod.yml', '.github/workflows/*pod*.yml')).toBe(true);
    expect(matches('.github/workflows/release.yml', '.github/workflows/*pod*.yml')).toBe(false);
  });

  it('respects literal paths', () => {
    expect(matches('CLAUDE.md', 'CLAUDE.md')).toBe(true);
    expect(matches('claude.md', 'CLAUDE.md')).toBe(false);
  });
});

describe('semverBump', () => {
  it('detects patch', () => expect(semverBump('1.0.0', '1.0.1')).toBe('patch'));
  it('detects minor', () => expect(semverBump('1.0.0', '1.1.0')).toBe('minor'));
  it('detects major', () => expect(semverBump('1.0.0', '2.0.0')).toBe('major'));
  it('detects no change', () => expect(semverBump('1.0.0', '1.0.0')).toBe('none'));

  it('classifies major even if minor regresses', () => {
    expect(semverBump('1.5.0', '2.0.0')).toBe('major');
  });

  it('handles missing parts', () => {
    expect(semverBump('1', '1.0.1')).toBe('patch');
    expect(semverBump('', '1.0.0')).toBe('major');
  });
});
