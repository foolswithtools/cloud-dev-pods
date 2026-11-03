// Print the CDK stack names derived from `naming.prefix` (#225).
//
// The provisioning workflows call this instead of hardcoding
// `CloudDevPods-*`, so a fork with a custom prefix deploys and destroys the
// stacks the CDK app actually defines. The names come from
// infra/lib/stack-names.ts, the same module infra/lib/app.ts builds the app
// from.
//
// Usage (config resolved like the CDK app: CDPODS_CONFIG, then
// config/config.yaml, then config/config.example.yaml):
//
//   tsx scripts/stack-names.ts --cluster     # every stack except Bootstrap, space-separated
//   tsx scripts/stack-names.ts --bootstrap   # the Bootstrap stack
//   tsx scripts/stack-names.ts --cluster-stack  # the Cluster stack (EFS lives here)
//   tsx scripts/stack-names.ts --all         # Bootstrap + cluster stacks
//   tsx scripts/stack-names.ts --prefix      # naming.prefix itself
//
// Exits non-zero, printing nothing on stdout, when the config can't be loaded
// or the prefix yields a name CloudFormation would reject.

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isInvokedAsCli } from './lib/cli-entry.js';

export type StackNamesMode = 'cluster' | 'bootstrap' | 'cluster-stack' | 'all' | 'prefix';

interface StackNamesModule {
  stackNames: (prefix: string) => { bootstrap: string; cluster: string };
  clusterStackNames: (prefix: string) => string[];
  allStackNames: (prefix: string) => string[];
}

// Dynamic import: a static `import '../infra/...'` fails `tsc -b scripts`
// with TS6059 because the file sits outside scripts/'s rootDir.
async function loadInfra(): Promise<{
  names: StackNamesModule;
  loadConfig: () => { naming: { prefix: string } };
}> {
  const names = (await import(
    pathToFileURL(resolve(import.meta.dirname, '../infra/lib/stack-names.ts')).href
  )) as StackNamesModule;
  const { loadConfig } = (await import(
    pathToFileURL(resolve(import.meta.dirname, '../infra/lib/config/config.ts')).href
  )) as { loadConfig: () => { naming: { prefix: string } } };
  return { names, loadConfig };
}

export function parseStackNamesArgs(argv: string[]): { mode: StackNamesMode } | { error: string } {
  const modes: Record<string, StackNamesMode> = {
    '--cluster': 'cluster',
    '--bootstrap': 'bootstrap',
    '--cluster-stack': 'cluster-stack',
    '--all': 'all',
    '--prefix': 'prefix',
  };
  if (argv.length !== 1 || !(argv[0]! in modes)) {
    return { error: 'Usage: stack-names.ts --cluster | --bootstrap | --cluster-stack | --all | --prefix' };
  }
  return { mode: modes[argv[0]!]! };
}

// CloudFormation stack names: a letter, then letters, digits and hyphens, at
// most 128 characters.
const STACK_NAME = /^[A-Za-z][A-Za-z0-9-]{0,127}$/;

/**
 * The names for `mode`, or an error when any would be rejected by
 * CloudFormation (e.g. a prefix with a space or underscore). Failing here
 * stops a workflow before it deploys or destroys anything.
 */
export async function resolveStackNames(
  prefix: string,
  mode: StackNamesMode,
): Promise<{ names: string[] } | { error: string }> {
  const { names } = await loadInfra();
  const all = names.allStackNames(prefix);
  const bad = all.filter((n) => !STACK_NAME.test(n));
  if (bad.length > 0) {
    return {
      error: `naming.prefix ${JSON.stringify(prefix)} yields invalid CloudFormation stack name(s): ${bad.join(', ')}. Use letters, digits and hyphens, starting with a letter.`,
    };
  }
  switch (mode) {
    case 'cluster':
      return { names: names.clusterStackNames(prefix) };
    case 'bootstrap':
      return { names: [names.stackNames(prefix).bootstrap] };
    case 'cluster-stack':
      return { names: [names.stackNames(prefix).cluster] };
    case 'all':
      return { names: all };
    case 'prefix':
      return { names: [prefix] };
  }
}

async function main() {
  const parsed = parseStackNamesArgs(process.argv.slice(2));
  if ('error' in parsed) {
    console.error(parsed.error);
    process.exit(2);
  }
  const { loadConfig } = await loadInfra();
  const prefix = loadConfig().naming.prefix;
  const result = await resolveStackNames(prefix, parsed.mode);
  if ('error' in result) {
    console.error(`::error::${result.error}`);
    process.exit(1);
  }
  console.log(result.names.join(' '));
}

// Only run main() when invoked as a CLI (not when imported by tests).
if (isInvokedAsCli(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
