# Troubleshooting

Top failure signatures with the diagnostic and the fix.

## 1. `Not authorized to perform sts:AssumeRoleWithWebIdentity`

**Cause:** OIDC trust policy on `CloudDevPodsDeployerRole` doesn't match this repo's `sub` claim. Often happens after a repo rename or transfer.

**Fix:** Re-run `gh workflow run bootstrap-aws.yml` — it's idempotent and re-applies the trust policy with the current repo path.

## 2. `cdk bootstrap` missing

**Cause:** The CDK toolkit stack hasn't been bootstrapped in this account/region.

**Fix:** `cluster-up.yml` includes a `cdk bootstrap` step that runs once. If you skipped it, run manually: `aws cloudformation create-stack --stack-name CDKToolkit ...`.

## 3. ALB rule limit hit

**Cause:** AWS ALB has a default of 100 listener rules. With 1 rule per pod, you've hit it.

**Fix:** Open a Service Quotas request (`L-EAD7E5BC` -> 1000). Or shard pods across multiple ALBs.

## 4. EFS mount target not in same AZ

**Cause:** Task placed in an AZ where EFS has no mount target.

**Fix:** Check `aws efs describe-mount-targets` — should be one per private subnet. If missing, the cluster stack didn't deploy fully; rerun `cluster-up.yml`.

## 5. oauth2-proxy cookie domain mismatch

**Cause:** `OAUTH2_PROXY_COOKIE_DOMAINS` doesn't match the actual host the user reaches.

**Fix:** Make sure `domain.baseDomain` in `config/config.yaml` matches the Route53 zone, and that `<pod>.<baseDomain>` resolves to the ALB.

## 6. Tunnel pod never shows in VS Code

**Cause:** Different GitHub account on local VS Code vs the pod's auth.

**Fix:** Sign out of VS Code Tunnels and sign in with the same GitHub account you used for the device-code flow.

## 7. Pod files disappeared after restart

**Cause:** Pod was created without EFS mount, or EFS access point was deleted on `pod-down`.

**Fix:** Confirm `keepWorkspaceOnDown: true` (the default). For brand-new pods on first start, this is normal; subsequent restarts should preserve.

## 8. `cluster-down` fails with "rule still references target group"

**Cause:** A pod is still running; ALB rule + target group can't be deleted.

**Fix:** `gh workflow run pod-list.yml` — for any running pod, run `pod-down`. Or pass `force=true` to `cluster-down` to mass-stop.

## 9. Trivy fails on runtime image

**Cause:** A CVE was published against the openvscode-server or ubuntu base.

**Fix:** Bump the base image digest in `runtime/<flavor>/Dockerfile`, push, rerun `build-runtime.yml`.

## 10. `release-please` not opening release PR

**Cause:** No `feat:` or `fix:` commits since last release.

**Fix:** Land a conventional commit. `chore:` and `docs:` don't trigger a version bump.
