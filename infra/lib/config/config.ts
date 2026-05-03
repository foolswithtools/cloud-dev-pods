import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ConfigSchema, type Config } from './schema';

/**
 * Load and validate the YAML config.
 *
 * Resolution order:
 *   1. CDPODS_CONFIG env var (preferred — explicit, used by CI).
 *   2. config/config.yaml (downstream user's gitignored config).
 *   3. config/config.example.yaml (the committed template — last resort, useful
 *      for synth in CI before a user has copied it).
 *
 * Always relative to process.cwd(). For invocations from `infra/`, paths are
 * adjusted automatically.
 */
export function loadConfig(explicitPath?: string): Config {
  const path = pickPath(explicitPath);
  const raw = readFileSync(path, 'utf8');
  const parsed: unknown = parseYaml(raw);
  return ConfigSchema.parse(parsed);
}

function pickPath(explicit?: string): string {
  if (explicit) return resolve(process.cwd(), explicit);
  if (process.env.CDPODS_CONFIG) return resolve(process.cwd(), process.env.CDPODS_CONFIG);

  const candidates = [
    'config/config.yaml',
    '../config/config.yaml',
    'config/config.example.yaml',
    '../config/config.example.yaml',
  ];
  for (const candidate of candidates) {
    const abs = resolve(process.cwd(), candidate);
    try {
      readFileSync(abs);
      return abs;
    } catch {
      /* try next */
    }
  }
  throw new Error(
    'Cannot find cloud-dev-pods config. Set CDPODS_CONFIG or create config/config.yaml.',
  );
}

export type { Config } from './schema';
