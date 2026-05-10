#!/usr/bin/env bash
# cleanup-orphan-efs.sh — sweep orphan cloud-dev-pods EFS resources.
#
# Background:
#   Forks running v0.1.x of cloud-dev-pods provisioned EFS with
#   RemovalPolicy.RETAIN, and the pod-manager Lambda created a fresh
#   per-pod access point on every `pod-up`. v0.2.0 fixes both by
#   default, but legacy filesystems / orphan APs may still be in the
#   account from earlier deployments. This script lists (and optionally
#   deletes) those orphans.
#
# What counts as an orphan:
#   - EFS filesystem mode: a filesystem tagged Project=cloud-dev-pods
#     whose owning CloudFormation stack `CloudDevPods-Cluster` does not
#     exist (or was destroyed). The filesystem is no longer referenced
#     by any live stack.
#   - Access-point mode: an EFS access point with a `Pod=<name>` tag
#     where multiple APs exist for the same pod-name. All-but-newest are
#     orphaned. APs whose pod-name is in the live registry table are
#     skipped (never delete a live pod's AP).
#
# Inputs (env / flags):
#   --mode efs|aps|all      Which orphan class to scan (default: all).
#   --dry-run               List only; do not delete (default behavior).
#   --apply                 Actually delete the orphans found.
#   AWS_REGION              Region to scan (defaults to AWS CLI default).
#   PROJECT_TAG             Tag value to filter on (default: cloud-dev-pods).
#   CLUSTER_STACK_NAME      Stack to check existence of (default: CloudDevPods-Cluster).
#   REGISTRY_TABLE_NAME     DDB pod registry to read live pod-names from
#                            (default: cloud-dev-pods-registry).
#
# Outputs:
#   - List of orphan resources to stdout.
#   - On `--apply`, deletion progress + per-resource result.
#   - Non-zero exit only on hard failures (missing aws CLI, missing
#     permissions). An orphan that fails to delete is logged and
#     skipped; the script keeps going.
#
# Usage:
#   scripts/maintainer/cleanup-orphan-efs.sh                  # dry-run, all
#   scripts/maintainer/cleanup-orphan-efs.sh --mode aps       # dry-run, APs only
#   scripts/maintainer/cleanup-orphan-efs.sh --mode all --apply
#
# Required: `aws` CLI authenticated to the cloud-dev-pods AWS account
# (any role with efs:Describe*, efs:Delete*, dynamodb:Scan,
# cloudformation:DescribeStacks).

set -euo pipefail

MODE="all"
APPLY="no"
PROJECT_TAG="${PROJECT_TAG:-cloud-dev-pods}"
CLUSTER_STACK_NAME="${CLUSTER_STACK_NAME:-CloudDevPods-Cluster}"
REGISTRY_TABLE_NAME="${REGISTRY_TABLE_NAME:-cloud-dev-pods-registry}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)
      MODE="${2:-all}"
      shift 2
      ;;
    --dry-run)
      APPLY="no"
      shift
      ;;
    --apply)
      APPLY="yes"
      shift
      ;;
    -h|--help)
      sed -n '2,40p' "$0"
      exit 0
      ;;
    *)
      echo "unknown flag: $1" >&2
      exit 2
      ;;
  esac
done

case "$MODE" in
  efs|aps|all) ;;
  *) echo "--mode must be one of: efs, aps, all" >&2; exit 2 ;;
esac

log()  { printf '\033[1;34m[%s]\033[0m %s\n' "$(date +%H:%M:%S)" "$*"; }
ok()   { printf '\033[1;32m  v\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m  !\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[1;31m  x\033[0m %s\n' "$*" >&2; }

if ! command -v aws >/dev/null 2>&1; then
  err "aws CLI not found in PATH"
  exit 1
fi

if [[ "$APPLY" == "yes" ]]; then
  log "MODE=$MODE APPLY=yes — destructive operations will run"
else
  log "MODE=$MODE (dry-run; pass --apply to delete)"
fi

# ---- helpers ------------------------------------------------------------

cluster_stack_exists() {
  aws cloudformation describe-stacks \
    --stack-name "$CLUSTER_STACK_NAME" \
    --query 'Stacks[0].StackStatus' \
    --output text 2>/dev/null \
    | grep -qE 'CREATE_COMPLETE|UPDATE_COMPLETE|UPDATE_ROLLBACK_COMPLETE|ROLLBACK_COMPLETE'
}

live_pod_names() {
  # Best effort. If the table doesn't exist (cluster torn down), just
  # return empty — every AP is fair game for cleanup.
  aws dynamodb scan \
    --table-name "$REGISTRY_TABLE_NAME" \
    --projection-expression 'podName' \
    --query 'Items[].podName.S' \
    --output text 2>/dev/null \
    | tr '\t' '\n' \
    | grep -v '^$' || true
}

# ---- EFS filesystem sweep ----------------------------------------------

