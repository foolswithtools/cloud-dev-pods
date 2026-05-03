import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigSchema, type Config } from './schema.js';

export function loadConfig(path: string): Config {
  const absolute = resolve(process.cwd(), path);
  const raw = readFileSync(absolute, 'utf8');
  // TODO(phase-4): replace stub JSON parse with YAML loader (e.g., yaml package)
  // once `yaml` is added to dependencies. For now, accept JSON to keep stubs compiling.
  const parsed: unknown = JSON.parse(raw);
  return ConfigSchema.parse(parsed);
}

export type { Config } from './schema.js';
