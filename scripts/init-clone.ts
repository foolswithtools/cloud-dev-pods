#!/usr/bin/env node
/**
 * Setup for a fresh cloud-dev-pods fork.
 *
 * Interactive (default):
 *   - Auto-detects AWS account/region, GitHub owner/repo, Route53 zones.
 *   - Prompts for browser provider (GitHub or Entra ID), domain strategy,
 *     sign-in allowlist, ownerOnly, tunnel provider, VPC CIDR, sizing, idle.
 *   - Writes config/config.yaml, .upstream-sync.state, .envrc,
 *     infra/extensions.local.ts (stub).
 *   - Pushes initial GitHub repo Variables via `gh variable set`
 *     (skip with --no-push).
 *   - Optional: creates the cloud-dev-pods-bootstrap IAM user and pushes
 *     its access keys as repo Secrets (avoids the GitHub-UI paste-mangling
 *     issue surfaced during smoke testing). Skip the prompt with --no-iam.
 *   - Idempotent: rerunning prompts to overwrite or skip each artifact.
 *
 * Non-interactive (--non-interactive): every answer comes from a flag (see
 * parseInitFlags). Writes only the --out file; no prompts, no gh/aws/git
 * calls. Exit 0 written, 2 usage/validation error, 1 unexpected error.
 *
 * Usage:
 *   npm run init [-- --no-push] [-- --no-iam]
 *   npm run init -- --non-interactive --aws-account-id 123456789012 \
 *     --github-owner alice --github-repo cloud-dev-pods --allowed-users alice
 */

import * as clack from '@clack/prompts';
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, type ParseArgsConfig } from 'node:util';

const REPO_ROOT = process.cwd();
const CONFIG_PATH = join(REPO_ROOT, 'config', 'config.yaml');
const STATE_PATH = join(REPO_ROOT, '.upstream-sync.state');
const ENVRC_PATH = join(REPO_ROOT, '.envrc');
const EXTENSIONS_PATH = join(REPO_ROOT, 'infra', 'extensions.local.ts');

// Copied from infra/lambda/pod-manager/entra-id.ts (ENTRA_GUID): scripts/
// must not import infra at runtime.
const ENTRA_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ENTRA_DOMAIN_NOTE =
  'Entra ID requires https, so pods need your own Route53 zone (domain.strategy: byo).';

interface Defaults {
  awsAccountId?: string;
  awsRegion?: string;
  githubOwner?: string;
  githubRepo?: string;
  hostedZones: { name: string; id: string }[];
}

export type BrowserProvider = 'github' | 'entra-id';
export type TunnelProvider = 'github' | 'microsoft';

export interface Answers {
  awsAccountId: string;
  awsRegion: string;
  githubOwner: string;
  githubRepo: string;
  browserProvider: BrowserProvider;
  domainStrategy: 'byo' | 'alb-default';
  baseDomain: string;
  hostedZoneId: string;
  // github only.
  allowedUsers: string[];
  allowedOrg: string;
  // entra-id only. Lowercased GUIDs.
  entraTenantId: string;
  entraGroups: string[];
  ownerOnly: boolean;
  tunnelProvider: TunnelProvider;
  vpcCidr: string;
  cpu: number;
  memory: number;
  idleMinutes: number;
}

const POD_SIZES = {
  small: { cpu: 512, memory: 1024 },
  medium: { cpu: 1024, memory: 2048 },
  large: { cpu: 2048, memory: 4096 },
  xlarge: { cpu: 4096, memory: 8192 },
} as const;
type PodSize = keyof typeof POD_SIZES;

// Validators shared by the prompts and parseInitFlags. Each returns an error
// message, or undefined when the value is fine.
type Validator = (s: string) => string | undefined;

const validateAccountId: Validator = (s) => (/^\d{12}$/.test(s) ? undefined : 'Must be exactly 12 digits.');
const validateRequired: Validator = (s) => (s.trim().length > 0 ? undefined : 'Required.');
const validateZoneId: Validator = (s) =>
  /^Z[A-Z0-9]{10,}$/.test(s) ? undefined : 'Must look like Z01234567ABCDEFGHIJK.';
const validateCidr: Validator = (s) =>
  /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(s) ? undefined : 'Must be valid CIDR.';
const validateIdle: Validator = (s) => (/^\d+$/.test(s) ? undefined : 'Must be a non-negative integer.');
const validateGuid: Validator = (s) =>
  ENTRA_GUID.test(s.trim()) ? undefined : 'Must be a GUID like 11111111-2222-3333-4444-555555555555.';
const validateGuidList: Validator = (s) => {
  const bad = parseUserList(s).find((g) => !ENTRA_GUID.test(g));
  return bad === undefined ? undefined : `"${bad}" is not a GUID.`;
};

