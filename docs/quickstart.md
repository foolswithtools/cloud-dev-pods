# Quickstart

Goal: from zero to a running browser-mode pod in under 30 minutes.

## Step-by-step

(Phase 11 will fill this in with the exact happy-path command sequence.)

1. Use the template to create your private fork.
2. Clone locally.
3. `npm ci && npm run init` — interactive setup.
4. `gh workflow run bootstrap-aws.yml` — one-time AWS bootstrap.
5. `gh workflow run build-runtime.yml` — push runtime images to your ECR.
6. `gh workflow run cluster-up.yml` — provision VPC + ECS + ALB + EFS.
7. `gh workflow run pod-up.yml -f pod_name=hello -f mode=browser` — launch a pod.
8. Open the URL printed in the workflow summary. Sign in with GitHub. You're in VS Code.

## Cost estimate (us-west-2, idle)

- ALB: ~$16/month
- NAT Gateway: ~$32/month
- EFS storage: $0.30/GB-month
- Per pod (1 vCPU / 2 GB Spot): ~$0.014/hour while running

Run `gh workflow run cluster-down.yml` to zero out fixed cost.

## Verify

After step 7, you should see:

```text
Pod `hello` is up
URL: https://hello.<your-base-domain>
Mode: browser
```
