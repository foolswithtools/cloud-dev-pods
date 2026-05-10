# CLAUDE.md

You are Claude Code, running inside a fork of `foolswithtools/cloud-dev-pods`. Your job is to help the user provision and operate their cloud-dev-pods platform — bootstrap AWS, spin up pods, spin them down, and tear down the cluster — using `gh` and `aws` CLIs that the user has authenticated.

This file is **the contract**. Follow it. The order of sections matters.

## Hard rules

1. **Never** run `cdk destroy` or `aws ... delete-*` directly. Always go through the relevant workflow (`cluster-down.yml`, `pod-down.yml`) so the audit trail exists in GitHub Actions.
2. **Never** `aws ecs stop-task` to bypass `pod-down.yml`. The pod-manager Lambda owns ALB rule + EFS access-point cleanup; bypassing leaks resources.
3. **Never** modify the OIDC trust policy on `CloudDevPodsDeployerRole` without explaining the security model to the user first.
4. **Never** commit secrets, raw AWS keys, or anything in `.gitignore` (`infra/extensions.local.ts`, `.env*`, `cdk.context.json`).
5. **Never** edit files classified as `[tracked]` in `.upstream-sync.toml` and expect changes to persist; the next `sync-upstream` overwrites them. Use `infra/extensions.local.ts` (see `docs/extending.md`) for customizations.
6. **Browser-mode pods require a real DNS domain** the user controls. GitHub OAuth Apps don't accept wildcard callback URLs, so each pod's URL has to resolve. Tunnel mode has no such requirement.

## 1. Verify prerequisites

Run these in order. Stop and ask the user to fix any that fail.

```bash
gh auth status                           # must be authenticated
aws sts get-caller-identity              # must return their AWS account
aws configure list                       # confirm region matches config/config.yaml
node --version                           # >= 20
git remote -v                            # origin must NOT be foolswithtools/cloud-dev-pods
test -f config/config.yaml               # MUST exist + be COMMITTED (not gitignored)
```

Confirm GitHub repo Variables and Secrets:

```bash
gh variable list
gh secret list
```

**Required Variables**: `AWS_REGION`, `AWS_ACCOUNT_ID`, `AWS_DEPLOYER_ROLE_ARN`, `AWS_POD_OPS_ROLE_ARN`, `CLUSTER_NAME` (default `cloud-dev-pods`).

**Bootstrap-only Secrets** (deleted after first `bootstrap-aws.yml` run): `AWS_BOOTSTRAP_ACCESS_KEY_ID`, `AWS_BOOTSTRAP_SECRET_ACCESS_KEY`.

The two AWS roles are split by privilege per ADR 0003. `AWS_DEPLOYER_ROLE_ARN` is for `bootstrap-aws.yml` (after first run), `cluster-up.yml`, `cluster-down.yml`. `AWS_POD_OPS_ROLE_ARN` is for `build-runtime.yml`, `pod-up.yml`, `pod-down.yml`, `pod-list.yml`.

OAuth values live in **AWS Secrets Manager**, not GitHub: `/cloud-dev-pods/oauth/{client-id,client-secret,cookie-secret}`. They're created with placeholders by `bootstrap-aws.yml`; the user (or you) updates them with `aws secretsmanager update-secret`.

## 2. Setup decision tree

Three questions before the user runs anything:

1. **Browser, tunnel, or both?**
   - Browser → user accesses VS Code at `https://<pod>.<base-domain>` via GitHub OAuth.
   - Tunnel → user connects from local VS Code Desktop via the device-code flow.
2. **Do you own a domain?** Browser mode requires one (Route53 hosted zone). If no domain, default to tunnel-only.
3. **Solo or org-restricted?** Sets `oauthAllowedUsers` (single user) or `oauthAllowedOrg` (a GitHub org) in `config/config.yaml`. **At least one must be set or browser pods refuse to launch.**

## 3. First-run sequence

For a fresh fork generated from the template (`gh repo create <user>/<repo> --template foolswithtools/cloud-dev-pods --private`):

### 3a. Run the interactive init

```bash
npm ci
npm run init
```