sweep_efs() {
  log "scanning EFS filesystems tagged Project=$PROJECT_TAG"

  local fs_ids
  fs_ids=$(aws efs describe-file-systems \
    --query "FileSystems[?Tags[?Key=='Project' && Value=='$PROJECT_TAG']].FileSystemId" \
    --output text)

  if [[ -z "$fs_ids" ]]; then
    ok "no project-tagged EFS filesystems found"
    return
  fi

  if cluster_stack_exists; then
    log "$CLUSTER_STACK_NAME exists — skipping EFS deletion to avoid yanking the live filesystem"
    log "filesystems found: $fs_ids"
    return
  fi

  warn "$CLUSTER_STACK_NAME does not exist; the following filesystem(s) are orphans"
  for fs in $fs_ids; do
    echo "  - $fs"
    if [[ "$APPLY" == "yes" ]]; then
      log "deleting access points + mount targets + filesystem $fs"
      # Access points first.
      local aps
      aps=$(aws efs describe-access-points --file-system-id "$fs" \
        --query 'AccessPoints[].AccessPointId' --output text || true)
      for ap in $aps; do
        if aws efs delete-access-point --access-point-id "$ap" 2>/dev/null; then
          ok "deleted access-point $ap"
        else
          warn "failed to delete access-point $ap"
        fi
      done
      # Mount targets.
      local mts
      mts=$(aws efs describe-mount-targets --file-system-id "$fs" \
        --query 'MountTargets[].MountTargetId' --output text || true)
      for mt in $mts; do
        if aws efs delete-mount-target --mount-target-id "$mt" 2>/dev/null; then
          ok "deleted mount-target $mt"
        else
          warn "failed to delete mount-target $mt"
        fi
      done
      # Wait for mount targets to actually go away before deleting fs.
      for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
        local remaining
        remaining=$(aws efs describe-mount-targets --file-system-id "$fs" \
          --query 'length(MountTargets)' --output text 2>/dev/null || echo 0)
        [[ "$remaining" == "0" ]] && break
        sleep 5
      done
      if aws efs delete-file-system --file-system-id "$fs" 2>/dev/null; then
        ok "deleted filesystem $fs"
      else
        warn "failed to delete filesystem $fs (may still have mount targets draining)"
      fi
    fi
  done
}

# ---- Access-point sweep -------------------------------------------------

sweep_aps() {
  log "scanning EFS access points tagged Project=$PROJECT_TAG (grouped by Pod tag)"

  # All filesystems with our project tag — APs hang off filesystems.
  local fs_ids
  fs_ids=$(aws efs describe-file-systems \
    --query "FileSystems[?Tags[?Key=='Project' && Value=='$PROJECT_TAG']].FileSystemId" \
    --output text)

  if [[ -z "$fs_ids" ]]; then
    ok "no project-tagged filesystems; nothing to scan"
    return
  fi

  local live
  live=$(live_pod_names || true)

  for fs in $fs_ids; do
    log "filesystem $fs"
    # Pull APs as TSV: <ap_id>\t<creation_time>\t<pod_tag>
    local rows
    rows=$(aws efs describe-access-points --file-system-id "$fs" \
      --query "AccessPoints[].[AccessPointId,LifeCycleState,join(',', Tags[?Key=='Pod'].Value || [\`\`])]" \
      --output text 2>/dev/null || true)

    if [[ -z "$rows" ]]; then
      ok "  no access points"
      continue
    fi

    # Group by pod-name. We need creation times — fetch per-AP.
    declare -A POD_NEWEST_AP=()
    declare -A POD_NEWEST_TS=()
    declare -A POD_ALL_APS=()

    while IFS=$'\t' read -r ap_id state pod; do
      [[ -z "$ap_id" ]] && continue
      [[ "$state" != "available" ]] && continue
      [[ -z "$pod" ]] && continue

      # Fetch creation time per AP (DescribeAccessPoints returns it but
      # not in our --query above; re-query single AP for stable parse).
      local ts
      ts=$(aws efs describe-access-points --access-point-id "$ap_id" \
        --query 'AccessPoints[0].LifeCycleState' --output text 2>/dev/null || true)
      # We sort by CreationTime; describe-access-points emits ISO date.
      ts=$(aws efs describe-access-points --access-point-id "$ap_id" \
        --query 'AccessPoints[0].CreationTime' --output text 2>/dev/null || echo 0)

      POD_ALL_APS[$pod]+="${ap_id}|${ts} "
      if [[ -z "${POD_NEWEST_TS[$pod]:-}" ]] || [[ "$ts" > "${POD_NEWEST_TS[$pod]}" ]]; then
        POD_NEWEST_TS[$pod]="$ts"
        POD_NEWEST_AP[$pod]="$ap_id"
      fi
    done <<< "$rows"

    for pod in "${!POD_ALL_APS[@]}"; do
      # Skip live pods.
      if printf '%s\n' $live | grep -Fxq "$pod"; then
        log "  pod=$pod is LIVE in registry — skipping"
        continue
      fi

      local entries
      read -ra entries <<< "${POD_ALL_APS[$pod]}"
      local count=${#entries[@]}
      if (( count <= 1 )); then
        ok "  pod=$pod single AP (${POD_NEWEST_AP[$pod]}) — no duplicates"
        continue
      fi

      warn "  pod=$pod has $count APs; keeping newest=${POD_NEWEST_AP[$pod]}"
      for entry in "${entries[@]}"; do
        local ap_id="${entry%%|*}"
        if [[ "$ap_id" == "${POD_NEWEST_AP[$pod]}" ]]; then continue; fi
        echo "    - orphan: $ap_id"
        if [[ "$APPLY" == "yes" ]]; then
          if aws efs delete-access-point --access-point-id "$ap_id" 2>/dev/null; then
            ok "    deleted $ap_id"
          else
            warn "    failed to delete $ap_id"
          fi
        fi
      done
    done

    unset POD_NEWEST_AP POD_NEWEST_TS POD_ALL_APS
  done
}

# ---- run ----------------------------------------------------------------

case "$MODE" in
  efs) sweep_efs ;;
  aps) sweep_aps ;;
  all) sweep_efs; sweep_aps ;;
esac

log "done"