/** A GitHub org login: refuse blank or whitespace-only. */
export const validateOrg: Validator = (s) =>
  s.trim().length > 0 ? undefined : 'Enter an organization login.';

function tryRun(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

function run(cmd: string, args: string[], opts: { input?: string } = {}): void {
  execFileSync(cmd, args, {
    stdio: opts.input !== undefined ? ['pipe', 'inherit', 'inherit'] : ['ignore', 'inherit', 'inherit'],
    input: opts.input,
  });
}

function checkOrExit(value: string | symbol, label: string): asserts value is string {
  if (clack.isCancel(value)) {
    clack.cancel(`Cancelled at "${label}".`);
    process.exit(1);
  }
}

// clack's validate callback types `v` as `string | undefined`. Wrap to coerce
// to a string for the predicate so each call site doesn't need a guard.
function v(predicate: (s: string) => string | undefined): (s: string | undefined) => string | undefined {
  return (s) => predicate(s ?? '');
}

async function detectDefaults(): Promise<Defaults> {
  const out: Defaults = { hostedZones: [] };

  const sts = tryRun('aws', ['sts', 'get-caller-identity', '--output', 'json']);
  if (sts) {
    try {
      const parsed = JSON.parse(sts) as { Account?: string };
      if (parsed.Account) out.awsAccountId = parsed.Account;
    } catch {
      /* noop */
    }
  }

  const region = tryRun('aws', ['configure', 'get', 'region']);
  if (region) out.awsRegion = region;

  const remote = tryRun('git', ['remote', 'get-url', 'origin']);
  if (remote) {
    const m = /github\.com[:/](?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?$/.exec(remote);
    if (m?.groups) {
      out.githubOwner = m.groups['owner'];
      out.githubRepo = m.groups['repo'];
    }
  }

  if (out.awsAccountId) {
    const zonesJson = tryRun('aws', ['route53', 'list-hosted-zones', '--output', 'json']);
    if (zonesJson) {
      try {
        const parsed = JSON.parse(zonesJson) as {
          HostedZones?: { Name: string; Id: string; Config?: { PrivateZone?: boolean } }[];
        };
        for (const z of parsed.HostedZones ?? []) {
          if (z.Config?.PrivateZone) continue;
          out.hostedZones.push({
            name: z.Name.replace(/\.$/, ''),
            id: z.Id.replace('/hostedzone/', ''),
          });
        }
      } catch {
        /* noop */
      }
    }
  }

  return out;
}

function checkPrereqs(): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!tryRun('gh', ['auth', 'status'])) missing.push('gh (logged in)');
  if (!tryRun('aws', ['sts', 'get-caller-identity'])) missing.push('aws (logged in)');
  if (!tryRun('git', ['rev-parse', '--show-toplevel'])) missing.push('git (in a repo)');
  return { ok: missing.length === 0, missing };
}

