# Phase 5: openvscode-server-based browser IDE image.
# Final image will FROM gitpod/openvscode-server:<digest-pinned> and add
# language runtimes (Node 20, Python 3, etc.), git, curl, build-essential.
# Entrypoint binds 127.0.0.1:3000 with --without-connection-token; oauth2-proxy
# sidecar (port 4180) handles auth and forwards to localhost:3000.

FROM gitpod/openvscode-server:1.96.0

USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git curl ca-certificates build-essential python3 python3-pip \
 && rm -rf /var/lib/apt/lists/*

USER openvscode-server
WORKDIR /workspace

COPY settings/default-settings.json /home/.openvscode-server/data/Machine/settings.json
COPY entrypoint.sh /usr/local/bin/cloud-dev-pods-entrypoint
ENTRYPOINT ["/usr/local/bin/cloud-dev-pods-entrypoint"]
