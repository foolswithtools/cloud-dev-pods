import { Tags } from 'aws-cdk-lib';
import type { IConstruct } from 'constructs';
import type { Config } from '../config/schema.js';

export function applyProjectTags(scope: IConstruct, config: Config): void {
  Tags.of(scope).add('Project', config.project.name);
  Tags.of(scope).add('Env', config.project.env);
  Tags.of(scope).add('ManagedBy', 'cdk');
}
