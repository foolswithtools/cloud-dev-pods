import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  nextSteps,
  parseInitFlags,
  parseInteractiveFlags,
  parseUserList,
  promptRetainWorkspaces,
  RETAIN_WORKSPACES_PROMPT,
  renderConfigYaml,
  validateOrg,
  type Answers,
} from './init-clone.js';

// Dynamic import: a static `import '../infra/...'` fails `tsc -b scripts`
// with TS6059 because the file sits outside scripts/'s rootDir.
interface ResolvedBrowser {
  provider: 'github' | 'entra-id' | 'oidc';
  issuerUrl?: string;
  allowedOrg?: string;
  allowedUsers: string[];
  allowedGroups: string[];
  allowedEmailDomains: string[];
  allowedTenants: string[];
  ownerOnly: boolean;
}
interface ResolvedConfig {
  domain: { strategy: 'byo' | 'alb-default'; baseDomain?: string; hostedZoneId?: string };
  auth: { browser: ResolvedBrowser; tunnel: { provider: 'github' | 'microsoft' } };
  efs?: { retainOnClusterDown: boolean };
}

const { resolveConfig } = (await import(
  pathToFileURL(resolve(import.meta.dirname, '../infra/lib/config/schema.ts')).href
)) as {
  resolveConfig: (input: unknown) => { config: ResolvedConfig; warnings: string[] };
};
const { assertBrowserAuthRestricted } = (await import(
  pathToFileURL(resolve(import.meta.dirname, '../infra/lambda/pod-manager/auth-guard.ts')).href
)) as {
  assertBrowserAuthRestricted: (b: ResolvedBrowser) => { ok: true } | { ok: false; message: string };
};

const TENANT = '11111111-2222-3333-4444-555555555555';
const GROUP = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function answers(allowedUsers: string[], allowedOrg: string): Answers {
  return {
    awsAccountId: '123456789012',
    awsRegion: 'us-west-2',
    githubOwner: 'alice',
    githubRepo: 'cloud-dev-pods',
    browserProvider: 'github',
    domainStrategy: 'alb-default',
    baseDomain: '',
    hostedZoneId: '',
    allowedUsers,
    allowedOrg,
    entraTenantId: '',
    entraGroups: [],
    ownerOnly: false,
    tunnelProvider: 'github',
    vpcCidr: '10.50.0.0/16',
    cpu: 1024,
    memory: 2048,
    idleMinutes: 60,
    retainWorkspaces: false,
  };
}

const CASES: { name: string; users: string[]; org?: string }[] = [
  // Built from the CSV the same way the users prompt does.
  { name: 'solo', users: parseUserList(' alice, bob ,,') },
  { name: 'org', users: [], org: 'acme' },
  { name: 'both', users: ['alice'], org: 'acme' },
  { name: 'none', users: [] },
];

describe('parseUserList', () => {
  it('trims entries and drops empties', () => {
    expect(parseUserList(' alice, bob ,,')).toEqual(['alice', 'bob']);
  });
});

describe('validateOrg', () => {
  it('refuses a blank or whitespace-only org', () => {
    expect(validateOrg('')).toBeTypeOf('string');
    expect(validateOrg('   ')).toBeTypeOf('string');
  });
  it('accepts a login', () => {
    expect(validateOrg(' acme ')).toBeUndefined();
  });
});

