# Tunnel-mode pod runtime: VS Code CLI dialing out to Microsoft's tunnel broker.
# No inbound port; auth via device-code flow surfaced through CloudWatch Logs.

FROM ubuntu:24.10

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get upgrade -y --no-install-recommends \
 && apt-get install -y --no-install-recommends \
      curl ca-certificates tar git bash sudo \
      python3 nodejs npm \
      procps \
 && rm -rf /var/lib/apt/lists/*

RUN useradd -ms /bin/bash vscode \
 && echo 'vscode ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/vscode \
 && chmod 0440 /etc/sudoers.d/vscode \
 && mkdir -p /opt/vscode-cli \
 && curl -fSL 'https://code.visualstudio.com/sha/download?build=stable&os=cli-alpine-x64' \
      -o /tmp/vscode_cli.tar.gz \
 && tar -xf /tmp/vscode_cli.tar.gz -C /opt/vscode-cli \
 && rm /tmp/vscode_cli.tar.gz \
 && chown -R vscode:vscode /opt/vscode-cli

# Entrypoint: COPY before USER switch so it lands as root-owned in /usr/local/bin/.
COPY entrypoint.sh /usr/local/bin/cloud-dev-pods-entrypoint
RUN chmod +x /usr/local/bin/cloud-dev-pods-entrypoint

LABEL org.opencontainers.image.source="https://github.com/foolswithtools/cloud-dev-pods"
LABEL org.opencontainers.image.description="VS Code (remote tunnel) cloud-dev-pods runtime image"
LABEL org.opencontainers.image.licenses="Apache-2.0"

USER vscode
WORKDIR /workspace

# Tunnel mode has no inbound port. Healthcheck just verifies the agent is alive.
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 \
  CMD pgrep -x code >/dev/null || exit 1

ENTRYPOINT ["/usr/local/bin/cloud-dev-pods-entrypoint"]
