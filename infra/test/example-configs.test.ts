import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { resolveConfig } from '../lib/config/schema';

// Schema-check every committed example config so one can't silently go stale
// (CI only synths config/config.example.yaml). Files are discovered by
// pattern, so a new config/*.example.yaml is picked up without editing this test.
const CONFIG_DIR = resolve(__dirname, '../../config');
const EXAMPLE_FILES = readdirSync(CONFIG_DIR)
  .filter((f) => f.endsWith('.example.yaml'))
  .sort();

// Example files may carry a quoted `<...>` placeholder for aws.accountId.
// Patch it in memory only with a dummy 12-digit id; never write it to disk.
const PLACEHOLDER_ACCOUNT_ID = '123456789012';

function loadExample(file: string): unknown {
  const parsed = parseYaml(readFileSync(join(CONFIG_DIR, file), 'utf8')) as {
    aws?: { accountId?: unknown };
  };
  const accountId = parsed?.aws?.accountId;
  if (typeof accountId === 'string' && /^<[^>]+>$/.test(accountId)) {
    parsed.aws!.accountId = PLACEHOLDER_ACCOUNT_ID;
  }
  return parsed;
}

describe('example configs', () => {
  it('discovers at least 2 config/*.example.yaml files', () => {
    expect(EXAMPLE_FILES.length).toBeGreaterThanOrEqual(2);
    expect(EXAMPLE_FILES).toContain('config.example.yaml');
    expect(EXAMPLE_FILES).toContain('config.smoke.example.yaml');
  });

  describe.each(EXAMPLE_FILES)('%s', (file) => {
    it('passes the schema', () => {
      expect(() => resolveConfig(loadExample(file))).not.toThrow();
    });

    it('raises no deprecation warnings', () => {
      expect(resolveConfig(loadExample(file)).warnings).toEqual([]);
    });
  });

  it('config.smoke.example.yaml resolves to env dev with the idle reaper disabled', () => {
    const { config } = resolveConfig(loadExample('config.smoke.example.yaml'));
    expect(config.project.env).toBe('dev');
    expect(config.pods.idleMinutes).toBe(0);
  });
});
