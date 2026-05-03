# ADR 0002: oauth2-proxy as same-task sidecar

## Status

Accepted (2026-05-03).

## Context

Each pod URL must be authenticated. ALB native OIDC doesn't accept GitHub directly. Options:

- (a) ALB → Cognito User Pool with GitHub federation. Native AWS, but Cognito federation to GitHub is finicky.
- (b) `oauth2-proxy` deployed as a sidecar in the same ECS task as openvscode-server, configured with a GitHub OAuth App.
- (c) ALB → IAM Identity Center / SAML. Requires SSO setup; awkward for solo devs.

## Decision

Option (b): `oauth2-proxy` as same-task sidecar.

Container layout: ALB target = oauth2-proxy port 4180; oauth2-proxy upstream = `http://127.0.0.1:3000` (openvscode-server, loopback only).

## Consequences

- Zero extra network hops; both containers share the awsvpc network namespace.
- No Cognito to manage.
- GitHub org allowlist is one env var (`OAUTH2_PROXY_GITHUB_ORG`).
- Trade-off: oauth2-proxy can't scale independently of the IDE container. Acceptable because pods are single-user.
- If multi-user-per-pod is ever needed, would migrate to a separate task (see open trade-offs in master plan).
