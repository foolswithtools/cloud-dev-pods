#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { Aspects } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { loadConfig } from '../lib/config/config';
import { BootstrapStack } from '../lib/stacks/bootstrap-stack';
import { ClusterStack } from '../lib/stacks/cluster-stack';
import { IdleReaperStack } from '../lib/stacks/idle-reaper-stack';
import { NetworkStack } from '../lib/stacks/network-stack';
import { PodManagerStack } from '../lib/stacks/pod-manager-stack';
import { PodTaskFamilyStack } from '../lib/stacks/pod-task-family-stack';
import { applyProjectTags } from '../lib/util/tags';

const app = new cdk.App();
const config = loadConfig();

// Stacks are env-agnostic at synth time; real account/region come from
// CDK_DEFAULT_* (set by aws-actions/configure-aws-credentials in CI) or
// from the user's local AWS profile at deploy time. config.aws.region is
// the fallback so synth without any AWS context still produces consistent
// region-flavored output (e.g. for cdk-nag region-specific rules).
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? config.aws.region,
};
const prefix = config.naming.prefix;

// Phase 4: Bootstrap (one-time, account-level).
new BootstrapStack(app, `${prefix}-Bootstrap`, { env, config });

// Phase 4: Network.
const network = new NetworkStack(app, `${prefix}-Network`, { env, config });

// Phase 6 (stub): Cluster.
const cluster = new ClusterStack(app, `${prefix}-Cluster`, { env, config, network });

// Phase 7 (stubs): Pod task family + pod manager.
const taskFamily = new PodTaskFamilyStack(app, `${prefix}-PodTaskFamily`, {
  env, config, cluster,
});
const podManager = new PodManagerStack(app, `${prefix}-PodManager`, {
  env, config, network, cluster, taskFamily,
});

// Phase 8: Idle reaper.
new IdleReaperStack(app, `${prefix}-IdleReaper`, { env, config, cluster, podManager });

applyProjectTags(app, config);
Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
