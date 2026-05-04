# Quickstart

End-to-end happy path for getting a working pod in under 30 minutes. This is the path validated by smoke testing; it works for both browser and tunnel modes (browser mode requires the optional Route53 step).

## Prereqs

- AWS account you own or admin (us-west-2 region recommended; any region works).
- (Browser mode only) A domain registered in Route53 with a public hosted zone — see `docs/prerequisites.md`.
- `gh` and `aws` CLIs installed and authenticated.
- Node 20+.

## 1. Generate your fork from the template

```bash
gh repo create <your-account>/cloud-dev-pods --template foolswithtools/cloud-dev-pods --private --clone
cd cloud-dev-pods
npm ci
```

## 2. Edit and commit `config/config.yaml`

```yaml
project:
  name: cloud-dev-pods
  env: dev
aws:
  accountId: "<12-digit account id>"
  region: us-west-2
github:
  org: <your-github-login-or-org>
  repo: cloud-dev-pods
  oauthAllowedUsers: <your-github-login>   # solo
  # OR oauthAllowedOrg: <your-org>          # team
domain:
  strategy: byo                              # use "alb-default" for tunnel-only
  baseDomain: pods.<your-domain>
  hostedZoneId: <Route53 zone ID>
network:
  vpcCidr: "10.50.0.0/16"
  natGateways: 1
  useVpcEndpoints: false
pods:
  defaultCpu: 1024
  defaultMemory: 2048
  spotPercentage: 100
  idleMinutes: 60
naming:
  prefix: CloudDevPods
```

```bash
git add config/config.yaml
git commit -m "chore: initial config"
git push
```

> **Important**: the upstream template `.gitignore`s `config/config.yaml` because each fork's values differ. Your fork commits it as the source of truth.

## 3. Set initial GitHub repo Variables

```bash
gh variable set AWS_REGION --body "us-west-2"
gh variable set AWS_ACCOUNT_ID --body "<12-digit account id>"
gh variable set CLUSTER_NAME --body "cloud-dev-pods"
```

## 4. Create one-time bootstrap IAM user

```bash
aws iam create-user --user-name cloud-dev-pods-bootstrap
aws iam attach-user-policy --user-name cloud-dev-pods-bootstrap \
  --policy-arn arn:aws:iam::aws:policy/AdministratorAccess
aws iam create-access-key --user-name cloud-dev-pods-bootstrap
```

Verify the keys work, then push as repo secrets via stdin (avoids paste-mangling):

```bash
unset AWS_PROFILE
AWS_ACCESS_KEY_ID="<id>" AWS_SECRET_ACCESS_KEY="<secret>" aws sts get-caller-identity
# Should print the bootstrap user's ARN.

printf '%s' "<id>" | gh secret set AWS_BOOTSTRAP_ACCESS_KEY_ID
printf '%s' "<secret>" | gh secret set AWS_BOOTSTRAP_SECRET_ACCESS_KEY
```

## 5. (Browser mode only) Register a GitHub OAuth App

Open `https://github.com/settings/applications/new`. Fill:

- Application name: anything
- Homepage URL: your fork's URL
- Authorization callback URL: `https://hello.pods.<your-domain>/oauth2/callback`

GitHub OAuth Apps accept one callback URL — picking `hello` here means our first test pod must be named `hello`. (Multi-pod OAuth is Phase 9.6+ polish.)

After registering, generate a Client Secret. You'll paste both values into Secrets Manager in step 7.

## 6. Run bootstrap

```bash
gh workflow run bootstrap-aws.yml -f confirm_account_id=<account>
gh run watch
```

When it succeeds, push role ARNs as Variables and clean up:

```bash
DEPLOYER=$(aws ssm get-parameter --name /cloud-dev-pods/dev/bootstrap/deployer-role-arn \
  --query Parameter.Value --output text)
PODOPS=$(aws ssm get-parameter --name /cloud-dev-pods/dev/bootstrap/pod-ops-role-arn \
  --query Parameter.Value --output text)
gh variable set AWS_DEPLOYER_ROLE_ARN --body "$DEPLOYER"
gh variable set AWS_POD_OPS_ROLE_ARN --body "$PODOPS"

gh secret delete AWS_BOOTSTRAP_ACCESS_KEY_ID
gh secret delete AWS_BOOTSTRAP_SECRET_ACCESS_KEY
```

## 7. (Browser mode only) Update oauth secrets

```bash
aws secretsmanager update-secret --secret-id /cloud-dev-pods/oauth/client-id \
  --secret-string "<Client ID>"
aws secretsmanager update-secret --secret-id /cloud-dev-pods/oauth/client-secret \
  --secret-string "<Client Secret>"
# cookie-secret was auto-generated; leave it alone.
```

## 8. Build runtime images and bring up the cluster

```bash
gh workflow run build-runtime.yml          # ~3 min
gh run watch
gh workflow run cluster-up.yml             # ~12 min
gh run watch
```

## 9. Spin up `hello`

```bash
gh workflow run pod-up.yml -f pod_name=hello -f mode=browser
gh run watch
```

The workflow summary prints `https://hello.pods.<your-domain>`. **Initial requests may 502 for ~30s** while the ALB target group registration completes. After that:

1. Open the URL.
2. Sign in with GitHub (oauth2-proxy enforces the allowlist from your config).
3. VS Code loads with `/workspace` (your EFS-mounted, POSIX-isolated home) open.

## 10. Verify in browser

- Open Terminal (`` Ctrl+` ``) — `whoami` prints a UID like `10000`, `pwd` is `/workspace`.
- Create a file. The next `pod-up hello` (after `pod-down`) reattaches the same EFS access point.

## Tear down

```bash
gh workflow run pod-down.yml -f pod_name=hello
gh run watch
gh workflow run cluster-down.yml -f confirm=destroy
gh run watch
```

This brings ongoing AWS spend to ~$0. The bootstrap stack (OIDC + IAM + ECR + secrets) is intentionally retained so a future `cluster-up` doesn't have to redo it.

## Cost

The full smoke-test cycle (bootstrap → cluster up → 1 pod ~10 min → tear down) is **under $0.10** in AWS spend.

## What's next

- **Day-2 operations**: see [`operating.md`](operating.md).
- **Multiple pods, idle behavior, EFS performance**: see [`operating.md`](operating.md).
- **Customizing `infra/lib/`**: see [`extending.md`](extending.md) — use `infra/extensions.local.ts`, never edit `[tracked]` files directly.
- **Pulling upstream improvements**: `gh workflow run sync-upstream.yml` opens a PR.
- **Tear it all down**: see [`teardown.md`](teardown.md).
