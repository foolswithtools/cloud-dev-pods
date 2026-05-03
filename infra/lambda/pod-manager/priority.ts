// FNV-1a 32-bit hash for ALB rule priority assignment.
// Deterministic per podName so the same pod always tries the same priority
// across re-creates (avoids needing a global counter).
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export function priorityForPod(podName: string): number {
  return (fnv1a(podName) % 49000) + 1000;
}
