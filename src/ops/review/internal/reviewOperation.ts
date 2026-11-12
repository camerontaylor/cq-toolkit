// Mirrors policy/review-operation.schema.json; shared vectors pin parity.
import { z } from 'zod';
import { createHash } from 'node:crypto';
// Match the contract's quartet/padding grammar without recursive regex groups:
// V8 exhausts its regex stack on valid snapshot-sized strings with that pattern.
const Base64Schema = z.string().refine((value) => {
  if (value.length % 4 !== 0) return false;
  let end = value.length;
  if (value[end - 1] === '=') end--;
  if (value[end - 1] === '=') end--;
  return !/[^A-Za-z0-9+/]/.test(value.slice(0, end));
}, 'invalid base64');
const RequestIdSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/);
const SlotSchema = z.string().regex(new RegExp('^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'));
const CommitSchema = z.string().regex(new RegExp('^[0-9a-f]{40}$'));
const DigestSchema = z.string().regex(new RegExp('^[0-9a-f]{64}$'));
const ObservedSchema = z
  .object({
    ancestor: z.boolean(),
    commits_ahead: z.number().int().min(0).nullable().optional(),
  })
  .strict();
export const IdentitySchema = z
  .object({
    v: z.literal(1),
    repo: z.string().regex(new RegExp('^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$')),
    base_commit: z.string().regex(new RegExp('^[0-9a-f]{40}$')),
    base_tree: z.string().regex(new RegExp('^[0-9a-f]{40}$')),
    head_commit: z.string().regex(new RegExp('^[0-9a-f]{40}$')),
    head_tree: z.string().regex(new RegExp('^[0-9a-f]{40}$')),
    scope: z.literal('full-diff'),
    projection: z.string().min(1),
    config_digest: z.string().regex(new RegExp('^[0-9a-f]{64}$')),
    profile: z
      .object({ adapter: z.literal('coderabbit-cli'), revision: z.string().min(1) })
      .strict(),
  })
  .strict();
export const SubmitInputsSchema = z
  .object({
    repo: z.string().regex(new RegExp('^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$')),
    base_commit: z.string().regex(new RegExp('^[0-9a-f]{40}$')),
    base_tree: z.string().regex(new RegExp('^[0-9a-f]{40}$')),
    head_commit: z.string().regex(new RegExp('^[0-9a-f]{40}$')),
    head_tree: z.string().regex(new RegExp('^[0-9a-f]{40}$')),
    projection: z.string().min(1),
    target: z.string().min(1),
  })
  .strict();
export const ProfileSchema = z
  .object({
    adapter: z.literal('coderabbit-cli'),
    revision: z.string().min(1),
    flags: z.array(z.string().min(1)),
  })
  .strict();
export const NotifyDestinationSchema = z
  .object({ paseo_agent_id: z.string(), paseo_host: z.string().nullable() })
  .strict();
const NotifyStateSchema = z
  .object({
    state: z.enum(['pending', 'sent', 'error', 'withdrawn', 'not-required']),
    reason: z.string().min(1).optional(),
  })
  .strict();
const HistoryCueSchema = z
  .object({
    v: z.literal(1),
    digest: DigestSchema,
    status: z.enum(['ok', 'degraded']),
    cue: z.string().min(1).optional(),
    reason: z.string().min(1).optional(),
  })
  .strict();
const HistoryEntryDeltaSchema = z
  .object({
    method: z.literal('tree'),
    files: z.number().int().min(0).nullable(),
    insertions: z.number().int().min(0).nullable(),
    deletions: z.number().int().min(0).nullable(),
    binary_files: z.number().int().min(0).nullable(),
    partial: z.boolean(),
  })
  .strict();
const HistoryDeltaSchema = HistoryEntryDeltaSchema.extend({
  commits_ahead: z.number().int().min(0).nullable(),
  ancestry: z.enum(['server', 'client']).nullable(),
}).strict();
const HistorySummarySchema = z
  .object({
    requests: z.number().int().min(0),
    invocations: z.number().int().min(0),
    completed: z.number().int().min(0),
    failed: z.number().int().min(0),
  })
  .strict();
const HistoryPredecessorSchema = z
  .object({
    request_id: RequestIdSchema.nullable(),
    item: z.string().min(1),
    generation: z.number().int().min(1),
    state: z.string().min(1),
    created_at: z.string().nullable(),
    head_commit: CommitSchema,
    head_tree: CommitSchema,
    same_task: z.boolean(),
    same_branch: z.boolean(),
    relationship: z.enum(['ancestral', 'possible', 'unrelated']),
    ancestry: z.enum(['server', 'client']).nullable(),
    commits_ahead: z.number().int().min(0).nullable(),
  })
  .strict();
