// Tunnel CLI pin (issue #158): the tunnel image downloads one specific VS Code
// CLI build, verified by SHA-256, so the device-code prompt the log poller
// matches cannot change underneath it between image builds.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../..');
const read = (p: string): string => readFileSync(resolve(ROOT, p), 'utf8');

const DOCKERFILE = read('runtime/vscode-tunnel/Dockerfile');

function arg(name: string): string | undefined {
  return new RegExp(`^ARG ${name}=(\\S+)$`, 'm').exec(DOCKERFILE)?.[1];
}

describe('tunnel image VS Code CLI pin', () => {
  it('pins the CLI to a full commit SHA', () => {
    expect(arg('VSCODE_CLI_COMMIT')).toMatch(/^[0-9a-f]{40}$/);
  });

  it('downloads a commit-specific build, not the moving stable channel', () => {
    expect(DOCKERFILE).toContain(
      'https://update.code.visualstudio.com/commit:${VSCODE_CLI_COMMIT}/cli-alpine-x64/stable',
    );
    expect(DOCKERFILE).not.toContain('build=stable');
    expect(DOCKERFILE).not.toContain('code.visualstudio.com/sha/download');
  });

  it('verifies the archive against a pinned SHA-256', () => {
    expect(arg('VSCODE_CLI_SHA256')).toMatch(/^[0-9a-f]{64}$/);
    expect(DOCKERFILE).toMatch(
      /echo "\$\{VSCODE_CLI_SHA256\}  \/tmp\/vscode_cli\.tar\.gz" \| sha256sum -c -/,
    );
  });

  it('prints and checks the CLI version during the build', () => {
    expect(arg('VSCODE_CLI_VERSION')).toMatch(/^\d+\.\d+\.\d+$/);
    expect(DOCKERFILE).toContain('code --version');
  });

  it('keeps the poller and its test quoting the pinned CLI version', () => {
    const version = arg('VSCODE_CLI_VERSION');
    expect(read('scripts/tunnel-poll-logs.ts')).toContain(`VS Code CLI ${version} prints`);
    expect(read('scripts/tunnel-poll-logs.test.ts')).toContain(`VS Code CLI ${version}`);
  });

  it('records the CLI version in the build-runtime log and summary', () => {
    const workflow = read('.github/workflows/build-runtime.yml');
    expect(workflow).toMatch(/--entrypoint code "\$IMAGE_URI" --version/);
    expect(workflow).toContain('GITHUB_STEP_SUMMARY');
  });
});
