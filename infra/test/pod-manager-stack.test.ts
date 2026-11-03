// PodManagerStack wiring for ssh mode (issue #145): the Lambda must be able
// to pass the ssh roles to ECS, and learns the ssh family/roles/backend from
// its environment.

import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { resolveConfig } from '../lib/config/schema';
import { ClusterStack } from '../lib/stacks/cluster-stack';
import { NetworkStack } from '../lib/stacks/network-stack';
import { PodManagerStack } from '../lib/stacks/pod-manager-stack';
import { PodTaskFamilyStack } from '../lib/stacks/pod-task-family-stack';

let template: Template;
let familyTemplate: Template;

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
  // Skip esbuild bundling of the Lambda; env vars and IAM still synthesize.
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const env = { account: '123456789012', region: config.aws.region };
  const network = new NetworkStack(app, 'Network', { env, config });
  const cluster = new ClusterStack(app, 'Cluster', { env, config, network });
  const taskFamily = new PodTaskFamilyStack(app, 'PodTaskFamily', { env, config, cluster });
  const podManager = new PodManagerStack(app, 'PodManager', { env, config, network, cluster, taskFamily });
  template = Template.fromStack(podManager);
  familyTemplate = Template.fromStack(taskFamily);
});

// Cross-stack refs render as Fn::ImportValue of an export whose name embeds
// the producing resource's logical ID.
function roleLogicalId(roleName: string): string {
  const ids = Object.keys(familyTemplate.findResources('AWS::IAM::Role', { Properties: { RoleName: roleName } }));
  expect(ids, roleName).toHaveLength(1);
  return ids[0]!;
}

describe('PodManagerStack ssh wiring', () => {
  it('iam:PassRole lists exactly the shared execution role, three task roles and the ssh execution role', () => {
    const statements = Object.values(template.findResources('AWS::IAM::Policy')).flatMap(
      (p) => (p.Properties.PolicyDocument as { Statement: Array<Record<string, unknown>> }).Statement,
    );
    const passRole = statements.filter((s) => s.Action === 'iam:PassRole' || JSON.stringify(s.Action) === '["iam:PassRole"]');
    expect(passRole).toHaveLength(1);
    const stmt = passRole[0]!;
    expect(stmt.Condition).toEqual({ StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } });

    const resources = stmt.Resource as unknown[];
    expect(resources).toHaveLength(5);
    const rendered = resources.map((r) => JSON.stringify(r));
    for (const name of [
      'CloudDevPodsTaskExecutionRole',
      'CloudDevPodsBrowserTaskRole',
      'CloudDevPodsTunnelTaskRole',
      'CloudDevPodsSshTaskRole',
      'CloudDevPodsSshTaskExecutionRole',
    ]) {
      const id = roleLogicalId(name);
      expect(rendered.filter((r) => r.includes(id)), name).toHaveLength(1);
    }
  });

  it('function env carries the ssh family, ssh role ARNs and an empty REMOTE_BACKEND', () => {
    const fns = template.findResources('AWS::Lambda::Function', { Properties: { FunctionName: 'pod-manager' } });
    const [fn] = Object.values(fns);
    expect(fn).toBeDefined();
    const vars = (fn!.Properties.Environment as { Variables: Record<string, unknown> }).Variables;
    expect(vars.SSH_TASK_DEF_FAMILY).toBeDefined();
    expect(JSON.stringify(vars.SSH_TASK_ROLE_ARN)).toContain(roleLogicalId('CloudDevPodsSshTaskRole'));
    expect(JSON.stringify(vars.SSH_EXECUTION_ROLE_ARN)).toContain(roleLogicalId('CloudDevPodsSshTaskExecutionRole'));
    expect(vars.REMOTE_BACKEND).toBe('');
  });
});

// Least-privilege scoping of the pod-manager role (issue #224).
interface Statement {
  Action: string | string[];
  Resource: unknown;
  Condition?: Record<string, Record<string, unknown>>;
}

function roleStatements(): Statement[] {
  return Object.values(template.findResources('AWS::IAM::Policy')).flatMap(
    (p) => (p.Properties.PolicyDocument as { Statement: Statement[] }).Statement,
  );
}

function actionsOf(s: Statement): string[] {
  return Array.isArray(s.Action) ? s.Action : [s.Action];
}

function resourcesOf(s: Statement): unknown[] {
  return Array.isArray(s.Resource) ? s.Resource : [s.Resource];
}

function statementsWith(action: string): Statement[] {
  const found = roleStatements().filter((s) => actionsOf(s).includes(action));
  expect(found.length, action).toBeGreaterThan(0);
  return found;
}

describe('PodManagerStack least privilege (#224)', () => {
  it('grants no route53 action (the Lambda never calls Route 53)', () => {
    const route53 = roleStatements().flatMap(actionsOf).filter((a) => a.startsWith('route53:'));
    expect(route53).toEqual([]);
  });

  it('does not grant elasticfilesystem:CreateAccessPoint on *', () => {
    for (const s of statementsWith('elasticfilesystem:CreateAccessPoint')) {
      expect(resourcesOf(s)).not.toContain('*');
      expect(JSON.stringify(s.Resource)).toContain('EfsFs');
    }
  });

  it('scopes elasticfilesystem:DeleteAccessPoint to Project-tagged access points', () => {
    for (const s of statementsWith('elasticfilesystem:DeleteAccessPoint')) {
      expect(resourcesOf(s)).not.toContain('*');
      expect(s.Condition?.StringEquals?.['aws:ResourceTag/Project']).toBe('cloud-dev-pods');
    }
  });

  it('allows elasticfilesystem:TagResource only as part of CreateAccessPoint', () => {
    for (const s of statementsWith('elasticfilesystem:TagResource')) {
      expect(resourcesOf(s)).not.toContain('*');
      expect(s.Condition?.StringEquals?.['elasticfilesystem:CreateAction']).toBe('CreateAccessPoint');
    }
  });

  it.each(['ecs:RunTask', 'ecs:StopTask', 'ecs:ListTasks', 'ecs:DescribeTasks'])(
    '%s carries an ecs:cluster condition on the cluster ARN',
    (action) => {
      for (const s of statementsWith(action)) {
        const cluster = s.Condition?.ArnEquals?.['ecs:cluster'];
        expect(cluster, action).toBeDefined();
        expect(JSON.stringify(cluster)).toContain('Cluster');
      }
    },
  );
});
