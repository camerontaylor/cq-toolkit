import { z } from 'zod';
import {
  isComplete,
  openBlocking,
  type FindingsRecord,
  type ReviewSource,
} from '../../review/findings.js';
import {
  QueueSha,
  QueueToken,
  QueueReferenceSchema,
  QueueStatusSchema,
  type DeferredQueueClient,
  type QueueReference,
  type QueueStatus,
} from '../../review/internal/queueProtocol.js';

/** A classified vendor failure, never a classification inferred from free text. */
export type VendorFailure =
  | 'unavailable'
  | 'rate-limited'
  | 'login-required'
  | 'scan'
  | 'tamper'
  | 'identity'
  | 'substantive'
  | 'unknown';

export const VendorFailureProvenanceSchema = z
  .object({
    source: z.literal('vendor'),
    category: z.enum(['vendor-unavailable', 'vendor-rate-limited', 'vendor-needs-action']),
    codes: z.array(QueueToken).min(1),
  })
  .strict();
export type VendorFailureProvenance = z.infer<typeof VendorFailureProvenanceSchema>;

/** Recognized structured codes only; mixed/unknown causes fail closed. */
export function classifyDeferredVendorFailure(input: {
  origin: 'vendor-cli' | 'queue';
  codes: readonly string[];
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  budgetStopped: boolean;
  malformed: boolean;
  actionRequired: boolean;
  skipped: boolean;
}): VendorFailureProvenance | undefined {
  if (
    input.origin !== 'vendor-cli' ||
    input.exitCode === null ||
    input.timedOut ||
    input.cancelled ||
    input.budgetStopped ||
    input.malformed ||
    input.actionRequired ||
    input.skipped ||
    !input.codes.length
  )
    return undefined;
  const categories = input.codes.map((code) => {
    if (code === 'con_err') return 'vendor-unavailable';
    if (code === 'rate_limited') return 'vendor-rate-limited';
    if (code === 'auth') return 'vendor-needs-action';
    return undefined;
  });
  if (categories.some((category) => category === undefined)) return undefined;
  // A mixed vendor-only failure stays operational debt; the action-needed cause is visible.
  return VendorFailureProvenanceSchema.parse({
    source: 'vendor',
    category: categories.includes('vendor-needs-action')
      ? 'vendor-needs-action'
      : categories.includes('vendor-rate-limited')
        ? 'vendor-rate-limited'
        : 'vendor-unavailable',
    codes: [...input.codes],
  });
}

export const DeferredVendorDebtSchema = z
  .object({
    reference: QueueReferenceSchema.refine((ref) => ref.binding.kind === 'deferred-author'),
    queue: QueueStatusSchema,
    vendor: z.enum(['vendor-pending', 'vendor-blocked-transient', 'vendor-needs-action']),
    /** Independent acceptance and required CI are separate evidence. */
    vendorCompleted: z.literal(false),
    attempt: z
      .object({ cycleId: QueueToken, base: QueueSha, dirtySha256: z.literal('clean-tree') })
      .strict(),
  })
  .strict();
export type DeferredVendorDebt = z.infer<typeof DeferredVendorDebtSchema>;

/** A server-proven vendor outage is debt; queue/unknown failures are blockers. */
function continuableQueue(queue: QueueStatus): boolean {
  const vendorReason =
    queue.reason?.source === 'vendor' &&
    ['vendor-unavailable', 'vendor-rate-limited', 'vendor-needs-action'].includes(
      queue.reason.category,
    );
  if (queue.reason && !vendorReason) return false;
  if (queue.state === 'blocked') return queue.enqueued === true && vendorReason;
  return [
    'awaiting-pr',
    'awaiting-merge',
    'ready-current',
    'enqueued',
    'pending',
    'reviewing',
  ].includes(queue.state);
}

/** Persist before returning permission to proceed. Lost replies replay the SAME request. */
export async function deferVendorReview(
  client: DeferredQueueClient,
  reference: QueueReference,
  failure: VendorFailure,
  attempt: DeferredVendorDebt['attempt'],
): Promise<DeferredVendorDebt> {
  if (failure !== 'unavailable' && failure !== 'rate-limited' && failure !== 'login-required') {
    throw new Error(`vendor failure remains blocking: ${failure}`);
  }
  const ref = QueueReferenceSchema.parse(reference);
  if (ref.binding.kind !== 'deferred-author') throw new Error('deferred author binding required');
  const pin = DeferredVendorDebtSchema.shape.attempt.parse(attempt);
  const queue = QueueStatusSchema.parse(await client.enqueue(ref));
  if (!continuableQueue(queue)) {
    throw new Error(`queue enrollment does not establish deferred debt: ${queue.state}`);
  }
  return {
    reference: ref,
    queue,
    vendor: failure === 'login-required' ? 'vendor-needs-action' : 'vendor-blocked-transient',
    vendorCompleted: false,
    attempt: pin,
  };
}

