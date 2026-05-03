# Browser-mode pod runtime: openvscode-server bound to localhost; an oauth2-proxy
# sidecar handles auth in the same ECS task. See ADR 0002.

FROM gitpod/openvscode-server:1.105.1

USER root

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git curl ca-certificates build-essential python3 python3-pip \
 && rm -rf /var/lib/apt/lists/*

# Pre-seed VS Code Machine settings (telemetry off, autosave on, etc.).
COPY --chown=openvscode-server:openvscode-server \
     settings/default-settings.json \
     /home/.openvscode-server/data/Machine/settings.json

# Entrypoint: COPY runs as root (Dockerfile-level), so write to /usr/local/bin/.
COPY entrypoint.sh /usr/local/bin/cloud-dev-pods-entrypoint
RUN chmod +x /usr/local/bin/cloud-dev-pods-entrypoint

LABEL org.opencontainers.image.source="https://github.com/foolswithtools/cloud-dev-pods"
LABEL org.opencontainers.image.description="VS Code (browser) cloud-dev-pods runtime image"
LABEL org.opencontainers.image.licenses="Apache-2.0"

USER openvscode-server
WORKDIR /workspace

# 3000 is bound to 127.0.0.1 only (see entrypoint). Probe the local instance.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/ >/dev/null || exit 1

ENTRYPOINT ["/usr/local/bin/cloud-dev-pods-entrypoint"]
