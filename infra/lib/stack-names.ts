/**
 * Single source of truth for the CDK stack names.
 *
 * Every stack ID is `${naming.prefix}-<Suffix>`. `infra/lib/app.ts` builds the
 * app from these names, and the provisioning workflows read them through
 * `scripts/stack-names.ts`, so a fork with a custom `naming.prefix` deploys
 * and destroys the same stacks the app defines (#225).
 */
export interface StackNames {
  bootstrap: string;
  network: string;
  cluster: string;
  podTaskFamily: string;
  podManager: string;
  idleReaper: string;
}

export function stackNames(prefix: string): StackNames {
  return {
    bootstrap: `${prefix}-Bootstrap`,
    network: `${prefix}-Network`,
    cluster: `${prefix}-Cluster`,
    podTaskFamily: `${prefix}-PodTaskFamily`,
    podManager: `${prefix}-PodManager`,
    idleReaper: `${prefix}-IdleReaper`,
  };
}

/**
 * The stacks `cluster-up` deploys and `cluster-down` destroys: every stack
 * except Bootstrap, in deploy (dependency) order.
 */
export function clusterStackNames(prefix: string): string[] {
  const n = stackNames(prefix);
  return [n.network, n.cluster, n.podTaskFamily, n.podManager, n.idleReaper];
}

/** Every stack the app defines: Bootstrap first, then the cluster stacks. */
export function allStackNames(prefix: string): string[] {
  return [stackNames(prefix).bootstrap, ...clusterStackNames(prefix)];
}
