# Tunnel-mode pod runtime: VS Code CLI dialing out to Microsoft's tunnel broker.
# No inbound port; auth via device-code flow surfaced through CloudWatch Logs.

FROM ubuntu:26.04

# The VS Code CLI is pinned to one build: scripts/tunnel-poll-logs.ts matches
# the exact device-code prompt this CLI prints. To move the pin, follow
# "Bumping the tunnel VS Code CLI pin" in docs/maintainer-runbook.md.
ARG VSCODE_CLI_VERSION=1.143.0
ARG VSCODE_CLI_COMMIT=2d0b7506a36c1d6db9a466440131a8e01eab2289
ARG VSCODE_CLI_SHA256=efd89d72d5ef9a24bd0dcc2353df902a92650e8665f856527fc538c18eab23e9

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
 && curl -fSL "https://update.code.visualstudio.com/commit:${VSCODE_CLI_COMMIT}/cli-alpine-x64/stable" \
      -o /tmp/vscode_cli.tar.gz \
 && echo "${VSCODE_CLI_SHA256}  /tmp/vscode_cli.tar.gz" | sha256sum -c - \
 && tar -xf /tmp/vscode_cli.tar.gz -C /opt/vscode-cli \
 && rm /tmp/vscode_cli.tar.gz \
 && /opt/vscode-cli/code --version \
 && /opt/vscode-cli/code --version | grep -Fqx "code ${VSCODE_CLI_VERSION} (commit ${VSCODE_CLI_COMMIT})" \
 && chown -R vscode:vscode /opt/vscode-cli

ENV PATH=/opt/vscode-cli:$PATH

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
