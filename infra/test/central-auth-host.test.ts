// Central auth host (#144, ADR 0009): one oauth2-proxy at auth.<baseDomain>
// completes every OAuth callback and sets a session cookie on .<baseDomain>.
//
//   1. Synth guard: auth.browser.centralAuthHost needs domain.strategy byo,
//      ownerOnly true, no adminUsers, and a deployment-wide sign-in
//      restriction on the central host's effective settings (ownerOnly off).
//   2. The pod-manager Lambda gets AUTH_BROWSER_CENTRAL_AUTH_HOST=true, and
//      nothing at all when the setting is off.
//   3. ClusterStack adds one Fargate Spot service, a target group, a listener
//      rule for auth.<baseDomain> below every pod rule, and a Route53 record;
//      the oauth secrets reach its execution role only.

import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Config } from '../lib/config/schema';
import { CENTRAL_AUTH_HOST_RULE_PRIORITY } from '../lambda/pod-manager/priority';
import { authLambdaEnvironment } from '../lib/config/auth-env';
import { resolveConfig } from '../lib/config/schema';
import { ClusterStack } from '../lib/stacks/cluster-stack';
import { NetworkStack } from '../lib/stacks/network-stack';
import { PodManagerStack } from '../lib/stacks/pod-manager-stack';
import { PodTaskFamilyStack } from '../lib/stacks/pod-task-family-stack';

type Browser = Record<string, unknown>;

const ENTRA_ISSUER = 'https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/v2.0';
const GUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

export function centralConfigInput(browser: Browser = {}, domain: Record<string, unknown> = {}) {
  return {
    project: {},
    aws: { accountId: '123456789012' },
    github: { org: 'acme', repo: 'cloud-dev-pods' },
    domain: { strategy: 'byo', baseDomain: 'pods.example.com', hostedZoneId: 'Z0123456789ABC', ...domain },
    network: {},
    pods: {},
    naming: {},
    auth: { browser: { allowedOrg: 'acme', ownerOnly: true, centralAuthHost: true, ...browser } },
  };
}

const resolve = (browser: Browser = {}, domain: Record<string, unknown> = {}) =>
  resolveConfig(centralConfigInput(browser, domain)).config;

