import type { DevEffects } from '../effects.js';
import type { Finding } from '../../review/findings.js';
import { restoreDurableDisposition } from '../../review/internal/durableDisposition.js';
import { createHash } from 'node:crypto';
import { consumeDeferredVendorReport } from './deferredSettlement.js';
import { isDeepStrictEqual } from 'node:util';
import type { DevCycleRecord, DevLedgerFile } from '../record.js';
import { makeConfiguredQueueClient } from '../../review/queue.js';
import type { DeferredQueueClient, QueueStatus } from '../../review/internal/queueProtocol.js';
import {
  DeferredVendorDebtSchema,
  VendorFailureProvenanceSchema,
  deferredReceiptFindings,
  hasPersistedVendorOutageOrigin,
  matchesDeferredVendorDebt,
  refreshDeferredVendorDebt,
  bindDeferredPublication,
  deferVendorReview,
  advanceDeferredVendorDebt,
  type DeferredVendorDebt,
  type VendorOutageOrigin,
} from './deferredReview.js';
import { readWorkState, type WorkState } from './workState.js';

/** Stable request identity survives enqueue success followed by a local write failure. */
function requestId(
  repo: string,
  producer: string,
  target: string,
  state: WorkState,
  origin: VendorOutageOrigin,
): string {
  return `defer-${createHash('sha256')
    .update(JSON.stringify({ repo, producer, target, base: state.base, head: state.head, origin }))
    .digest('hex')}`;
}

/** The #632 lifetime contract, adopted with its exact names and semantics: one caller budget
 * shared across the entire invocation, never renewed per reference or per page.
 */
export interface QueueLineageOptions {
  onEvidenceImported?: (evidence: { receiptId: string; path: string }) => Promise<void>;
  /** Caller cancellation, combined with this invocation's own deadline. */
  signal?: AbortSignal;
  /** Caller remaining lifetime in ms; the invocation total below is the ceiling. */
  remainingMs?: () => number;
}

/** #632's total, applied once per invocation and never renewed. */
const INVOCATION_TOTAL_MS = 45_000;

/** PRIVATE provenance marker for THIS invocation's own deadline outcome. Never exported, never a
 * schema or observer: it exists so the ancestry catch can truncate only on the genuine deadline and
 * still propagate caller reasons and unrelated status/schema/report-integrity/import failures.
 */
class LineageDeadlineExhausted extends Error {
  constructor() {
    super('queue delivery unknown: deadline exhausted');
    this.name = 'LineageDeadlineExhausted';
  }
}
/** Count backstop for authorized-predecessor refreshes in one invocation. */
const MAX_PREDECESSOR_REFRESHES = 16;

interface InvocationLifetime {
  /** Caller cancellation combined with the invocation deadline. */
  signal: AbortSignal;
  remainingMs(): number;
  /** True only when the deadline fired and the caller did not cancel. */
  expired(): boolean;
  /** True when the caller cancelled; a cancellation always outranks a deadline stop. */
  callerAborted(): boolean;
  dispose(): void;
}

function combineCallerSignals(
  primary: AbortSignal | undefined,
  secondary: AbortSignal | undefined,
): AbortSignal | undefined {
  if (primary && secondary) return AbortSignal.any([primary, secondary]);
  return primary ?? secondary;
}

/** One deadline per invocation: min(caller remaining, start + 45 s total), #632's math. */
function startInvocationLifetime(
  caller: AbortSignal | undefined,
  callerRemaining: (() => number) | undefined,
): InvocationLifetime {
  const controller = new AbortController();
  const started = performance.now();
  const initial = callerRemaining?.() ?? INVOCATION_TOTAL_MS;
  if (!Number.isFinite(initial) || initial <= 0)
    throw new Error('queue delivery unknown: deadline exhausted');
  const deadline = started + Math.min(INVOCATION_TOTAL_MS, initial);
  let fired = false;
  const remainingMs = () => {
    const fromCaller = callerRemaining?.() ?? INVOCATION_TOTAL_MS;
    if (!Number.isFinite(fromCaller)) return 0;
    return Math.min(deadline - performance.now(), fromCaller);
  };
  const onCallerAbort = () => controller.abort(caller?.reason);
  if (caller) {
    if (caller.aborted) onCallerAbort();
    else caller.addEventListener('abort', onCallerAbort, { once: true });
  }
  const timer = setTimeout(
    () => {
      fired = true;
      controller.abort(new LineageDeadlineExhausted());
    },
    Math.max(0, remainingMs()),
  );
  timer.unref();
  return {
    signal: caller ? AbortSignal.any([caller, controller.signal]) : controller.signal,
    remainingMs,
    expired: () => fired && caller?.aborted !== true,
    callerAborted: () => caller?.aborted === true,
    dispose: () => {
      clearTimeout(timer);
      caller?.removeEventListener('abort', onCallerAbort);
    },
  };
}

