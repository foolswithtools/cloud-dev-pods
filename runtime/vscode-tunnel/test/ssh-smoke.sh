#!/usr/bin/env bash
# Container-level smoke test for ssh-mode pods (POD_MODE=ssh) of the tunnel
# runtime image. Needs only `docker` and an OpenSSH client; no host sudo and
# no AWS. A named Docker volume stands in for the pod's EFS /workspace.
#
#   bash runtime/vscode-tunnel/test/ssh-smoke.sh <image-tag>
#
# SMOKE_PORT overrides the host port sshd is published on (default 2222).
# On an arm64 host, export DOCKER_DEFAULT_PLATFORM=linux/amd64 (the image
# bundles the x64 VS Code CLI). Fails on the first check that misses.
set -euo pipefail

IMAGE="${1:?usage: ssh-smoke.sh <image-tag>}"
PORT="${SMOKE_PORT:-2222}"
RUN_ID="cdp-ssh-smoke-$$"
VOLUME="${RUN_ID}-ws"
KEY_PATH=/workspace/.cloud-dev-pods/ssh/ssh_host_ed25519_key

tmp="$(mktemp -d)"
containers=()

# shellcheck disable=SC2329 # invoked by the EXIT trap
cleanup() {
  for c in "${containers[@]}"; do
    docker rm -f "$c" >/dev/null 2>&1 || true
  done
  docker volume rm -f "$VOLUME" >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  for c in "${containers[@]}"; do
    echo "--- logs: $c" >&2
    docker logs "$c" >&2 2>&1 || true
  done
  exit 1
}
pass() { echo "ok: $*"; }

ssh-keygen -q -t ed25519 -N '' -C ssh-smoke -f "$tmp/id"
pubkey="$(cat "$tmp/id.pub")"

ssh_opts=(
  -p "$PORT"
  -o StrictHostKeyChecking=no
  -o UserKnownHostsFile=/dev/null
  -o BatchMode=yes
  -o IdentitiesOnly=yes
  -o ConnectTimeout=5
  -o LogLevel=ERROR
)

# Root-owned helper container on the workspace volume.
as_root() {
  docker run --rm --user 0 -v "$VOLUME:/workspace" --entrypoint sh "$IMAGE" -c "$1"
}

start_pod() {
  local name="$1"
  docker run -d --name "$name" \
    -e POD_NAME=smoke -e POD_MODE=ssh -e REMOTE_BACKEND=ssm \
    -e SSH_AUTHORIZED_KEYS="$pubkey" \
    -v "$VOLUME:/workspace" \
    -p "127.0.0.1:${PORT}:2222" \
    --health-interval 2s --health-start-period 2s \
    "$IMAGE" >/dev/null
  containers+=("$name")
  # Wait for sshd to answer before any check talks to it.
  for _ in $(seq 1 30); do
    if ssh-keyscan -p "$PORT" -T 2 127.0.0.1 >/dev/null 2>&1; then return 0; fi
    [ "$(docker inspect -f '{{.State.Running}}' "$name")" = true ] || fail "$name exited before sshd listened"
    sleep 1
  done
  fail "$name: sshd not listening on ${PORT} after 30s"
}

fingerprint() {
  ssh-keyscan -p "$PORT" -t ed25519 127.0.0.1 2>/dev/null | ssh-keygen -lf - | awk '{print $2}'
}

stop_pod() {
  docker stop -t 15 "$1" >/dev/null || fail "docker stop $1 failed"
}

# 1. Effective config, with a throwaway host key.
cfg="$(docker run --rm --entrypoint sh "$IMAGE" -c \
  'ssh-keygen -q -t ed25519 -N "" -f /tmp/hk && /usr/sbin/sshd -T -f /etc/ssh/cloud-dev-pods/sshd_config -o HostKey=/tmp/hk 2>/dev/null')"
