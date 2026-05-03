import { Construct } from 'constructs';

export interface VSCodeBrowserContainerProps {
  // Phase 7: image URI (ECR), EFS volume reference, log group, port (3000 default).
  readonly placeholder?: never;
}

/**
 * Reusable container definition for openvscode-server (browser-mode IDE).
 * Built from runtime/vscode-browser/Dockerfile.
 */
export class VSCodeBrowserContainer extends Construct {
  constructor(scope: Construct, id: string, props?: VSCodeBrowserContainerProps) {
    super(scope, id);
    void props;
  }
}
