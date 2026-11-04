import type { App, Environment } from 'aws-cdk-lib';
import type { Config } from './config/config';
import type { Extensions } from './extensions';
import { stackNames } from './stack-names';
import { BootstrapStack } from './stacks/bootstrap-stack';
import { ClusterStack } from './stacks/cluster-stack';
import { IdleReaperStack } from './stacks/idle-reaper-stack';
import { NetworkStack } from './stacks/network-stack';
import { PodManagerStack } from './stacks/pod-manager-stack';
import { PodTaskFamilyStack } from './stacks/pod-task-family-stack';

/**
 * Construct every cloud-dev-pods stack on `app`. Stack IDs come from
 * `stackNames(config.naming.prefix)`, the same list the workflows use, so
 * adding a stack here without adding it to `stack-names.ts` fails
 * `infra/test/stack-names.test.ts`.
 *
 * `extensions` are the fork's hooks from `infra/extensions.local.ts` (#239).
 * Each runs right after its stack is constructed.
 */
export function buildStacks(
  app: App,
  config: Config,
  env: Environment,
  extensions: Extensions = {},
): void {
  const names = stackNames(config.naming.prefix);
  const ctx = { app, config };

  // Phase 4: Bootstrap (one-time, account-level).
  const bootstrap = new BootstrapStack(app, names.bootstrap, { env, config });
  extensions.customizeBootstrap?.(bootstrap, ctx);

  // Phase 4: Network.
  const network = new NetworkStack(app, names.network, { env, config });
  extensions.customizeNetwork?.(network, ctx);

  // Phase 6: Cluster.
  const cluster = new ClusterStack(app, names.cluster, { env, config, network });
  extensions.customizeCluster?.(cluster, ctx);

  // Phase 7: Pod task family + pod manager.
  const taskFamily = new PodTaskFamilyStack(app, names.podTaskFamily, {
    env, config, cluster,
  });
  extensions.customizePodTaskFamily?.(taskFamily, ctx);
  const podManager = new PodManagerStack(app, names.podManager, {
    env, config, network, cluster, taskFamily,
  });
  extensions.customizePodManager?.(podManager, ctx);

  // Phase 8: Idle reaper.
  const idleReaper = new IdleReaperStack(app, names.idleReaper, { env, config, cluster, podManager });
  extensions.customizeIdleReaper?.(idleReaper, ctx);
}
