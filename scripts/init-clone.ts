#!/usr/bin/env node
/**
 * Interactive setup for a fresh cloud-dev-pods fork.
 *
 *   - Auto-detects AWS account/region, GitHub owner/repo, Route53 zones.
 *   - Prompts for domain strategy, OAuth allowlist, VPC CIDR, sizing, idle.
 *   - Writes config/config.yaml, .upstream-sync.state, .envrc,
 *     infra/extensions.local.ts (stub).
 *   - Pushes initial GitHub repo Variables via `gh variable set`.
 *   - Optional: creates the cloud-dev-pods-bootstrap IAM user and pushes
 *     its access keys as repo Secrets (avoids the GitHub-UI paste-mangling
 *     issue surfaced during smoke testing).
 *   - Idempotent: rerunning prompts to overwrite or skip each artifact.
 *
 * Usage:
 *   npm run init
 */

import * as clack from '@clack/prompts';
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = process.cwd();
const CONFIG_PATH = join(REPO_ROOT, 'config', 'config.yaml');
const STATE_PATH = join(REPO_ROOT, '.upstream-sync.state');
const ENVRC_PATH = join(REPO_ROOT, '.envrc');
const EXTENSIONS_PATH = join(REPO_ROOT, 'infra', 'extensions.local.ts');

interface Defaults {
  awsAccountId?: string;
  awsRegion?: string;
  githubOwner?: string;
  githubRepo?: string;
  hostedZones: { name: string; id: string }[];
}