async function prompt(defaults: Defaults): Promise<Answers> {
  const a: Partial<Answers> = {};

  const accountId = await clack.text({
    message: 'AWS account ID',
    placeholder: '123456789012',
    initialValue: defaults.awsAccountId,
    validate: v(validateAccountId),
  });
  checkOrExit(accountId, 'AWS account ID');
  a.awsAccountId = accountId;

  const region = await clack.text({
    message: 'AWS region',
    placeholder: 'us-west-2',
    initialValue: defaults.awsRegion ?? 'us-west-2',
    validate: v(validateRequired),
  });
  checkOrExit(region, 'AWS region');
  a.awsRegion = region;

  const owner = await clack.text({
    message: 'GitHub owner (your username or org)',
    initialValue: defaults.githubOwner,
    validate: v(validateRequired),
  });
  checkOrExit(owner, 'GitHub owner');
  a.githubOwner = owner;

  const repo = await clack.text({
    message: 'GitHub repo name',
    initialValue: defaults.githubRepo,
    validate: v(validateRequired),
  });
  checkOrExit(repo, 'GitHub repo');
  a.githubRepo = repo;

  // Asked before the domain strategy: Entra ID forces byo.
  const provider = await clack.select({
    message: 'Browser sign-in provider',
    initialValue: 'github',
    options: [
      { value: 'github', label: 'GitHub', hint: 'GitHub OAuth App' },
      { value: 'entra-id', label: 'Microsoft Entra ID', hint: 'Needs your own Route53 zone' },
    ],
  });
  checkOrExit(provider, 'Browser provider');
  a.browserProvider = provider as BrowserProvider;

  if (a.browserProvider === 'entra-id') {
    clack.log.info(ENTRA_DOMAIN_NOTE);
    a.domainStrategy = 'byo';
  } else {
    const strategy = await clack.select({
      message: 'Domain strategy',
      options: [
        {
          value: 'byo',
          label: 'Bring my own Route53 zone',
          hint: 'Required for browser-mode pods',
        },
        {
          value: 'alb-default',
          label: 'No domain (tunnel-mode pods only)',
        },
      ],
    });
    checkOrExit(strategy, 'Domain strategy');
    a.domainStrategy = strategy as 'byo' | 'alb-default';
  }
  a.baseDomain = '';
  a.hostedZoneId = '';

  if (a.domainStrategy === 'byo') {
    let pickedZoneId = '';
    let pickedZoneName = '';
    if (defaults.hostedZones.length > 0) {
      const choice = await clack.select({
        message: 'Pick a Route53 hosted zone',
        options: [
          ...defaults.hostedZones.map((z) => ({
            value: z.id,
            label: z.name,
            hint: z.id,
          })),
          { value: '__manual__', label: 'Enter manually' },
        ],
      });
      checkOrExit(choice, 'Hosted zone');
      if (choice !== '__manual__') {
        pickedZoneId = choice;
        const z = defaults.hostedZones.find((x) => x.id === choice);
        if (z) pickedZoneName = z.name;
      }
    }

    if (!pickedZoneId) {
      const id = await clack.text({
        message: 'Route53 hosted zone ID',
        placeholder: 'Z01234567ABCDEFGHIJK',
        validate: v(validateZoneId),
      });
      checkOrExit(id, 'Hosted zone ID');
      pickedZoneId = id;
    }
    a.hostedZoneId = pickedZoneId;

    const subdomainPrefix = await clack.text({
      message: 'Subdomain prefix for pods',
      placeholder: 'pods',
      initialValue: 'pods',
      validate: v((s) => (/^[a-z0-9-]+$/.test(s) ? undefined : 'Lowercase letters, digits, hyphens.')),
    });
    checkOrExit(subdomainPrefix, 'Subdomain prefix');
    if (pickedZoneName) {
      a.baseDomain = `${subdomainPrefix}.${pickedZoneName}`;
    } else {
      const apex = await clack.text({
        message: `Apex domain for hosted zone ${pickedZoneId}`,
        placeholder: 'example.com',
      });
      checkOrExit(apex, 'Apex domain');
      a.baseDomain = `${subdomainPrefix}.${apex}`;
    }
  }

  a.allowedUsers = [];
  a.allowedOrg = '';
  a.entraTenantId = '';
  a.entraGroups = [];
  if (a.browserProvider === 'github') {
    // OAuth allowlist (relevant for browser mode but harmless to set always).
    const allowKind = await clack.select({
      message: 'OAuth allowlist (who can sign in to browser pods)',
      options: [
        { value: 'user', label: `Just specific GitHub users`, hint: 'Solo dev or invite list' },
        { value: 'org', label: 'Anyone in a GitHub organization' },
        { value: 'both', label: 'Both' },
        { value: 'none', label: 'Skip (tunnel-mode only)', hint: 'Browser pods will refuse to launch' },
      ],
    });
    checkOrExit(allowKind, 'Allowlist kind');
    if (allowKind === 'user' || allowKind === 'both') {
      const users = await clack.text({
        message: 'Comma-separated GitHub usernames',
        initialValue: defaults.githubOwner ?? '',
        validate: v((s) => (parseUserList(s).length > 0 ? undefined : 'Required.')),
      });
      checkOrExit(users, 'Allowed users');
      a.allowedUsers = parseUserList(users);
    }
    if (allowKind === 'org' || allowKind === 'both') {
      const org = await clack.text({
        message: 'GitHub organization login',
        placeholder: defaults.githubOwner ?? 'foolswithtools',
        validate: v(validateOrg),
      });
      checkOrExit(org, 'Allowed org');
      a.allowedOrg = org.trim();
    }
  } else {
    const tenant = await clack.text({
      message: 'Entra Directory (tenant) ID',
      placeholder: '11111111-2222-3333-4444-555555555555',
      validate: v(validateGuid),
    });
    checkOrExit(tenant, 'Entra tenant ID');
    a.entraTenantId = tenant.trim().toLowerCase();

    const groups = await clack.text({
      message: 'Entra group object IDs allowed to sign in (comma-separated, optional)',
      placeholder: 'leave empty to admit the whole tenant',
      validate: v(validateGuidList),
    });
    checkOrExit(groups, 'Entra group IDs');
    a.entraGroups = parseUserList(groups).map((g) => g.toLowerCase());
  }

  const ownerOnly = await clack.confirm({
    message: 'Restrict each browser pod to the user who launched it (ownerOnly)?',
    initialValue: false,
  });
  if (clack.isCancel(ownerOnly)) {
    clack.cancel('Cancelled at "ownerOnly".');
    process.exit(1);
  }
  a.ownerOnly = ownerOnly;

  const tunnel = await clack.select({
    message: 'Tunnel sign-in provider (VS Code Desktop Remote Tunnels)',
    initialValue: 'github',
    options: [
      { value: 'github', label: 'GitHub account' },
      { value: 'microsoft', label: 'Microsoft account' },
    ],
  });
  checkOrExit(tunnel, 'Tunnel provider');
  a.tunnelProvider = tunnel as TunnelProvider;

  const cidr = await clack.text({
    message: 'VPC CIDR (avoid collisions with VPCs you might peer with later)',
    placeholder: '10.50.0.0/16',
    initialValue: '10.50.0.0/16',
    validate: v(validateCidr),
  });
  checkOrExit(cidr, 'VPC CIDR');
  a.vpcCidr = cidr;

  const sizing = await clack.select({
    message: 'Default pod sizing',
    options: [
      { value: 'small', label: 'Small (0.5 vCPU, 1 GB)' },
      { value: 'medium', label: 'Medium (1 vCPU, 2 GB)', hint: 'Recommended' },
      { value: 'large', label: 'Large (2 vCPU, 4 GB)' },
      { value: 'xlarge', label: 'Extra large (4 vCPU, 8 GB)' },
    ],
  });
  checkOrExit(sizing, 'Sizing');
  const size = POD_SIZES[sizing as PodSize] ?? POD_SIZES.medium;
  a.cpu = size.cpu;
  a.memory = size.memory;

  const idleStr = await clack.text({
    message: 'Idle-shutdown threshold (minutes; 0 = disabled)',
    placeholder: '60',
    initialValue: '60',
    validate: v(validateIdle),
  });
  checkOrExit(idleStr, 'Idle minutes');
  a.idleMinutes = parseInt(idleStr, 10);

  return a as Answers;
}

