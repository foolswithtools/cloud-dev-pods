// Issue #225: the workflows deploy and destroy the stack names from
// lib/stack-names.ts. They must be exactly the stacks the app synthesizes,
// for the default prefix and a custom one, or a fork with a custom
// naming.prefix destroys nothing (or deploys only part of the app).

import { App } from 'aws-cdk-lib';
import { describe, expect, it } from 'vitest';
import { buildStacks } from '../lib/app';
import { resolveConfig } from '../lib/config/schema';
import { allStackNames, clusterStackNames, stackNames } from '../lib/stack-names';

function synthesizedStackNames(naming: Record<string, unknown>): { prefix: string; names: string[] } {
  const { config } = resolveConfig({
    project: {},
    aws: { accountId: '123456789012' },
    github: { org: 'acme', repo: 'cloud-dev-pods' },
    domain: {},
    network: {},
    pods: {},
    naming,
    auth: { browser: { allowedOrg: 'acme' } },
  });
  // Skip esbuild bundling of the Lambdas; stack names don't depend on it.
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  buildStacks(app, config, { account: '123456789012', region: config.aws.region });
  const assembly = app.synth();
  return { prefix: config.naming.prefix, names: assembly.stacks.map((s) => s.stackName) };
}

describe.each([
  { label: 'default prefix', naming: {}, expectedPrefix: 'CloudDevPods' },
  { label: 'custom prefix', naming: { prefix: 'AcmePods' }, expectedPrefix: 'AcmePods' },
])('stack names ($label)', ({ naming, expectedPrefix }) => {
  const { prefix, names } = synthesizedStackNames(naming);

  it('resolves the expected prefix', () => {
    expect(prefix).toBe(expectedPrefix);
  });

  it('allStackNames matches the synthesized app exactly', () => {
    expect([...allStackNames(prefix)].sort()).toEqual([...names].sort());
  });

  it('clusterStackNames is every synthesized stack except Bootstrap', () => {
    const bootstrap = stackNames(prefix).bootstrap;
    expect(names).toContain(bootstrap);
    expect([...clusterStackNames(prefix)].sort()).toEqual(names.filter((n) => n !== bootstrap).sort());
  });

  it('every name carries the prefix', () => {
    for (const n of names) expect(n.startsWith(`${expectedPrefix}-`)).toBe(true);
  });
});