interface Answers {
  awsAccountId: string;
  awsRegion: string;
  githubOwner: string;
  githubRepo: string;
  domainStrategy: 'byo' | 'alb-default';
  baseDomain: string;
  hostedZoneId: string;
  oauthAllowedUsers: string;
  oauthAllowedOrg: string;
  vpcCidr: string;
  cpu: number;
  memory: number;
  idleMinutes: number;
}

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
    validate: v((s) => (/^\d{12}$/.test(s) ? undefined : 'Must be exactly 12 digits.')),
  });
  checkOrExit(accountId, 'AWS account ID');
  a.awsAccountId = accountId;

  const region = await clack.text({
    message: 'AWS region',
    placeholder: 'us-west-2',
    initialValue: defaults.awsRegion ?? 'us-west-2',
    validate: v((s) => (s.length > 0 ? undefined : 'Required.')),
  });
  checkOrExit(region, 'AWS region');
  a.awsRegion = region;

  const owner = await clack.text({
    message: 'GitHub owner (your username or org)',
    initialValue: defaults.githubOwner,
    validate: v((s) => (s.length > 0 ? undefined : 'Required.')),
  });
  checkOrExit(owner, 'GitHub owner');
  a.githubOwner = owner;

  const repo = await clack.text({
    message: 'GitHub repo name',
    initialValue: defaults.githubRepo,
    validate: v((s) => (s.length > 0 ? undefined : 'Required.')),
  });
  checkOrExit(repo, 'GitHub repo');
  a.githubRepo = repo;

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
        validate: v((s) => (/^Z[A-Z0-9]{10,}$/.test(s) ? undefined : 'Must look like Z01234567ABCDEFGHIJK.')),
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
  a.oauthAllowedUsers = '';
  a.oauthAllowedOrg = '';
  if (allowKind === 'user' || allowKind === 'both') {
    const users = await clack.text({
      message: 'Comma-separated GitHub usernames',
      initialValue: defaults.githubOwner ?? '',
      validate: v((s) => (s.length > 0 ? undefined : 'Required.')),
    });
    checkOrExit(users, 'Allowed users');
    a.oauthAllowedUsers = users;
  }
  if (allowKind === 'org' || allowKind === 'both') {
    const org = await clack.text({
      message: 'GitHub organization login',
      placeholder: defaults.githubOwner ?? 'foolswithtools',
    });
    checkOrExit(org, 'Allowed org');
    a.oauthAllowedOrg = org;
  }

  const cidr = await clack.text({
    message: 'VPC CIDR (avoid collisions with VPCs you might peer with later)',
    placeholder: '10.50.0.0/16',
    initialValue: '10.50.0.0/16',
    validate: v((s) =>
      /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(s) ? undefined : 'Must be valid CIDR.'),
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
  const sizes: Record<string, { cpu: number; memory: number }> = {
    small: { cpu: 512, memory: 1024 },
    medium: { cpu: 1024, memory: 2048 },
    large: { cpu: 2048, memory: 4096 },
    xlarge: { cpu: 4096, memory: 8192 },
  };
  const size = sizes[sizing as keyof typeof sizes] ?? { cpu: 1024, memory: 2048 };
  a.cpu = size.cpu;
  a.memory = size.memory;

  const idleStr = await clack.text({
    message: 'Idle-shutdown threshold (minutes; 0 = disabled)',
    placeholder: '60',
    initialValue: '60',
    validate: v((s) => (/^\d+$/.test(s) ? undefined : 'Must be a non-negative integer.')),
  });
  checkOrExit(idleStr, 'Idle minutes');
  a.idleMinutes = parseInt(idleStr, 10);

  return a as Answers;
}

function renderConfigYaml(a: Answers): string {
  const oauthLines: string[] = [];
  if (a.oauthAllowedUsers) oauthLines.push(`  oauthAllowedUsers: ${a.oauthAllowedUsers}`);
  if (a.oauthAllowedOrg) oauthLines.push(`  oauthAllowedOrg: ${a.oauthAllowedOrg}`);

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
${oauthLines.join('\n')}

${domainBlock}

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

async function main(): Promise<void> {
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
  const s = clack.spinner();
  s.start('Pushing GitHub repo Variables');
  let okCount = 0;
  okCount += (await pushGhVariable('AWS_REGION', a.awsRegion)) ? 1 : 0;
  okCount += (await pushGhVariable('AWS_ACCOUNT_ID', a.awsAccountId)) ? 1 : 0;
  okCount += (await pushGhVariable('CLUSTER_NAME', 'cloud-dev-pods')) ? 1 : 0;
  s.stop(`Pushed ${okCount}/3 Variables.`);

  // Optional: create bootstrap IAM user.
  await maybeCreateBootstrapIam();

  // Outro with next steps.
  const nextSteps: string[] = [
    `1. Commit config/config.yaml: \`git add config/config.yaml && git commit -m 'chore: init config' && git push\``,
    `2. Run bootstrap: \`gh workflow run bootstrap-aws.yml -f confirm_account_id=${a.awsAccountId}\``,
    `3. After bootstrap succeeds, set role ARNs and clean up:`,
    `     DEPLOYER=$(aws ssm get-parameter --name /cloud-dev-pods/dev/bootstrap/deployer-role-arn --query Parameter.Value --output text)`,
    `     PODOPS=$(aws ssm get-parameter --name /cloud-dev-pods/dev/bootstrap/pod-ops-role-arn --query Parameter.Value --output text)`,
    `     gh variable set AWS_DEPLOYER_ROLE_ARN --body "$DEPLOYER"`,
    `     gh variable set AWS_POD_OPS_ROLE_ARN --body "$PODOPS"`,
    `     gh secret delete AWS_BOOTSTRAP_ACCESS_KEY_ID && gh secret delete AWS_BOOTSTRAP_SECRET_ACCESS_KEY`,
  ];
  if (a.domainStrategy === 'byo') {
    nextSteps.push(
      `4. Browser-mode only: register an OAuth App at https://github.com/settings/applications/new`,
      `     Callback URL: https://<podname>.${a.baseDomain}/oauth2/callback`,
      `5. Update oauth secrets:`,
      `     aws secretsmanager update-secret --secret-id /cloud-dev-pods/oauth/client-id --secret-string "<id>"`,
      `     aws secretsmanager update-secret --secret-id /cloud-dev-pods/oauth/client-secret --secret-string "<secret>"`,
      `6. Build images and bring up the cluster:`,
    );
  } else {
    nextSteps.push(`4. Build images and bring up the cluster:`);
  }
  nextSteps.push(
    `     gh workflow run build-runtime.yml`,
    `     gh workflow run cluster-up.yml`,
  );

  clack.note(nextSteps.join('\n'), 'Next steps');
  clack.outro('Init complete.');
}

main().catch((err: unknown) => {
  process.stderr.write(`init-clone: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