/** Publication can be replayed after a crash. The server verifies forge identity. */
export async function bindDeferredPublication(
  client: DeferredQueueClient,
  debt: DeferredVendorDebt,
  pr: number,
): Promise<DeferredVendorDebt> {
  const reference = QueueReferenceSchema.parse(debt.reference);
  const queue = QueueStatusSchema.parse(await client.bind({ ...reference, pr }));
  if (queue.pr !== pr || !continuableQueue(queue)) {
    throw new Error('publication binding failed; retain and reconcile the original debt');
  }
  return { ...debt, reference, queue };
}

/** Author-tier readiness exception only; this grants no independent acceptance. */
export function matchesDeferredVendorDebt(
  debt: DeferredVendorDebt,
  identity: {
    repo: string;
    producer: string;
    head: string;
    target: string;
    cycleId: string;
    base: string;
    dirtySha256: string;
  },
): boolean {
  const parsed = DeferredVendorDebtSchema.safeParse(debt);
  if (!parsed.success) return false;
  const binding = parsed.data.reference.binding;
  return (
    binding.kind === 'deferred-author' &&
    binding.repo === identity.repo &&
    binding.producer === identity.producer &&
    binding.head === identity.head &&
    binding.target === identity.target &&
    parsed.data.attempt.cycleId === identity.cycleId &&
    parsed.data.attempt.base === identity.base &&
    parsed.data.attempt.dirtySha256 === identity.dirtySha256 &&
    continuableQueue(parsed.data.queue) &&
    debt.vendorCompleted === false
  );
}

export type DeferredReviewIdentity = Parameters<typeof matchesDeferredVendorDebt>[1];

/** Source coverage for the fix loop, never a declaration that findings are clean. */
export function hasDeferredReviewSources(
  record: FindingsRecord,
  configured: readonly ReviewSource['kind'][],
  debt: DeferredVendorDebt,
  identity: DeferredReviewIdentity,
): boolean {
  if (
    !matchesDeferredVendorDebt(debt, identity) ||
    record.head !== identity.head ||
    record.reviewed?.base !== identity.base ||
    record.reviewed.scope !== 'full' ||
    !configured.includes('agent') ||
    !configured.includes('coderabbit')
  )
    return false;
  const blockedVendor = record.sources.filter(
    (source) => source.kind === 'coderabbit' && source.status === 'blocked',
  );
  if (!blockedVendor.length || blockedVendor.some((source) => source.cycleId !== identity.cycleId))
    return false;
  const remaining = configured.filter((kind) => kind !== 'coderabbit');
  if (record.sources.some((source) => source.kind !== 'coderabbit' && source.status === 'blocked'))
    return false;
  // Legacy agent records without engine coverage cannot authorize this exception.
  if (
    !record.sources.some(
      (source) =>
        source.kind === 'agent' &&
        source.status === 'terminal' &&
        source.coverage &&
        'version' in source.coverage &&
        source.coverage.version === 2,
    )
  )
    return false;
  return isComplete(
    {
      ...record,
      sources: record.sources.filter(
        (source) =>
          source.kind !== 'agent' ||
          (source.coverage && 'version' in source.coverage && source.coverage.version === 2),
      ),
    },
    remaining,
  );
}

/** Final author readiness keeps known substantive findings blocking. */
export function allowsDeferredVendorComposition(
  record: FindingsRecord,
  configured: readonly ReviewSource['kind'][],
  debt: DeferredVendorDebt,
  identity: DeferredReviewIdentity,
  blockingSeverities: readonly string[],
): boolean {
  return (
    hasDeferredReviewSources(record, configured, debt, identity) &&
    openBlocking(record, blockingSeverities).length === 0
  );
}

/** Refresh before evaluating readiness: an old pending snapshot cannot hide a new blocker. */
export async function refreshDeferredVendorDebt(
  client: DeferredQueueClient,
  debt: DeferredVendorDebt,
): Promise<DeferredVendorDebt> {
  const parsed = DeferredVendorDebtSchema.parse(debt);
  return { ...parsed, queue: QueueStatusSchema.parse(await client.status(parsed.reference)) };
}