/** Every client call is bounded by the invocation lifetime. An unabortable RPC is raced, and a
 * late resolution is dropped: once the race loses, the client is dead, so no import, ack,
 * observer call or ledger write can follow a timed-out RPC. Bounding the same lifetime twice is
 * idempotent (both races share one signal).
 */
function boundQueueClient(
  source: DeferredQueueClient,
  lifetime: InvocationLifetime,
): DeferredQueueClient {
  let dead = lifetime.remainingMs() <= 0;
  /** Refusal before dispatch. An already-cancelled or exhausted lifetime must never invoke the
   * wrapped operation at all — a rejected race still evaluates `run()`. The caller's cancellation
   * is the reason the caller observes; an internal deadline keeps its own reason.
   */
  const refuse = (label: string): never => {
    dead = true;
    // A caller cancellation (and our own deadline sentinel) keeps its exact reason. Otherwise an
    // exhausted budget is OUR deadline whatever the timer scheduling: the timer callback may not
    // have run yet, so classify by the budget itself, never by `expired()` alone.
    lifetime.signal.throwIfAborted();
    if (lifetime.expired() || lifetime.remainingMs() <= 0) throw new LineageDeadlineExhausted();
    throw new Error(`queue lifetime exhausted before ${label}`);
  };
  const settle = async <T>(label: string, run: () => Promise<T>): Promise<T> => {
    if (dead || lifetime.signal.aborted || lifetime.remainingMs() <= 0) return refuse(label);
    let detach: () => void = () => undefined;
    const expired = new Promise<never>((_resolve, reject) => {
      const fail = () =>
        reject(
          lifetime.signal.reason instanceof Error
            ? lifetime.signal.reason
            : new Error(`queue lifetime exhausted during ${label}`),
        );
      if (lifetime.signal.aborted) {
        fail();
        return;
      }
      lifetime.signal.addEventListener('abort', fail, { once: true });
      detach = () => lifetime.signal.removeEventListener('abort', fail);
    });
    try {
      const value = await Promise.race([run(), expired]);
      if (dead) throw new Error(`queue lifetime exhausted during ${label}`);
      return value;
    } catch (error) {
      if (lifetime.signal.aborted || lifetime.remainingMs() <= 0) dead = true;
      throw error;
    } finally {
      detach();
    }
  };
  const bounded: DeferredQueueClient & {
    report?: (
      reference: DeferredVendorDebt['reference'],
      evidenceDir: string,
      options?: QueueLineageOptions,
    ) => Promise<unknown>;
  } = {
    enqueue: (input) => settle('enqueue', () => source.enqueue(input)),
    bind: (input) => settle('bind', () => source.bind(input)),
    cancel: (input) => settle('cancel', () => source.cancel(input)),
    status: (input) => settle('status', () => source.status(input)),
  };
  const report = (source as { report?: unknown }).report;
  if (typeof report === 'function')
    bounded.report = (reference, evidenceDir, options) =>
      settle('report', () =>
        (
          report as (
            a: DeferredVendorDebt['reference'],
            b: string,
            c?: QueueLineageOptions,
          ) => Promise<unknown>
        ).call(source, reference, evidenceDir, options),
      );
  return bounded;
}

interface DebtGroup {
  requestId: string;
  snapshots: DeferredVendorDebt[];
}

/** Group the append-only snapshots by immutable request identity. A pending → completed upgrade
 * inside one group is the only permitted difference; conflicting bytes fail closed.
 */
function debtGroups(ledger: DevLedgerFile): DebtGroup[] {
  const groups = new Map<string, DeferredVendorDebt[]>();
  for (const entry of ledger.records) {
    if (entry.kind !== 'vendor-debt') continue;
    const debt = DeferredVendorDebtSchema.parse(entry.debt);
    const existing = groups.get(debt.reference.requestId);
    if (!existing) {
      groups.set(debt.reference.requestId, [debt]);
      continue;
    }
    const first = existing[0]!;
    if (
      !isDeepStrictEqual(first.reference, debt.reference) ||
      !isDeepStrictEqual(first.originAttempt, debt.originAttempt) ||
      !isDeepStrictEqual(first.deferral, debt.deferral)
    )
      throw new Error('deferred ledger holds conflicting snapshots for one request identity');
    existing.push(debt);
  }
  return [...groups.entries()].map(([requestId, snapshots]) => ({ requestId, snapshots }));
}

