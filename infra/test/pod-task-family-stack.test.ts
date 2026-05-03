import { describe, it } from 'vitest';

describe('PodTaskFamilyStack', () => {
  it.todo('registers cloud-dev-pods-browser family with vscode + oauth2-proxy containers');
  it.todo('registers cloud-dev-pods-tunnel family with single vscode-tunnel container');
  it.todo('mounts EFS at /workspace via per-pod access point');
  it.todo('injects oauth secrets via secrets: not environment:');
});