/** Split the comma-separated users answer: trim each entry, drop empties. */
export function parseUserList(csv: string): string[] {
  return csv
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Every flag init accepts. Interactive mode accepts only --no-push and
// --no-iam; the rest need --non-interactive (see parseInitFlags).
const FLAG_OPTIONS = {
  'non-interactive': { type: 'boolean' },
  out: { type: 'string' },
  force: { type: 'boolean' },
  'no-push': { type: 'boolean' },
  'no-iam': { type: 'boolean' },
  'aws-account-id': { type: 'string' },
  'aws-region': { type: 'string' },
  'github-owner': { type: 'string' },
  'github-repo': { type: 'string' },
  'browser-provider': { type: 'string' },
  'domain-strategy': { type: 'string' },
  'hosted-zone-id': { type: 'string' },
  'base-domain': { type: 'string' },
  'allowed-users': { type: 'string' },
  'allowed-org': { type: 'string' },
  'entra-tenant-id': { type: 'string' },
  'entra-groups': { type: 'string' },
  'owner-only': { type: 'boolean' },
  'tunnel-provider': { type: 'string' },
  'vpc-cidr': { type: 'string' },
  'pod-size': { type: 'string' },
  'idle-minutes': { type: 'string' },
} as const satisfies NonNullable<ParseArgsConfig['options']>;

type FlagName = keyof typeof FLAG_OPTIONS;
type Flags = {
  [K in FlagName]?: (typeof FLAG_OPTIONS)[K]['type'] extends 'string' ? string : boolean;
};
const INTERACTIVE_FLAGS: readonly FlagName[] = ['no-push', 'no-iam'];

type Failure = { ok: false; error: string };

function isOneOf<T extends string>(value: string, allowed: readonly T[]): value is T {
  return (allowed as readonly string[]).includes(value);
}

// node:util parseArgs in strict mode throws on an unknown flag, a value given
// to a boolean flag, a missing value, or a positional argument.
function parseFlags(argv: string[]): { ok: true; flags: Flags } | Failure {
  try {
    const { values } = parseArgs({ args: argv, options: FLAG_OPTIONS, strict: true, allowPositionals: false });
    return { ok: true, flags: values as Flags };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function needsNonInteractive(flags: Flags): Failure | undefined {
  const extra = (Object.keys(flags) as FlagName[]).find((k) => !INTERACTIVE_FLAGS.includes(k));
  return extra === undefined ? undefined : { ok: false, error: `--${extra} requires --non-interactive.` };
}

/** Flags for the interactive (prompting) mode: only --no-push and --no-iam. */
export function parseInteractiveFlags(argv: string[]): { ok: true; noPush: boolean; noIam: boolean } | Failure {
  const p = parseFlags(argv);
  if (!p.ok) return p;
  const bad = needsNonInteractive(p.flags);
  if (bad) return bad;
  return { ok: true, noPush: p.flags['no-push'] === true, noIam: p.flags['no-iam'] === true };
}

/**
 * Parse and validate the --non-interactive flags into the same Answers the
 * prompts produce. Pure: no filesystem, process, or network access.
 */
export function parseInitFlags(
  argv: string[],
): { ok: true; answers: Answers; out: string; force: boolean } | Failure {
  const p = parseFlags(argv);
  if (!p.ok) return p;
  const f = p.flags;
  if (f['non-interactive'] !== true) {
    return needsNonInteractive(f) ?? { ok: false, error: 'parseInitFlags needs --non-interactive.' };
  }

  const fail = (error: string): Failure => ({ ok: false, error });
  // Validate one flag's value; a missing value means the flag is required.
  const check = (flag: FlagName, value: string | undefined, validator: Validator): string | undefined => {
    if (value === undefined) return `--${flag} is required.`;
    const msg = validator(value);
    return msg === undefined ? undefined : `--${flag}: ${msg}`;
  };
  const notFor = (flags: FlagName[], what: string): string | undefined => {
    const set = flags.find((k) => f[k] !== undefined);
    return set === undefined ? undefined : `--${set} does not apply ${what}.`;
  };

  let err =
    check('aws-account-id', f['aws-account-id'], validateAccountId) ??
    check('aws-region', f['aws-region'] ?? 'us-west-2', validateRequired) ??
    check('github-owner', f['github-owner'], validateRequired) ??
    check('github-repo', f['github-repo'], validateRequired);
  if (err) return fail(err);

  const browserProvider = f['browser-provider'] ?? 'github';
  if (!isOneOf(browserProvider, ['github', 'entra-id'] as const)) {
    return fail(`--browser-provider must be github or entra-id; got "${browserProvider}".`);
  }
  const domainStrategy = f['domain-strategy'] ?? (browserProvider === 'entra-id' ? 'byo' : 'alb-default');
  if (!isOneOf(domainStrategy, ['byo', 'alb-default'] as const)) {
    return fail(`--domain-strategy must be byo or alb-default; got "${domainStrategy}".`);
  }
  if (browserProvider === 'entra-id' && domainStrategy !== 'byo') {
    return fail(`--browser-provider entra-id requires --domain-strategy byo. ${ENTRA_DOMAIN_NOTE}`);
  }
  if (domainStrategy === 'byo') {
    err =
      check('hosted-zone-id', f['hosted-zone-id'], validateZoneId) ??
      check('base-domain', f['base-domain'], validateRequired);
  } else {
    err = notFor(['hosted-zone-id', 'base-domain'], 'with --domain-strategy alb-default; use --domain-strategy byo');
  }
  if (err) return fail(err);

  let allowedUsers: string[] = [];
  let allowedOrg = '';
  let entraTenantId = '';
  let entraGroups: string[] = [];
  if (browserProvider === 'github') {
    err = notFor(['entra-tenant-id', 'entra-groups'], 'to --browser-provider github');
    if (err) return fail(err);
    if (f['allowed-users'] !== undefined) {
      allowedUsers = parseUserList(f['allowed-users']);
      if (allowedUsers.length === 0) return fail('--allowed-users must list at least one GitHub login.');
    }
    if (f['allowed-org'] !== undefined) {
      err = check('allowed-org', f['allowed-org'], validateOrg);
      if (err) return fail(err);
      allowedOrg = f['allowed-org'].trim();
    }
  } else {
    err =
      notFor(['allowed-users', 'allowed-org'], 'to --browser-provider entra-id; use --entra-tenant-id / --entra-groups') ??
      check('entra-tenant-id', f['entra-tenant-id'], validateGuid) ??
      (f['entra-groups'] === undefined ? undefined : check('entra-groups', f['entra-groups'], validateGuidList));
    if (err) return fail(err);
    entraTenantId = (f['entra-tenant-id'] ?? '').trim().toLowerCase();
    entraGroups = parseUserList(f['entra-groups'] ?? '').map((g) => g.toLowerCase());
  }

  const tunnelProvider = f['tunnel-provider'] ?? 'github';
  if (!isOneOf(tunnelProvider, ['github', 'microsoft'] as const)) {
    return fail(`--tunnel-provider must be github or microsoft; got "${tunnelProvider}".`);
  }
  const vpcCidr = f['vpc-cidr'] ?? '10.50.0.0/16';
  const podSize = f['pod-size'] ?? 'medium';
  const idle = f['idle-minutes'] ?? '60';
  err = check('vpc-cidr', vpcCidr, validateCidr) ?? check('idle-minutes', idle, validateIdle);
  if (err) return fail(err);
  if (!isOneOf(podSize, Object.keys(POD_SIZES) as PodSize[])) {
    return fail(`--pod-size must be one of ${Object.keys(POD_SIZES).join(', ')}; got "${podSize}".`);
  }
  if (f.out !== undefined && f.out.trim() === '') return fail('--out needs a file path.');

  return {
    ok: true,
    out: resolve(process.cwd(), f.out ?? join('config', 'config.yaml')),
    force: f.force === true,
    answers: {
      awsAccountId: f['aws-account-id'] ?? '',
      awsRegion: (f['aws-region'] ?? 'us-west-2').trim(),
      githubOwner: (f['github-owner'] ?? '').trim(),
      githubRepo: (f['github-repo'] ?? '').trim(),
      browserProvider,
      domainStrategy,
      baseDomain: domainStrategy === 'byo' ? (f['base-domain'] ?? '').trim() : '',
      hostedZoneId: domainStrategy === 'byo' ? (f['hosted-zone-id'] ?? '') : '',
      allowedUsers,
      allowedOrg,
      entraTenantId,
      entraGroups,
      ownerOnly: f['owner-only'] === true,
      tunnelProvider,
      vpcCidr,
      cpu: POD_SIZES[podSize].cpu,
      memory: POD_SIZES[podSize].memory,
      idleMinutes: parseInt(idle, 10),
    },
  };
}

// The `auth:` block. Always written: `browser.provider` and `tunnel.provider`
// are explicit even when there's no allowlist (tunnel only). Values are
// double-quoted (JSON strings are valid YAML) so a login like `123` or `yes`
// stays a string. entra-id never gets allowedUsers / allowedOrg: the schema
// rejects them for that provider.
function renderAuthBlock(a: Answers): string {
  const lines = ['auth:', '  browser:', `    provider: ${a.browserProvider}`];
  if (a.browserProvider === 'entra-id') {
    lines.push(
      `    issuerUrl: ${JSON.stringify(`https://login.microsoftonline.com/${a.entraTenantId}/v2.0`)}`,
      '    allowedTenants:',
      `      - ${JSON.stringify(a.entraTenantId)}`,
    );
    if (a.entraGroups.length > 0) {
      lines.push('    allowedGroups:', ...a.entraGroups.map((g) => `      - ${JSON.stringify(g)}`));
    }
  } else {
    if (a.allowedUsers.length > 0) {
      lines.push('    allowedUsers:', ...a.allowedUsers.map((u) => `      - ${JSON.stringify(u)}`));
    }
    if (a.allowedOrg) lines.push(`    allowedOrg: ${JSON.stringify(a.allowedOrg)}`);
  }
  if (a.ownerOnly) lines.push('    ownerOnly: true');
  lines.push('  tunnel:', `    provider: ${a.tunnelProvider}`);
  return lines.join('\n') + '\n\n';
}

export function renderConfigYaml(a: Answers): string {
  const domainBlock =
    a.domainStrategy === 'byo'
      ? `domain:
  strategy: byo
  baseDomain: ${a.baseDomain}
  hostedZoneId: ${a.hostedZoneId}`
      : `domain:
  strategy: alb-default`;

  return `# Generated by scripts/init-clone.ts. Edit and re-commit as your fork's
# source of truth. Phase 11 onboarding workflow expects this file committed.

project:
  name: cloud-dev-pods
  env: dev

aws:
  accountId: "${a.awsAccountId}"
  region: ${a.awsRegion}

github:
  org: ${a.githubOwner}
  repo: ${a.githubRepo}

${renderAuthBlock(a)}${domainBlock}

network:
  vpcCidr: "${a.vpcCidr}"
  natGateways: 1
  useVpcEndpoints: false

pods:
  defaultCpu: ${a.cpu}
  defaultMemory: ${a.memory}
  spotPercentage: 100
  idleMinutes: ${a.idleMinutes}

naming:
  prefix: CloudDevPods
`;
}

function renderEnvrc(a: Answers): string {
  return `# direnv config (optional). Run 'direnv allow' once to load.
export AWS_REGION=${a.awsRegion}
export AWS_ACCOUNT_ID=${a.awsAccountId}
export CDPODS_CONFIG=$PWD/config/config.yaml
`;
}

const EXTENSIONS_STUB = `// Customizations that survive sync-upstream. This file is [user] in
// .upstream-sync.toml — never overwritten. See docs/extending.md.
//
// Each hook is optional and runs after the corresponding stack constructs
// its default resources but before synthesis is finalized.

// import type { ClusterStack } from './lib/stacks/cluster-stack';
// import type { NetworkStack } from './lib/stacks/network-stack';

export const extensions = {
  // customizeNetwork(stack: NetworkStack): void {
  //   // e.g., add VPC endpoints, more subnets, custom flow logs
  // },
  // customizeCluster(stack: ClusterStack): void {
  //   // e.g., add capacity providers, change ALB idle timeout
  // },
};
`;

async function maybeOverwrite(label: string, path: string): Promise<boolean> {
  if (!existsSync(path)) return true;
  const overwrite = await clack.confirm({
    message: `${label} exists at ${path.replace(REPO_ROOT, '.')}. Overwrite?`,
    initialValue: false,
  });
  if (clack.isCancel(overwrite)) return false;
  return Boolean(overwrite);
}

async function pushGhVariable(name: string, value: string): Promise<boolean> {
  try {
    run('gh', ['variable', 'set', name, '--body', value]);
    return true;
  } catch (err) {
    process.stderr.write(`gh variable set ${name} failed: ${(err as Error).message}\n`);
    return false;
  }
}

async function maybeCreateBootstrapIam(): Promise<void> {
  const yes = await clack.confirm({
    message:
      'Create the cloud-dev-pods-bootstrap IAM user and push access keys as repo Secrets now?',
    initialValue: false,
  });
  if (clack.isCancel(yes) || yes !== true) return;

  const s = clack.spinner();
  try {
    s.start('aws iam create-user cloud-dev-pods-bootstrap');
    tryRun('aws', ['iam', 'create-user', '--user-name', 'cloud-dev-pods-bootstrap']);
    tryRun('aws', [
      'iam',
      'attach-user-policy',
      '--user-name',
      'cloud-dev-pods-bootstrap',
      '--policy-arn',
      'arn:aws:iam::aws:policy/AdministratorAccess',
    ]);

    const keyJson = tryRun('aws', [
      'iam',
      'create-access-key',
      '--user-name',
      'cloud-dev-pods-bootstrap',
      '--output',
      'json',
    ]);
    if (!keyJson) {
      s.stop('Could not create access key (existing key? AWS limit is 2 per user).');
      return;
    }
    const parsed = JSON.parse(keyJson) as {
      AccessKey?: { AccessKeyId?: string; SecretAccessKey?: string };
    };
    const id = parsed.AccessKey?.AccessKeyId;
    const secret = parsed.AccessKey?.SecretAccessKey;
    if (!id || !secret) {
      s.stop('AWS returned an incomplete access key.');
      return;
    }
    s.message('Pushing keys to GitHub repo Secrets via stdin');
    run('gh', ['secret', 'set', 'AWS_BOOTSTRAP_ACCESS_KEY_ID'], { input: id });
    run('gh', ['secret', 'set', 'AWS_BOOTSTRAP_SECRET_ACCESS_KEY'], { input: secret });
    s.stop('Bootstrap IAM user + secrets ready.');
  } catch (err) {
    s.stop(`Bootstrap IAM step failed: ${(err as Error).message}`);
  }
}

/** The outro's next steps for these answers (both modes print them). */
export function nextSteps(a: Answers): string[] {
  const steps: string[] = [
    `1. Commit config/config.yaml: \`git add config/config.yaml && git commit -m 'chore: init config' && git push\``,
    `2. Run bootstrap: \`gh workflow run bootstrap-aws.yml -f confirm_account_id=${a.awsAccountId}\``,
    `3. After bootstrap succeeds, set role ARNs and clean up:`,
    `     DEPLOYER=$(aws ssm get-parameter --name /cloud-dev-pods/dev/bootstrap/deployer-role-arn --query Parameter.Value --output text)`,
    `     PODOPS=$(aws ssm get-parameter --name /cloud-dev-pods/dev/bootstrap/pod-ops-role-arn --query Parameter.Value --output text)`,
    `     gh variable set AWS_DEPLOYER_ROLE_ARN --body "$DEPLOYER"`,
    `     gh variable set AWS_POD_OPS_ROLE_ARN --body "$PODOPS"`,
    `     gh secret delete AWS_BOOTSTRAP_ACCESS_KEY_ID && gh secret delete AWS_BOOTSTRAP_SECRET_ACCESS_KEY`,
  ];
  if (a.browserProvider === 'entra-id') {
    steps.push(
      `4. Browser-mode only: follow docs/setup-entra.md to register the Entra app`,
      `     (redirect URI https://<podname>.${a.baseDomain}/oauth2/callback), create a client secret,`,
      `     then store both with \`aws secretsmanager update-secret\` (docs/setup-entra.md §6).`,
      `5. Build images and bring up the cluster:`,
    );
  } else if (a.domainStrategy === 'byo') {
    steps.push(
      `4. Browser-mode only: register an OAuth App at https://github.com/settings/applications/new`,
      `     Callback URL: https://<podname>.${a.baseDomain}/oauth2/callback`,
      `5. Update oauth secrets:`,
      `     aws secretsmanager update-secret --secret-id /cloud-dev-pods/oauth/client-id --secret-string "<id>"`,
      `     aws secretsmanager update-secret --secret-id /cloud-dev-pods/oauth/client-secret --secret-string "<secret>"`,
      `6. Build images and bring up the cluster:`,
    );
  } else {
    steps.push(`4. Build images and bring up the cluster:`);
  }
  steps.push(
    `     gh workflow run build-runtime.yml`,
    `     gh workflow run cluster-up.yml`,
  );
  return steps;
}

// One line on stderr, prefixed for grep-ability.
function usageError(message: string): void {
  process.stderr.write(`init-clone: ${message.replace(/\s*\n\s*/g, ' ')}\n`);
}

// --non-interactive: no prompts, no gh/aws/git, and only the --out file is
// written. Returns the exit code.
function runNonInteractive(argv: string[]): number {
  const r = parseInitFlags(argv);
  if (!r.ok) {
    usageError(r.error);
    return 2;
  }
  try {
    // 'wx' fails with EEXIST instead of a separate exists check, so there's
    // no window between checking for the file and writing it.
    writeFileSync(r.out, renderConfigYaml(r.answers), { flag: r.force ? 'w' : 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      usageError(`${r.out} already exists; pass --force to overwrite it.`);
      return 2;
    }
    usageError(`could not write ${r.out}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  process.stdout.write(`Wrote ${r.out}\n\nNext steps:\n${nextSteps(r.answers).join('\n')}\n`);
  return 0;
}

async function main(argv: string[]): Promise<void> {
  if (argv.includes('--non-interactive')) {
    process.exitCode = runNonInteractive(argv);
    return;
  }
  const flags = parseInteractiveFlags(argv);
  if (!flags.ok) {
    usageError(flags.error);
    process.exitCode = 2;
    return;
  }

  clack.intro('cloud-dev-pods init');

  const pre = checkPrereqs();
  if (!pre.ok) {
    clack.cancel(`Missing prereqs: ${pre.missing.join(', ')}.`);
    process.exit(1);
  }

  const defaults = await detectDefaults();
  const a = await prompt(defaults);

  // Write config.yaml
  if (await maybeOverwrite('config/config.yaml', CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, renderConfigYaml(a));
    clack.note(`Wrote ${CONFIG_PATH.replace(REPO_ROOT, '.')}.`, 'config.yaml');
  }

  // Write .upstream-sync.state with current HEAD if absent (so sync-upstream
  // doesn't try to replay all of history on first run).
  if (!existsSync(STATE_PATH)) {
    const head = tryRun('git', ['rev-parse', 'HEAD']);
    if (head) {
      writeFileSync(STATE_PATH, `${head}\n`);
      clack.note(`Initialized .upstream-sync.state with current HEAD.`, 'state');
    }
  }

  // Write .envrc (gitignored — direnv-friendly).
  if (await maybeOverwrite('.envrc', ENVRC_PATH)) {
    writeFileSync(ENVRC_PATH, renderEnvrc(a));
    clack.note(`Wrote .envrc. Run 'direnv allow' if you use direnv.`, '.envrc');
  }

  // Write infra/extensions.local.ts stub.
  if (!existsSync(EXTENSIONS_PATH)) {
    writeFileSync(EXTENSIONS_PATH, EXTENSIONS_STUB);
    clack.note(`Wrote infra/extensions.local.ts stub.`, 'extensions');
  }

  // Push GitHub Variables.
  if (!flags.noPush) {
    const s = clack.spinner();
    s.start('Pushing GitHub repo Variables');
    let okCount = 0;
    okCount += (await pushGhVariable('AWS_REGION', a.awsRegion)) ? 1 : 0;
    okCount += (await pushGhVariable('AWS_ACCOUNT_ID', a.awsAccountId)) ? 1 : 0;
    okCount += (await pushGhVariable('CLUSTER_NAME', 'cloud-dev-pods')) ? 1 : 0;
    s.stop(`Pushed ${okCount}/3 Variables.`);
  }

  // Optional: create bootstrap IAM user.
  if (!flags.noIam) await maybeCreateBootstrapIam();

  clack.note(nextSteps(a).join('\n'), 'Next steps');
  clack.outro('Init complete.');
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
  main(process.argv.slice(2)).catch((err: unknown) => {
    process.stderr.write(`init-clone: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  });
}
