# Workflows

| File | Trigger | Runs on | Purpose |
|---|---|---|---|
| `ci-lint.yml` | `pull_request` | Upstream + forks | actionlint, markdownlint, eslint, shellcheck, link-check. |
| `ci-test.yml` | `pull_request` | Upstream + forks | tsc, vitest, `cdk synth`, `cdk-nag`. |
| `ci-security.yml` | `pull_request` + daily | Upstream + forks | gitleaks, trivy, osv-scanner. |
| `release.yml` | push to `main` | Upstream only | release-please version + tag + changelog. |
| `bootstrap-aws.yml` | `workflow_dispatch` | Forks only | One-time GitHub OIDC + IAM role setup in user's AWS account. |
| `build-runtime.yml` | `workflow_dispatch` + on push to `runtime/**` | Forks only | Build + push runtime images to user's ECR. |
| `cluster-up.yml` | `workflow_dispatch` | Forks only | `cdk deploy` cluster + supporting stacks. |
| `cluster-down.yml` | `workflow_dispatch` (typed-confirmation) | Forks only | `cdk destroy` to zero ongoing AWS spend. |
| `pod-up.yml` | `workflow_dispatch` | Forks only | Spin up one pod (browser or tunnel mode). |
| `pod-down.yml` | `workflow_dispatch` | Forks only | Spin down one pod. |
| `pod-list.yml` | `workflow_dispatch` | Forks only | List running pods, URLs, costs-to-date. |
| `sync-upstream.yml` | `workflow_dispatch` + weekly cron | Forks only | Open PR with upstream upgrades. |
| `smoke-test.yml` | `workflow_dispatch` (gated) | Upstream sandbox only | End-to-end test if a sandbox AWS account is configured. |

## Public-repo safety

Provisioning workflows that target AWS (everything that calls the OIDC composite action) include this guard as the first job:

```yaml
guard:
  runs-on: ubuntu-latest
  if: github.repository != 'foolswithtools/cloud-dev-pods'
  steps:
    - run: echo "Running in fork ${{ github.repository }}"
```

All AWS-touching jobs `needs: guard`. On the upstream repo, `guard` evaluates false, dependent jobs skip, the run is green-empty. Belt-and-suspenders: foolswithtools owns no AWS account that trusts this repo, so even if the guard regresses, `AssumeRoleWithWebIdentity` fails.