describe('renderConfigYaml', () => {
  for (const c of CASES) {
    describe(c.name, () => {
      const out = renderConfigYaml(answers(c.users, c.org ?? ''));

      it('never writes the deprecated github.oauthAllowed* keys', () => {
        expect(out).not.toContain('oauthAllowed');
      });

      it('resolves with no deprecation warnings and the allowlist from auth.browser', () => {
        const { config, warnings } = resolveConfig(parse(out));
        expect(warnings).toEqual([]);
        expect(config.auth.browser.allowedUsers).toEqual(c.users);
        expect(config.auth.browser.allowedOrg).toBe(c.org);
      });
    });
  }

  it('writes only the provider and the tunnel block when there is no allowlist', () => {
    const out = renderConfigYaml(answers([], ''));
    const doc = parse(out) as { auth: unknown };
    expect(doc.auth).toEqual({ browser: { provider: 'github' }, tunnel: { provider: 'github' } });
  });

  it('keeps a numeric-looking login a string', () => {
    const { config } = resolveConfig(parse(renderConfigYaml(answers(['123', 'yes'], ''))));
    expect(config.auth.browser.allowedUsers).toEqual(['123', 'yes']);
  });

  // #227: the workspace-retention answer is always written, so the choice
  // is visible in the committed config.
  for (const retain of [true, false]) {
    it(`writes efs.retainOnClusterDown: ${retain}`, () => {
      const out = renderConfigYaml({ ...answers(['alice'], ''), retainWorkspaces: retain });
      expect(out).toContain(`retainOnClusterDown: ${retain}`);
      const { config, warnings } = resolveConfig(parse(out));
      expect(warnings).toEqual([]);
      expect(config.efs?.retainOnClusterDown).toBe(retain);
    });
  }
});

describe('promptRetainWorkspaces', () => {
  type ConfirmOpts = { message: string; initialValue?: boolean };
  for (const answer of [true, false]) {
    it(`returns the answer (${answer})`, async () => {
      const seen: ConfirmOpts[] = [];
      const r = await promptRetainWorkspaces(async (o: ConfirmOpts) => {
        seen.push(o);
        return answer;
      });
      expect(r).toBe(answer);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.message).toBe(RETAIN_WORKSPACES_PROMPT);
      // Default no: matches the schema default (ADR 0007).
      expect(seen[0]!.initialValue).toBe(false);
    });
  }

  it('asks the issue\'s question and mentions the retained-storage cost', () => {
    expect(RETAIN_WORKSPACES_PROMPT).toContain('Keep workspaces when the cluster is torn down?');
    expect(RETAIN_WORKSPACES_PROMPT).toMatch(/billed/);
  });

  it('passes a cancel through for the caller to handle', async () => {
    const cancel = Symbol('cancel');
    expect(await promptRetainWorkspaces(async () => cancel)).toBe(cancel);
  });
});

const REQUIRED = [
  '--non-interactive',
  '--aws-account-id', '123456789012',
  '--github-owner', 'alice',
  '--github-repo', 'cloud-dev-pods',
];
const GITHUB = [...REQUIRED, '--allowed-users', 'alice'];
const ENTRA = [
  ...REQUIRED,
  '--browser-provider', 'entra-id',
  '--entra-tenant-id', TENANT,
  '--hosted-zone-id', 'Z01234567ABCDEFGHIJK',
  '--base-domain', 'pods.example.com',
];

function parseOk(argv: string[]): { answers: Answers; out: string; force: boolean } {
  const r = parseInitFlags(argv);
  if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
  return r;
}

function resolveChecked(yamlText: string): ResolvedConfig {
  const { config, warnings } = resolveConfig(parse(yamlText));
  expect(warnings).toEqual([]);
  expect(assertBrowserAuthRestricted(config.auth.browser)).toEqual({ ok: true });
  return config;
}

function checkEntra(yamlText: string, tenant = TENANT): ResolvedConfig {
  const config = resolveChecked(yamlText);
  expect(config.domain.strategy).toBe('byo');
  expect(config.auth.browser.provider).toBe('entra-id');
  expect(config.auth.browser.issuerUrl).toBe(`https://login.microsoftonline.com/${tenant}/v2.0`);
  expect(config.auth.browser.allowedTenants).toEqual([tenant]);
  expect(yamlText).not.toContain('allowedUsers');
  expect(yamlText).not.toContain('allowedOrg');
  return config;
}

