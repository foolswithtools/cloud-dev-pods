import { describe, expect, it } from 'vitest';
import { extractDeviceCode, FILTER_PATTERN } from './tunnel-poll-logs.js';

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
