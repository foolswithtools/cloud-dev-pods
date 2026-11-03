import type { App, Environment } from 'aws-cdk-lib';
import type { Config } from './config/config';
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
 */
export function buildStacks(app: App, config: Config, env: Environment): void {
  const names = stackNames(config.naming.prefix);

  // Phase 4: Bootstrap (one-time, account-level).
  new BootstrapStack(app, names.bootstrap, { env, config });

  // Phase 4: Network.
  const network = new NetworkStack(app, names.network, { env, config });

  // Phase 6: Cluster.
  const cluster = new ClusterStack(app, names.cluster, { env, config, network });

  // Phase 7: Pod task family + pod manager.
  const taskFamily = new PodTaskFamilyStack(app, names.podTaskFamily, {
    env, config, cluster,
  });
  const podManager = new PodManagerStack(app, names.podManager, {
    env, config, network, cluster, taskFamily,
  });

  // Phase 8: Idle reaper.
  new IdleReaperStack(app, names.idleReaper, { env, config, cluster, podManager });
}
