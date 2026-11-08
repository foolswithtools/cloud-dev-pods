// Central auth host (#144, ADR 0009): one oauth2-proxy at auth.<baseDomain>
// completes every OAuth callback and sets a session cookie on .<baseDomain>.
//
//   1. Synth guard: auth.browser.centralAuthHost needs domain.strategy byo,
//      ownerOnly true, no adminUsers, and a deployment-wide sign-in
//      restriction on the central host's effective settings (ownerOnly off).
//   2. The pod-manager Lambda gets AUTH_BROWSER_CENTRAL_AUTH_HOST=true, and
//      nothing at all when the setting is off.

import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
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
  });
});
