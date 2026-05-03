import { Construct } from 'constructs';

export interface VSCodeTunnelContainerProps {
  // Phase 7: image URI (ECR), EFS volume reference, log group, POD_NAME env override.
  readonly placeholder?: never;
}

/**
 * Reusable container definition for the VS Code CLI tunnel agent.
 * Built from runtime/vscode-tunnel/Dockerfile.
 */
export class VSCodeTunnelContainer extends Construct {
  constructor(scope: Construct, id: string, props?: VSCodeTunnelContainerProps) {
    super(scope, id);
    void props;
  }
}
