import { z } from 'zod';

/** Queue capability is separate from author-v1/v2 admission and never dispatches. */
export const QueueToken = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/);
export const QueueSha = z.string().regex(/^[0-9a-f]{40}$/);
export const QueueDigest = z.string().regex(/^[0-9a-f]{64}$/);
export const QueueRepo = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/);
export const QueueTarget = z.enum(['promoted-main', 'merge-queue']);
export const DeferredBindingSchema = z
  .object({
    kind: z.literal('deferred-author'),
    repo: QueueRepo,
    producer: QueueToken,
    head: QueueSha,
    target: QueueToken,
    targetSelector: QueueTarget,
  })
  .strict();
export const MergedBindingSchema = z
  .object({
    kind: z.literal('merged-current'),
    repo: QueueRepo,
    pr: z.number().int().positive(),
    mergeSha: QueueSha,
    targetSelector: QueueTarget,
  })
  .strict();
export const QueueBindingSchema = z.discriminatedUnion('kind', [
  DeferredBindingSchema,
  MergedBindingSchema,
]);
export type QueueBinding = z.infer<typeof QueueBindingSchema>;
export type DeferredAuthorBinding = z.infer<typeof DeferredBindingSchema>;
export const QueueReferenceSchema = z
  .object({ requestId: QueueToken, binding: QueueBindingSchema })
  .strict();
export type QueueReference = z.infer<typeof QueueReferenceSchema>;
export const QueueBindSchema = QueueReferenceSchema.extend({
  pr: z.number().int().positive(),
  mergeSha: QueueSha.exactOptional(),
}).strict();
export type QueueBindInput = z.infer<typeof QueueBindSchema>;
export type QueueTransport = (request: string) => Promise<string>;
export const QUEUE_WIRE_BYTES = 8192;
export const QueueStateSchema = z.enum([
  'awaiting-pr',
  'awaiting-merge',
  'ready-current',
  'cancelled',
  'reused',
  'enqueued',
  'pending',
  'reviewing',
  'terminal-with-findings',
  'terminal-clean',
  'no-current-code',
  'partial-scope',
  'blocked',
  'unsupported',
]);
export type QueueState = z.infer<typeof QueueStateSchema>;
export const QueueStatusSchema = z
  .object({
    state: QueueStateSchema,
    pr: z.number().int().positive().nullable(),
    mergeSha: QueueSha.nullable(),
    itemId: z.string().nullable(),
    receiptId: QueueDigest.nullable(),
    consumed: z.boolean(),
    reviewed: z.boolean(),
    fixed: z.literal(false),
  })
  .strict();
export type QueueStatus = z.infer<typeof QueueStatusSchema>;

/** Q6 persists the same immutable producer/head/target binding before publication.
 * bind attaches verified forge metadata; it never changes this binding or renews an author grant.
 */
export interface DeferredQueueClient {
  enqueue(input: QueueReference): Promise<QueueStatus>;
  bind(input: QueueBindInput): Promise<QueueStatus>;
  cancel(input: QueueReference): Promise<QueueStatus>;
  status(input: QueueReference): Promise<QueueStatus>;
}
