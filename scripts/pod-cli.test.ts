import { describe, expect, it } from 'vitest';
import { buildEvent, invokePodManager, parseArgs } from './pod-cli.js';

// Importing pod-cli must not invoke the Lambda: main() only runs when the
// file is executed directly.
describe('pod-cli buildEvent', () => {
  it('builds an ssh up event with sshPublicKey (issue #145)', () => {
    const key = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';
    const { action, flags } = parseArgs(['up', '--pod', 'x', '--mode', 'ssh', '--ssh-public-key', key]);
    const event = buildEvent(action, flags);
    expect(event).toMatchObject({ action: 'up', podName: 'x', mode: 'ssh', sshPublicKey: key });
  });

  it('leaves sshPublicKey undefined when the flag is absent', () => {
    const { action, flags } = parseArgs(['up', '--pod', 'x', '--mode', 'tunnel']);
    expect(buildEvent(action, flags).sshPublicKey).toBeUndefined();
  });
});

// invokePodManager takes an injectable `send`, so these never reach AWS.
describe('pod-cli invokePodManager', () => {
  const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

  it('maps a FunctionError to { ok: false } with the formatted error', async () => {
    const out = await invokePodManager(
      { action: 'list' },
      { send: async () => ({ FunctionError: 'Unhandled', Payload: enc({ errorMessage: 'kaboom' }) }) },
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toBe(`Lambda error (Unhandled):\n${JSON.stringify({ errorMessage: 'kaboom' }, null, 2)}`);
  });

  it('passes an ok:false payload through as { ok: true, payload }', async () => {
    const payload = { ok: false, status: 'error', message: 'boom' };
    const out = await invokePodManager({ action: 'list' }, { send: async () => ({ Payload: enc(payload) }) });
    expect(out).toEqual({ ok: true, payload });
  });

  it('decodes valid JSON to { ok: true, payload } and sends the event to the named function', async () => {
    const payload = { ok: true, status: 'ok', pods: [] };
    const seen: unknown[] = [];
    const out = await invokePodManager(
      { action: 'list' },
      {
        functionName: 'my-fn',
        send: async (input) => {
          seen.push(input);
          return { Payload: enc(payload) };
        },
      },
    );
    expect(out).toEqual({ ok: true, payload });
    expect(seen).toHaveLength(1);
    const input = seen[0] as { FunctionName: string; InvocationType: string; Payload: Uint8Array };
    expect(input.FunctionName).toBe('my-fn');
    expect(input.InvocationType).toBe('RequestResponse');
    expect(JSON.parse(new TextDecoder().decode(input.Payload))).toEqual({ action: 'list' });
  });

  it('maps a thrown SDK error to { ok: false } with its message', async () => {
    const out = await invokePodManager(
      { action: 'list' },
      {
        send: async () => {
          throw new Error('Function not found: pod-manager');
        },
      },
    );
    expect(out).toEqual({ ok: false, error: 'Function not found: pod-manager' });
  });

  it('keeps a non-JSON payload as the raw string', async () => {
    const out = await invokePodManager(
      { action: 'list' },
      { send: async () => ({ Payload: new TextEncoder().encode('not json') }) },
    );
    expect(out).toEqual({ ok: true, payload: 'not json' });
  });
});
