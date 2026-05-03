# CLI setup walkthrough

Phase 11 will populate this with the exact `gh` and `aws` command sequence to:

1. Verify auth (`gh auth status`, `aws sts get-caller-identity`).
2. Run `npm run init` (which writes config and pushes Variables/Secrets).
3. Trigger workflows in order: bootstrap → build-runtime → cluster-up → pod-up.
4. Verify post-conditions with `aws iam list-open-id-connect-providers`, `aws ecs list-clusters`, etc.

See [`prerequisites.md`](prerequisites.md) for what to install first.
