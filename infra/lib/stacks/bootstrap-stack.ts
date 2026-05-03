import { Stack, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { Config } from '../config/schema.js';

export interface BootstrapStackProps extends StackProps {
  config: Config;
}

/**
 * One-time, account-level bootstrap.
 *
 * Phase 4 will build out:
 * - GitHub OIDC identity provider (`token.actions.githubusercontent.com`).
 * - `CloudDevPodsDeployerRole` (broad CDK deploy power, bounded).
 * - `CloudDevPodsPodOpsRole` (lambda:Invoke on pod-manager only).
 * - `CloudDevPodsBoundary` permissions boundary.
 * - ECR repos for runtime images.
 */
export class BootstrapStack extends Stack {
  constructor(scope: Construct, id: string, props: BootstrapStackProps) {
    super(scope, id, props);
    void props.config;
  }
}