`scripts/init-clone.ts` is the primary path. **Run it in the foreground** (don't background it — it's interactive and uses `@clack/prompts`). It will:

- Auto-detect AWS account/region (`aws sts get-caller-identity`, `aws configure get region`).
- Auto-detect GitHub owner/repo from `git remote get-url origin`.
- List Route53 public hosted zones and let the user pick one (browser mode).
- Prompt for domain strategy, OAuth allowlist, VPC CIDR, pod sizing, idle minutes.
- Write `config/config.yaml`, `.envrc`, `.upstream-sync.state`, and an `infra/extensions.local.ts` stub.
- Push `AWS_REGION`, `AWS_ACCOUNT_ID`, and `CLUSTER_NAME` as GitHub repo Variables (`gh variable set`).
- Optionally create the `cloud-dev-pods-bootstrap` IAM user, attach `AdministratorAccess`, create an access key, and push it as repo Secrets via stdin (avoids GitHub-UI paste-mangling).

When the script completes, `git add config/config.yaml && git commit -m 'chore: init config' && git push`. The fork's `.gitignore` excludes `config/config.yaml` upstream, but downstream forks **must commit it** so CI workflows can read it.

If the user prefers GUI for any step, see [`docs/setup-gui.md`](docs/setup-gui.md). Skip to **3c** for the manual-CLI fallback.

### 3b. Cost guardrail (do this before `cluster-up`)

Idle cluster cost runs ~$50/month (NAT + ALB). Read [`docs/cost-controls.md`](docs/cost-controls.md) and set up an AWS Budgets alarm before bringing the cluster up — the doc has a copy-pasteable `aws budgets create-budget` template. Two minutes here saves debugging "why did I get a $60 AWS bill" later.

### 3c. Manual fallback (if `npm run init` was skipped)

Edit `config/config.yaml` by hand (start from `config/config.example.yaml`) with the user's values (account, region, github org/repo, domain, allowlist). Commit and push it. Then set initial Variables manually:

```bash
gh variable set AWS_REGION --body "<region>"
gh variable set AWS_ACCOUNT_ID --body "<12-digit account id>"
gh variable set CLUSTER_NAME --body "cloud-dev-pods"
```

Create the bootstrap IAM user manually (`init-clone` does this for you when run):

```bash
aws iam create-user --user-name cloud-dev-pods-bootstrap
aws iam attach-user-policy --user-name cloud-dev-pods-bootstrap \
  --policy-arn arn:aws:iam::aws:policy/AdministratorAccess
aws iam create-access-key --user-name cloud-dev-pods-bootstrap
```

The `create-access-key` output prints `AccessKeyId` + `SecretAccessKey`. **Verify locally** (avoid paste-mangling):

```bash
unset AWS_PROFILE
AWS_ACCESS_KEY_ID="<id>" AWS_SECRET_ACCESS_KEY="<secret>" aws sts get-caller-identity
# Should print the bootstrap user's ARN.
```

Then push to GitHub via stdin (preserves slashes / pluses in the secret):

```bash
printf '%s' "<id>" | gh secret set AWS_BOOTSTRAP_ACCESS_KEY_ID
printf '%s' "<secret>" | gh secret set AWS_BOOTSTRAP_SECRET_ACCESS_KEY
```

### 3d. Register the GitHub OAuth App (browser mode only)

Navigate the user to `https://github.com/settings/applications/new`. Fill in:

- Application name: anything memorable
- Homepage URL: their fork URL
- Authorization callback URL: `https://<pod-name>.<base-domain>/oauth2/callback` (e.g., `https://hello.pods.example.com/oauth2/callback`)

GitHub OAuth Apps accept exactly one callback URL — pick the pod name now or use a service like a single fixed callback URL with a more elaborate oauth2-proxy setup (Phase 9.6+ polish).

After registering, generate a Client Secret. Keep both values out of CLAUDE's chat history; the user will set them in step 3f.

### 3e. Run bootstrap

```bash
gh workflow run bootstrap-aws.yml -f confirm_account_id=<account>
gh run watch
```

