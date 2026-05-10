# ADR 0007: EFS filesystem RemovalPolicy = DESTROY by default; opt-in `retainOnClusterDown`

## Status

Accepted (2026-05-09).

## Context

`ClusterStack` provisioned the EFS filesystem with `RemovalPolicy.RETAIN` from Phase 6 onward. The intent was to protect user `/workspace` data across `cluster-down`. In practice, this caused two compounding failures (#29):

1. `cluster-down` left the EFS filesystem (and its mount targets and access points) behind.
2. The next `cluster-up` either **silently produced a new filesystem** — orphaning the previous one for the indefinite future — or, when name collisions intervened, failed mid-deploy with a confusing error that did not point at the orphan.

Compounding this, the pod-manager Lambda (#30) created a fresh EFS access point on every `pod-up`, accumulating duplicates without an upper bound. After repeated up/down cycles, a fork could end up with several orphan filesystems and dozens of orphan access points per pod — paying for storage they were no longer using and bumping into the 1000-AP-per-filesystem cap.

The audience for cloud-dev-pods is dev-default: a public template a single user clones to spin up VS Code pods in their own AWS account. The expected workflow is `cluster-up` → use → `cluster-down`, not "preserve this filesystem indefinitely." The default behavior must minimize footguns for that audience, even at the cost of losing data when an explicit `cluster-down` is requested.

## Decision

The EFS filesystem in `ClusterStack` defaults to `RemovalPolicy.DESTROY`. An optional config flag `efs.retainOnClusterDown: boolean` (default `false`) gates the choice:

```ts
removalPolicy: config.efs?.retainOnClusterDown
  ? RemovalPolicy.RETAIN
  : RemovalPolicy.DESTROY,
```

Forks that genuinely cannot afford to lose `/workspace` data on an explicit `cluster-down` opt in by setting `efs.retainOnClusterDown: true` in `config/config.yaml` and re-deploying.

A maintainer script (`scripts/maintainer/cleanup-orphan-efs.sh`) sweeps orphan filesystems and orphan access points left over from v0.1.x deployments. The pre-flight step in `cluster-up.yml` emits a non-blocking warning when project-tagged EFS filesystems exist without a live `CloudDevPods-Cluster` stack, pointing the user at the cleanup script.

## Rationale

Three properties drove the decision toward DESTROY-by-default:

- **Visibility.** Orphan-by-default produces silent, growing AWS spend. Data-loss-on-explicit-teardown is loud — a user who runs `cluster-down -f confirm=destroy` has acknowledged they are tearing things down.
- **Reproducibility.** Repeated `cluster-up` / `cluster-down` cycles must produce the same end state. With `RETAIN`, they do not — each cycle leaks one filesystem.
- **Audience fit.** Public dev template, single-user clones, no production data assumption. The minority of users who do host data they cannot lose can opt in with one config line.

The flag is gated at deploy time (it changes the synthesized CloudFormation template's `DeletionPolicy`), not at runtime. Toggling the flag without re-deploying has no effect — there is no Lambda or workflow logic that reads it. This is intentional: the flag is a deploy-time policy decision, not an operational toggle.

## Rejected alternatives

- **Env-conditional default (DESTROY in `dev`, RETAIN in `prod`).** Tempting, but the template's `project.env` field is opaque metadata, not an actual environment dimension. Users running production-grade workloads typically still leave `env: dev`. A one-line opt-in is no harder than reading docs to figure out what env-conditional default applies to them.
- **Lookup-on-up (existing-EFS-import).** Keep `RETAIN`, then teach `cluster-up` to look up an existing project-tagged filesystem and import it via `EFS.FileSystem.fromFileSystemAttributes` rather than create a new one. Workable but invasive: requires the deploy role to query EFS, surfaces ambiguity when multiple project-tagged filesystems exist, and does not address the orphan-AP accumulation problem at all. DESTROY-by-default removes both pathologies in one stroke.
- **Snapshot-on-down.** Trigger an EFS-to-S3 backup on `cluster-down` before destroying. Out of scope for v0.2.0 — adds dependencies (AWS Backup or DataSync), needs lifecycle policy decisions, and substantially complicates the teardown workflow. Listed as a candidate for a future `efs.snapshotOnDown` flag.

## Migration

Forks running v0.1.1 with `RETAIN` and live workspace data they want to preserve:

1. **Before upgrading**, set `efs.retainOnClusterDown: true` in `config/config.yaml`.
2. Pull the v0.2.0 upgrade. The flag preserves prior behavior — `cluster-down` will still leave the filesystem.
3. If you do not care about the data, you can leave the flag at the default `false`. A subsequent `cluster-down` will destroy the filesystem.

Forks with already-orphaned filesystems from prior `cluster-down` cycles:

```bash
scripts/maintainer/cleanup-orphan-efs.sh --mode efs           # dry-run
scripts/maintainer/cleanup-orphan-efs.sh --mode efs --apply
```

The script refuses to delete a filesystem while `CloudDevPods-Cluster` exists.

## Consequences

- `cluster-down` is now lossy by default. Documented in `docs/teardown.md` and the `cluster-down.yml` summary section.
- The `cluster-up` pre-flight orphan check makes pre-existing leaks visible without blocking the deploy.
- Combined with the access-point reuse change (ADR 0004 "Reuse semantics"), repeated up/down cycles on the same pod-name are now idempotent: same UID, same AP, same `/workspace` data — assuming `retainOnClusterDown: true`, or assuming the cluster is not torn down between cycles.
- Forks running `retainOnClusterDown: true` are responsible for their own filesystem cleanup. The cleanup script handles that case as well (it skips filesystems whose owning stack is live).
- Conventional Commit prefix `feat!:` is used for this change to bump the minor version (0.1.x → 0.2.0) via release-please. Downstream forks see this as a behavior-change semver signal.
