# Glossary

| Term | Meaning |
|---|---|
| **Pod** | A single ECS task running either openvscode-server (browser mode) or `code tunnel` (tunnel mode), with EFS mounted at `/workspace`. |
| **Cluster** | The shared AWS infrastructure (VPC, ECS cluster, ALB, EFS) that hosts pods. One cluster per AWS account+region. |
| **Browser mode** | Pod accessed via HTTPS URL through ALB+oauth2-proxy. |
| **Tunnel mode** | Pod accessed via Microsoft's VS Code Tunnel Service from local VS Code Desktop. |
| **Pod-manager** | The Lambda function that creates/destroys/lists pods. Sole holder of ECS/ALB/EFS write rights. |
| **Idle reaper** | EventBridge-scheduled Lambda that auto-stops pods after configurable idle time. |
| **Upstream** | `foolswithtools/cloud-dev-pods` — the source-of-truth template repo. |
| **Sync PR** | Pull request opened by `sync-upstream.yml` proposing upstream changes. |
| **Tracked / Merged / User** | File classifications in `.upstream-sync.toml` controlling sync behavior. |
| **Extension hook** | A function in `infra/extensions.local.ts` that customizes a stack without forking upstream code. |
| **Base domain** | The DNS zone pods live under (e.g., `pods.example.com`). Pods are at `<podName>.<baseDomain>`. |
| **OIDC** | OpenID Connect — GitHub Actions exchanges a JWT for short-lived AWS credentials, no long-lived keys. |
