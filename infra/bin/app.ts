#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { Aspects } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { loadConfig } from '../lib/config/config.js';
import { BootstrapStack } from '../lib/stacks/bootstrap-stack.js';
import { NetworkStack } from '../lib/stacks/network-stack.js';
import { ClusterStack } from '../lib/stacks/cluster-stack.js';
import { PodTaskFamilyStack } from '../lib/stacks/pod-task-family-stack.js';
import { PodManagerStack } from '../lib/stacks/pod-manager-stack.js';
import { IdleReaperStack } from '../lib/stacks/idle-reaper-stack.js';
import { applyProjectTags } from '../lib/util/tags.js';

const app = new cdk.App();
const config = loadConfig(process.env.CDPODS_CONFIG ?? 'config/config.yaml');

const env = { account: config.aws.accountId, region: config.aws.region };

// Phase 4: Bootstrap (one-time, account-level)
const bootstrap = new BootstrapStack(app, `${config.naming.prefix}-Bootstrap`, { env, config });

// Phase 4: Network
const network = new NetworkStack(app, `${config.naming.prefix}-Network`, { env, config });

// Phase 6: Cluster (depends on Network)
const cluster = new ClusterStack(app, `${config.naming.prefix}-Cluster`, {
  env, config, network,
});

// Phase 7: Pod task family (depends on Cluster)
const taskFamily = new PodTaskFamilyStack(app, `${config.naming.prefix}-PodTaskFamily`, {
  env, config, cluster,
});

// Phase 7: Pod manager Lambda (depends on PodTaskFamily)
const podManager = new PodManagerStack(app, `${config.naming.prefix}-PodManager`, {
  env, config, cluster, taskFamily,
});

// Phase 8: Idle reaper (depends on PodManager)
new IdleReaperStack(app, `${config.naming.prefix}-IdleReaper`, {
  env, config, podManager,
});

applyProjectTags(app, config);
Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

void bootstrap;
void network;
void taskFamily;