describe('parseInitFlags', () => {
  for (const tunnel of ['github', 'microsoft'] as const) {
    it(`github browser + ${tunnel} tunnel`, () => {
      const { answers: a } = parseOk([...GITHUB, '--tunnel-provider', tunnel]);
      const config = resolveChecked(renderConfigYaml(a));
      expect(config.auth.browser.provider).toBe('github');
      expect(config.auth.browser.allowedUsers).toEqual(['alice']);
      expect(config.auth.tunnel.provider).toBe(tunnel);
      expect(config.auth.browser.ownerOnly).toBe(false);
    });

    it(`entra-id browser + ${tunnel} tunnel`, () => {
      const { answers: a } = parseOk([...ENTRA, '--tunnel-provider', tunnel]);
      const config = checkEntra(renderConfigYaml(a));
      expect(config.auth.tunnel.provider).toBe(tunnel);
      expect(config.auth.browser.ownerOnly).toBe(false);
    });
  }

  it('github --owner-only', () => {
    const { answers: a } = parseOk([...REQUIRED, '--owner-only']);
    const config = resolveChecked(renderConfigYaml(a));
    expect(config.auth.browser.ownerOnly).toBe(true);
  });

  it('entra-id --owner-only', () => {
    const { answers: a } = parseOk([...ENTRA, '--owner-only']);
    expect(checkEntra(renderConfigYaml(a)).auth.browser.ownerOnly).toBe(true);
  });

  it('entra-id writes allowedGroups only when given', () => {
    const without = renderConfigYaml(parseOk(ENTRA).answers);
    expect(without).not.toContain('allowedGroups');
    const { answers: a } = parseOk([...ENTRA, '--entra-groups', `${GROUP}, ${GROUP.toUpperCase()}`]);
    expect(checkEntra(renderConfigYaml(a)).auth.browser.allowedGroups).toEqual([GROUP, GROUP]);
  });

  it('lowercases an uppercase tenant ID', () => {
    const argv = ENTRA.map((x) => (x === TENANT ? 'ABCDEF01-2222-3333-4444-555555555555' : x));
    const { answers: a } = parseOk(argv);
    checkEntra(renderConfigYaml(a), 'abcdef01-2222-3333-4444-555555555555');
  });

  it('applies the documented defaults', () => {
    const { answers: a, out, force } = parseOk(REQUIRED);
    expect(out).toBe(join(process.cwd(), 'config', 'config.yaml'));
    expect(force).toBe(false);
    expect(a).toMatchObject({
      awsRegion: 'us-west-2',
      browserProvider: 'github',
      domainStrategy: 'alb-default',
      tunnelProvider: 'github',
      ownerOnly: false,
      vpcCidr: '10.50.0.0/16',
      cpu: 1024,
      memory: 2048,
      idleMinutes: 60,
      retainWorkspaces: false,
    });
    expect(resolveConfig(parse(renderConfigYaml(a))).config.efs?.retainOnClusterDown).toBe(false);
  });

  it('--retain-workspaces writes efs.retainOnClusterDown: true', () => {
    const { answers: a } = parseOk([...GITHUB, '--retain-workspaces']);
    expect(a.retainWorkspaces).toBe(true);
    expect(resolveChecked(renderConfigYaml(a)).efs?.retainOnClusterDown).toBe(true);
  });

  it('accepts --out, --force, --no-push and --no-iam', () => {
    const r = parseOk([...REQUIRED, '--out', 'x/c.yaml', '--force', '--no-push', '--no-iam']);
    expect(r.out).toBe(resolve(process.cwd(), 'x/c.yaml'));
    expect(r.force).toBe(true);
  });

  const ERRORS: { name: string; argv: string[] }[] = [
    { name: 'missing --aws-account-id', argv: REQUIRED.filter((_, i) => i !== 1 && i !== 2) },
    { name: 'missing --github-owner', argv: REQUIRED.filter((_, i) => i !== 3 && i !== 4) },
    { name: 'missing --github-repo', argv: REQUIRED.filter((_, i) => i !== 5 && i !== 6) },
    { name: 'missing --entra-tenant-id', argv: ENTRA.filter((x, i, arr) => x !== '--entra-tenant-id' && arr[i - 1] !== '--entra-tenant-id') },
    { name: 'bad account ID', argv: REQUIRED.map((x) => (x === '123456789012' ? '12345' : x)) },
    { name: 'non-GUID tenant', argv: ENTRA.map((x) => (x === TENANT ? 'not-a-guid' : x)) },
    { name: 'non-GUID group', argv: [...ENTRA, '--entra-groups', `${GROUP},nope`] },
    { name: 'entra-id + alb-default', argv: [...ENTRA, '--domain-strategy', 'alb-default'] },
    { name: '--allowed-org with entra-id', argv: [...ENTRA, '--allowed-org', 'acme'] },
    { name: '--allowed-users with entra-id', argv: [...ENTRA, '--allowed-users', 'alice'] },
    { name: '--entra-tenant-id with github', argv: [...GITHUB, '--entra-tenant-id', TENANT] },
    { name: '--entra-groups with github', argv: [...GITHUB, '--entra-groups', GROUP] },
    { name: 'byo without --hosted-zone-id', argv: [...REQUIRED, '--domain-strategy', 'byo', '--base-domain', 'pods.example.com'] },
    { name: 'byo without --base-domain', argv: [...REQUIRED, '--domain-strategy', 'byo', '--hosted-zone-id', 'Z01234567ABCDEFGHIJK'] },
    { name: '--hosted-zone-id with alb-default', argv: [...REQUIRED, '--hosted-zone-id', 'Z01234567ABCDEFGHIJK'] },
    { name: 'bad --hosted-zone-id', argv: [...REQUIRED, '--domain-strategy', 'byo', '--hosted-zone-id', 'abc', '--base-domain', 'pods.example.com'] },
    { name: 'blank --allowed-org', argv: [...REQUIRED, '--allowed-org', '   '] },
    { name: 'empty --allowed-users', argv: [...REQUIRED, '--allowed-users', ' , '] },
    { name: 'bad --browser-provider', argv: [...REQUIRED, '--browser-provider', 'oidc'] },
    { name: 'bad --tunnel-provider', argv: [...REQUIRED, '--tunnel-provider', 'gitlab'] },
    { name: 'bad --vpc-cidr', argv: [...REQUIRED, '--vpc-cidr', '10.0.0.0'] },
    { name: 'bad --pod-size', argv: [...REQUIRED, '--pod-size', 'huge'] },
    { name: 'bad --idle-minutes', argv: [...REQUIRED, '--idle-minutes', '-5'] },
    { name: 'an unknown flag', argv: [...REQUIRED, '--bogus'] },
    { name: 'a boolean flag given a value', argv: [...REQUIRED, '--owner-only=yes'] },
    { name: 'a value flag missing its value', argv: [...REQUIRED, '--aws-region'] },
    { name: 'a positional argument', argv: [...REQUIRED, 'extra'] },
    { name: 'a value flag without --non-interactive', argv: REQUIRED.slice(1) },
  ];
  for (const e of ERRORS) {
    it(`rejects ${e.name}`, () => {
      const r = parseInitFlags(e.argv);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
    });
  }

  it('names --non-interactive when a value flag is given without it', () => {
    const r = parseInitFlags(['--aws-account-id', '123456789012']);
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.error).toContain('--non-interactive');
  });
});

