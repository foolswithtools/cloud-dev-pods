import { describe, expect, it } from 'vitest';
import { extractDeviceCode, FILTER_PATTERN, parseArgs, tunnelLogStreamName } from './tunnel-poll-logs.js';

// Verbatim prompt lines printed by VS Code CLI 1.143.0
// (`code tunnel user login --provider <p>`), as quoted in tunnel-poll-logs.ts.
// That is the version pinned in runtime/vscode-tunnel/Dockerfile; re-capture these lines in
// the same PR whenever the pin moves.
const GITHUB_LINE =
  'To grant access to the server, please log into https://github.com/login/device and use code CC3A-5101';
const MICROSOFT_LINE =
  'To sign in, use a web browser to open the page https://login.microsoft.com/device and enter the code FHLARZB9J to authenticate.';

describe('extractDeviceCode', () => {
  it('extracts URL and code from the GitHub prompt', () => {
    expect(extractDeviceCode(GITHUB_LINE)).toEqual({
      url: 'https://github.com/login/device',
      code: 'CC3A-5101',
    });
  });

  it('extracts URL and code from the Microsoft prompt', () => {
    expect(extractDeviceCode(MICROSOFT_LINE)).toEqual({
      url: 'https://login.microsoft.com/device',
      code: 'FHLARZB9J',
    });
  });

  it('extracts from the older microsoft.com/devicelogin wording', () => {
    expect(
      extractDeviceCode('Please open https://microsoft.com/devicelogin and enter the code ABCD1234'),
    ).toEqual({ url: 'https://microsoft.com/devicelogin', code: 'ABCD1234' });
  });

  it('extracts from a log line carrying a timestamp prefix', () => {
    expect(extractDeviceCode(`[2026-10-22 11:11:49] info ${GITHUB_LINE}`)?.code).toBe('CC3A-5101');
  });

  it('returns undefined for unrelated lines', () => {
    expect(extractDeviceCode('Using GitHub for authentication, run `code tunnel user login --provider <provider>` option to change this.')).toBeUndefined();
    expect(extractDeviceCode('Open this link in your browser https://vscode.dev/tunnel/hello')).toBeUndefined();
  });
});

describe('FILTER_PATTERN', () => {
  // CloudWatch "?term" alternatives are plain substring matches; every
  // prompt URL must appear as one of them or the event is never fetched.
  const terms = [...FILTER_PATTERN.matchAll(/\?"([^"]+)"/g)].map((m) => m[1]!);

  it.each([GITHUB_LINE, MICROSOFT_LINE])('selects %s', (line) => {
    expect(terms.some((t) => line.includes(t))).toBe(true);
  });
});

describe('tunnelLogStreamName', () => {
  // awslogs names streams <prefix>/<container>/<task-id>; pod-manager sets the
  // prefix to tunnel/<pod>/vscode-tunnel and the container is vscode-tunnel.
  it('builds the exact stream for one task', () => {
    expect(
      tunnelLogStreamName('t1', 'arn:aws:ecs:us-west-2:123456789012:task/cloud-dev-pods/0123456789abcdef0123456789abcdef'),
    ).toBe('tunnel/t1/vscode-tunnel/vscode-tunnel/0123456789abcdef0123456789abcdef');
  });

  it('rejects a value that is not an ECS task ARN', () => {
    expect(() => tunnelLogStreamName('t1', 'not-an-arn')).toThrow();
    expect(() => tunnelLogStreamName('t1', '')).toThrow();
  });
});

describe('parseArgs', () => {
  it('reads the exact stream of the given task', () => {
    const arn = 'arn:aws:ecs:us-west-2:123456789012:task/cloud-dev-pods/0123456789abcdef0123456789abcdef';
    expect(parseArgs(['--log-group', 'g', '--pod', 't1', '--task-arn', arn])).toEqual({
      logGroup: 'g',
      logStream: 'tunnel/t1/vscode-tunnel/vscode-tunnel/0123456789abcdef0123456789abcdef',
      timeoutSeconds: 180,
    });
  });

  it('requires the task ARN', () => {
    expect(() => parseArgs(['--log-group', 'g', '--pod', 't1'])).toThrow(/--task-arn/);
  });

  it('no longer accepts a stream prefix', () => {
    // A prefix matches streams any task could have written; only an exact
    // stream is trusted.
    expect(() => parseArgs(['--log-group', 'g', '--stream-prefix', 'tunnel/t1/'])).toThrow(/--task-arn/);
  });
});
