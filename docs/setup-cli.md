# CLI setup walkthrough

Detailed CLI-only walkthrough. For the same steps in compact form, see [`quickstart.md`](quickstart.md). For the GUI alternative, see [`setup-gui.md`](setup-gui.md).

## Verify prereqs

```bash
gh auth status                        # Logged in to github.com? Yes.
aws sts get-caller-identity           # AWS account + role/user.
node --version                        # >= 20.
which aws gh git npx                  # All present.
```

If anything is missing:

- `gh`: <https://github.com/cli/cli#installation>
- `aws`: <https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html>
- Node 20: install via [nvm](https://github.com/nvm-sh/nvm) or [fnm](https://github.com/Schniz/fnm).

## Generate your fork

```bash
gh repo create <user>/cloud-dev-pods --template foolswithtools/cloud-dev-pods --private --clone
cd cloud-dev-pods
npm ci
```

Confirm the workflows are present:

```bash
ls .github/workflows/
# Expected: bootstrap-aws.yml, build-runtime.yml, cluster-up.yml, cluster-down.yml,
#           pod-up.yml, pod-down.yml, pod-list.yml, sync-upstream.yml,
#           ci-lint.yml, ci-test.yml, ci-security.yml, ci-runtime.yml, release.yml,
#           smoke-test.yml.
```

If any are missing, your token may not have the `workflow` scope when generating from template. Re-clone with `gh auth refresh -s workflow,repo`.

## Configure

`config/config.yaml` is the source of truth. The upstream template gitignores it; for your fork, commit it. Schema: `infra/lib/config/schema.ts` (Zod-validated at synth time).

Minimum (tunnel-only):

```yaml
project: { name: cloud-dev-pods, env: dev }
aws:
  accountId: "111122223333"
  region: us-west-2
github:
  org: clostaunau
  repo: cloud-dev-pods
  oauthAllowedUsers: clostaunau
domain:
  strategy: alb-default
network: { vpcCidr: "10.50.0.0/16", natGateways: 1, useVpcEndpoints: false }
pods: { defaultCpu: 1024, defaultMemory: 2048, spotPercentage: 100, idleMinutes: 60 }
naming: { prefix: CloudDevPods }
```

Browser mode adds:

```yaml
domain:
  strategy: byo
  baseDomain: pods.example.com         # subdomain of a Route53 zone you own
  hostedZoneId: Z01234567ABCDEFGHIJK
```

Then:

```bash
git add config/config.yaml
git commit -m "chore: initial config"
git push
```

## Push initial GH Variables

```bash
gh variable set AWS_REGION --body "us-west-2"
gh variable set AWS_ACCOUNT_ID --body "<12-digit-account>"
gh variable set CLUSTER_NAME --body "cloud-dev-pods"
gh variable list
```

## Create the bootstrap IAM user

```bash
aws iam create-user --user-name cloud-dev-pods-bootstrap
aws iam attach-user-policy --user-name cloud-dev-pods-bootstrap \
  --policy-arn arn:aws:iam::aws:policy/AdministratorAccess
aws iam create-access-key --user-name cloud-dev-pods-bootstrap
```

The output prints `AccessKeyId` and `SecretAccessKey`. **Test them locally before pushing**:

```bash
unset AWS_PROFILE
AWS_ACCESS_KEY_ID="<id>" AWS_SECRET_ACCESS_KEY="<secret>" aws sts get-caller-identity
# Expect: ARN ending in :user/cloud-dev-pods-bootstrap
```

If that succeeds, push via stdin (preserves `+` `/` `=` characters that GitHub UI paste sometimes mangles):

```bash
printf '%s' "<id>" | gh secret set AWS_BOOTSTRAP_ACCESS_KEY_ID
printf '%s' "<secret>" | gh secret set AWS_BOOTSTRAP_SECRET_ACCESS_KEY
gh secret list
```

## Browser-mode only: register the OAuth App

Browser pods authenticate via GitHub OAuth. GitHub doesn't let workflows create OAuth Apps via API, so this is manual:

1. Open <https://github.com/settings/applications/new>.
2. Fill in:
   - **Application name**: anything you'll recognize.
   - **Homepage URL**: your fork's HTTPS URL.
   - **Authorization callback URL**: `https://<pod>.<base-domain>/oauth2/callback`.
3. Register. Generate a Client Secret on the next page.
4. Keep both values handy for step "Update oauth secrets" below.

> **GitHub OAuth Apps accept one callback URL.** This is why each pod's hostname must match. Multi-pod OAuth requires either one OAuth App per pod or a centralized oauth2-proxy — both are tracked as Phase 9.6+ polish.

## Bootstrap AWS

```bash
gh workflow run bootstrap-aws.yml -f confirm_account_id=<account>
gh run watch
```

About 3 minutes. After it succeeds:

```bash
DEPLOYER=$(aws ssm get-parameter --name /cloud-dev-pods/dev/bootstrap/deployer-role-arn \
  --query Parameter.Value --output text)
PODOPS=$(aws ssm get-parameter --name /cloud-dev-pods/dev/bootstrap/pod-ops-role-arn \
  --query Parameter.Value --output text)
gh variable set AWS_DEPLOYER_ROLE_ARN --body "$DEPLOYER"
gh variable set AWS_POD_OPS_ROLE_ARN --body "$PODOPS"

# Housekeeping: delete the bootstrap secrets and IAM user.
gh secret delete AWS_BOOTSTRAP_ACCESS_KEY_ID
gh secret delete AWS_BOOTSTRAP_SECRET_ACCESS_KEY
aws iam list-access-keys --user-name cloud-dev-pods-bootstrap
aws iam delete-access-key --user-name cloud-dev-pods-bootstrap --access-key-id <AKIA...>
aws iam detach-user-policy --user-name cloud-dev-pods-bootstrap \
  --policy-arn arn:aws:iam::aws:policy/AdministratorAccess
aws iam delete-user --user-name cloud-dev-pods-bootstrap
```

All subsequent workflows authenticate via OIDC against the two roles. No long-lived AWS keys exist anywhere now.

## Browser-mode only: update oauth secrets

`bootstrap-aws.yml` created `/cloud-dev-pods/oauth/{client-id,client-secret,cookie-secret}` with placeholder values. Update the first two with your OAuth App values:

```bash
aws secretsmanager update-secret --secret-id /cloud-dev-pods/oauth/client-id \
  --secret-string "<Client ID>"
aws secretsmanager update-secret --secret-id /cloud-dev-pods/oauth/client-secret \
  --secret-string "<Client Secret>"

aws secretsmanager get-secret-value --secret-id /cloud-dev-pods/oauth/client-id \
  --query SecretString --output text
# Should print your Client ID, not a random placeholder.
```

The `cookie-secret` was auto-generated as 32 random bytes — oauth2-proxy reads it at task start, you never need to view it.

## Build the runtime images

```bash
gh workflow run build-runtime.yml
gh run watch                                # ~3 min for both browser + tunnel images
```

Confirm via:

```bash
aws ecr describe-images --repository-name cloud-dev-pods/vscode-browser \
  --query 'imageDetails[*].imageTags[0]'
aws ecr describe-images --repository-name cloud-dev-pods/vscode-tunnel \
  --query 'imageDetails[*].imageTags[0]'
```

## Provision the cluster

```bash
gh workflow run cluster-up.yml
gh run watch                                # ~12 min
```

This deploys NetworkStack + ClusterStack + PodTaskFamilyStack + PodManagerStack + IdleReaperStack. The longest waits are EFS mount-target creation, ALB provisioning, and ACM cert DNS validation.

## Spin up your first pod

Browser:

```bash
gh workflow run pod-up.yml -f pod_name=hello -f mode=browser
gh run watch
```

Workflow summary prints `https://hello.pods.<base-domain>`. Visit, sign in, land in VS Code.

Tunnel:

```bash
gh workflow run pod-up.yml -f pod_name=dev -f mode=tunnel
gh run watch
```

Workflow summary prints a `https://github.com/login/device` URL + 8-character code. Open the URL on your laptop, enter the code, sign in. Then in VS Code Desktop: Cmd-Shift-P → "Remote Tunnels: Connect to Tunnel" → pick `dev`.

## Day-2

```bash
gh workflow run pod-list.yml                      # see all running pods
gh workflow run pod-down.yml -f pod_name=hello    # stop one
aws logs tail /cloud-dev-pods/dev/pods --follow --since 10m
```

## Tear down

When you're done for the day:

```bash
gh workflow run cluster-down.yml -f confirm=destroy
gh run watch
```

Ongoing AWS spend after this drops to ~$0.40/month (the three Secrets Manager secrets that are retained). Bootstrap (OIDC + IAM roles + ECR repos) is also retained so the next `cluster-up` is fast.

## What's next

- **Customize the IaC** without losing upstream sync: [`extending.md`](extending.md).
- **Operate the platform** (idle behavior, costs, logs, multi-pod): [`operating.md`](operating.md).
- **Pull upstream improvements**: `gh workflow run sync-upstream.yml`.
- **Hit a bug?** [`troubleshooting.md`](troubleshooting.md) lists every signature surfaced during smoke testing.
