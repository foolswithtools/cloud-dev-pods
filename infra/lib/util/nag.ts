import { type Stack, Validations } from 'aws-cdk-lib';
import type { IConstruct } from 'constructs';

export interface NagAcknowledgment {
  /** cdk-nag rule ID, e.g. `AwsSolutions-IAM5`. */
  readonly id: string;
  readonly reason: string;
  /**
   * Specific findings to acknowledge, e.g. `Resource::*`. Each becomes a
   * `RuleId[finding]` acknowledgment. cdk-nag v3 matches finding IDs exactly,
   * so a bare rule ID does NOT cover a rule's individual findings.
   */
  readonly appliesTo?: readonly string[];
}

/**
 * cdk-nag v3 replacement for v2's `NagSuppressions.addResourceSuppressions(
 * scope, rules, true)`. Acknowledgments apply to each scope and all of its
 * descendants (cdk-nag walks up the construct tree when matching).
 */
export function acknowledgeNag(
  scopes: IConstruct | readonly IConstruct[],
  rules: readonly NagAcknowledgment[],
): void {
  const targets: readonly IConstruct[] = Array.isArray(scopes) ? scopes : [scopes as IConstruct];
  for (const scope of targets) {
    for (const rule of rules) {
      const ids = rule.appliesTo?.map((finding) => `${rule.id}[${finding}]`) ?? [rule.id];
      Validations.of(scope).acknowledge(...ids.map((id) => ({ id, reason: rule.reason })));
    }
  }
}

/**
 * How a token imported from another stack appears in a cdk-nag v3 finding.
 * v3 runs after CDK resolves cross-stack references, so the token is rendered
 * as its CloudFormation export name (`<producer stack>:<export id>`). CDK keeps
 * export names stable because changing one breaks deployed consumers; if a
 * construct rename changes it, synth fails on the unacknowledged finding.
 */
export function nagImportRef(producer: Stack, exportId: string): string {
  return `${producer.stackName}:${exportId}`;
}
