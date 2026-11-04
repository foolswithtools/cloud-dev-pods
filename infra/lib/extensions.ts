// Fork extension hooks (#239). A fork customizes the CDK stacks from
// `infra/extensions.local.ts` instead of editing `[tracked]` files under
// `infra/lib/**`. See docs/extending.md.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { App, Stack } from 'aws-cdk-lib';
import type { Config } from './config/config';
import type { BootstrapStack } from './stacks/bootstrap-stack';
import type { ClusterStack } from './stacks/cluster-stack';
import type { IdleReaperStack } from './stacks/idle-reaper-stack';
import type { NetworkStack } from './stacks/network-stack';
import type { PodManagerStack } from './stacks/pod-manager-stack';
import type { PodTaskFamilyStack } from './stacks/pod-task-family-stack';

/** Passed to every hook alongside its stack. */
export interface ExtensionContext {
  app: App;
  config: Config;
}

type Hook<S extends Stack> = (stack: S, ctx: ExtensionContext) => void;

/**
 * Every hook is optional. Each runs right after its stack is constructed and
 * before the next stack is, so a later hook sees what an earlier one added.
 * cdk-nag checks resources a hook adds, like any other.
 */
export interface Extensions {
  customizeBootstrap?: Hook<BootstrapStack>;
  customizeNetwork?: Hook<NetworkStack>;
  customizeCluster?: Hook<ClusterStack>;
  customizePodTaskFamily?: Hook<PodTaskFamilyStack>;
  customizePodManager?: Hook<PodManagerStack>;
  customizeIdleReaper?: Hook<IdleReaperStack>;
}

/** Hook names, in the order `buildStacks` calls them. */
export const EXTENSION_HOOKS = [
  'customizeBootstrap',
  'customizeNetwork',
  'customizeCluster',
  'customizePodTaskFamily',
  'customizePodManager',
  'customizeIdleReaper',
] as const satisfies ReadonlyArray<keyof Extensions>;

/** `infra/extensions.local.ts`, resolved from this file (`infra/lib/`). */
export const DEFAULT_EXTENSIONS_PATH = join(__dirname, '..', 'extensions.local.ts');

/** Checks the shape of a loaded `extensions` export; throws naming `source`. */
export function validateExtensions(value: unknown, source: string): Extensions {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${source}: \`extensions\` must be an object of hook functions.`);
  }
  const known: readonly string[] = EXTENSION_HOOKS;
  for (const [key, hook] of Object.entries(value)) {
    if (!known.includes(key)) {
      throw new Error(`${source}: unknown hook "${key}". Known hooks: ${EXTENSION_HOOKS.join(', ')}.`);
    }
    if (hook !== undefined && typeof hook !== 'function') {
      throw new Error(`${source}: ${key} must be a function (got ${typeof hook}).`);
    }
  }
  return value as Extensions;
}

/**
 * Loads the `extensions` export from `path`, or returns no hooks when the
 * file doesn't exist. The CDK app runs under ts-node, so a `.ts` file loads
 * directly.
 */
export function loadExtensions(path: string = DEFAULT_EXTENSIONS_PATH): Extensions {
  if (!existsSync(path)) return {};
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require(path) as Record<string, unknown>;
  if (!('extensions' in mod)) {
    throw new Error(`${path}: no \`extensions\` export. Export \`const extensions = { ... }\` (see docs/extending.md).`);
  }
  return validateExtensions(mod.extensions, path);
}