describe('parseInteractiveFlags', () => {
  it('accepts no flags, --no-push and --no-iam', () => {
    expect(parseInteractiveFlags([])).toEqual({ ok: true, noPush: false, noIam: false });
    expect(parseInteractiveFlags(['--no-push', '--no-iam'])).toEqual({ ok: true, noPush: true, noIam: true });
  });
  it('refuses value flags and unknown flags', () => {
    const r = parseInteractiveFlags(['--aws-account-id', '123456789012']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('--non-interactive');
    expect(parseInteractiveFlags(['--bogus']).ok).toBe(false);
    const retain = parseInteractiveFlags(['--retain-workspaces']);
    expect(retain.ok).toBe(false);
    if (!retain.ok) expect(retain.error).toContain('--non-interactive');
  });
});

describe('nextSteps', () => {
  it('points entra-id at docs/setup-entra.md instead of the GitHub OAuth App', () => {
    const text = nextSteps(parseOk(ENTRA).answers).join('\n');
    expect(text).toContain('docs/setup-entra.md');
    expect(text).not.toContain('github.com/settings/applications/new');
  });
  it('keeps the GitHub OAuth App steps for github + byo', () => {
    const a = parseOk([...GITHUB, '--domain-strategy', 'byo', '--hosted-zone-id', 'Z01234567ABCDEFGHIJK', '--base-domain', 'pods.example.com']).answers;
    const text = nextSteps(a).join('\n');
    expect(text).toContain('github.com/settings/applications/new');
    expect(text).toContain('https://<podname>.pods.example.com/oauth2/callback');
  });
});

describe('init-clone CLI (--non-interactive)', () => {
  const SCRIPT = resolve(import.meta.dirname, 'init-clone.ts');
  const REPO_ROOT = resolve(import.meta.dirname, '..');

  function setup(): { dir: string; stubDir: string; callsLog: string } {
    const dir = mkdtempSync(join(tmpdir(), 'init-clone-'));
    const stubDir = join(dir, 'stubs');
    const callsLog = join(stubDir, 'calls.log');
    mkdirSync(stubDir);
    for (const cmd of ['gh', 'aws', 'git']) {
      const p = join(stubDir, cmd);
      writeFileSync(p, `#!/bin/sh\necho "$0 $*" >> "${callsLog}"\nexit 1\n`);
      chmodSync(p, 0o755);
    }
    return { dir, stubDir, callsLog };
  }

  function runCli(stubDir: string, args: string[]) {
    return spawnSync(process.execPath, ['--import', 'tsx', SCRIPT, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, PATH: stubDir },
      encoding: 'utf8',
    });
  }

  it('writes an Entra config and calls no gh/aws/git', { timeout: 60_000 }, () => {
    const { dir, stubDir, callsLog } = setup();
    const out = join(dir, 'c.yaml');
    const r = runCli(stubDir, [...ENTRA.slice(1), '--non-interactive', '--out', out]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`Wrote ${out}`);
    expect(r.stdout).toContain('docs/setup-entra.md');
    expect(existsSync(out)).toBe(true);
    checkEntra(readFileSync(out, 'utf8'));
    expect(existsSync(callsLog)).toBe(false);
  });

  it('writes efs.retainOnClusterDown from --retain-workspaces', { timeout: 60_000 }, () => {
    const { dir, stubDir, callsLog } = setup();
    const out = join(dir, 'c.yaml');
    const r = runCli(stubDir, [...GITHUB, '--retain-workspaces', '--out', out]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(resolveChecked(readFileSync(out, 'utf8')).efs?.retainOnClusterDown).toBe(true);
    expect(existsSync(callsLog)).toBe(false);
  });

  it('refuses an existing --out without --force and leaves it unchanged', { timeout: 60_000 }, () => {
    const { dir, stubDir } = setup();
    const out = join(dir, 'c.yaml');
    writeFileSync(out, 'original\n');
    const r = runCli(stubDir, [...GITHUB, '--out', out]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/^init-clone: /);
    expect(readFileSync(out, 'utf8')).toBe('original\n');
  });

  it('overwrites an existing --out with --force', { timeout: 60_000 }, () => {
    const { dir, stubDir } = setup();
    const out = join(dir, 'c.yaml');
    writeFileSync(out, 'original\n');
    const r = runCli(stubDir, [...GITHUB, '--out', out, '--force']);
    expect(r.status).toBe(0);
    resolveChecked(readFileSync(out, 'utf8'));
  });

  it('exits 2 and writes nothing when --aws-account-id is missing', { timeout: 60_000 }, () => {
    const { dir, stubDir } = setup();
    const out = join(dir, 'c.yaml');
    const r = runCli(stubDir, [...GITHUB.filter((_, i) => i !== 1 && i !== 2), '--out', out]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/^init-clone: /);
    expect(r.stderr.trim().split('\n')).toHaveLength(1);
    expect(existsSync(out)).toBe(false);
  });
});
