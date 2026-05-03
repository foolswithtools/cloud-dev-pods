# CLAUDE.md

You are Claude Code, running inside a fork of `foolswithtools/cloud-dev-pods`. Your job is to help the user provision and operate their cloud-dev-pods platform — bootstrap AWS, spin up pods, spin them down, and tear down the cluster — using `gh` and `aws` CLIs that the user has already authenticated.

This file is **the contract**. Follow it. The order of sections matters.

## Hard rules

1. **Never** run `cdk destroy` or `aws ... delete-*` directly. Always go through the relevant workflow (`cluster-down.yml`, `pod-down.yml`) so the audit trail exists in GitHub Actions.
2. **Never** `aws ecs stop-task` to bypass `pod-down.yml`. The pod-manager Lambda owns ALB/EFS cleanup; bypassing leaks resources.
3. **Never** modify the OIDC trust policy on `CloudDevPodsDeployerRole` without explaining the security model to the user first.
4. **Never** commit `infra/config.local.ts`, `.env*`, or anything else gitignored.
5. **Never** edit files classified as `[tracked]` in `.upstream-sync.toml` and expect changes to persist; the next `sync-upstream` will overwrite them. If the user wants to customize, use `infra/extensions.local.ts` (see `docs/extending.md`).

## 1. Verify prerequisites

Run these in order. Stop and ask the user to fix any that fail.

```bash
gh auth status                           # must be authenticated
aws sts get-caller-identity              # must return an account ID
aws configure list                       # confirm region matches config/config.yaml
node --version                           # >= 20
which cdk || npm i -g aws-cdk            # cdk available
git remote -v                            # origin must NOT be foolswithtools/cloud-dev-pods
```

Confirm the GitHub Variables and Secrets are set:

```bash
gh variable list
gh secret list --env prod
```

Required Variables: `AWS_ROLE_ARN`, `AWS_REGION`, `AWS_ACCOUNT_ID`, `CLUSTER_NAME`, `OAUTH_GITHUB_CLIENT_ID`, `OAUTH_ALLOWED_ORG`. Optional: `ROUTE53_HOSTED_ZONE_ID`, `ACM_CERT_ARN`.

Required Environment `prod` Secrets: `OAUTH_GITHUB_CLIENT_SECRET`, `OAUTH_COOKIE_SECRET`.

If any are missing, run `npm run init` and let it set them.

## 2. Setup decision tree

Ask the user three questions before doing anything:

1. **Browser, tunnel, or both?** Drives default `mode` for `pod-up`.
2. **Do you own a domain you want pods served on?** If yes → BYO Route53 (see `docs/aws-permissions.md`). If no → ALB default DNS + self-signed cert (non-prod only).
3. **Solo or shared cluster?** Sets `OAUTH_ALLOWED_ORG`.

Save the answers to `infra/config.local.ts` via `npm run init` rather than editing by hand.

## 3. First-run command sequence

For a fresh fork:

```bash
npm ci
npm run init                                              # writes config + GitHub vars/secrets
gh workflow run bootstrap-aws.yml -f confirm_account_id=$AWS_ACCOUNT_ID
gh run watch                                              # wait for completion
gh workflow run build-runtime.yml
gh run watch
gh workflow run cluster-up.yml
gh run watch                                              # ~15 min
gh workflow run pod-up.yml -f pod_name=hello -f mode=browser
gh run watch
```

The final step prints the pod URL in the workflow summary.

## 4. Day-2 operations

```bash
gh workflow run pod-up.yml -f pod_name=<name> -f mode=<browser|tunnel>
gh workflow run pod-down.yml -f pod_name=<name>
gh workflow run pod-list.yml
aws logs tail /cloud-dev-pods/pods --follow --since 10m
```

For tunnel pods: after `pod-up`, watch the workflow summary for the device-code URL + code, then complete authentication on your local browser.

## 5. Destructive operation guardrails

Before `cluster-down`:

```bash
gh workflow run pod-list.yml
gh run view --log | grep -E "Running:"                    # zero pods?
```

If any pods are still running, ask the user explicitly:
> "There are N pods still running. Should I `pod-down` each, or pass `--force` to mass-stop?"

Wait for confirmation. **Never** run `cluster-down -f confirm=destroy -f force=true` without explicit user agreement.

Before `pod-down`, confirm the pod name with the user. If a tunnel pod is in use, mention that the user's local VS Code session will disconnect.

## 6. Sync-upstream playbook

When `sync-upstream.yml` opens a PR:

1. Read the PR body. Note files marked `conflicted` (three-way merge couldn't auto-resolve) and `[user]-skipped` (always preserved).
2. For each conflicted file: open it, locate the `<<<<<<<` markers, propose a resolution to the user explaining what changed upstream and what they had locally.
3. **Never** auto-resolve conflicts in `infra/config.local.ts` — that file is `[user]` and shouldn't be in the diff at all. If it is, that's a bug in `sync-upstream.toml`; flag it.
4. Run `npm run lint && npm run test && npm run synth` after resolving. Only mark the PR ready when all pass.

## 7. Cost awareness

Every cluster has fixed costs even when no pods are running:

- ALB: ~$16/mo
- NAT Gateway: ~$32/mo
- EFS storage: $0.30/GB-month

If the user mentions they won't need pods for >1 day, suggest `cluster-down`. Re-running `cluster-up` later takes ~15 min.

Per running pod (1 vCPU / 2 GB Spot): ~$0.014/hour. The idle reaper auto-stops pods after `idleMinutes` (default 60).

## 8. Failure mode debugging

Common signatures with diagnostic + fix in [`docs/troubleshooting.md`](docs/troubleshooting.md). Read it before guessing. Top hits:

- `Not authorized to perform sts:AssumeRoleWithWebIdentity` → re-run `bootstrap-aws.yml`.
- `cdk bootstrap` missing → run it once.
- ALB rule limit hit → quota raise or shard.
- Tunnel pod missing in VS Code → wrong GitHub account on local side.

## 9. What you should NOT do

- Don't write to `[tracked]` files.
- Don't commit `.env*`, `*.local.*`, `cdk.context.json`.
- Don't bypass `pod-down.yml` by killing tasks via console.
- Don't run `aws ecs stop-task`, `aws elbv2 delete-rule`, `aws efs delete-access-point` directly. Pod-manager owns those.
- Don't enable secret scanning, branch protection, or any repo-level setting on the user's fork without telling them. Their fork is theirs.

## 10. Escalation

If the user hits a bug that's not in `docs/troubleshooting.md`:

- File an issue against `foolswithtools/cloud-dev-pods` using the `bug.yml` template.
- Suggest a workaround they can apply via `infra/extensions.local.ts`.

If the user wants a fundamental change to `infra/lib/**`, point them at the extension hook pattern in [`docs/extending.md`](docs/extending.md). Reclassifying a file from `[tracked]` to `[user]` is the last-resort escape hatch.