function lastSnapshot(group: DebtGroup): DeferredVendorDebt {
  return group.snapshots[group.snapshots.length - 1]!;
}

function matchesEnrollmentIdentity(
  debt: DeferredVendorDebt,
  identity: { head: string; base: string; dirtySha256: string },
  target: string,
): boolean {
  const binding = debt.reference.binding;
  return (
    binding.kind === 'deferred-author' &&
    binding.head === identity.head &&
    binding.target === target &&
    debt.deferral.base === identity.base &&
    debt.deferral.dirtySha256 === identity.dirtySha256
  );
}

export interface CurrentEnrollment {
  /** The identity-matched enrollment (its newest snapshot). */
  debt: DeferredVendorDebt;
  /** That enrollment's own ledger snapshot: the originAttempt/deferral proof readiness shares. */
  snapshot: DeferredVendorDebt;
  /** Authorized ancestry, nearest first, from the enrollment's predecessor chain. */
  ancestry: readonly DeferredVendorDebt[];
  /** Authorized ancestry whose obligation is still open. */
  pendingAncestry: readonly DeferredVendorDebt[];
}

export type CurrentEnrollmentRead =
  | { kind: 'none' }
  /** Two distinct enrollments claim one identity: never an authority, always a readiness gap. */
  | { kind: 'ambiguous'; requestIds: readonly string[] }
  | { kind: 'enrollment'; enrollment: CurrentEnrollment };

/** The ONE current-authority proof, shared by continuation selection and readiness assembly.
 * Authority is the identity-matched enrollment and its authorized predecessor chain, never the
 * positionally last appended snapshot; unrelated roots and other identities gain nothing.
 */
export function readCurrentEnrollment(
  ledger: DevLedgerFile,
  identity: { head: string; base: string; dirtySha256: string },
  target: string,
): CurrentEnrollmentRead {
  const groups = debtGroups(ledger);
  const matching = groups.filter((group) =>
    matchesEnrollmentIdentity(lastSnapshot(group), identity, target),
  );
  if (matching.length === 0) return { kind: 'none' };
  if (matching.length > 1)
    return { kind: 'ambiguous', requestIds: matching.map((group) => group.requestId) };
  const group = matching[0]!;
  const debt = lastSnapshot(group);
  const byRequestId = new Map(groups.map((entry) => [entry.requestId, entry]));
  const ancestry: DeferredVendorDebt[] = [];
  const pendingAncestry: DeferredVendorDebt[] = [];
  const visited = new Set<string>([group.requestId]);
  let cursor = debt.predecessor;
  while (cursor !== undefined) {
    const link = byRequestId.get(cursor.requestId);
    if (!link) throw new Error('authorized predecessor lineage is missing a retained snapshot');
    if (!isDeepStrictEqual(lastSnapshot(link).reference, cursor))
      throw new Error('authorized predecessor lineage conflicts with the retained snapshot');
    if (visited.has(link.requestId)) throw new Error('authorized predecessor lineage cycles');
    visited.add(link.requestId);
    const ancestor = lastSnapshot(link);
    ancestry.push(ancestor);
    if (!ancestor.vendorCompleted) pendingAncestry.push(ancestor);
    cursor = ancestor.predecessor;
  }
  return { kind: 'enrollment', enrollment: { debt, snapshot: debt, ancestry, pendingAncestry } };
}

/** The enrollment preparation advances from: never a snapshot some other group references as its
 * predecessor, so a completed predecessor appended after its successor cannot be mistaken for it.
 */
function advancementEnrollment(
  ledger: DevLedgerFile,
  target: string,
): DeferredVendorDebt | undefined {
  const groups = debtGroups(ledger);
  const referenced = new Set<string>();
  for (const group of groups) {
    const predecessor = lastSnapshot(group).predecessor;
    if (predecessor !== undefined) referenced.add(predecessor.requestId);
  }
  const candidates = groups.filter((group) => {
    if (referenced.has(group.requestId)) return false;
    const binding = lastSnapshot(group).reference.binding;
    return binding.kind === 'deferred-author' && binding.target === target;
  });
  const selected = candidates[candidates.length - 1] ?? groups[groups.length - 1];
  return selected === undefined ? undefined : lastSnapshot(selected);
}

