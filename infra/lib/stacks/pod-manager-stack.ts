import { Stack, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { Config } from '../config/schema.js';
import type { ClusterStack } from './cluster-stack.js';
import type { PodTaskFamilyStack } from './pod-task-family-stack.js';

export interface PodManagerStackProps extends StackProps {
  config: Config;
  cluster: ClusterStack;
  taskFamily: PodTaskFamilyStack;
}

/**
 * Pod lifecycle Lambda + DynamoDB registry.
 *
 * Phase 7 will build out:
 * - `pod-manager` Lambda (Node 20, ARM64) with actions: up | down | list | status.
 * - `cloud-dev-pods-registry` DynamoDB table (PK: podName).
 * - This is the ONLY component holding ECS/ALB/EFS write permissions.
 *   GitHub Actions OIDC role only has `lambda:InvokeFunction` on this Lambda.
 */
export class PodManagerStack extends Stack {
  constructor(scope: Construct, id: string, props: PodManagerStackProps) {
    super(scope, id, props);
    void props.config;
    void props.cluster;
    void props.taskFamily;
  }
}
