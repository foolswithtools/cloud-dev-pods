# Phase 5: VS Code Remote Tunnel agent image.
# Per docs/architecture.md (image 1) and the upstream setup guide §3,
# the standalone VS Code CLI dials out to Microsoft's tunnel broker; no inbound port required.

FROM ubuntu:24.04

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      curl ca-certificates tar git bash sudo python3 nodejs npm \
 && rm -rf /var/lib/apt/lists/*

RUN useradd -ms /bin/bash vscode \
 && mkdir -p /opt/vscode-cli \
 && curl -L 'https://code.visualstudio.com/sha/download?build=stable&os=cli-alpine-x64' \
      -o /tmp/vscode_cli.tar.gz \
 && tar -xf /tmp/vscode_cli.tar.gz -C /opt/vscode-cli \
 && rm /tmp/vscode_cli.tar.gz \
 && chown -R vscode:vscode /opt/vscode-cli

USER vscode
WORKDIR /workspace

COPY entrypoint.sh /usr/local/bin/cloud-dev-pods-entrypoint
ENTRYPOINT ["/usr/local/bin/cloud-dev-pods-entrypoint"]