When it succeeds, read the role ARNs the workflow summary points at and set them as repo Variables:

```bash
DEPLOYER=$(aws ssm get-parameter --name /cloud-dev-pods/dev/bootstrap/deployer-role-arn \
  --query Parameter.Value --output text)
PODOPS=$(aws ssm get-parameter --name /cloud-dev-pods/dev/bootstrap/pod-ops-role-arn \
  --query Parameter.Value --output text)
gh variable set AWS_DEPLOYER_ROLE_ARN --body "$DEPLOYER"
gh variable set AWS_POD_OPS_ROLE_ARN --body "$PODOPS"
```

**Bootstrap IAM cleanup (mandatory).** The `cloud-dev-pods-bootstrap` IAM user has `AdministratorAccess` — it must not survive past first-run bootstrap. Verify it exists, then remove it:

```bash
aws iam get-user --user-name cloud-dev-pods-bootstrap
# If this returns the user (exit 0), proceed with cleanup. If it 404s
# (NoSuchEntity), the user was already deleted — skip ahead.
```

Cleanup checklist (run in order; each step must succeed before the next):

```bash
# 1. Delete the GitHub repo Secrets (no longer needed; OIDC roles take over).
gh secret delete AWS_BOOTSTRAP_ACCESS_KEY_ID
gh secret delete AWS_BOOTSTRAP_SECRET_ACCESS_KEY

# 2. Delete every access key on the IAM user.
aws iam list-access-keys --user-name cloud-dev-pods-bootstrap \
  --query 'AccessKeyMetadata[*].AccessKeyId' --output text
# For each AccessKeyId returned (there may be 1 or 2):
aws iam delete-access-key --user-name cloud-dev-pods-bootstrap --access-key-id <AKIA...>

# 3. Detach the AdministratorAccess managed policy.
aws iam detach-user-policy --user-name cloud-dev-pods-bootstrap \
  --policy-arn arn:aws:iam::aws:policy/AdministratorAccess

# 4. Delete the user.
aws iam delete-user --user-name cloud-dev-pods-bootstrap

# 5. Verify it's gone.
aws iam get-user --user-name cloud-dev-pods-bootstrap 2>&1 | grep -q NoSuchEntity \
  && echo "OK: bootstrap user deleted" \
  || echo "FAIL: bootstrap user still exists — re-check steps 2-4"
```

If any step fails (e.g., `DeleteConflict: must delete access keys first`), back up to the failing prerequisite and rerun.

### 3f. Update oauth secrets (browser mode only)

```bash
aws secretsmanager update-secret --secret-id /cloud-dev-pods/oauth/client-id \
  --secret-string "<GitHub OAuth App Client ID>"
aws secretsmanager update-secret --secret-id /cloud-dev-pods/oauth/client-secret \
  --secret-string "<GitHub OAuth App Client Secret>"
```

The `cookie-secret` was auto-generated as a 32-byte random value — leave it alone.

### 3g. Build the runtime images and bring up the cluster

```bash
gh workflow run build-runtime.yml         # ~3 min
gh run watch
gh workflow run cluster-up.yml            # ~12 min
gh run watch
```

### 3h. Spin up the first pod

```bash
gh workflow run pod-up.yml -f pod_name=<name> -f mode=<browser|tunnel>
gh run watch
```

For browser mode the workflow summary prints the URL. **Initial requests may return 502 for ~30s** while the ALB target group registration completes. After that, the user signs in via GitHub OAuth and lands in VS Code. For tunnel mode the summary surfaces the device-code URL + code from CloudWatch Logs; the user authenticates that flow on their laptop.

## 4. Day-2 operations

```bash
gh workflow run pod-up.yml -f pod_name=<name> -f mode=<browser|tunnel>
gh workflow run pod-down.yml -f pod_name=<name>
gh workflow run pod-list.yml
aws logs tail /cloud-dev-pods/dev/pods --follow --since 10m
```

For tunnel pods: after `pod-up` succeeds, the workflow summary surfaces the GitHub device-code URL + code. The user opens it on their laptop, authenticates, then connects via VS Code Desktop's `Remote Tunnels: Connect to Tunnel`.

