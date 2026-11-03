// Pod manager Lambda — entry point and dispatch.
// Sole holder of ECS/ALB/EFS/DDB write permissions per ADR 0003.

import { z } from 'zod';
import { podDown, podList, podStatus, podUp } from './actions';

// One OpenSSH public key line (issue #145). It becomes the SSH_AUTHORIZED_KEYS
// container env var, so no newlines and no spaces beyond the comment separator.
export const SSH_PUBLIC_KEY_RE =
  /^(ssh-ed25519|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|ssh-rsa) [A-Za-z0-9+/]+={0,3}( [\x21-\x7e]{1,100})?$/;

const PodEventSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('up'),
    podName: z.string().regex(/^[a-z0-9-]{1,30}$/),
    mode: z.enum(['browser', 'tunnel', 'ssh']),
    cpu: z.number().int().optional(),
    memory: z.number().int().optional(),
    imageTag: z.string().optional(),
    idleMinutes: z.number().int().optional(),
    // Becomes an ECS tag value and a workflow output, so only the characters
    // ECS tags allow, and no whitespace (a newline could forge outputs).
    owner: z.string().regex(/^[\p{L}\p{N}+\-=._:/@]{1,256}$/u).optional(),
    // Per-pod override of auth.tunnel.provider; ignored for browser pods.
    tunnelProvider: z.enum(['github', 'microsoft']).optional(),
    // Required for ssh pods, rejected for browser and tunnel (checked in podUp).
    sshPublicKey: z.string().max(2048).regex(SSH_PUBLIC_KEY_RE).optional(),
  }),
  z.object({
    action: z.literal('down'),
    podName: z.string().regex(/^[a-z0-9-]{1,30}$/),
    keepWorkspace: z.boolean().optional(),
  }),
  z.object({ action: z.literal('list') }),
  z.object({
    action: z.literal('status'),
    podName: z.string().regex(/^[a-z0-9-]{1,30}$/),
  }),
]);

export type PodEvent = z.infer<typeof PodEventSchema>;

export interface PodResult {
  ok: boolean;
  status: 'ok' | 'invalid-input' | 'not-implemented' | 'conflict' | 'not-found' | 'error';
  message?: string;
  url?: string;
  tunnelName?: string;
  tunnelProvider?: 'github' | 'microsoft';
  // ssh pods: the config remote.backend the pod was launched with.
  remoteBackend?: string;
  podName?: string;
  owner?: string;
  // pod-up: the started task. pod-up.yml reads a tunnel pod's device code
  // from this task's own log stream.
  taskArn?: string;
  // Non-fatal notice for the caller, e.g. the tunnel cap warning.
  warning?: string;
  pods?: Array<Record<string, unknown>>;
}

export const handler = async (rawEvent: unknown): Promise<PodResult> => {
  console.log('pod-manager invoked', JSON.stringify(rawEvent));

  const parsed = PodEventSchema.safeParse(rawEvent);
  if (!parsed.success) {
    return {
      ok: false,
      status: 'invalid-input',
      message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    };
  }

  const event = parsed.data;
  try {
    switch (event.action) {
      case 'up':
        return await podUp(event);
      case 'down':
        return await podDown(event);
      case 'list':
        return await podList();
      case 'status':
        return await podStatus(event);
    }
  } catch (err) {
    console.error('Unhandled error in pod-manager', err);
    return {
      ok: false,
      status: 'error',
      message: (err as Error).message ?? 'unknown error',
    };
  }
};
