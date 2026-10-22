// The single definition of the oauth2-proxy sidecar container (ADR 0002,
// ADR 0008). Pure: no env reads, no SDK calls, so it can be unit-tested and
// imported outside a Lambda. registerTaskDef in aws.ts is the only caller.

import type { ContainerDefinition } from '@aws-sdk/client-ecs';

// v7.15.5, pinned to the multi-arch image index digest. Bump the tag and the
// digest together; the tag is informational, ECS pulls by digest.
export const OAUTH2_PROXY_IMAGE =
  'quay.io/oauth2-proxy/oauth2-proxy:v7.15.5@sha256:8498b0d0ef0a7b29686414000a08aee467f02d0299c9ed1e006a8f33fc017916';

export interface Oauth2ProxyAuthConfig {
  provider: 'github' | 'entra-id' | 'oidc';
  allowedOrg?: string;
  allowedUsers: readonly string[];
}

export interface Oauth2ProxySecretArns {
  clientId: string;
  clientSecret: string;
  cookieSecret: string;
}

export interface Oauth2ProxyOptions {
  podName: string;
  listenerProtocol: 'HTTP' | 'HTTPS';
  logGroupName: string;
  region: string;
}

export function buildOauth2ProxyContainer(
  auth: Oauth2ProxyAuthConfig,
  secretArns: Oauth2ProxySecretArns,
  opts: Oauth2ProxyOptions,
): ContainerDefinition {
  if (auth.provider !== 'github') {
    throw new Error(`oauth2-proxy provider "${auth.provider}" is not wired yet; only "github" is supported.`);
  }
  const allowedUsers = auth.allowedUsers.join(',');
  return {
    name: 'oauth2-proxy',
    image: OAUTH2_PROXY_IMAGE,
    essential: true,
    portMappings: [{ containerPort: 4180, protocol: 'tcp' }],
    logConfiguration: {
      logDriver: 'awslogs',
      options: {
        'awslogs-group': opts.logGroupName,
        'awslogs-region': opts.region,
        'awslogs-stream-prefix': `browser/${opts.podName}/oauth2-proxy`,
      },
    },
    environment: [
      { name: 'OAUTH2_PROXY_PROVIDER', value: 'github' },
      { name: 'OAUTH2_PROXY_HTTP_ADDRESS', value: '0.0.0.0:4180' },
      { name: 'OAUTH2_PROXY_UPSTREAMS', value: 'http://127.0.0.1:3000' },
      { name: 'OAUTH2_PROXY_REVERSE_PROXY', value: 'true' },
      { name: 'OAUTH2_PROXY_PASS_AUTHORIZATION_HEADER', value: 'true' },
      { name: 'OAUTH2_PROXY_COOKIE_SECURE', value: opts.listenerProtocol === 'HTTPS' ? 'true' : 'false' },
      { name: 'OAUTH2_PROXY_EMAIL_DOMAINS', value: '*' },
      // Auth allowlists: org takes precedence if set; user list applies on
      // top. If both empty, oauth2-proxy will accept any GitHub user (which
      // is why podUp refuses a browser pod when neither is configured).
      ...(auth.allowedOrg ? [{ name: 'OAUTH2_PROXY_GITHUB_ORG', value: auth.allowedOrg }] : []),
      ...(allowedUsers ? [{ name: 'OAUTH2_PROXY_GITHUB_USER', value: allowedUsers }] : []),
    ],
    secrets: [
      { name: 'OAUTH2_PROXY_CLIENT_ID', valueFrom: secretArns.clientId },
      { name: 'OAUTH2_PROXY_CLIENT_SECRET', valueFrom: secretArns.clientSecret },
      { name: 'OAUTH2_PROXY_COOKIE_SECRET', valueFrom: secretArns.cookieSecret },
    ],
    dependsOn: [{ containerName: 'vscode', condition: 'HEALTHY' }],
  };
}
