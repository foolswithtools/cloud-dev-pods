# cloud-dev-pods

[![ci-lint](https://github.com/foolswithtools/cloud-dev-pods/actions/workflows/ci-lint.yml/badge.svg?branch=main)](https://github.com/foolswithtools/cloud-dev-pods/actions/workflows/ci-lint.yml)
[![ci-test](https://github.com/foolswithtools/cloud-dev-pods/actions/workflows/ci-test.yml/badge.svg?branch=main)](https://github.com/foolswithtools/cloud-dev-pods/actions/workflows/ci-test.yml)
[![ci-security](https://github.com/foolswithtools/cloud-dev-pods/actions/workflows/ci-security.yml/badge.svg?branch=main)](https://github.com/foolswithtools/cloud-dev-pods/actions/workflows/ci-security.yml)

Provision ECS-based VS Code dev pods in your own AWS account.

A template repo: clone or "Use this template" to your own GitHub account or org, run a few GitHub Actions workflows, and you have an on-demand fleet of containerized VS Code dev environments — each with its own URL, GitHub-OAuth-protected, with persistent EFS-backed storage. Tear it all down with one workflow when you're not using it; pay only for what's running.

## Two delivery modes

- **Browser** (default): `https://<pod>.<base-domain>` → ALB → oauth2-proxy (GitHub OAuth) → openvscode-server in ECS Fargate. Mount EFS at `/workspace`.
- **Tunnel** (opt-in): VS Code Desktop on your laptop → Microsoft VS Code Tunnel Service → ECS Fargate task running `code tunnel`. No ALB, no inbound port.

See [`docs/architecture.md`](docs/architecture.md), [`docs/delivery-modes.md`](docs/delivery-modes.md).

## Quickstart

```bash
gh repo create <your>/cloud-dev-pods --template foolswithtools/cloud-dev-pods --private --clone
cd cloud-dev-pods
npm ci && npm run init                          # interactive setup
gh workflow run bootstrap-aws.yml               # one-time AWS bootstrap
gh workflow run build-runtime.yml               # build + push runtime images
gh workflow run cluster-up.yml                  # provision VPC + ECS + ALB + EFS
gh workflow run pod-up.yml -f pod_name=hello -f mode=browser
```

Full walkthrough: [`docs/quickstart.md`](docs/quickstart.md).

## Cost

Idle fixed cost: ~$50/month (ALB ~$16, NAT ~$32, EFS ~$0). Per running pod: ~$0.014/hour on Fargate Spot.

```bash
gh workflow run cluster-down.yml -f confirm=destroy   # zero ongoing spend
```

## Cloning into your own account

This repo is a **public template**. When you clone or "Use this template" into your own GitHub account or organization:

- Make your fork **private** (recommended).
- All AWS resources are provisioned in **your own AWS account** by GitHub Actions in **your fork**.
- The provisioning workflows are guarded by `if: github.repository != 'foolswithtools/cloud-dev-pods'` so they're inert on this upstream repo — they only do anything in your fork.

## Updating from upstream

```bash
gh workflow run sync-upstream.yml
```

Opens a PR with upstream upgrades. Local-only files (`infra/config.local.ts`, `infra/extensions.local.ts`, your secrets) are never overwritten. See [`docs/extending.md`](docs/extending.md) and [`docs/adr/0006-tracked-merged-user-sync-taxonomy.md`](docs/adr/0006-tracked-merged-user-sync-taxonomy.md) for the customization model.

## Documentation map

- [`CLAUDE.md`](CLAUDE.md) — playbook for Claude Code (or any LLM agent) to drive setup/teardown.
- [`docs/quickstart.md`](docs/quickstart.md) — happy-path setup.
- [`docs/prerequisites.md`](docs/prerequisites.md), [`docs/setup-cli.md`](docs/setup-cli.md), [`docs/setup-gui.md`](docs/setup-gui.md) — step-by-step.
- [`docs/aws-permissions.md`](docs/aws-permissions.md) — IAM model.
- [`docs/operating.md`](docs/operating.md), [`docs/teardown.md`](docs/teardown.md), [`docs/troubleshooting.md`](docs/troubleshooting.md) — day-2.
- [`docs/architecture.md`](docs/architecture.md), [`docs/adr/`](docs/adr/) — how it works and why.

## Status

Pre-alpha. Skeleton committed; Phase 3+ implementation in progress. See [`docs/`](docs/) for the planned architecture; see actual code under `infra/`, `runtime/`, `scripts/`, `.github/workflows/` for what's wired up.

## License

[Apache-2.0](LICENSE).