## 5. Destructive operation guardrails

Before `cluster-down`:

```bash
gh workflow run pod-list.yml && gh run watch
```

If pods are still running, ask the user explicitly:

> N pods are running. Should I `pod-down` each, or pass `force=true` to `cluster-down` to mass-stop them?

Wait for confirmation. **Never** run `cluster-down -f confirm=destroy -f force=true` without explicit user agreement.

Before `pod-down`, confirm the pod name. If a tunnel pod is in use, mention the local VS Code session will disconnect.

## 6. Sync-upstream playbook

When `sync-upstream.yml` opens a PR:

1. Read the PR body. Note files marked `Conflicted files (resolve before merging)` (three-way merge couldn't auto-resolve).
2. For each conflicted file, locate the `<<<<<<<`/`|||||||`/`>>>>>>>` markers and propose a resolution to the user explaining what changed upstream and what they had locally.
3. **Never** auto-resolve conflicts in `config/config.yaml` or files matching `*.local.*` — those are `[user]` and shouldn't even be in the diff. If they are, that's a `.upstream-sync.toml` bug; flag it.
4. Run `npm run lint && npm run test && npm run synth` after resolving. Only mark the PR ready when all pass.

## 7. Cost awareness

Fixed costs while the cluster is up (no pods running):

- ALB: ~$16/month
- NAT Gateway: ~$32/month
- EFS storage: $0.30/GB-month (negligible until workspaces grow)

Per running pod (1 vCPU / 2 GB Fargate Spot): ~$0.014/hour.

If the user mentions they won't need pods for >1 day, suggest `cluster-down`. Re-running `cluster-up` later takes ~12 min.

The idle reaper auto-stops browser pods after `idleMinutes` of zero ALB request count (default 60). Tunnel pods aren't idle-reaped.

For an AWS Budgets alarm template (recommended before first `cluster-up`) and the full cost ceiling discussion, see [`docs/cost-controls.md`](docs/cost-controls.md).

## 8. Failure mode debugging

Common signatures with diagnostic + fix in [`docs/troubleshooting.md`](docs/troubleshooting.md). Read it before guessing. Top hits surfaced during smoke testing:

- `cdk` failures with `ENOENT ... config/config.yaml` → user didn't commit it (Phase 11 footgun).
- ECS task fails with `ResourceInitializationError ... AccessDenied ... secret:/cloud-dev-pods/oauth/...` → secret ARN suffix mismatch; rerun `cluster-up` with the latest pod-manager Lambda.
- oauth2-proxy crashes with `cookie_secret must be 16, 24, or 32 bytes ... but is N bytes` → `aws secretsmanager update-secret` with `$(openssl rand -hex 16)` (32 bytes).
- Idle reaper stops fresh pods within 5 min → ensure `ALB_NAME_DIMENSION` env var is wired (Phase 9.8).
- ALB rule limit (100) hit → quota raise (`L-EAD7E5BC`).
- Tunnel pod missing in VS Code Desktop → wrong GitHub account on the local side.

## 9. What you should NOT do

- Don't write to `[tracked]` files (overwritten on next sync).
- Don't commit `.env*`, `*.local.*`, `cdk.context.json`, raw AWS keys.
- Don't bypass `pod-down.yml` by killing tasks via console / CLI.
- Don't run `aws ecs stop-task`, `aws elbv2 delete-rule`, `aws efs delete-access-point` directly. Pod-manager owns those.
- Don't enable repo settings (branch protection, secret scanning) on the user's fork without telling them.

## 10. Escalation

If the user hits a bug that's not in `docs/troubleshooting.md`:

- File an issue against `foolswithtools/cloud-dev-pods` using the `bug.yml` template, with full reproduction steps and CloudWatch log excerpts.
- Suggest a workaround they can apply via `infra/extensions.local.ts` (see `docs/extending.md`).

If the user wants a fundamental change to `infra/lib/**`, point them at the extension hook pattern. Reclassifying a file from `[tracked]` to `[user]` is the last-resort escape hatch — explain that they own merge conflicts on every upstream change after that.
