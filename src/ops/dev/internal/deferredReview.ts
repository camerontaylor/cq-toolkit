import { z } from 'zod';
import type { DevCycleRecord } from '../record.js';
import {
  isComplete,
  openBlocking,
  type FindingsRecord,
  type Finding,
  type ReviewSource,
} from '../../review/findings.js';
import { QueueEvidenceSchema } from '../../review/internal/queueEvidence.js';
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

function vendorCategory(codes: readonly string[]) {
  if (!codes.length || codes.some((code) => !['con_err', 'rate_limited', 'auth'].includes(code)))
    return undefined;
  return codes.includes('auth')
    ? 'vendor-needs-action'
    : codes.includes('rate_limited')
      ? 'vendor-rate-limited'
      : 'vendor-unavailable';
}

export const VendorFailureProvenanceSchema = z
  .object({
    source: z.literal('vendor'),
    category: z.enum(['vendor-unavailable', 'vendor-rate-limited', 'vendor-needs-action']),
    codes: z.array(QueueToken).min(1),
  })
  .strict()
  .refine(
    (value) => vendorCategory(value.codes) === value.category,
    'vendor category must match wholly recognized structured codes',
  );
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
  const category = vendorCategory(input.codes);
  if (!category) return undefined;
  // A mixed vendor-only failure stays operational debt; the action-needed cause is visible.
  return VendorFailureProvenanceSchema.parse({
    source: 'vendor',
    category,
    codes: [...input.codes],
  });
}

export const VendorOutageOriginSchema = z
  .object({
    cycleId: QueueToken,
    head: QueueSha,
    base: QueueSha,
    target: QueueToken,
    scope: z.literal('full'),
    dirtySha256: z.literal('clean-tree'),
    failure: VendorFailureProvenanceSchema,
  })
  .strict();
export type VendorOutageOrigin = z.infer<typeof VendorOutageOriginSchema>;

/** A caller-supplied origin is insufficient: match the genuine retained local cycle. */
export function hasPersistedVendorOutageOrigin(
  origin: VendorOutageOrigin,
  cycles: readonly (DevCycleRecord & { vendorFailure?: VendorFailureProvenance })[],
): boolean {
  const parsed = VendorOutageOriginSchema.safeParse(origin);
  if (!parsed.success) return false;
  const matching = cycles.filter((cycle) => cycle.cycleId === parsed.data.cycleId);
  if (matching.length !== 1) return false;
  const cycle = matching[0]!;
  const failure = VendorFailureProvenanceSchema.safeParse(cycle.vendorFailure);
  return (
    cycle.reviewer === 'coderabbit' &&
    cycle.completion.kind === 'blocked' &&
    cycle.scope === parsed.data.scope &&
    cycle.head === parsed.data.head &&
    cycle.base === parsed.data.base &&
    cycle.target === parsed.data.target &&
    cycle.dirtySha256 === parsed.data.dirtySha256 &&
    failure.success &&
    failure.data.category === parsed.data.failure.category &&
    failure.data.codes.length === parsed.data.failure.codes.length &&
    failure.data.codes.every((code, index) => code === parsed.data.failure.codes[index])
  );
}

const DeferralIdentitySchema = z
  .object({
    id: QueueToken,
    base: QueueSha,
    dirtySha256: z.literal('clean-tree'),
  })
  .strict();

const DebtIdentitySchema = z
  .object({
    reference: QueueReferenceSchema.refine((ref) => ref.binding.kind === 'deferred-author'),
    queue: QueueStatusSchema,
    /** Genuine retained vendor cycle; a successor never changes this evidence. */
    originAttempt: VendorOutageOriginSchema,
    /** Current enrollment, explicitly not a vendor run. */
    deferral: DeferralIdentitySchema,
    predecessor: QueueReferenceSchema.exactOptional(),
  })
  .strict();
