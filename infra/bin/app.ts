#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { buildStacks } from '../lib/app';
import { loadConfig } from '../lib/config/config';
import { loadExtensions } from '../lib/extensions';
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

// Stack IDs are `${naming.prefix}-<Suffix>`; see lib/stack-names.ts.
// Fork hooks come from infra/extensions.local.ts when it exists (#239).
buildStacks(app, config, env, loadExtensions());

applyProjectTags(app, config);
// cdk-nag v3: a policy-validation plugin; unacknowledged findings fail synth.
// writeSuppressionsToCloudFormation keeps the v2-style `cdk_nag` metadata
// (rule IDs + reasons) in the templates as an audit trail.
Validations.of(app).addPlugins(
  new AwsSolutionsChecks(app, { verbose: true, writeSuppressionsToCloudFormation: true }),
);