const HistoryEntrySchema = z
  .object({
    item: z.string().min(1),
    request_id: RequestIdSchema.nullable(),
    generation: z.number().int().min(1),
    state: z.string().min(1),
    created_at: z.string().nullable(),
    head_commit: CommitSchema,
    head_tree: CommitSchema,
    task: z.string().nullable(),
    branch: z.string().nullable(),
    same_task: z.boolean(),
    same_branch: z.boolean(),
    relationship: z.enum(['ancestral', 'possible', 'unrelated']),
    ancestry: z.enum(['server', 'client']).nullable(),
    commits_ahead: z.number().int().min(0).nullable(),
    delta: HistoryEntryDeltaSchema.nullable(),
  })
  .strict();
export const HistorySchema = z
  .object({
    v: z.literal(1),
    status: z.enum(['ok', 'degraded']),
    reason: z.string().min(1).optional(),
    scope: z.enum(['task', 'branch', 'none']),
    relation: z.enum(['none', 'ancestral', 'possible']),
    repeat: z.boolean(),
    predecessor: HistoryPredecessorSchema.nullable(),
    delta: HistoryDeltaSchema.nullable(),
    summary: HistorySummarySchema.nullable(),
    cue: z.string().nullable(),
    entries: z.array(HistoryEntrySchema).max(50),
    cursor: z.number().int().min(0),
    next_cursor: z.number().int().min(0).nullable(),
    digest: DigestSchema,
  })
  .strict();
export const RequestSchema = z
  .object({
    v: z.literal(1),
    key_digest: z.string().regex(new RegExp('^[0-9a-f]{64}$')),
    identity: z.string().regex(new RegExp('^[0-9a-f]{64}$')),
    item: z.string().min(1),
    created_at: z.string().min(1),
    principal: z.string().min(1).optional(),
    notify_status: NotifyStateSchema.optional(),
    supersedes: z
      .string()
      .min(1)
      .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/)
      .optional(),
    task: z.string().min(1).optional(),
    branch: z.string().min(1).optional(),
    predecessor: RequestIdSchema.optional(),
    observed: ObservedSchema.optional(),
    notify: NotifyDestinationSchema.optional(),
  })
  .strict();