export const DeferredVendorDebtSchema = z.discriminatedUnion('vendorCompleted', [
  DebtIdentitySchema.extend({
    vendor: z.enum(['vendor-pending', 'vendor-blocked-transient', 'vendor-needs-action']),
    vendorCompleted: z.literal(false),
  }).strict(),
  DebtIdentitySchema.extend({
    vendor: z.literal('vendor-completed'),
    vendorCompleted: z.literal(true),
    /** Genuine affected-current receipt; never full-branch or independent proof. */
    completion: QueueEvidenceSchema,
  }).strict(),
]);
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
  deferral: DeferredVendorDebt['deferral'],
  originAttempt: VendorOutageOrigin,
): Promise<DeferredVendorDebt> {
  if (failure !== 'unavailable' && failure !== 'rate-limited' && failure !== 'login-required') {
    throw new Error(`vendor failure remains blocking: ${failure}`);
  }
  const ref = QueueReferenceSchema.parse(reference);
  if (ref.binding.kind !== 'deferred-author') throw new Error('deferred author binding required');
  const pin = DeferralIdentitySchema.parse(deferral);
  const origin = VendorOutageOriginSchema.parse(originAttempt);
  const category =
    failure === 'login-required'
      ? 'vendor-needs-action'
      : failure === 'rate-limited'
        ? 'vendor-rate-limited'
        : 'vendor-unavailable';
  if (
    pin.id !== ref.requestId ||
    origin.head !== ref.binding.head ||
    origin.base !== pin.base ||
    origin.target !== ref.binding.target ||
    origin.failure.category !== category
  ) {
    throw new Error('origin vendor attempt does not match initial deferral');
  }
  const queue = QueueStatusSchema.parse(await client.enqueue(ref));
  if (!continuableQueue(queue)) {
    throw new Error(`queue enrollment does not establish deferred debt: ${queue.state}`);
  }
  return {
    reference: ref,
    queue,
    vendor: failure === 'login-required' ? 'vendor-needs-action' : 'vendor-blocked-transient',
    vendorCompleted: false,
    deferral: pin,
    originAttempt: origin,
  };
}

/** Enroll and persist a linked successor before selecting it for continuation.
 * Never cancels or mutates the predecessor, including its published obligations.
 * On an uncertain write the caller must replay the SAME nextReference.
 */
export async function advanceDeferredVendorDebt(
  client: DeferredQueueClient,
  previous: DeferredVendorDebt,
  nextReference: QueueReference,
  deferral: DeferredVendorDebt['deferral'],
  persistSuccessor: (successor: DeferredVendorDebt) => Promise<void>,
): Promise<DeferredVendorDebt> {
  const prior = DeferredVendorDebtSchema.parse(previous);
  const next = QueueReferenceSchema.parse(nextReference);
  const pin = DeferralIdentitySchema.parse(deferral);
  const before = prior.reference.binding;
  const after = next.binding;
  if (
    before.kind !== 'deferred-author' ||
    after.kind !== 'deferred-author' ||
    next.requestId === prior.reference.requestId ||
    pin.id !== next.requestId ||
    before.head === after.head ||
    before.repo !== after.repo ||
    before.producer !== after.producer ||
    before.target !== after.target ||
    before.targetSelector !== after.targetSelector ||
    prior.vendorCompleted ||
    !continuableQueue(prior.queue)
  ) {
    throw new Error('successor must retain outage lineage with a new immutable head and request');
  }
  const queue = QueueStatusSchema.parse(await client.enqueue(next));
  if (!continuableQueue(queue)) throw new Error('successor queue enrollment failed');
  const successor: DeferredVendorDebt = {
    ...prior,
    reference: next,
    queue,
    deferral: pin,
    predecessor: prior.reference,
  };
  await persistSuccessor(successor);
  return successor;
}

