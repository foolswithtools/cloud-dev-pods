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

  it('gives the tunnel container 30 s to unregister on stop (issue #141)', () => {
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Family: 'cloud-dev-pods-tunnel',
      ContainerDefinitions: [Match.objectLike({ Name: 'vscode-tunnel', StopTimeout: 30 })],
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

// ssh mode (issue #145): separate task and execution roles so per-pod
// backend secrets (#147) never touch the shared execution role.
describe('PodTaskFamilyStack ssh roles and family', () => {
  type Res = { Type: string; Properties: Record<string, unknown> };
  const roleId = (name: string): string => {
    const roles = template.findResources('AWS::IAM::Role', { Properties: { RoleName: name } });
    const ids = Object.keys(roles);
    expect(ids, `role ${name}`).toHaveLength(1);
    return ids[0]!;
  };
  // AWS::IAM::Policy resources whose Roles list references the logical ID.
  const policiesFor = (logicalId: string): Res[] =>
    Object.values(template.findResources('AWS::IAM::Policy') as Record<string, Res>).filter((p) =>
      JSON.stringify(p.Properties.Roles).includes(`"${logicalId}"`),
    );

  it('CloudDevPodsSshTaskRole: only inline policy is the ssh/* log-stream statement', () => {
    const id = roleId('CloudDevPodsSshTaskRole');
    const role = template.toJSON().Resources[id] as Res;
    expect(role.Properties.ManagedPolicyArns).toBeUndefined();
    const inline = role.Properties.Policies as Array<{ PolicyDocument: { Statement: Array<Record<string, unknown>> } }>;
    expect(inline).toHaveLength(1);
    const stmts = inline[0]!.PolicyDocument.Statement;
    expect(stmts).toHaveLength(1);
    expect(stmts[0]!.Action).toEqual(['logs:CreateLogStream', 'logs:PutLogEvents']);
    expect(JSON.stringify(stmts[0]!.Resource)).toMatch(/:log-stream:ssh\/\*"/);
    expect(policiesFor(id)).toEqual([]);
  });

  it('CloudDevPodsSshTaskExecutionRole: ECS managed policy and no secretsmanager actions', () => {
    const id = roleId('CloudDevPodsSshTaskExecutionRole');
    const role = template.toJSON().Resources[id] as Res;
    expect(role.Properties.Path).toBe('/cloud-dev-pods/');
    expect(JSON.stringify(role.Properties.AssumeRolePolicyDocument)).toContain('ecs-tasks.amazonaws.com');
    expect(JSON.stringify(role.Properties.ManagedPolicyArns)).toContain(
      'service-role/AmazonECSTaskExecutionRolePolicy',
    );
    expect(JSON.stringify(role.Properties.Policies ?? [])).not.toContain('secretsmanager:');
    for (const p of policiesFor(id)) {
      expect(JSON.stringify(p.Properties.PolicyDocument)).not.toContain('secretsmanager:');
    }
  });

  it('shared CloudDevPodsTaskExecutionRole policy still reads exactly the three oauth secrets', () => {
    const id = roleId('CloudDevPodsTaskExecutionRole');
    const policies = policiesFor(id);
    const smStatements = policies.flatMap((p) =>
      (p.Properties.PolicyDocument as { Statement: Array<{ Action: unknown; Resource: unknown }> }).Statement,
    ).filter((s) => JSON.stringify(s.Action).includes('secretsmanager:'));
    const resources = JSON.stringify(smStatements.map((s) => s.Resource));
    for (const name of ['client-id', 'client-secret', 'cookie-secret']) {
      expect(resources).toContain(`/cloud-dev-pods/oauth/${name}`);
    }
    // Nothing from Secrets Manager outside /cloud-dev-pods/oauth/.
    const secretPaths = resources.match(/secret:[^"]+/g) ?? [];
    expect(secretPaths).toHaveLength(3);
    for (const p of secretPaths) expect(p).toMatch(/^secret:\/cloud-dev-pods\/oauth\/(client-id|client-secret|cookie-secret)-\?{6}$/);
  });

  it('registers cloud-dev-pods-ssh family with a single vscode-ssh container on the ssh roles', () => {
    const defs = template.findResources('AWS::ECS::TaskDefinition', {
      Properties: { Family: 'cloud-dev-pods-ssh' },
    });
    const [td] = Object.values(defs) as Res[];
    expect(td).toBeDefined();
    const containers = td!.Properties.ContainerDefinitions as Array<{ Name: string; Image: unknown }>;
    expect(containers.map((c) => c.Name)).toEqual(['vscode-ssh']);
    expect(JSON.stringify(containers[0]!.Image)).toContain('cloud-dev-pods/vscode-tunnel');
    expect(JSON.stringify(td!.Properties.TaskRoleArn)).toContain(roleId('CloudDevPodsSshTaskRole'));
    expect(JSON.stringify(td!.Properties.ExecutionRoleArn)).toContain(roleId('CloudDevPodsSshTaskExecutionRole'));
  });

  it('exports the ssh family and role ARNs as SSM params', () => {
    for (const suffix of ['ssh-arn', 'ssh-task-role-arn', 'ssh-execution-role-arn']) {
      template.hasResourceProperties('AWS::SSM::Parameter', {
        Name: Match.stringLikeRegexp(`pod-task-family/${suffix}$`),
      });
    }
  });
});
