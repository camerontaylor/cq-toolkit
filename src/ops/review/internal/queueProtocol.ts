import { z } from 'zod';
import { branchPathFault } from '../../../shared/refname.js';

/** Queue capability is separate from author-v1/v2 admission and never dispatches. */
export const QueueToken = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/);
/**
 * A deferred target is a git BRANCH, not a request token: reuse the shared refname
 * grammar instead of widening QueueToken (which must stay strict for request ids,
 * principals, codes and item ids).
 */
export const QueueBranch = z
  .string()
  .refine((branch) => branchPathFault(branch) === null, 'target must be a git branch refname');
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
    target: QueueBranch,
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
/** One caller budget shared across the entire operation, never renewed per page (#632 contract). */
export interface QueueLifetimeOptions {
  signal?: AbortSignal;
  remainingMs?: () => number;
}
export type QueueTransport = (request: string, options?: QueueLifetimeOptions) => Promise<string>;
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
/** Structured producer classification only; consumers never infer authority from prose. */
export const QueueReasonSchema = z
  .object({
    source: z.enum(['vendor', 'queue']),
    category: z.enum([
      'vendor-unavailable',
      'vendor-rate-limited',
      'vendor-needs-action',
      'scan',
      'identity',
      'persistence',
      'unknown',
    ]),
    code: QueueToken,
  })
  .strict();
export type QueueReason = z.infer<typeof QueueReasonSchema>;
/** Authenticated same-item identity relation; never completion or coverage authority. */
export const QueueRequestAliasSchema = z
  .object({
    v: z.literal(1),
    reference: QueueReferenceSchema,
    originalRequestId: QueueToken,
    itemId: QueueToken,
    source: MergedBindingSchema,
    policy: z.literal('affected-current-additions-v1'),
    receiptId: QueueDigest,
    receiptEquivalence: QueueDigest,
  })
  .strict();
export type QueueRequestAlias = z.infer<typeof QueueRequestAliasSchema>;
export const QueueStatusSchema = z
  .object({
    state: QueueStateSchema,
    pr: z.number().int().positive().nullable(),
    mergeSha: QueueSha.nullable(),
    itemId: z.string().nullable(),
    receiptId: QueueDigest.nullable(),
    consumed: z.boolean(),
    enqueued: z.boolean().exactOptional(),
    reviewed: z.boolean(),
    fixed: z.literal(false),
    reason: QueueReasonSchema.nullable().exactOptional(),
    reusedFrom: z.string().nullable().exactOptional(),
    receiptSource: MergedBindingSchema.nullable().exactOptional(),
    receiptEquivalence: QueueDigest.nullable().exactOptional(),
    requestAlias: QueueRequestAliasSchema.nullable().exactOptional(),
  })
  .strict();
export type QueueStatus = z.infer<typeof QueueStatusSchema>;

/** Q6 persists the same immutable producer/head/target binding before publication.
 * bind attaches verified forge metadata; it never changes this binding or renews an author grant.
 */
export interface DeferredQueueClient {
  enqueue(input: QueueReference, options?: QueueLifetimeOptions): Promise<QueueStatus>;
  bind(input: QueueBindInput, options?: QueueLifetimeOptions): Promise<QueueStatus>;
  cancel(input: QueueReference, options?: QueueLifetimeOptions): Promise<QueueStatus>;
  status(input: QueueReference, options?: QueueLifetimeOptions): Promise<QueueStatus>;
}

/** JSON-valued --binding plus flags only; no positional arguments. */
export const QueueEnqueueInputSchema = QueueReferenceSchema.extend({
  action: z.enum(['enqueue', 'bind', 'cancel']).exactOptional(),
  pr: z.number().int().positive().exactOptional(),
  mergeSha: QueueSha.exactOptional(),
}).strict();
export const QueueReportInputSchema = QueueReferenceSchema.extend({
  evidenceDir: z.string().min(1),
}).strict();
export type QueueEnqueueInput = z.infer<typeof QueueEnqueueInputSchema>;
export type QueueReportInput = z.infer<typeof QueueReportInputSchema>;