const refusal = (browser: Browser = {}, domain: Record<string, unknown> = {}): string => {
  try {
    resolve(browser, domain);
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('expected resolveConfig to throw');
};

describe('auth.browser.centralAuthHost config', () => {
  it('defaults to false', () => {
    const { config } = resolveConfig({ ...centralConfigInput(), auth: { browser: { allowedOrg: 'acme' } } });
    expect(config.auth.browser.centralAuthHost).toBe(false);
  });

  it('accepts a valid enabled config for every provider', () => {
    expect(resolve().auth.browser.centralAuthHost).toBe(true);
    expect(resolve({ allowedOrg: undefined, allowedUsers: ['alice'] }).auth.browser.centralAuthHost).toBe(true);
    expect(
      resolve({ provider: 'entra-id', allowedOrg: undefined, issuerUrl: ENTRA_ISSUER, allowedGroups: [GUID] }).auth.browser
        .centralAuthHost,
    ).toBe(true);
    expect(
      resolve({ provider: 'oidc', allowedOrg: undefined, issuerUrl: 'https://acme.okta.com', allowedEmailDomains: ['acme.com'] })
        .auth.browser.centralAuthHost,
    ).toBe(true);
  });

  it('refuses ownerOnly: false, naming the setting and ADR 0009', () => {
    const msg = refusal({ ownerOnly: false });
    expect(msg).toContain('auth.browser.ownerOnly');
    expect(msg).toContain('ADR 0009');
  });

  it('refuses domain.strategy alb-default, naming the setting', () => {
    const msg = refusal({}, { strategy: 'alb-default' });
    expect(msg).toContain('domain.strategy');
    expect(msg).toContain('ADR 0009');
  });

  it('refuses a non-empty adminUsers', () => {
    const msg = refusal({ adminUsers: ['ops'] });
    expect(msg).toContain('auth.browser.adminUsers');
    expect(msg).toContain('ADR 0009');
  });

  it('every refusal states that baseDomain must hold only cloud-dev-pods records', () => {
    for (const msg of [refusal({ ownerOnly: false }), refusal({ adminUsers: ['ops'] })]) {
      expect(msg).toContain('domain.baseDomain');
      expect(msg).toMatch(/only cloud-dev-pods/);
    }
  });

  // auth-guard counts ownerOnly as a restriction, so the check runs on the
  // central host's effective settings: { ...auth, ownerOnly: false }.
  it.each([
    ['github with no allowedOrg / allowedUsers', { allowedOrg: undefined }, /allowedOrg/],
    ['entra-id with no tenant, group or domain restriction', { provider: 'entra-id', allowedOrg: undefined, issuerUrl: ENTRA_ISSUER }, /allowedTenants/],
    ['entra-id with only allowedEmailDomains ["*"]', { provider: 'entra-id', allowedOrg: undefined, issuerUrl: ENTRA_ISSUER, allowedEmailDomains: ['*'] }, /allowedEmailDomains/],
    ['oidc with no group or domain restriction', { provider: 'oidc', allowedOrg: undefined, issuerUrl: 'https://acme.okta.com' }, /allowedGroups/],
  ])('refuses %s even with ownerOnly on', (_label, browser, named) => {
    const msg = refusal(browser);
    expect(msg).toMatch(named);
    expect(msg).toContain('ADR 0009');
    expect(msg).toContain('central auth host');
  });

  it('lists every failed precondition at once', () => {
    const msg = refusal({ ownerOnly: false, adminUsers: ['ops'] }, { strategy: 'alb-default' });
    expect(msg).toContain('auth.browser.ownerOnly');
    expect(msg).toContain('auth.browser.adminUsers');
    expect(msg).toContain('domain.strategy');
  });
});

describe('pod-manager Lambda environment', () => {
  it('sets AUTH_BROWSER_CENTRAL_AUTH_HOST=true when enabled', () => {
    expect(authLambdaEnvironment(resolve()).AUTH_BROWSER_CENTRAL_AUTH_HOST).toBe('true');
  });

  it('sets nothing when disabled, so the default template is unchanged', () => {
    const { config } = resolveConfig({ ...centralConfigInput(), auth: { browser: { allowedOrg: 'acme' } } });
    expect(authLambdaEnvironment(config)).not.toHaveProperty('AUTH_BROWSER_CENTRAL_AUTH_HOST');
  });

  it('reaches the synthesized pod-manager function', () => {
    const config = resolve();
    const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
    const env = { account: '123456789012', region: config.aws.region };
    const network = new NetworkStack(app, 'Network', { env, config });
    const cluster = new ClusterStack(app, 'Cluster', { env, config, network });
    const taskFamily = new PodTaskFamilyStack(app, 'PodTaskFamily', { env, config, cluster });
    const podManager = new PodManagerStack(app, 'PodManager', { env, config, network, cluster, taskFamily });
    const fns = Object.values(Template.fromStack(podManager).findResources('AWS::Lambda::Function')).filter(
      (f) => (f.Properties.Environment?.Variables ?? {}).REGISTRY_TABLE_NAME !== undefined,
    );
    expect(fns).toHaveLength(1);
    expect(fns[0]!.Properties.Environment.Variables.AUTH_BROWSER_CENTRAL_AUTH_HOST).toBe('true');
    // Synthesizes four stacks; slow when the whole suite runs in parallel.
  }, 30_000);
});

function clusterTemplate(config: Config): Template {
  const app = new App();
  const env = { account: '123456789012', region: config.aws.region };
  const network = new NetworkStack(app, 'Network', { env, config });
  return Template.fromStack(new ClusterStack(app, 'Cluster', { env, config, network }));
}

const count = (t: Template, type: string) => Object.keys(t.findResources(type)).length;

describe('ClusterStack with centralAuthHost', () => {
  let t: Template;
  beforeAll(() => {
    t = clusterTemplate(resolve());
  }, 30_000);

  it('synthesizes one ECS service, one target group and one listener rule for auth.<base> below 1000', () => {
    expect(count(t, 'AWS::ECS::Service')).toBe(1);
    expect(count(t, 'AWS::ElasticLoadBalancingV2::TargetGroup')).toBe(1);
    const rules = Object.values(t.findResources('AWS::ElasticLoadBalancingV2::ListenerRule'));
    expect(rules).toHaveLength(1);
    const props = rules[0]!.Properties;
    expect(props.Priority).toBe(CENTRAL_AUTH_HOST_RULE_PRIORITY);
    expect(props.Priority).toBeLessThan(1000);
    expect(props.Conditions).toEqual([{ Field: 'host-header', HostHeaderConfig: { Values: ['auth.pods.example.com'] } }]);
  });

  it('attaches the rule to the HTTPS listener', () => {
    const rule = Object.values(t.findResources('AWS::ElasticLoadBalancingV2::ListenerRule'))[0]!;
    const https = Object.entries(t.findResources('AWS::ElasticLoadBalancingV2::Listener')).find(
      ([, l]) => l.Properties.Port === 443,
    )!;
    expect(rule.Properties.ListenerArn).toEqual({ Ref: https[0] });
  });

  it('runs a 0.25 vCPU task on Fargate Spot, one copy, in private subnets', () => {
    const svc = Object.values(t.findResources('AWS::ECS::Service'))[0]!.Properties;
    expect(svc.CapacityProviderStrategy).toEqual([{ CapacityProvider: 'FARGATE_SPOT', Weight: 1 }]);
    expect(svc.DesiredCount).toBe(1);
    expect(svc.NetworkConfiguration.AwsvpcConfiguration.AssignPublicIp).toBe('DISABLED');
    const td = Object.values(t.findResources('AWS::ECS::TaskDefinition'))[0]!.Properties;
    expect(td.Cpu).toBe('256');
  });

  it('health-checks oauth2-proxy on port 4180 at /ping', () => {
    const tg = Object.values(t.findResources('AWS::ElasticLoadBalancingV2::TargetGroup'))[0]!.Properties;
    expect(tg.Port).toBe(4180);
    expect(tg.TargetType).toBe('ip');
    expect(tg.HealthCheckPath).toBe('/ping');
    expect(tg.HealthyThresholdCount).toBe(2);
    const svc = Object.values(t.findResources('AWS::ECS::Service'))[0]!.Properties;
    expect(svc.HealthCheckGracePeriodSeconds).toBe(120);
  });

  it('adds a Route53 alias record for auth.<base>', () => {
    const names = Object.values(t.findResources('AWS::Route53::RecordSet')).map((r) => r.Properties.Name);
    expect(names).toContain('auth.pods.example.com.');
  });

  it('runs the central host container: static 202, shared cookie settings, the three oauth secrets', () => {
    const td = Object.values(t.findResources('AWS::ECS::TaskDefinition'))[0]!.Properties;
    expect(td.ContainerDefinitions).toHaveLength(1);
    const c = td.ContainerDefinitions[0];
    const env = Object.fromEntries((c.Environment as { Name: string; Value: string }[]).map((e) => [e.Name, e.Value]));
    expect(env.OAUTH2_PROXY_UPSTREAMS).toBe('static://202');
    expect(env.OAUTH2_PROXY_REDIRECT_URL).toBe('https://auth.pods.example.com/oauth2/callback');
    expect(env.OAUTH2_PROXY_COOKIE_DOMAINS).toBe('.pods.example.com');
    expect(env.OAUTH2_PROXY_WHITELIST_DOMAINS).toBe('.pods.example.com');
    expect(env.OAUTH2_PROXY_GITHUB_ORG).toBe('acme');
    expect(env).not.toHaveProperty('OAUTH2_PROXY_AUTHENTICATED_EMAILS_FILE');
    expect(c.DependsOn).toBeUndefined();
    const secrets = (c.Secrets as { Name: string; ValueFrom: unknown }[]).map((x) => [x.Name, JSON.stringify(x.ValueFrom)]);
    expect(secrets.map(([n]) => n)).toEqual(['OAUTH2_PROXY_CLIENT_ID', 'OAUTH2_PROXY_CLIENT_SECRET', 'OAUTH2_PROXY_COOKIE_SECRET']);
    // Each ValueFrom is the full ARN that the lookup of that secret returned.
    const lookups = t.findResources('Custom::AWS');
    const lookedUp = (x: { ValueFrom: { 'Fn::GetAtt': [string, string] } }) =>
      JSON.stringify(lookups[x.ValueFrom['Fn::GetAtt'][0]]!.Properties.Create);
    const [id, sec, cookie] = c.Secrets as Parameters<typeof lookedUp>[0][];
    expect(lookedUp(id!)).toContain('/cloud-dev-pods/oauth/client-id');
    expect(lookedUp(sec!)).toContain('/cloud-dev-pods/oauth/client-secret');
    expect(lookedUp(cookie!)).toContain('/cloud-dev-pods/oauth/cookie-secret');
  });

  // Partial ARNs fail in ECS for names ending in "-secret" (docs/troubleshooting.md),
  // so the full ARNs are looked up at deploy time, like the Lambda's resolveSecretArn.
  it('references each secret by its full ARN, looked up with DescribeSecret at deploy time', () => {
    const td = Object.values(t.findResources('AWS::ECS::TaskDefinition'))[0]!.Properties;
    const lookups = t.findResources('Custom::AWS');
    for (const s of td.ContainerDefinitions[0].Secrets as { ValueFrom: { 'Fn::GetAtt'?: [string, string] } }[]) {
      const [id, attr] = s.ValueFrom['Fn::GetAtt']!;
      expect(attr).toBe('ARN');
      const create = JSON.stringify(lookups[id]!.Properties.Create);
      expect(create).toContain('describeSecret');
    }
  });

  it('grants the oauth secrets to its execution role and to no task role', () => {
    const td = Object.values(t.findResources('AWS::ECS::TaskDefinition'))[0]!.Properties;
    const execRoleId = (td.ExecutionRoleArn as { 'Fn::GetAtt': [string, string] })['Fn::GetAtt'][0];
    const taskRoleId = (td.TaskRoleArn as { 'Fn::GetAtt': [string, string] } | undefined)?.['Fn::GetAtt'][0];
    type Stmt = { Action: string | string[] };
    const policies = Object.values(t.findResources('AWS::IAM::Policy')).map((p) => ({
      roles: (p.Properties.Roles as { Ref: string }[]).map((r) => r.Ref),
      actions: (p.Properties.PolicyDocument.Statement as Stmt[]).flatMap((x) => [x.Action].flat()),
    }));
    const readers = policies.filter((p) => p.actions.includes('secretsmanager:GetSecretValue'));
    expect(readers.length).toBeGreaterThan(0);
    for (const p of readers) expect(p.roles).toEqual([execRoleId]);
    if (taskRoleId) {
      for (const p of policies) expect(p.roles).not.toContain(taskRoleId);
    }
    // The deploy-time lookup can describe the three secrets but never read them.
    const others = Object.values(t.findResources('AWS::IAM::Policy')).filter(
      (p) => !(p.Properties.Roles as { Ref: string }[]).some((r) => r.Ref === execRoleId),
    );
    expect(others.length).toBeGreaterThan(0);
    for (const p of others) {
      for (const st of p.Properties.PolicyDocument.Statement as { Action: unknown; Resource: unknown }[]) {
        expect(st.Action).toBe('secretsmanager:DescribeSecret');
        const resources = JSON.stringify(st.Resource);
        for (const name of ['client-id', 'client-secret', 'cookie-secret']) {
          expect(resources).toContain(`:secret:/cloud-dev-pods/oauth/${name}-??????`);
        }
        expect((st.Resource as unknown[]).length).toBe(3);
        expect(resources).not.toContain('"*"');
      }
    }
    // GetSecretValue is granted on exactly the ARNs the lookups returned.
    const lookupIds = Object.keys(t.findResources('Custom::AWS')).sort();
    const readerResources = Object.values(t.findResources('AWS::IAM::Policy'))
      .flatMap((p) => p.Properties.PolicyDocument.Statement as { Action: unknown; Resource: unknown }[])
      .filter((st) => [st.Action].flat().includes('secretsmanager:GetSecretValue'))
      .flatMap((st) => [st.Resource].flat() as { 'Fn::GetAtt'?: [string, string] }[]);
    expect(readerResources.map((r) => r['Fn::GetAtt']?.[0]).sort()).toEqual(lookupIds);
  });
});

describe('ClusterStack without centralAuthHost', () => {
  it.each([
    ['byo', { strategy: 'byo' }],
    ['alb-default', { strategy: 'alb-default' }],
  ])('%s: no central host service, target group, listener rule or auth record', (_label, domain) => {
    const { config } = resolveConfig({ ...centralConfigInput({}, domain), auth: { browser: { allowedOrg: 'acme' } } });
    const t = clusterTemplate(config);
    expect(count(t, 'AWS::ECS::Service')).toBe(0);
    expect(count(t, 'AWS::ECS::TaskDefinition')).toBe(0);
    expect(count(t, 'AWS::ElasticLoadBalancingV2::TargetGroup')).toBe(0);
    expect(count(t, 'AWS::ElasticLoadBalancingV2::ListenerRule')).toBe(0);
    const names = Object.values(t.findResources('AWS::Route53::RecordSet')).map((r) => r.Properties.Name);
    expect(names).not.toContain('auth.pods.example.com.');
  });
});