/** Publication can be replayed after a crash. The server verifies forge identity. */
export async function bindDeferredPublication(
  client: DeferredQueueClient,
  debt: DeferredVendorDebt,
  pr: number,
): Promise<DeferredVendorDebt> {
  if (debt.vendorCompleted) {
    if (debt.queue.pr !== pr || !verifiedCompletedDebt(debt))
      throw new Error('completed debt publication identity differs');
    return debt;
  }
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
    deferralId: string;
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
    parsed.data.deferral.id === identity.deferralId &&
    parsed.data.reference.requestId === identity.deferralId &&
    parsed.data.originAttempt.target === identity.target &&
    parsed.data.deferral.base === identity.base &&
    parsed.data.deferral.dirtySha256 === identity.dirtySha256 &&
    (parsed.data.vendorCompleted
      ? verifiedCompletedDebt(parsed.data)
      : continuableQueue(parsed.data.queue))
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
  if (blockedVendor.some((source) => source.cycleId !== debt.originAttempt.cycleId)) return false;
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
    openBlocking(record, blockingSeverities).length === 0 &&
    openBlocking(
      {
        ...record,
        findings: deferredReceiptFindings([debt]).map(
          (finding) => record.findings.find((retained) => retained.id === finding.id) ?? finding,
        ),
      },
      blockingSeverities,
    ).length === 0
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

/** Q1 retains raw finding events. Match its renderer's text precedence while
 * retaining the entire original event in the immutable receipt, without truncation.
 */
function receiptFindingText(finding: Record<string, unknown>): string | undefined {
  for (const key of ['codegenInstructions', 'comment', 'excerpt', 'text']) {
    const value = finding[key];
    if (value === undefined || value === null || value === '') continue;
    return typeof value === 'string' ? value : undefined;
  }
  return undefined;
}

/** Strict terminal receipt checks supplement Q3's authenticated byte/source verification.
 * Completion covers only the captured current affected content, never this branch's full diff.
 */
export function verifiedCompletedDebt(debt: DeferredVendorDebt): boolean {
  if (!debt.vendorCompleted) return false;
  const { document, receiptId } = debt.completion;
  const { queue, reference } = debt;
  const binding = reference.binding;
  const reused = Boolean(
    queue.reusedFrom &&
    queue.receiptSource &&
    queue.receiptEquivalence === document.capture.equivalence &&
    queue.receiptSource.repo === document.source.repo &&
    queue.receiptSource.pr === document.source.pr &&
    queue.receiptSource.mergeSha === document.source.merge_sha &&
    queue.receiptSource.targetSelector === document.source.target_selector,
  );
  return (
    binding.kind === 'deferred-author' &&
    !queue.reason &&
    queue.consumed &&
    queue.reviewed &&
    queue.receiptId === receiptId &&
    ['terminal-clean', 'terminal-with-findings', 'reused'].includes(queue.state) &&
    ['terminal-clean', 'terminal-with-findings'].includes(document.outcome) &&
    document.counted &&
    document.classification?.['counted'] === true &&
    document.classification['outcome'] === 'completed' &&
    document.source.repo === binding.repo &&
    document.source.target_selector === binding.targetSelector &&
    (reused ||
      (document.item_id === queue.itemId &&
        document.source.pr === queue.pr &&
        document.source.merge_sha === queue.mergeSha &&
        document.request_id === reference.requestId)) &&
    // Q1 may retain supported no-content rows beside genuinely reviewed files.
    // Empty/deleted-only captures are uncounted and never establish completion.
    document.capture.paths.some(
      (path) =>
        ['included', 'renamed'].includes(path.disposition) &&
        typeof path['bytes'] === 'number' &&
        path['bytes'] > 0,
    ) &&
    document.capture.paths.every((path) => {
      if (path.disposition === 'deleted')
        return (
          path['reason'] === 'no current path or evidenced rename' &&
          !('blob' in path) &&
          !('mode' in path) &&
          !('bytes' in path)
        );
      const regular =
        typeof path['blob'] === 'string' &&
        QueueSha.safeParse(path['blob']).success &&
        typeof path['mode'] === 'string' &&
        ['100644', '100755'].includes(path['mode']) &&
        typeof path['bytes'] === 'number' &&
        Number.isSafeInteger(path['bytes']);
      if (path.disposition === 'excluded-with-reason')
        return regular && path['reason'] === 'empty current file' && path['bytes'] === 0;
      return (
        ['included', 'renamed'].includes(path.disposition) &&
        regular &&
        typeof path['bytes'] === 'number' &&
        path['bytes'] > 0
      );
    }) &&
    (document.outcome !== 'terminal-clean' || document.findings.length === 0) &&
    (document.outcome !== 'terminal-with-findings' || document.findings.length > 0) &&
    document.findings.every(
      (finding) =>
        typeof finding['severity'] === 'string' &&
        ['critical', 'major', 'minor', 'trivial', 'info', 'none'].includes(finding['severity']) &&
        receiptFindingText(finding) !== undefined,
    )
  );
}

/** Stable imported IDs, preserving original receipt findings in completion.document. */
export function deferredReceiptFindings(debts: readonly DeferredVendorDebt[]): Finding[] {
  const receipts = new Map<string, DeferredVendorDebt>();
  for (const debt of debts)
    if (debt.vendorCompleted && verifiedCompletedDebt(debt))
      receipts.set(debt.completion.receiptId, debt);
  return [...receipts.values()].flatMap((debt) =>
    debt.vendorCompleted
      ? debt.completion.document.findings.map((finding, index) => ({
          id: `receipt-${debt.completion.receiptId}#f${String(index + 1)}`,
          source: 'coderabbit',
          severity: String(finding['severity']),
          text: receiptFindingText(finding)!,
          status: 'open' as const,
          ...(typeof finding['fileName'] === 'string' ? { file: finding['fileName'] } : {}),
          evidence: debt.completion.receiptId,
        }))
      : [],
  );
}