export const WireSchema = z.union([
  z
    .object({
      v: z.literal(1),
      op: z.literal('notify-update'),
      request_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/),
      notify: NotifyDestinationSchema.nullable(),
    })
    .strict(),
  z.object({ v: z.literal(1), op: z.literal('capabilities') }).strict(),
  z
    .object({
      v: z.literal(1),
      op: z.literal('submit'),
      request_id: z
        .string()
        .min(1)
        .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/),
      inputs: z
        .object({
          repo: z.string().regex(new RegExp('^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$')),
          base_commit: z.string().regex(new RegExp('^[0-9a-f]{40}$')),
          base_tree: z.string().regex(new RegExp('^[0-9a-f]{40}$')),
          head_commit: z.string().regex(new RegExp('^[0-9a-f]{40}$')),
          head_tree: z.string().regex(new RegExp('^[0-9a-f]{40}$')),
          projection: z.string().min(1),
          target: z.string().min(1),
        })
        .strict(),
      repeat: z.boolean().optional(),
      snapshot: z
        .object({
          v: z.literal(1),
          tree: z.string().regex(new RegExp('^[0-9a-f]{40}$')),
          objects: z
            .array(
              z
                .object({
                  oid: z.string().regex(new RegExp('^[0-9a-f]{40}$')),
                  type: z.enum(['blob', 'tree', 'commit']),
                  data: Base64Schema,
                })
                .strict(),
            )
            .min(1)
            .max(4096),
          sha256: z.string().regex(new RegExp('^[0-9a-f]{64}$')),
        })
        .strict()
        .optional(),
      notify: NotifyDestinationSchema.optional(),
      supersedes: z
        .string()
        .min(1)
        .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/)
        .optional(),
      task: z.string().min(1).optional(),
      branch: z.string().min(1).optional(),
      predecessor: RequestIdSchema.optional(),
      observed: ObservedSchema.optional(),
    })
    .strict(),
  z
    .object({
      v: z.literal(1),
      op: z.literal('status'),
      request_id: z
        .string()
        .min(1)
        .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/),
    })
    .strict(),
  z
    .object({
      v: z.literal(1),
      op: z.literal('result'),
      request_id: z
        .string()
        .min(1)
        .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/),
      index: z.number().int().min(0).optional(),
    })
    .strict(),
  z
    .object({
      v: z.literal(1),
      op: z.literal('cancel'),
      request_id: z
        .string()
        .min(1)
        .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/),
    })
    .strict(),
  z
    .object({
      v: z.literal(1),
      op: z.literal('review-history'),
      request_id: RequestIdSchema.optional(),
      repo: SlotSchema.optional(),
      target: z.string().min(1).optional(),
      base_commit: CommitSchema.optional(),
      base_tree: CommitSchema.optional(),
      head_commit: CommitSchema.optional(),
      head_tree: CommitSchema.optional(),
      task: z.string().min(1).optional(),
      branch: z.string().min(1).optional(),
      predecessor: RequestIdSchema.optional(),
      observed: ObservedSchema.optional(),
      limit: z.number().int().min(1),
      cursor: z.number().int().min(0),
    })
    .strict(),
]);
export const ResponseSchema = z.union([
  z
    .object({
      v: z.literal(1),
      request_id: z
        .string()
        .min(1)
        .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/)
        .optional(),
      notify: NotifyStateSchema.optional(),
      action: z.enum(['created', 'joined', 'reused', 'observed', 'no-changes']),
      state: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled', 'unsupported']),
      identity: z.string().regex(new RegExp('^[0-9a-f]{64}$')).optional(),
      item: z.string().min(1).optional(),
      generation: z.number().int().min(1).optional(),
      receipt_id: z.string().regex(new RegExp('^[0-9a-f]{64}$')).optional(),
      next_action: z.enum(['resubmit']).optional(),
      reason: z.string().min(1).optional(),
      history: HistoryCueSchema.optional(),
    })
    .strict(),
  HistorySchema,
  z
    .object({
      v: z.literal(1),
      command: z.literal('review-v1'),
      operations: z.array(
        z.enum([
          'capabilities',
          'submit',
          'status',
          'result',
          'cancel',
          'notify-update',
          'review-history',
        ]),
      ),
      features: z.array(
        z.enum([
          'original-commit-snapshot-v1',
          'chunked-result-v1',
          'repeat-generations-v1',
          'review-history-v1',
        ]),
      ),
      limits: z
        .object({
          max_request_bytes: z.literal(6291456),
          max_snapshot_bytes: z.literal(5242880),
          max_content_bytes: z.literal(3145728),
          max_objects: z.literal(4096),
          chunk_bytes: z.literal(3072),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      v: z.literal(1),
      receipt_id: z.string().regex(new RegExp('^[0-9a-f]{64}$')),
      index: z.number().int().min(0),
      chunks: z.number().int().min(1),
      bytes: z.number().int().min(0),
      sha256: z.string().regex(new RegExp('^[0-9a-f]{64}$')),
      encoding: z.literal('base64-utf8-json'),
      data: Base64Schema,
      chunk_sha256: z.string().regex(new RegExp('^[0-9a-f]{64}$')),
      next_index: z.union([z.number().int().min(0), z.null()]),
    })
    .strict(),
  z
    .object({
      v: z.literal(1),
      error: z
        .object({ code: z.string().min(1), message: z.string().min(1), retryable: z.boolean() })
        .strict(),
    })
    .strict(),
]);
export const ReceiptSchema = z
  .object({
    v: z.literal(1),
    kind: z.literal('local-review-full-diff'),
    identity: z.string().regex(new RegExp('^[0-9a-f]{64}$')),
    identity_inputs: z
      .object({
        v: z.literal(1),
        repo: z.string().regex(new RegExp('^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$')),
        base_commit: z.string().regex(new RegExp('^[0-9a-f]{40}$')),
        base_tree: z.string().regex(new RegExp('^[0-9a-f]{40}$')),
        head_commit: z.string().regex(new RegExp('^[0-9a-f]{40}$')),
        head_tree: z.string().regex(new RegExp('^[0-9a-f]{40}$')),
        scope: z.literal('full-diff'),
        projection: z.string().min(1),
        config_digest: z.string().regex(new RegExp('^[0-9a-f]{64}$')),
        profile: z
          .object({ adapter: z.literal('coderabbit-cli'), revision: z.string().min(1) })
          .strict(),
      })
      .strict(),
    profile: z
      .object({
        adapter: z.literal('coderabbit-cli'),
        revision: z.string().min(1),
        flags: z.array(z.string().min(1)),
      })
      .strict(),
    run_id: z.string().min(1),
    outcome: z.enum(['clean', 'findings', 'no-verdict', 'unknown']),
    scope_adequate: z.boolean(),
    findings: z.array(z.record(z.string(), z.unknown())),
    report: z.string(),
    observed: z.record(z.string(), z.unknown()),
    independent_acceptance: z.literal(false),
  })
  .strict();
export const OutboxSchema = z
  .object({
    v: z.literal(1),
    request_id: z
      .string()
      .min(1)
      .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/),
    event_id: z.string().min(1),
    destination: z
      .object({ paseo_agent_id: z.string().min(1), paseo_host: z.string().min(1) })
      .strict(),
    state: z.enum(['pending', 'sent', 'error']),
    receipt_id: z.string().regex(new RegExp('^[0-9a-f]{64}$')).optional(),
  })
  .strict();
