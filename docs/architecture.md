# Architecture

How cloud-dev-pods works end-to-end.

## Delivery modes

Two pod delivery modes are supported. Browser is the default; tunnel is opt-in per-pod.

### Browser mode (default)

```
Browser ──HTTPS──> ALB ──> oauth2-proxy (sidecar :4180)
                              │
                              ▼
                       openvscode-server (:3000, loopback)
                              │
                              ▼
                       EFS access point (/workspace)
```

Authentication is enforced by oauth2-proxy via a GitHub OAuth App. ALB enforces HTTPS and forwards to the oauth2-proxy sidecar, which gates traffic before openvscode-server ever sees it.

### Tunnel mode (opt-in)

```
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
