import { Stack, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { Config } from '../config/schema.js';

export interface NetworkStackProps extends StackProps {
  config: Config;
}

/**
 * VPC, subnets, NAT, security groups.
 *
 * Phase 4 will build out:
 * - 2 AZs, 2 public + 2 private subnets, 1 NAT (configurable to 2).
 * - sg-alb (443 from world), sg-tasks (4180 from sg-alb), sg-efs (2049 from sg-tasks).
 * - Optional VPC endpoints (S3 gateway; ECR/Secrets/Logs interface, gated by `useVpcEndpoints`).
 */
export class NetworkStack extends Stack {
  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);
    void props.config;
  }
}
