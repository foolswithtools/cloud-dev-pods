import { Stack, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { Config } from '../config/schema';
import type { ClusterStack } from './cluster-stack';

export interface PodTaskFamilyStackProps extends StackProps {
  config: Config;
  cluster: ClusterStack;
}

/**
 * Reusable Fargate task definition families.
 *
 * Phase 7 will register two families:
 * - `cloud-dev-pods-browser`: openvscode-server (port 3000, loopback) + oauth2-proxy (port 4180, ALB target).
 * - `cloud-dev-pods-tunnel`:  vscode-tunnel (single container, no ALB target).
 *
 * Each pod gets a fresh revision at RunTask time only when the image digest changes.
 * Pod-manager overrides image, env, and EFS access point per invocation.
 */
export class PodTaskFamilyStack extends Stack {
  constructor(scope: Construct, id: string, props: PodTaskFamilyStackProps) {
    super(scope, id, props);
    void props.config;
    void props.cluster;
  }
}
