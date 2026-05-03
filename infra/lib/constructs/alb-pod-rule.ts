import { Construct } from 'constructs';

export interface AlbPodRuleProps {
  // Phase 8: listener, podName, baseDomain, target group ARN, deterministic priority.
  readonly placeholder?: never;
}

/**
 * Per-pod ALB listener rule + target group.
 * Host-based routing: `<podName>.<baseDomain>` -> port 4180 on the task ENI.
 * Priority: (fnv1a(podName) % 49000) + 1000 with collision retry.
 */
export class AlbPodRule extends Construct {
  constructor(scope: Construct, id: string, props?: AlbPodRuleProps) {
    super(scope, id);
    void props;
  }
}
