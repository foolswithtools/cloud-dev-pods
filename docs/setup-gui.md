# GUI setup walkthrough

Point-and-click setup for users who don't have (or don't want to use) the `gh` and `aws` CLIs. Pairs with [`setup-cli.md`](setup-cli.md) — every step here has a CLI equivalent there. If you prefer to mix and match, the artifacts produced are identical.

This walkthrough does **not** replace the `bootstrap-aws.yml` / `cluster-up.yml` workflow runs themselves — those still execute in GitHub Actions. The GUI alternatives below are only for the data those workflows read (repo Variables, repo Secrets, the OAuth App, `config/config.yaml`, the bootstrap IAM user).

If you have the CLIs installed and authenticated, prefer `npm run init` — it does most of this in one interactive prompt. See [`setup-cli.md`](setup-cli.md) §"Configure".

## 1. Generate your fork from the template

1. Open [https://github.com/foolswithtools/cloud-dev-pods](https://github.com/foolswithtools/cloud-dev-pods).
2. Click **Use this template** → **Create a new repository**.
3. Owner: your account or org. Repository name: `cloud-dev-pods` (or any name; it's not load-bearing).
4. Set visibility to **Private** (recommended — your AWS account ID and config will be committed).
5. Click **Create repository from template**.
6. Clone the new repo locally (HTTPS or SSH, whichever you normally use). You still need the working tree on disk so you can edit `config/config.yaml`.

## 2. Edit and commit `config/config.yaml`

You can do this in GitHub's web editor (no local clone needed for this step alone, though you'll need one later for `npm ci`):

1. Open your fork on github.com. Browse to `config/config.example.yaml`.
2. Click **Copy raw file** (the page icon top-right of the file viewer).
3. In the repo file list, click **Add file** → **Create new file**. Name it `config/config.yaml`. Paste the contents.
4. Edit the placeholder values (account ID, region, GitHub org/repo, domain, allowlist) inline.
5. Scroll down. Commit message: `chore: initial config`. Commit directly to `main`.

Schema reference: `infra/lib/config/schema.ts` (Zod-validated at synth time).

## 3. Register the GitHub OAuth App (browser mode only)

Skip this section if you're using tunnel-only mode (`domain.strategy: alb-default`).

1. Open [https://github.com/settings/developers](https://github.com/settings/developers).
2. Left sidebar: **OAuth Apps** → **New OAuth App**.
3. Fill the form:
   - **Application name**: anything memorable, e.g., `cloud-dev-pods`.
   - **Homepage URL**: your fork's HTTPS URL, e.g., `https://github.com/<you>/cloud-dev-pods`.
   - **Application description**: optional.
   - **Authorization callback URL**: `https://<pod-name>.<base-domain>/oauth2/callback`. Pick a pod name now (e.g., `hello`) and use the `baseDomain` you set in `config/config.yaml`. Example: `https://hello.pods.example.com/oauth2/callback`.
   - **Enable Device Flow**: leave unchecked.
4. Click **Register application**.
5. On the resulting page, copy the **Client ID** (visible) into a secure note.
6. Click **Generate a new client secret**. Copy the secret value into a secure note **immediately** — GitHub only shows it once.

GitHub OAuth Apps accept exactly one callback URL. To support multiple browser pods, register one OAuth App per pod, or migrate to a centralized oauth2-proxy (Phase 9.6+ polish, not yet automated).

You'll paste both values into AWS Secrets Manager in step 6 below.

## 4. Set repo Variables and Secrets via the GitHub UI

Both go to the same place: **Settings** → **Secrets and variables** → **Actions** in your fork.

### 4a. Variables tab

Required Variables that `init-clone.ts` would set automatically. Click **New repository variable** for each:

| Name | Value | When |
| --- | --- | --- |
| `AWS_REGION` | e.g., `us-west-2` | Now |
| `AWS_ACCOUNT_ID` | your 12-digit AWS account ID | Now |
| `CLUSTER_NAME` | `cloud-dev-pods` | Now |
| `AWS_DEPLOYER_ROLE_ARN` | `arn:aws:iam::<account>:role/cloud-dev-pods/CloudDevPodsDeployerRole` | After `bootstrap-aws.yml` succeeds |
| `AWS_POD_OPS_ROLE_ARN` | `arn:aws:iam::<account>:role/cloud-dev-pods/CloudDevPodsPodOpsRole` | After `bootstrap-aws.yml` succeeds |

The two role ARNs aren't known yet — they're created by `bootstrap-aws.yml`. Come back here once that workflow finishes; you'll find the ARNs in the workflow's job summary or in AWS Systems Manager Parameter Store at `/cloud-dev-pods/dev/bootstrap/deployer-role-arn` and `.../pod-ops-role-arn` (AWS Console → Systems Manager → Parameter Store).

### 4b. Secrets tab

Bootstrap-only Secrets — created in step 5, deleted right after `bootstrap-aws.yml` succeeds. Click **New repository secret** for each:

| Name | Source |
| --- | --- |
| `AWS_BOOTSTRAP_ACCESS_KEY_ID` | from step 5 |
| `AWS_BOOTSTRAP_SECRET_ACCESS_KEY` | from step 5 |

> **Heads-up on paste-mangling.** Secrets that start with `+`, `/`, or `=` (common in AWS secret keys) sometimes get character-corrupted when pasted into the GitHub web UI text field. If `bootstrap-aws.yml` fails with `The security token included in the request is invalid`, regenerate the access key and try the CLI path: `printf '%s' "<secret>" | gh secret set AWS_BOOTSTRAP_SECRET_ACCESS_KEY` (this preserves byte-for-byte; see [`docs/troubleshooting.md`](troubleshooting.md)).

OAuth values do **not** go here. They live in AWS Secrets Manager — see step 6.

## 5. Create the bootstrap IAM user in AWS Console

Used only for the first `bootstrap-aws.yml` run. **Delete it immediately afterward** (step 7).

1. Sign in to [https://console.aws.amazon.com/iam/](https://console.aws.amazon.com/iam/) with an account-admin identity.
2. Left sidebar: **Users** → **Create user**.
3. **User name**: `cloud-dev-pods-bootstrap`. Leave "Provide user access to the AWS Management Console" unchecked. Click **Next**.
4. **Set permissions**: choose **Attach policies directly**. Search and check **AdministratorAccess**. Click **Next** → **Create user**.
5. From the user list, click `cloud-dev-pods-bootstrap` → **Security credentials** tab.
6. Scroll to **Access keys** → **Create access key**.
7. Use case: **Command Line Interface (CLI)**. Tick the confirmation. Click **Next**.
8. Description (optional): `cloud-dev-pods one-time bootstrap`. Click **Create access key**.
9. **Copy both values now** — Access key ID and Secret access key. The Secret cannot be retrieved later. Paste them into the GitHub Secrets fields you created in step 4b.

## 6. Run `bootstrap-aws.yml`

1. Your fork on github.com → **Actions** tab.
2. Left sidebar: **bootstrap-aws**.
3. Click **Run workflow** → confirm `confirm_account_id` matches your AWS account ID → **Run workflow**.
4. Wait ~3 minutes. The run summary lists the two role ARNs you need for step 4a.

Now go back to the **Variables** tab (step 4a) and add `AWS_DEPLOYER_ROLE_ARN` and `AWS_POD_OPS_ROLE_ARN`.

### 6a. Update OAuth secrets in AWS Secrets Manager (browser mode only)

`bootstrap-aws.yml` created three secrets with placeholder values. Update the first two with the OAuth App values from step 3:

1. AWS Console → **Secrets Manager**.
2. Click `/cloud-dev-pods/oauth/client-id` → **Retrieve secret value** → **Edit** → paste the GitHub OAuth Client ID → **Save**.
3. Click `/cloud-dev-pods/oauth/client-secret` → same flow with the Client Secret.
4. **Do not edit** `/cloud-dev-pods/oauth/cookie-secret` — it's auto-generated as a 32-byte random value and oauth2-proxy will refuse to start if you change it to something invalid.

## 7. DELETE the bootstrap IAM user (mandatory)

The bootstrap user has `AdministratorAccess`. Leaving it around past first-run is the largest single security exposure in this setup.

1. Back in **GitHub** → **Settings** → **Secrets and variables** → **Actions** → **Secrets** tab. Delete `AWS_BOOTSTRAP_ACCESS_KEY_ID` and `AWS_BOOTSTRAP_SECRET_ACCESS_KEY`.
2. AWS Console → **IAM** → **Users** → `cloud-dev-pods-bootstrap` → **Security credentials** tab. For each access key listed: **Actions** → **Delete** → **Deactivate** → **Delete**.
3. Same user, **Permissions** tab → check **AdministratorAccess** → **Remove**.
4. Top of the user page → **Delete user** → confirm.
5. Verify on the **Users** list that `cloud-dev-pods-bootstrap` is gone.

## 8. Verify in AWS Console post-bootstrap

After `bootstrap-aws.yml` succeeds, you can spot-check via the Console:

- **IAM** → **Roles** → search `CloudDevPodsDeployerRole`, `CloudDevPodsPodOpsRole`. Both exist with path `/cloud-dev-pods/`.
- **IAM** → **Identity providers** → `token.actions.githubusercontent.com` exists.
- **ECR** → **Private registry** → repos `cloud-dev-pods/vscode-browser` and `cloud-dev-pods/vscode-tunnel` exist (empty until `build-runtime.yml` runs).
- **Secrets Manager** → three secrets at `/cloud-dev-pods/oauth/*`.
- **Systems Manager** → **Parameter Store** → parameters at `/cloud-dev-pods/dev/bootstrap/*`.

After `cluster-up.yml` succeeds:

- **VPC** → VPCs → one matching the CIDR you configured (default `10.50.0.0/16`).
- **EC2** → **Load Balancers** → one ALB tagged `Project=cloud-dev-pods`.
- **ECS** → **Clusters** → `cloud-dev-pods`.
- **EFS** → one filesystem tagged `Project=cloud-dev-pods` with mount targets in the private subnets.
- **Lambda** → `pod-manager` and `idle-reaper` functions exist.

After `pod-up.yml` succeeds:

- **ECS** → cluster → **Tasks** → one running task tagged with the pod name.
- The browser pod's URL prints in the workflow summary; sign in via GitHub OAuth and you should land in VS Code.

## What's next

- Cost ceiling: see [`cost-controls.md`](cost-controls.md) for an AWS Budgets alarm template (recommended before first `cluster-up`).
- Day-2: see [`operating.md`](operating.md).
- Tear down: see [`teardown.md`](teardown.md).
- If anything failed: [`troubleshooting.md`](troubleshooting.md) lists every signature surfaced during smoke testing.
