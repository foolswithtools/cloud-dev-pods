import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { resolveConfig } from '../lib/config/schema';
import { ClusterStack } from '../lib/stacks/cluster-stack';
import { NetworkStack } from '../lib/stacks/network-stack';

type Statement = {
  Effect: 'Allow' | 'Deny';
  Principal?: unknown;
  Action: string | string[];
  Condition?: Record<string, Record<string, unknown>>;
};

let fsProps: Record<string, unknown>;
let statements: Statement[];

const CLIENT_ACTIONS = [
  'elasticfilesystem:ClientMount',
  'elasticfilesystem:ClientRootAccess',
  'elasticfilesystem:ClientWrite',
];
const actionsOf = (s: Statement): string[] => [s.Action].flat().slice().sort();

beforeAll(() => {
  const { config } = resolveConfig({
    project: {},
    aws: { accountId: '123456789012' },
    github: { org: 'acme', repo: 'cloud-dev-pods' },
    domain: {},
    network: {},
    pods: {},
    naming: {},
    auth: { browser: { allowedOrg: 'acme' } },
  });
  const app = new App();
  const env = { account: '123456789012', region: config.aws.region };
  const network = new NetworkStack(app, 'Network', { env, config });
  const cluster = new ClusterStack(app, 'Cluster', { env, config, network });
  const template = Template.fromStack(cluster);
  const filesystems = Object.values(template.findResources('AWS::EFS::FileSystem'));
  expect(filesystems).toHaveLength(1);
  fsProps = filesystems[0]!.Properties as Record<string, unknown>;
  const policy = fsProps.FileSystemPolicy as { Statement?: Statement[] } | undefined;
  statements = policy?.Statement ?? [];
});

describe('ClusterStack', () => {
  it.todo('synthesizes ALB with HTTPS listener and HTTP redirect');
  it.todo('uses Fargate Spot capacity provider with configurable weight');
  it.todo('publishes outputs to SSM Parameter Store, not CFN exports');
});

// Issue #217: the file-system policy requires TLS, IAM and an access point.
describe('ClusterStack EFS file-system policy', () => {
  it('attaches a FileSystemPolicy to the EFS file system', () => {
    expect(fsProps.FileSystemPolicy).toBeDefined();
  });

  it('denies client access without TLS', () => {
    const deny = statements.find(
      (s) => s.Effect === 'Deny' && s.Condition?.Bool?.['aws:SecureTransport'] === 'false',
    );
    expect(deny).toBeDefined();
    expect(actionsOf(deny!)).toEqual(CLIENT_ACTIONS);
  });

  it('denies client access that does not go through an access point', () => {
    const deny = statements.find(
      (s) => s.Effect === 'Deny' && s.Condition?.Null?.['elasticfilesystem:AccessPointArn'] === 'true',
    );
    expect(deny).toBeDefined();
    expect(actionsOf(deny!)).toEqual(CLIENT_ACTIONS);
  });

  it('grants nothing to * or anonymous principals and never allows ClientRootAccess', () => {
    // The policy only denies; identity grants on the task roles do the
    // allowing. With no Allow at all, nothing reaches a * or anonymous
    // principal and nothing grants ClientRootAccess.
    expect(statements.filter((st) => st.Effect === 'Allow')).toEqual([]);
    expect(statements.every((st) => st.Effect === 'Deny')).toBe(true);
  });

  it('keeps encryption at rest and the IA lifecycle policy', () => {
    expect(fsProps.Encrypted).toBe(true);
    expect(fsProps.LifecyclePolicies).toEqual([{ TransitionToIA: 'AFTER_30_DAYS' }]);
  });
});
