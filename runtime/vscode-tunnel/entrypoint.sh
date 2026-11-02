#!/usr/bin/env bash
set -euo pipefail

: "${POD_NAME:?POD_NAME must be set by the ECS task override}"

# POD_MODE is set by pod-manager. Unset means tunnel, so task definitions that
# predate ssh mode keep working unchanged.
POD_MODE="${POD_MODE:-tunnel}"
case "$POD_MODE" in
  tunnel) ;;
  ssh) ;;
  *)
    echo "POD_MODE must be tunnel or ssh (got \"${POD_MODE}\")" >&2
    exit 64
    ;;
esac

# ssh mode: run sshd as the unprivileged `vscode` user on 2222 and never call
# `code`. sshd -T, the HostKey/PidFile paths and the reasons nothing here needs
# root are in /etc/ssh/cloud-dev-pods/sshd_config. CDP_HOME_DIR and
# CDP_WORKSPACE_DIR exist only so scripts/tunnel-entrypoint.test.ts can point
# them at a temp dir; production uses the defaults, which sshd_config hardcodes.
run_ssh() {
  if [ -z "${SSH_AUTHORIZED_KEYS:-}" ]; then
    echo "SSH_AUTHORIZED_KEYS must be set when POD_MODE=ssh" >&2
    exit 64
  fi
  if [ -z "${REMOTE_BACKEND:-}" ]; then
    echo "REMOTE_BACKEND must be set when POD_MODE=ssh" >&2
    exit 64
  fi

  # One arm per remote-access backend. Each later fills in its own agent.
  case "$REMOTE_BACKEND" in
    ssm) echo "remote backend ssm: no in-pod agent (ECS Exec carries the session)" ;;
    cloudflare) echo "remote backend cloudflare: agent not implemented yet" ;;
    tailscale) echo "remote backend tailscale: agent not implemented yet" ;;
    *)
      echo "REMOTE_BACKEND must be ssm, cloudflare or tailscale (got \"${REMOTE_BACKEND}\")" >&2
      exit 64
      ;;
  esac

  local home_dir="${CDP_HOME_DIR:-/home/vscode}"
  local workspace_dir="${CDP_WORKSPACE_DIR:-/workspace}"
  local ssh_dir="${home_dir}/.ssh"
  local sshd_dir="${ssh_dir}/sshd"
  local key_dir="${workspace_dir}/.cloud-dev-pods/ssh"
  local key_name="ssh_host_ed25519_key"

  # authorized_keys is container-local, not on EFS: StrictModes rejects a file
  # the login user doesn't own, and EFS access-point files show the AP's uid.
  mkdir -p "$ssh_dir" "$sshd_dir"
  chmod 700 "$ssh_dir" "$sshd_dir"
  (umask 077 && printf '%s\n' "$SSH_AUTHORIZED_KEYS" > "${ssh_dir}/authorized_keys")
  chmod 600 "${ssh_dir}/authorized_keys"

  # The canonical host key lives on the pod's EFS workspace so the fingerprint
  # survives pod-down / pod-up with the workspace kept. It is visible to the
  # user in their workspace; they have passwordless sudo in the pod anyway.
  # sshd refuses a host key it doesn't own or that is group/world-readable,
  # and the EFS copy is owned by the access point's uid, so sshd reads a
  # private copy under $HOME instead.
  if [ ! -f "${key_dir}/${key_name}" ]; then
    mkdir -p "$key_dir"
    ssh-keygen -q -t ed25519 -N '' -f "${key_dir}/${key_name}"
  fi
  cp "${key_dir}/${key_name}" "${key_dir}/${key_name}.pub" "$sshd_dir/"
  chmod 600 "${sshd_dir}/${key_name}"
  chmod 644 "${sshd_dir}/${key_name}.pub"

  # sshd re-execs itself, so it must be started by absolute path.
  local sshd_bin
  sshd_bin="$(command -v sshd)"

  # ECS sends SIGTERM on pod-down. Forward it to sshd, bounded so the
  # container exits within 10 s.
  child=""
  # shellcheck disable=SC2329 # invoked by the TERM trap
  on_term_ssh() {
    trap - TERM
    if [ -n "$child" ]; then
      kill -TERM "$child" 2>/dev/null || true
      for _ in 1 2 3 4 5; do
        kill -0 "$child" 2>/dev/null || break
        sleep 1
      done
      kill -KILL "$child" 2>/dev/null || true
      wait "$child" 2>/dev/null || true
    fi
    exit 0
  }
  trap on_term_ssh TERM

  # -e sends sshd's log to stderr, which is the pod's CloudWatch stream.
  "$sshd_bin" -D -e -f /etc/ssh/cloud-dev-pods/sshd_config &
  child=$!
  status=0
  wait "$child" || status=$?
  exit "$status"
}

if [ "$POD_MODE" = ssh ]; then
  run_ssh
fi

# Account type for the device-code login: auth.tunnel.provider in
# config/config.yaml, or pod-up's tunnel_provider input. Set by pod-manager.
TUNNEL_PROVIDER="${TUNNEL_PROVIDER:-github}"
case "$TUNNEL_PROVIDER" in
  github|microsoft) ;;
  *)
    echo "TUNNEL_PROVIDER must be github or microsoft (got \"${TUNNEL_PROVIDER}\")" >&2
    exit 64
    ;;
esac

# `code` is /opt/vscode-cli/code (on PATH via the Dockerfile). `user show`
# exits non-zero when no login is stored. The login prints the device-code
# prompt that scripts/tunnel-poll-logs.ts picks out of CloudWatch Logs.
if ! code tunnel user show >/dev/null 2>&1; then
  code tunnel user login --provider "$TUNNEL_PROVIDER"
fi

# ECS sends SIGTERM on pod-down. Stop the tunnel, then unregister it so the
# account's slot is freed now rather than at the 30-day inactivity expiry
# (an account may register 10 tunnels; an 11th evicts a random unused one).
# Unregister runs after the tunnel exits so the running CLI can't re-create
# it. Both steps are bounded (5 s + 22 s) to fit the container's 30 s stopTimeout.
child=""
# shellcheck disable=SC2329 # invoked by the TERM trap
on_term() {
  trap - TERM
  if [ -n "$child" ]; then
    kill -TERM "$child" 2>/dev/null || true
    for _ in 1 2 3 4 5; do
      kill -0 "$child" 2>/dev/null || break
      sleep 1
    done
    kill -KILL "$child" 2>/dev/null || true
    wait "$child" 2>/dev/null || true
  fi
  # Best-effort: log the exit code (CloudWatch is the only evidence unregister
  # ran) but exit 0 regardless.
  echo "on_term: unregistering tunnel ${POD_NAME}"
  local rc=0
  timeout -k 2 20 code tunnel unregister || rc=$?
  echo "on_term: code tunnel unregister exited ${rc}"
  exit 0
}
trap on_term TERM

code tunnel --accept-server-license-terms --name "$POD_NAME" &
child=$!
status=0
wait "$child" || status=$?
exit "$status"
