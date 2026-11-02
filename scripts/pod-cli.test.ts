import { describe, expect, it } from 'vitest';
import { buildEvent, parseArgs } from './pod-cli.js';

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
