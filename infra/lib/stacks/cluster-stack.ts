import { Stack, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { Config } from '../config/schema';
import type { NetworkStack } from './network-stack';

export interface ClusterStackProps extends StackProps {
  config: Config;
  network: NetworkStack;
}

/**
 * ECS cluster + EFS + ALB + ACM cert + log groups.
 *
 * Phase 6 will build out:
 * - ECS cluster with Fargate + Fargate Spot capacity providers.
 * - EFS filesystem (encrypted, IA after 30d).
 * - Internet-facing ALB, HTTPS listener (default 404), HTTP -> HTTPS redirect.
 * - ACM cert covering `*.<base-domain>` (when domainStrategy = "byo").
 * - Route53 wildcard A-alias `*.pods.<base>` -> ALB.
 * - CloudWatch log groups `/cloud-dev-pods/cluster` and `/cloud-dev-pods/pods`.
 */
export class ClusterStack extends Stack {
  constructor(scope: Construct, id: string, props: ClusterStackProps) {
    super(scope, id, props);
    void props.config;
    void props.network;
  }
}
