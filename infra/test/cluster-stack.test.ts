import { describe, it } from 'vitest';

describe('ClusterStack', () => {
  it.todo('synthesizes ALB with HTTPS listener and HTTP redirect');
  it.todo('synthesizes EFS with encryption + IA lifecycle');
  it.todo('uses Fargate Spot capacity provider with configurable weight');
  it.todo('publishes outputs to SSM Parameter Store, not CFN exports');
});