for want in "port 2222" "passwordauthentication no" "kbdinteractiveauthentication no" \
            "permitrootlogin no" "usepam no" "allowusers vscode"; do
  grep -qx "$want" <<<"$cfg" || fail "sshd -T is missing \"$want\""
done
pass "1 sshd -T reports the hardened settings"

# Prepare the workspace volume the way an EFS access point would hand it over:
# owned by the pod user.
docker volume create "$VOLUME" >/dev/null
as_root 'chown vscode:vscode /workspace'

# 2. Key login as vscode.
start_pod "${RUN_ID}-a"
who="$(ssh "${ssh_opts[@]}" -i "$tmp/id" vscode@127.0.0.1 id -un)" || fail "key login as vscode failed"
[ "$who" = vscode ] || fail "expected id -un to print vscode, got \"$who\""
pass "2 key login as vscode"

# 3. Password / keyboard-interactive and root logins are refused.
if out="$(ssh "${ssh_opts[@]}" -o PubkeyAuthentication=no \
    -o PreferredAuthentications=password,keyboard-interactive \
    vscode@127.0.0.1 true 2>&1)"; then
  fail "password-only login succeeded"
fi
grep -q 'Permission denied (publickey)' <<<"$out" || fail "server offered more than publickey: $out"
if ssh "${ssh_opts[@]}" -i "$tmp/id" root@127.0.0.1 true >/dev/null 2>&1; then
  fail "root login succeeded"
fi
pass "3 password-only and root logins refused"

# 4. sshd runs as vscode, never root.
users="$(docker exec "${RUN_ID}-a" ps -o user= -C sshd | sort -u | tr -d ' ')"
[ "$users" = vscode ] || fail "sshd process users: \"$users\" (want only vscode)"
pass "4 sshd runs only as vscode"

# 5. Docker health reaches healthy.
health=""
for _ in $(seq 1 30); do
  health="$(docker inspect -f '{{.State.Health.Status}}' "${RUN_ID}-a")"
  [ "$health" = healthy ] && break
  sleep 1
done
[ "$health" = healthy ] || fail "health is \"$health\" after 30s"
pass "5 container health is healthy"

# 6. Host key persists on the workspace and survives a new container.
docker exec "${RUN_ID}-a" test -f "$KEY_PATH" || fail "$KEY_PATH missing"
fp1="$(fingerprint)"
[ -n "$fp1" ] || fail "could not read host key fingerprint"
stop_pod "${RUN_ID}-a"
start_pod "${RUN_ID}-b"
fp2="$(fingerprint)"
[ "$fp1" = "$fp2" ] || fail "host key changed across containers: $fp1 vs $fp2"
pass "6 host key persisted on the workspace ($fp1)"
stop_pod "${RUN_ID}-b"

# 7. Foreign-owned key (the EFS access-point uid), group/world-readable.
as_root "chown -R 10000:10000 /workspace/.cloud-dev-pods/ssh && chmod 0644 $KEY_PATH"
start_pod "${RUN_ID}-c"
who="$(ssh "${ssh_opts[@]}" -i "$tmp/id" vscode@127.0.0.1 id -un)" || fail "key login failed with a foreign-owned host key"
[ "$who" = vscode ] || fail "expected vscode with a foreign-owned host key, got \"$who\""
fp3="$(fingerprint)"
[ "$fp1" = "$fp3" ] || fail "host key changed with a foreign-owned key: $fp1 vs $fp3"
pass "7 foreign-owned host key still served"

# 8. docker stop returns and the container exits 0.
start=$SECONDS
stop_pod "${RUN_ID}-c"
elapsed=$((SECONDS - start))
code="$(docker inspect -f '{{.State.ExitCode}}' "${RUN_ID}-c")"
[ "$code" = 0 ] || fail "container exit code $code after docker stop (want 0)"
[ "$elapsed" -le 10 ] || fail "docker stop took ${elapsed}s (want <= 10s)"
pass "8 docker stop exits 0 in ${elapsed}s"

echo "ssh smoke: all checks passed"
