// Issue #239: infra/extensions.local.ts hooks are loaded and called, one per
// stack, after that stack is constructed. Without a file the app is unchanged.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as sns from 'aws-cdk-lib/aws-sns';
import { describe, expect, it } from 'vitest';
import { buildStacks } from '../lib/app';
import { resolveConfig } from '../lib/config/schema';
import { EXTENSION_HOOKS, loadExtensions, validateExtensions, type Extensions } from '../lib/extensions';
import { stackNames } from '../lib/stack-names';

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
const env = { account: '123456789012', region: config.aws.region };
const names = stackNames(config.naming.prefix);

function build(extensions?: Extensions): App {
  // Skip esbuild bundling of the Lambdas; nothing here depends on it.
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  buildStacks(app, config, env, extensions);
  return app;
}

function stack(app: App, id: string): Stack {
  return app.node.findChild(id) as Stack;
}

const hookToStack: Record<(typeof EXTENSION_HOOKS)[number], string> = {
  customizeBootstrap: names.bootstrap,
  customizeNetwork: names.network,
  customizeCluster: names.cluster,
  customizePodTaskFamily: names.podTaskFamily,
  customizePodManager: names.podManager,
  customizeIdleReaper: names.idleReaper,
};

// Each test synthesizes the full app (twice for the unchanged-template check).
describe('extension hooks (#239)', { timeout: 60_000 }, () => {
  it('calls each hook once with its stack, in construction order', () => {
    const calls: Array<[string, string]> = [];
    const ext: Extensions = {};
    for (const hook of EXTENSION_HOOKS) {
      (ext as Record<string, unknown>)[hook] = (s: Stack, ctx: { config: unknown }) => {
        expect(ctx.config).toBe(config);
        calls.push([hook, s.stackName]);
      };
    }
    build(ext);
    expect(calls).toEqual(EXTENSION_HOOKS.map((h) => [h, hookToStack[h]]));
  });

  it('a resource a hook adds lands in that stack', () => {
    const app = build({
      customizeNetwork(s) {
        new sns.Topic(s, 'ForkTopic', { topicName: 'fork-topic', enforceSSL: true });
      },
    });
    Template.fromStack(stack(app, names.network)).hasResourceProperties('AWS::SNS::Topic', {
      TopicName: 'fork-topic',
    });
    Template.fromStack(stack(app, names.cluster)).resourceCountIs('AWS::SNS::Topic', 0);
  });

  it('a later hook sees resources from an earlier customized stack', () => {
    let seen = false;
    build({
      customizeNetwork(s) {
        new sns.Topic(s, 'ForkTopic', { enforceSSL: true });
      },
      customizeCluster(_s, { app }) {
        seen = (app.node.findChild(names.network) as Stack).node.tryFindChild('ForkTopic') !== undefined;
      },
    });
    expect(seen).toBe(true);
  });

  it('without extensions every template is unchanged', () => {
    const plain = build();
    const empty = build({});
    for (const id of Object.values(names)) {
      expect(Template.fromStack(stack(empty, id)).toJSON()).toEqual(Template.fromStack(stack(plain, id)).toJSON());
    }
  });
});

describe('loadExtensions / validateExtensions (#239)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cdp-ext-'));

  it('returns no hooks when the file does not exist', () => {
    expect(loadExtensions(join(dir, 'missing.local.ts'))).toEqual({});
  });

  it('loads the named `extensions` export from a module', () => {
    const file = join(dir, 'good.local.js');
    writeFileSync(file, 'exports.extensions = { customizeNetwork() {} };\n');
    const ext = loadExtensions(file);
    expect(typeof ext.customizeNetwork).toBe('function');
  });

  it('rejects a module without an `extensions` export, naming the file', () => {
    const file = join(dir, 'noexport.local.js');
    writeFileSync(file, 'exports.other = {};\n');
    expect(() => loadExtensions(file)).toThrow(/noexport\.local\.js.*`extensions`/);
  });

  it('rejects a hook that is not a function', () => {
    expect(() => validateExtensions({ customizeNetwork: 'nope' }, 'x.ts')).toThrow(
      /x\.ts: customizeNetwork must be a function/,
    );
  });

  it('rejects an unknown hook name (catches typos)', () => {
    expect(() => validateExtensions({ customiseNetwork() {} }, 'x.ts')).toThrow(
      /x\.ts: unknown hook "customiseNetwork".*customizeNetwork/,
    );
  });
});
