import { describe, expect, it } from 'vitest';
import { fnv1a, priorityForPod } from '../lambda/pod-manager/priority';

describe('fnv1a', () => {
  it('is deterministic', () => {
    expect(fnv1a('abc')).toBe(fnv1a('abc'));
  });

  it('produces different hashes for different inputs', () => {
    expect(fnv1a('abc')).not.toBe(fnv1a('abd'));
  });

  it('matches reference values for known seeds', () => {
    // fnv1a known test vectors.
    expect(fnv1a('')).toBe(0x811c9dc5);
    expect(fnv1a('a')).toBe(0xe40c292c);
    expect(fnv1a('foobar')).toBe(0xbf9cf968);
  });
});

describe('priorityForPod', () => {
  it('returns a value in [1000, 50000)', () => {
    for (const name of ['a', 'foo', 'chris-api', 'a-very-long-pod-name-x']) {
      const p = priorityForPod(name);
      expect(p).toBeGreaterThanOrEqual(1000);
      expect(p).toBeLessThan(50_000);
    }
  });

  it('is deterministic per pod name', () => {
    expect(priorityForPod('chris-api')).toBe(priorityForPod('chris-api'));
  });
});