export const SnapshotSchema = z
  .object({
    v: z.literal(1),
    tree: z.string().regex(new RegExp('^[0-9a-f]{40}$')),
    objects: z
      .array(
        z
          .object({
            oid: z.string().regex(new RegExp('^[0-9a-f]{40}$')),
            type: z.enum(['blob', 'tree', 'commit']),
            data: Base64Schema,
          })
          .strict(),
      )
      .min(1)
      .max(4096),
    sha256: z.string().regex(new RegExp('^[0-9a-f]{64}$')),
  })
  .strict();
export const ReviewOperationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('identity'), value: IdentitySchema }).strict(),
  z.object({ type: z.literal('submit_inputs'), value: SubmitInputsSchema }).strict(),
  z.object({ type: z.literal('profile'), value: ProfileSchema }).strict(),
  z.object({ type: z.literal('request'), value: RequestSchema }).strict(),
  z.object({ type: z.literal('wire'), value: WireSchema }).strict(),
  z.object({ type: z.literal('response'), value: ResponseSchema }).strict(),
  z.object({ type: z.literal('history'), value: HistorySchema }).strict(),
  z.object({ type: z.literal('receipt'), value: ReceiptSchema }).strict(),
  z.object({ type: z.literal('outbox'), value: OutboxSchema }).strict(),
  z.object({ type: z.literal('snapshot'), value: SnapshotSchema }).strict(),
]);
export function canonicalReview(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalReview).join(',') + ']';
  if (value !== null && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .filter(([, val]) => val !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, val]) => canonicalReview(key) + ':' + canonicalReview(val))
        .join(',') +
      '}'
    );
  // JSON.stringify omits undefined entries (handled above) but returns
  // undefined for an unserializable value; fail explicitly instead of
  // throwing an opaque TypeError from .replace.
  const json: string | undefined = JSON.stringify(value);
  if (json === undefined) throw new TypeError('canonicalReview: unserializable value');
  return json.replace(
    /[\u007f-\uffff]/g,
    (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'),
  );
}
export function reviewDigest(value: unknown): string {
  return createHash('sha256').update(canonicalReview(value)).digest('hex');
}

// Local operation inputs; these fields never expand the wire contract.
export const ReferenceSchema = z
  .object({
    requestId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/),
    cwd: z.string().default('.'),
  })
  .strict();
export const StatusInputSchema = ReferenceSchema.extend({
  notify: NotifyDestinationSchema.nullable().optional(),
});
export const WaitInputSchema = ReferenceSchema.extend({
  waitMs: z.number().int().nonnegative().default(600000),
});
export const SubmitInputSchema = z
  .object({
    cwd: z.string().default('.'),
    repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    target: z.string().min(1),
    base: z.string().min(1).optional(),
    /** Immutable object to submit instead of the checkout HEAD (synthetic snapshots). */
    head: z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .optional(),
    projection: z
      .enum(['full-diff', 'working-tree-full-v1', 'working-tree-uncommitted-v1'])
      .default('full-diff'),
    requestId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/)
      .optional(),
    notify: NotifyDestinationSchema.optional(),
    reachable: z.boolean().default(false),
    scanner: z.string().optional(),
    repeat: z.boolean().optional(),
    supersedes: z
      .string()
      .min(1)
      .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/)
      .optional(),
    task: z.string().min(1).optional(),
    branch: z.string().min(1).optional(),
    predecessor: z
      .string()
      .min(1)
      .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/)
      .optional(),
    observed: ObservedSchema.optional(),
    waitMs: z.number().int().nonnegative().optional(),
  })
  .strict();
export const HistoryInputSchema = z
  .object({
    cwd: z.string().default('.'),
    repo: SlotSchema,
    target: z.string().min(1),
    requestId: RequestIdSchema.optional(),
    base: z.string().min(1).optional(),
    head: CommitSchema.optional(),
    task: z.string().min(1).optional(),
    branch: z.string().min(1).optional(),
    predecessor: RequestIdSchema.optional(),
    limit: z.number().int().min(1).max(50).default(20),
    cursor: z.number().int().min(0).default(0),
  })
  .strict();
