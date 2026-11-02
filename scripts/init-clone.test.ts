import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { parseUserList, renderConfigYaml, type Answers } from './init-clone.js';

// Dynamic import: a static `import '../infra/...'` fails `tsc -b scripts`
// with TS6059 because the file sits outside scripts/'s rootDir.
const { resolveConfig } = (await import(
  pathToFileURL(resolve(import.meta.dirname, '../infra/lib/config/schema.ts')).href
)) as {
  resolveConfig: (input: unknown) => {
    config: { auth: { browser: { allowedUsers: string[]; allowedOrg?: string } } };
    warnings: string[];
  };
};

function answers(allowedUsers: string[], allowedOrg: string): Answers {
  return {
    awsAccountId: '123456789012',
    awsRegion: 'us-west-2',
    githubOwner: 'alice',
    githubRepo: 'cloud-dev-pods',
    domainStrategy: 'alb-default',
    baseDomain: '',
    hostedZoneId: '',
    allowedUsers,
    allowedOrg,
    vpcCidr: '10.50.0.0/16',
    cpu: 1024,
    memory: 2048,
    idleMinutes: 60,
  };
}

const CASES: { name: string; users: string[]; org?: string }[] = [
  // Built from the CSV the same way the users prompt does.
  { name: 'solo', users: parseUserList(' alice, bob ,,') },
  { name: 'org', users: [], org: 'acme' },
  { name: 'both', users: ['alice'], org: 'acme' },
  { name: 'none', users: [] },
];

describe('parseUserList', () => {
  it('trims entries and drops empties', () => {
    expect(parseUserList(' alice, bob ,,')).toEqual(['alice', 'bob']);
  });
});

describe('renderConfigYaml', () => {
  for (const c of CASES) {
    describe(c.name, () => {
      const out = renderConfigYaml(answers(c.users, c.org ?? ''));

      it('never writes the deprecated github.oauthAllowed* keys', () => {
        expect(out).not.toContain('oauthAllowed');
      });

      it('resolves with no deprecation warnings and the allowlist from auth.browser', () => {
        const { config, warnings } = resolveConfig(parse(out));
        expect(warnings).toEqual([]);
        expect(config.auth.browser.allowedUsers).toEqual(c.users);
        expect(config.auth.browser.allowedOrg).toBe(c.org);
      });
    });
  }

  it('omits the auth block entirely when there is no allowlist', () => {
    const out = renderConfigYaml(answers([], ''));
    expect(out).not.toMatch(/^\s*auth:/m);
    expect(out).not.toMatch(/^\s*browser:/m);
  });

  it('keeps a numeric-looking login a string', () => {
    const { config } = resolveConfig(parse(renderConfigYaml(answers(['123', 'yes'], ''))));
    expect(config.auth.browser.allowedUsers).toEqual(['123', 'yes']);
  });
});