/** Publish one completed snapshot atomically, requiring the ledger we validated to be unchanged. */
async function appendDebt(
  effects: DevEffects,
  state: WorkState,
  expected: DevLedgerFile,
  debt: DeferredVendorDebt,
): Promise<DevLedgerFile> {
  return effects.openLedger(state.branch).mutate((latest) => {
    if (!isDeepStrictEqual(latest, expected))
      throw new Error('deferred ledger changed while settling authorized ancestry');
    const next: DevLedgerFile = {
      ...latest,
      records: [...latest.records, { kind: 'vendor-debt' as const, debt, at: effects.nowIso() }],
    };
    return { ledger: next, value: next };
  });
}

/** Called before vendor dispatch and again after a positively typed local vendor failure.
 * Returned debt is durable before any fresh nondeferred review is invoked.
 */
export async function prepareDeferredVendorReview(
  effects: DevEffects,
  target: string,
  state: WorkState,
  client?: DeferredQueueClient,
  signal?: AbortSignal,
  options?: QueueLineageOptions,
): Promise<DeferredVendorDebt | undefined> {
  const ledger = effects.openLedger(state.branch).load();
  // ONE deadline per invocation, started before the first gh/status call and shared with the
  // load this preparation triggers; it is never renewed for later references.
  const lifetime = startInvocationLifetime(
    combineCallerSignals(signal, options?.signal),
    options?.remainingMs,
  );
  try {
    return await prepareWithLifetime(effects, target, state, ledger, lifetime, client, options);
  } finally {
    lifetime.dispose();
  }
}

