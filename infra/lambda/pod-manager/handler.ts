// Pod manager Lambda — entry point and dispatch.
// Sole holder of ECS/ALB/EFS/DDB write permissions per ADR 0003.

import { z } from 'zod';
import { podDown, podList, podStatus, podUp } from './actions';

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
