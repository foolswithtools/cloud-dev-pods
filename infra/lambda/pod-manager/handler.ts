// Pod manager Lambda. Phase 7a: scaffolding only — every action returns
// `{ ok: false, status: 'not-implemented' }`. Phase 7b implements the bodies.
//
// Sole holder of ECS/ALB/EFS/DDB write permissions. The GitHub Actions
// PodOpsRole holds only `lambda:InvokeFunction` on this function (see ADR 0003).

import { z } from 'zod';

const PodEventSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('up'),
    podName: z.string().regex(/^[a-z0-9-]{1,30}$/),
    mode: z.enum(['browser', 'tunnel']),
    cpu: z.number().int().optional(),
    memory: z.number().int().optional(),
    imageTag: z.string().optional(),
    idleMinutes: z.number().int().optional(),
    owner: z.string().optional(),
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
  podName?: string;
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

  switch (event.action) {
    case 'up':
      return notImplemented('up', { podName: event.podName });
    case 'down':
      return notImplemented('down', { podName: event.podName });
    case 'list':
      return notImplemented('list', {});
    case 'status':
      return notImplemented('status', { podName: event.podName });
  }
};

function notImplemented(action: string, extras: Partial<PodResult>): PodResult {
  return {
    ok: false,
    status: 'not-implemented',
    message: `Action "${action}" is implemented in Phase 7b.`,
    ...extras,
  };
}