/** The preparation body under the invocation lifetime; never creates a second budget. */
async function prepareWithLifetime(
  effects: DevEffects,
  target: string,
  state: WorkState,
  ledger: DevLedgerFile,
  lifetime: InvocationLifetime,
  client: DeferredQueueClient | undefined,
  options: QueueLineageOptions | undefined,
): Promise<DeferredVendorDebt | undefined> {
  const retained = advancementEnrollment(ledger, target);
  let previous = retained;
  const vendor = ledger.records
    .filter(
      (entry): entry is DevCycleRecord => entry.kind === 'cycle' && entry.reviewer === 'coderabbit',
    )
    .at(-1);
  // A later genuine local outage starts its own origin; completed lineage is retained.
  if (
    previous?.vendorCompleted &&
    vendor?.vendorFailure &&
    vendor.cycleId !== previous.originAttempt.cycleId
  )
    previous = undefined;
  if (!previous && !vendor?.vendorFailure) return undefined;
  if (retained === undefined && vendor?.vendorFailure) {
    lifetime.signal.throwIfAborted();
    // An unusable historical attempt is not debt. Admit a genuine fresh review,
    // without treating malformed provenance or ambiguous ledger identity as stale.
    VendorFailureProvenanceSchema.parse(vendor.vendorFailure);
    if (
      ledger.records.filter((entry) => entry.kind === 'cycle' && entry.cycleId === vendor.cycleId)
        .length !== 1
    )
      throw new Error('deferred vendor origin has ambiguous retained cycle identity');
    if (
      state.dirtySha256 !== 'clean-tree' ||
      vendor.scope !== 'full' ||
      vendor.dirtySha256 !== 'clean-tree' ||
      vendor.completion.kind !== 'blocked' ||
      vendor.head !== state.head ||
      vendor.base !== state.base ||
      vendor.target !== target
    )
      return undefined;
  }
  // A recovered vendor requires a fresh invocation on a new head; old current-code
  // completion never authorizes a successor outage or inherited coverage.
  if (
    previous?.vendorCompleted &&
    previous.reference.binding.kind === 'deferred-author' &&
    previous.reference.binding.head !== state.head &&
    vendor?.cycleId === previous.originAttempt.cycleId
  )
    return undefined;
  if (state.dirtySha256 !== 'clean-tree')
    throw new Error('deferred vendor review requires a committed clean identity');
  if (currentLedgerDebt(ledger, target, state))
    return loadCurrentWithLifetime(
      effects,
      target,
      state,
      ledger,
      lifetime,
      boundQueueClient(client ?? makeConfiguredQueueClient(), lifetime),
      options,
    );
  const origin: VendorOutageOrigin | undefined =
    previous?.originAttempt ??
    (vendor?.vendorFailure &&
    vendor.scope === 'full' &&
    vendor.dirtySha256 === 'clean-tree' &&
    vendor.completion.kind === 'blocked'
      ? {
          cycleId: vendor.cycleId,
          head: vendor.head,
          base: vendor.base,
          target: vendor.target,
          scope: 'full',
          dirtySha256: 'clean-tree',
          failure: vendor.vendorFailure,
        }
      : undefined);
  if (
    !origin ||
    !hasPersistedVendorOutageOrigin(
      origin,
      ledger.records.filter((entry): entry is DevCycleRecord => entry.kind === 'cycle'),
    )
  )
    throw new Error('deferred vendor origin is not a genuine retained blocked full CLI attempt');
  if (vendor?.completion.kind === 'blocked' && vendor.cycleId !== origin.cycleId)
    throw new Error('a newer vendor blocker is not authorized by the retained outage origin');
  if (origin.target !== target)
    throw new Error('deferred vendor target changed; prior debt retained');
  signalCheck(lifetime);
  const command = async (args: string[]) => {
    const result = await effects.runCommand('gh', args, {
      timeoutMs: 30_000,
      signal: lifetime.signal,
    });
    if (result.exitCode !== 0 || result.timedOut)
      throw new Error('cannot verify deferred forge identity');
    signalCheck(lifetime);
    return result.stdout.trim();
  };
  const repo = await command(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']);
  const producer = await command(['api', 'user', '--jq', '.login']);
  const queue = boundQueueClient(client ?? makeConfiguredQueueClient(), lifetime);
  const id = requestId(repo, producer, target, state, origin);
  const reference = {
    requestId: id,
    binding: {
      kind: 'deferred-author' as const,
      repo,
      producer,
      target,
      head: state.head,
      targetSelector: 'promoted-main' as const,
    },
  };
  const pin = { id, base: state.base, dirtySha256: 'clean-tree' as const };
  const persist = async (debt: DeferredVendorDebt) => {
    signalCheck(lifetime);
    const current = await readWorkState(effects, { target, base: state.base });
    if (
      !current.ok ||
      current.state.branch !== state.branch ||
      current.state.head !== state.head ||
      current.state.dirtySha256 !== state.dirtySha256
    )
      throw new Error('deferred invocation identity changed; replay the same successor');
    signalCheck(lifetime);
    await effects.openLedger(state.branch).mutate((latest) => {
      if (!isDeepStrictEqual(latest, ledger))
        throw new Error('deferred ledger changed; replay the same successor');
      return {
        ledger: {
          ...latest,
          records: [
            ...latest.records,
            { kind: 'vendor-debt' as const, debt, at: effects.nowIso() },
          ],
        },
        value: undefined,
      };
    });
  };
  if (previous) {
    const prior = DeferredVendorDebtSchema.parse(previous);
    prior.queue = await queue.status(prior.reference);
    signalCheck(lifetime);
    if (['terminal-clean', 'terminal-with-findings', 'reused'].includes(prior.queue.state)) {
      // Recovery may finish after HEAD moves. Settle the retained obligation,
      // then require a real fresh vendor invocation at the new identity.
      const completed = await consumeDeferredVendorReport(
        effects,
        queue,
        prior,
        lifetime.signal,
        options,
      );
      await persist(completed);
      return undefined;
    }
    await advanceDeferredVendorDebt(queue, prior, reference, pin, persist);
  } else {
    // Enrollment is for the genuine current blocked attempt, never fabricated old-head coverage.
    const failure =
      origin.failure.category === 'vendor-needs-action'
        ? 'login-required'
        : origin.failure.category === 'vendor-rate-limited'
          ? 'rate-limited'
          : 'unavailable';
    const debt = await deferVendorReview(queue, reference, failure, pin, origin);
    await persist(debt);
  }
  return loadCurrentWithLifetime(
    effects,
    target,
    state,
    effects.openLedger(state.branch).load(),
    lifetime,
    queue,
    options,
  );
}

/** Verified retained obligations are report findings, independent of current coverage.
 * Never invent a current source or discard predecessor receipts after HEAD changes.
 */
export function retainedReceiptFindings(ledger: DevLedgerFile): Finding[] {
  return deferredReceiptFindings(
    ledger.records
      .filter((entry) => entry.kind === 'vendor-debt')
      .map((entry) => DeferredVendorDebtSchema.parse(entry.debt)),
  ).map((finding) => restoreDurableDisposition(finding, ledger));
}

/** Latest exact enrollment only, selected by identity — never by append position, so a completed
 * predecessor appended after its successor can never displace it. With two distinct enrollments
 * claiming one identity, continuation keeps the newest matching snapshot and readiness reports the
 * ambiguity as a gap instead of crashing.
 */
export function currentLedgerDebt(
  ledger: DevLedgerFile,
  target: string,
  state: Pick<WorkState, 'head' | 'base' | 'dirtySha256'>,
): DeferredVendorDebt | undefined {
  const identity = { head: state.head, base: state.base, dirtySha256: state.dirtySha256 };
  const matching = debtGroups(ledger).filter((group) =>
    matchesEnrollmentIdentity(lastSnapshot(group), identity, target),
  );
  const selected = matching[matching.length - 1];
  if (selected === undefined) return undefined;
  const debt = lastSnapshot(selected);
  const binding = debt.reference.binding;
  if (binding.kind !== 'deferred-author') throw new Error('deferred author binding required');
  // Selection already enforces these; kept as defence in depth against future edits.
  if (
    binding.head !== state.head ||
    binding.target !== target ||
    debt.deferral.base !== state.base ||
    debt.deferral.dirtySha256 !== state.dirtySha256
  )
    return undefined;
  const cycles = ledger.records.filter(
    (record): record is DevCycleRecord => record.kind === 'cycle',
  );
  const latestVendor = cycles.filter((cycle) => cycle.reviewer === 'coderabbit').at(-1);
  if (
    latestVendor?.completion.kind === 'blocked' &&
    latestVendor.cycleId !== debt.originAttempt.cycleId
  )
    throw new Error('a newer vendor blocker is not authorized by the retained outage origin');
  if (!hasPersistedVendorOutageOrigin(debt.originAttempt, cycles))
    throw new Error(
      'deferred vendor origin is absent or differs from the retained local CLI attempt',
    );
  return debt;
}

/** Current work checks the combined signal directly: a caller abort or an exhausted deadline fails
 * it closed. Only the authorized-ancestry pass treats truncation as nonfatal.
 */
function signalCheck(lifetime: InvocationLifetime): void {
  lifetime.signal.throwIfAborted();
}

/** Authorized-ancestry boundary. A caller abort propagates with the caller's exact reason BEFORE any
 * nonfatal deadline/count classification — even when the caller's remaining budget is also zero.
 * Only the invocation's own deadline (or the count backstop, checked after this) stops the pass
 * without throwing.
 */
function ancestryBoundary(lifetime: InvocationLifetime): 'continue' | 'stop' {
  if (lifetime.callerAborted()) lifetime.signal.throwIfAborted();
  if (lifetime.expired()) return 'stop';
  if (lifetime.remainingMs() <= 0) return 'stop';
  if (lifetime.signal.aborted) lifetime.signal.throwIfAborted();
  return 'continue';
}

/** Set by the bounded view when it refuses a command, so the caller can rethrow the EXACT reason
 * after `readWorkState` (which folds thrown faults into a generic `ok:false`).
 */
interface BoundedRefusal {
  error?: unknown;
}

/** The post-report identity read runs under the SAME invocation lifetime: every command carries the
 * combined signal and a timeout clamped to the remaining budget, and a command is refused before
 * dispatch once the caller aborted or the budget is gone. A late check can therefore never follow an
 * unbounded wait. This is a view over the caller's effects — no client, protocol or workState change.
 */
function boundedEffects(
  effects: DevEffects,
  lifetime: InvocationLifetime,
  refusal: BoundedRefusal,
): DevEffects {
  const refuse = (error: unknown): Promise<never> => {
    refusal.error = error;
    return Promise.reject(error);
  };
  return {
    ...effects,
    runCommand: (command, args, opts) => {
      if (lifetime.signal.aborted) return refuse(lifetime.signal.reason);
      const remaining = lifetime.remainingMs();
      if (remaining <= 0) return refuse(new LineageDeadlineExhausted());
      const timeoutMs = Math.max(1, Math.min(opts.timeoutMs, Math.floor(remaining)));
      return effects.runCommand(command, args, { ...opts, timeoutMs, signal: lifetime.signal });
    },
  };
}

/** Nonterminal ancestor statuses are only continuable when they are VENDOR-shaped. A queue/scan/
 * identity/unknown blocker is a genuine trust failure reported by the queue, not ordinary pending
 * vendor work, so it must propagate instead of being discarded. Mirrors the current-debt rule in
 * deferredReview.ts so the two paths cannot disagree.
 */
function continuableAncestorStatus(queue: QueueStatus): boolean {
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

/** Refreshes the current enrollment's authorized predecessors, sequentially and in FIFO/lineage
 * order. A predecessor is settled only through the existing verified report import, and only the
 * current enrollment is ever returned for continuation or readiness.
 */
async function refreshAuthorizedAncestry(
  effects: DevEffects,
  target: string,
  state: WorkState,
  queue: DeferredQueueClient,
  lifetime: InvocationLifetime,
  options: QueueLineageOptions | undefined,
  expected: { ledger: DevLedgerFile },
): Promise<void> {
  const identity = { head: state.head, base: state.base, dirtySha256: state.dirtySha256 };
  let refreshed = 0;
  const attempted = new Set<string>();
  for (;;) {
    const read = readCurrentEnrollment(expected.ledger, identity, target);
    if (read.kind !== 'enrollment') return;
    const lineageOrder = [...read.enrollment.pendingAncestry].reverse();
    const next = lineageOrder.find((ancestor) => !attempted.has(ancestor.reference.requestId));
    if (next === undefined) {
      // An exhausted lineage never swallows a caller cancellation; deadline/count stops stay nonfatal.
      if (lifetime.callerAborted()) lifetime.signal.throwIfAborted();
      return;
    }
    // The caller's cancellation outranks the nonfatal count/deadline stops.
    if (ancestryBoundary(lifetime) === 'stop') return;
    if (refreshed >= MAX_PREDECESSOR_REFRESHES) return;
    attempted.add(next.reference.requestId);
    refreshed += 1;
    let completed: DeferredVendorDebt;
    try {
      const fresh = await refreshDeferredVendorDebt(queue, next);
      if (!['terminal-clean', 'terminal-with-findings', 'reused'].includes(fresh.queue.state)) {
        // A nonterminal status is only ordinary pending vendor work when it is vendor-shaped; a
        // queue/scan/identity/unknown blocker is a real trust failure and must not be discarded.
        if (!continuableAncestorStatus(fresh.queue))
          throw new Error(
            `authorized predecessor queue status is a non-vendor blocker: ${String(fresh.queue.state)}/${String(fresh.queue.reason?.category ?? 'no-reason')}`,
          );
        continue;
      }
      completed = await consumeDeferredVendorReport(
        effects,
        queue,
        fresh,
        lifetime.signal,
        options,
      );
    } catch (error) {
      // Deadline expiry WHILE an ancestor status/report is in flight is the same documented
      // nonfatal truncation as expiry between ancestors: keep the verified current enrollment and
      // leave the retained obligations as readiness gaps. Caller cancellation keeps its own exact
      // reason, and any genuine trust/import failure still propagates unchanged.
      if (error instanceof LineageDeadlineExhausted) return;
      throw error;
    }
    const refusal: BoundedRefusal = {};
    const current = await readWorkState(boundedEffects(effects, lifetime, refusal), {
      target,
      base: state.base,
    });
    if (refusal.error !== undefined) {
      // `readWorkState` folds thrown faults into `ok:false`; rethrow the bounded view's own outcome
      // so the caller's exact reason survives and an exhausted budget truncates nonfatally.
      if (refusal.error instanceof LineageDeadlineExhausted) return;
      throw refusal.error;
    }
    if (
      !current.ok ||
      current.state.branch !== state.branch ||
      current.state.head !== state.head ||
      current.state.base !== state.base ||
      current.state.dirtySha256 !== state.dirtySha256
    )
      throw new Error('deferred invocation identity changed while settling authorized ancestry');
    // The identity read is asynchronous: a cancellation that landed during it must prevent the
    // settlement write and propagate with its exact reason.
    signalCheck(lifetime);
    expected.ledger = await appendDebt(effects, state, expected.ledger, completed);
  }
}

/** Authoritative bounded read; generic RPC failure retains debt and refuses continuation.
 * No ledger lock is held over network reads and there is no refresh/retry loop.
 */
export async function loadCurrentDeferredVendorDebt(
  effects: DevEffects,
  target: string,
  state: WorkState,
  ledger: DevLedgerFile,
  client?: DeferredQueueClient,
  signal?: AbortSignal,
  options?: QueueLineageOptions,
): Promise<DeferredVendorDebt | undefined> {
  // ONE deadline per invocation, started before the gh identity read and the first status/report.
  const lifetime = startInvocationLifetime(
    combineCallerSignals(signal, options?.signal),
    options?.remainingMs,
  );
  try {
    return await loadCurrentWithLifetime(effects, target, state, ledger, lifetime, client, options);
  } finally {
    lifetime.dispose();
  }
}

async function loadCurrentWithLifetime(
  effects: DevEffects,
  target: string,
  state: WorkState,
  ledger: DevLedgerFile,
  lifetime: InvocationLifetime,
  client: DeferredQueueClient | undefined,
  options: QueueLineageOptions | undefined,
): Promise<DeferredVendorDebt | undefined> {
  const debt = currentLedgerDebt(ledger, target, state);
  if (!debt) return undefined;
  // Configured only when a debt actually needs the queue: a no-debt readiness read never
  // requires queue capability. Bounding an already-bounded client is idempotent.
  const queue = boundQueueClient(client ?? makeConfiguredQueueClient(), lifetime);
  signalCheck(lifetime);
  const repo = await effects.runCommand(
    'gh',
    ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'],
    { timeoutMs: 30_000, signal: lifetime.signal },
  );
  if (repo.exitCode !== 0 || repo.timedOut || repo.stdout.trim() !== debt.reference.binding.repo)
    throw new Error('cannot verify the deferred debt repository');
  let fresh = await refreshDeferredVendorDebt(queue, debt);
  if (
    debt.vendorCompleted ||
    ['terminal-clean', 'terminal-with-findings', 'reused'].includes(fresh.queue.state)
  ) {
    fresh = await consumeDeferredVendorReport(effects, queue, fresh, lifetime.signal, options);
  }
  signalCheck(lifetime);
  const current = await readWorkState(effects, { target, base: state.base });
  let expected = ledger;
  const latest = effects.openLedger(state.branch).load();
  if (
    !current.ok ||
    current.state.branch !== state.branch ||
    current.state.head !== state.head ||
    current.state.base !== state.base ||
    current.state.dirtySha256 !== state.dirtySha256 ||
    !isDeepStrictEqual(latest, expected)
  )
    throw new Error('deferred debt or working identity changed while verifying queue status');
  if (
    !matchesDeferredVendorDebt(fresh, {
      repo: repo.stdout.trim(),
      producer:
        debt.reference.binding.kind === 'deferred-author' ? debt.reference.binding.producer : '',
      target,
      head: state.head,
      base: state.base,
      dirtySha256: state.dirtySha256,
      deferralId: debt.deferral.id,
    })
  )
    throw new Error('queue status does not authorize deferred vendor continuation');
  if (fresh.vendorCompleted && !isDeepStrictEqual(debt, fresh)) {
    signalCheck(lifetime);
    expected = await appendDebt(effects, state, expected, fresh);
  }
  // Only the authorized predecessor chain is refreshed, and only the current enrollment is returned.
  await refreshAuthorizedAncestry(effects, target, state, queue, lifetime, options, {
    ledger: expected,
  });
  return fresh;
}

/** Server verifies the published PR; a lost reply/write is replayed with the same intent. */
export async function bindPublishedDeferredDebt(
  effects: DevEffects,
  target: string,
  state: WorkState,
  ledger: DevLedgerFile,
  pr: number,
  client?: DeferredQueueClient,
): Promise<void> {
  const debt = currentLedgerDebt(ledger, target, state);
  if (!debt) return;
  const bound = await bindDeferredPublication(client ?? makeConfiguredQueueClient(), debt, pr);
  const current = await readWorkState(effects, { target, base: state.base });
  if (
    !current.ok ||
    current.state.branch !== state.branch ||
    current.state.head !== state.head ||
    current.state.dirtySha256 !== state.dirtySha256
  )
    throw new Error('publication identity changed while binding deferred vendor debt');
  await effects.openLedger(state.branch).mutate((latest) => {
    if (!isDeepStrictEqual(latest, ledger))
      throw new Error(
        'latest ledger changed while binding deferred vendor debt; replay publication',
      );
    return {
      ledger:
        JSON.stringify(bound) === JSON.stringify(debt)
          ? latest
          : {
              ...latest,
              records: [
                ...latest.records,
                { kind: 'vendor-debt' as const, debt: bound, at: effects.nowIso() },
              ],
            },
      value: undefined,
    };
  });
}
