import { z } from 'zod';
import type { Op, OpRegistryEntry } from '../../kernel/types.js';

// review.ts owns the transport adapter; registration performs no I/O.
export const DevReviewInputSchema = z
  .object({
    action: z.enum(['enroll', 'status', 'fallback']),
    requestId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/),
    base: z.string().regex(/^[0-9a-f]{40}$/),
    head: z.string().regex(/^[0-9a-f]{40}$/),
    target: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/),
    cycle: z.number().int().min(1).max(2),
  })
  .strict()
  .refine(
    (i) => [i.requestId, i.base, i.head, i.target].every((v) => v.trim() === v),
    'binding must not contain whitespace or controls',
  )
  .refine((i) => i.base !== i.head, 'base and head must differ');

export type DevReviewInput = z.infer<typeof DevReviewInputSchema>;

export const registry: OpRegistryEntry[] = [
  {
    name: 'dev.review',
    inputSchema: DevReviewInputSchema,
    importer: async () => (await import('./review.js')).default as Op<unknown, unknown>,
  },
];
