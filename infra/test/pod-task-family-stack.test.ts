import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { resolveConfig } from '../lib/config/schema';
import { ClusterStack } from '../lib/stacks/cluster-stack';
import { NetworkStack } from '../lib/stacks/network-stack';
import { PodTaskFamilyStack } from '../lib/stacks/pod-task-family-stack';

let template: Template;

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
  const stack = new PodTaskFamilyStack(app, 'PodTaskFamily', { env, config, cluster });
  template = Template.fromStack(stack);
});

describe('PodTaskFamilyStack', () => {
  // The pod-manager Lambda registers every runtime revision itself (with the
  // sidecar from infra/lambda/pod-manager/oauth2-proxy.ts); the CDK revision
  // only reserves the family name, so it carries no oauth2-proxy copy.
  it('registers cloud-dev-pods-browser family with only the vscode container', () => {
    const defs = template.findResources('AWS::ECS::TaskDefinition', {
      Properties: { Family: 'cloud-dev-pods-browser' },
    });
    const [td] = Object.values(defs);
    expect(td).toBeDefined();
    const containers = (td!.Properties.ContainerDefinitions as { Name: string }[]).map((c) => c.Name);
    expect(containers).toEqual(['vscode']);
    expect(JSON.stringify(template.toJSON())).not.toContain('oauth2-proxy/oauth2-proxy');
  });

  it('registers cloud-dev-pods-tunnel family with single vscode-tunnel container', () => {
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Family: 'cloud-dev-pods-tunnel',
      ContainerDefinitions: [Match.objectLike({ Name: 'vscode-tunnel' })],
    });
  });

  it('execution role can still read all three oauth secrets for Lambda-registered revisions', () => {
    const json = JSON.stringify(template.findResources('AWS::IAM::Policy'));
    for (const name of ['client-id', 'client-secret', 'cookie-secret']) {
      expect(json).toContain(`/cloud-dev-pods/oauth/${name}`);
    }
  });

  it.todo('mounts EFS at /workspace via per-pod access point');
});
