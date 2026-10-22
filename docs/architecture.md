# Architecture

How cloud-dev-pods works end-to-end.

## Delivery modes

Two pod delivery modes are supported. Browser is the default; tunnel is opt-in per-pod.

### Browser mode (default)

```text
Browser ──HTTPS──> ALB ──> oauth2-proxy (sidecar :4180)
                              │
                              ▼
                       openvscode-server (:3000, loopback)
                              │
                              ▼
                       EFS access point (/workspace)
```

Authentication is enforced by oauth2-proxy via a GitHub OAuth App. ALB enforces HTTPS and forwards to the oauth2-proxy sidecar, which gates traffic before openvscode-server ever sees it.

The sidecar's container definition (image, env, secrets, port, logging, `dependsOn`) comes from one pure builder, `buildOauth2ProxyContainer` in [`infra/lambda/pod-manager/oauth2-proxy.ts`](../infra/lambda/pod-manager/oauth2-proxy.ts). The pod-manager Lambda calls it when it registers each pod's task-definition revision. The image is pinned by digest there. The CDK `cloud-dev-pods-browser` family revision carries only the `vscode` container: it is never run and exists to reserve the family name.

#### Authorization model

By default, authorization is deployment-wide: every browser pod's sidecar gets the same allowlist (`auth.browser.allowedOrg` / `allowedUsers`), client ID, and cookie secret, so anyone on the allowlist can open any pod. The pod's owner (from the `pod-up` `owner` input, defaulting to `GITHUB_ACTOR`) is recorded in the registry and as the task's `Owner` tag, but is not checked.

With `auth.browser.ownerOnly: true`, authorization becomes per pod. When the pod-manager registers a browser pod's task definition, `buildBrowserAuthTaskParts` in [`infra/lambda/pod-manager/owner-authz.ts`](../infra/lambda/pod-manager/owner-authz.ts) narrows the sidecar to the owner plus `auth.browser.adminUsers`:

- `github`: `OAUTH2_PROXY_GITHUB_USERS=<owner>,<admins>`, with `allowedOrg` kept as `OAUTH2_PROXY_ALLOWED_GROUPS` (an AND check; `GITHUB_ORG` would be ORed with the user list).
- `entra-id` / `oidc`: the init container below also writes the owner and admin emails to the volume, and the sidecar sets `OAUTH2_PROXY_AUTHENTICATED_EMAILS_FILE` with no `EMAIL_DOMAINS`.

For every provider, a non-essential init container (the pod's runtime image) writes a random per-task cookie secret to a task-scoped ephemeral volume. The sidecar waits for it to succeed, mounts the volume read-only, reads the secret via `OAUTH2_PROXY_COOKIE_SECRET_FILE`, and no longer receives the shared `OAUTH2_PROXY_COOKIE_SECRET`. A session cookie from one pod therefore doesn't decrypt on another, which matters for `github` because oauth2-proxy checks `GITHUB_USERS` only at sign-in.

Before creating any resource, `pod-up` refuses an owner-only browser pod whose owner is missing or not a valid identity for the provider. With `ownerOnly: false`, the task definition is exactly the one `buildOauth2ProxyContainer` produces, including the shared cookie secret. Usage is in [`docs/operating.md`](operating.md#per-pod-owner-authorization).

### Tunnel mode (opt-in)

```text
Local VS Code Desktop ──> Microsoft VS Code Tunnel Service ──> ECS task running `code tunnel`
```

No ALB, no inbound port. The ECS task dials out to Microsoft's tunnel broker over HTTPS. Auth happens via the device-code flow surfaced through CloudWatch Logs.

## AWS components

- **VPC**: 2 AZ, public + private subnets, 1 NAT.
- **ECS cluster**: Fargate + Fargate Spot capacity providers.
- **EFS**: one filesystem, per-pod access points (POSIX UID-isolated).
- **ALB**: internet-facing, HTTPS only, ACM cert covering `*.<base-domain>`.
- **Pod-manager Lambda**: orchestrates pod lifecycle. Sole holder of ECS/ALB/EFS write rights.
- **Idle reaper Lambda**: EventBridge-scheduled; auto-stops idle pods after configurable timeout.
- **DynamoDB registry**: tracks running pods.

## GitHub Actions

- **Maintainer-side** (foolswithtools upstream): lint, test, security, release.
- **User-side** (downstream forks): bootstrap, cluster lifecycle, pod lifecycle, upstream sync.

Provisioning workflows are gated by `if: github.repository != 'foolswithtools/cloud-dev-pods'` so they cannot run from the upstream public repo.

See: [`docs/delivery-modes.md`](delivery-modes.md), [`docs/operating.md`](operating.md), [`docs/adr/`](adr/).
