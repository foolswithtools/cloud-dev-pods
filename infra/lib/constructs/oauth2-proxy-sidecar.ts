import { Construct } from 'constructs';

export interface OAuth2ProxySidecarProps {
  // Phase 7: github clientId secret ARN, cookie secret ARN, allowed org/users,
  // upstream port (3000 default), listener port (4180 default).
  readonly placeholder?: never;
}

/**
 * Reusable container definition for the oauth2-proxy sidecar.
 * Image: quay.io/oauth2-proxy/oauth2-proxy (digest-pinned in Phase 7).
 */
export class OAuth2ProxySidecar extends Construct {
  constructor(scope: Construct, id: string, props?: OAuth2ProxySidecarProps) {
    super(scope, id);
    void props;
  }
}
