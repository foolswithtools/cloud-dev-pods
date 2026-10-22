# Operating cloud-dev-pods

Day-2 operations for downstream users.

## Common commands

```bash
gh workflow run pod-up.yml -f pod_name=foo -f mode=browser
gh workflow run pod-down.yml -f pod_name=foo
gh workflow run pod-list.yml
gh workflow run cluster-down.yml -f confirm=destroy   # zero ongoing cost
```

## Pod owner

Every pod has an owner, stored in the pod registry, tagged on the ECS task (`Owner`), and shown by `pod-list` and in the `pod-up` workflow summary. By default the owner is the GitHub user who ran `pod-up` (`GITHUB_ACTOR`). Pass a different one with the `owner` input:

```bash
gh workflow run pod-up.yml -f pod_name=foo -f mode=browser -f owner=octocat
npx tsx scripts/pod-cli.ts up --pod foo --mode browser --owner octocat   # local
```

Use a GitHub login for `auth.browser.provider: github` and an email for `entra-id` or `oidc`. Owners may contain only letters, digits, and `+ - = . _ : / @` (the characters ECS tags allow).

## Per-pod owner authorization

By default every browser pod admits anyone on the deployment-wide allowlist, so any allowlisted user can open any other user's pod. Set `auth.browser.ownerOnly: true` to lock each browser pod to its owner, plus the break-glass `auth.browser.adminUsers`:

```yaml
auth:
  browser:
    provider: github
    allowedOrg: your-org
    ownerOnly: true
    adminUsers: [ops-login]   # can open every pod
```

Commit, then re-deploy the pod-manager (`cluster-up`). The setting applies to pods started afterwards; running pods keep their task definition until they are recreated. Other allowlisted users get HTTP 403 from oauth2-proxy on a pod they don't own. Tunnel pods are unaffected.

How it is enforced, per provider:

| Provider | Sidecar settings with `ownerOnly: true` | What happens to the global allowlist |
| --- | --- | --- |
| `github` | `OAUTH2_PROXY_GITHUB_USERS=<owner>,<adminUsers>`; `allowedOrg` becomes `OAUTH2_PROXY_ALLOWED_GROUPS` | `allowedUsers` is replaced by owner + admins; at `pod-up` the owner must be in `allowedUsers` or `adminUsers` when `allowedUsers` is set. `allowedOrg` still applies to everyone, admins included. |
| `entra-id`, `oidc` | The init container also writes owner + admin emails to the task-scoped volume; the sidecar reads it via `OAUTH2_PROXY_AUTHENTICATED_EMAILS_FILE` and drops `OAUTH2_PROXY_EMAIL_DOMAINS` | `allowedEmailDomains` is no longer sent to the sidecar; at `pod-up` the owner's domain must be in it when it is set. |

`allowedOrg` is passed as an allowed group, not `OAUTH2_PROXY_GITHUB_ORG`: oauth2-proxy lets anyone in the org through `GITHUB_ORG` even when `GITHUB_USERS` is set, which would defeat owner-only. Likewise, `EMAIL_DOMAINS` would admit every address alongside the emails file.

GitHub logins are matched case-sensitively, so pass the owner exactly as GitHub spells it (`GITHUB_ACTOR` always does). `pod-up` refuses an owner-only browser pod when the owner is missing or isn't a valid identity for the provider; see [troubleshooting](troubleshooting.md).

With every provider, owner-only pods also get their own cookie secret. An init container writes a random secret to the task-scoped volume when the task starts, and the sidecar reads it via `OAUTH2_PROXY_COOKIE_SECRET_FILE` instead of the shared `/cloud-dev-pods/oauth/cookie-secret`. A session cookie copied from one pod is not valid on another, so it can't skip the sign-in owner check (oauth2-proxy checks `GITHUB_USERS` only at sign-in). The secret lives only as long as the task: when a pod's task is replaced (pod recreated, Spot interruption), its users sign in again.

## Costs

The biggest fixed costs are:

- ALB (~$16/mo)
- NAT Gateway (~$32/mo)
- EFS storage ($0.30/GB-month)

Pods themselves cost ~$0.014/hour on Fargate Spot (1 vCPU / 2 GB) while running. Idle reaper auto-stops pods after `idleMinutes`.

To go to zero ongoing cost: `cluster-down`.

## EFS performance for IDE I/O

EFS in Bursting mode is fine for source code but slow for `node_modules` install or large repo `git clone`. Recommended:

- Keep `node_modules` on the container's writable layer (ephemeral).
- Use `pnpm` with a content-addressed store on EFS for shared deps.
- For power users, enable Provisioned Throughput (extra cost).

## Custom images

Phase 5+ will document how to publish your own runtime image and reference it via `--image_tag` on `pod-up.yml`.

## Logs

```bash
aws logs tail /cloud-dev-pods/pods --follow --since 10m
```

## Limits

- **ALB listener rules: default 100 per listener.** With one rule per browser pod (host-based routing), this is the practical pod ceiling per cluster. Browser pods that fail with `PriorityInUse` after ~95 active pods are likely hitting it. Raise via Service Quotas (request `L-EAD7E5BC` → 1000) or shard pods across additional ALBs.
- **EFS access points: 1000 per filesystem.** One per pod; the lifecycle is "create on first up, retain across down (default), delete on `pod-down --no-keep-workspace`". Watch out for accumulation if many pods are created/destroyed without `keepWorkspace=false`.
- **POSIX UIDs: 10000–65000.** ~55k unique pods over the lifetime of a cluster. UIDs aren't recycled while the pod is in the registry; once `pod-down` removes the entry, the UID is free.
- **Fargate task quotas: 1000 tasks per region per account.** Default. Rarely a concern.

## Idle reaper behavior

The idle reaper runs every 5 minutes (per cluster). For each browser pod:

1. Reads `RequestCount` on the pod's ALB target group over the last `idleMinutes` (default 60). If sum is 0, marks the pod with `idleSince=<timestamp>` in DynamoDB and publishes a notification to the SNS topic `cloud-dev-pods-idle-warnings`.
2. On the next reaper cycle, if the pod is still idle, invokes `pod-manager.down(podName, keepWorkspace: true)` — task stops, ALB rule + target group are removed, EFS workspace is retained.

To opt out per-pod, run `pod-up` with `--idle 0`. To subscribe to idle warnings:

```bash
aws sns subscribe \
  --topic-arn $(aws ssm get-parameter --name /cloud-dev-pods/dev/idle-reaper/topic-arn --query Parameter.Value --output text) \
  --protocol email --notification-endpoint you@example.com
```

Tunnel-mode pods are NOT idle-reaped in v1 (no useful idle signal from the `code tunnel` agent). Stop them manually with `pod-down`.

The reaper also handles **task-stopped cleanup**: if an ECS task transitions to STOPPED for any reason (crash, manual `aws ecs stop-task`, capacity reclaim), the reaper invokes `pod-manager.down` to remove the orphaned ALB rule + target group + DDB entry.
