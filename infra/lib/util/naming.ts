import type { Config } from '../config/schema';

export function resourceName(config: Config, ...parts: string[]): string {
  return [config.naming.prefix, ...parts].join('-');
}

export function ssmParamPath(config: Config, key: string): string {
  return `/${config.project.name}/${config.project.env}/${key}`;
}
