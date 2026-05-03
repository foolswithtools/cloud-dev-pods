import { Stack, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { Config } from '../config/schema';
import type { PodManagerStack } from './pod-manager-stack';

export interface IdleReaperStackProps extends StackProps {
  config: Config;
  podManager: PodManagerStack;
}

/**
 * Idle pod reaper.
 *
 * Phase 8 will build out:
 * - EventBridge rule `every(5 minutes)` -> idle-reaper Lambda.
 * - Browser pods: `RequestCount` per target group over `idleMinutes`.
 * - Tunnel pods: CW Logs Insights query for last log line vs threshold.
 * - Two-phase shutdown: first detection notifies, second StopTask.
 */
export class IdleReaperStack extends Stack {
  constructor(scope: Construct, id: string, props: IdleReaperStackProps) {
    super(scope, id, props);
    void props.config;
    void props.podManager;
  }
}
