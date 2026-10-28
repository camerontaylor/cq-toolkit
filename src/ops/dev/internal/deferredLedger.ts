import type { DevEffects } from '../effects.js';
import type { Finding } from '../../review/findings.js';
import { restoreDurableDisposition } from '../../review/internal/durableDisposition.js';
import { createHash } from 'node:crypto';
import { consumeDeferredVendorReport } from './deferredSettlement.js';
import { isDeepStrictEqual } from 'node:util';
import type { DevCycleRecord, DevLedgerFile } from '../record.js';
import { makeConfiguredQueueClient } from '../../review/queue.js';
import type { DeferredQueueClient } from '../../review/internal/queueProtocol.js';
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

/** Called before vendor dispatch and again after a positively typed local vendor failure.
 * Returned debt is durable before any fresh nondeferred review is invoked.
 */
export async function prepareDeferredVendorReview(
  effects: DevEffects,
  target: string,
  state: WorkState,
  client?: DeferredQueueClient,
  signal?: AbortSignal,
  options?: {
    onEvidenceImported?: (evidence: { receiptId: string; path: string }) => Promise<void>;
  },
): Promise<DeferredVendorDebt | undefined> {
  const ledger = effects.openLedger(state.branch).load();
  const retainedDebt = ledger.records.filter((entry) => entry.kind === 'vendor-debt').at(-1);
  let previous = retainedDebt?.debt;
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
  if (!retainedDebt && vendor?.vendorFailure) {
    signal?.throwIfAborted();
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
    return loadCurrentDeferredVendorDebt(effects, target, state, ledger, client, signal, options);
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
  signal?.throwIfAborted();
  const command = async (args: string[]) => {
    const result = await effects.runCommand('gh', args, {
      timeoutMs: 30_000,
      ...(signal ? { signal } : {}),
    });
    if (result.exitCode !== 0 || result.timedOut)
      throw new Error('cannot verify deferred forge identity');
    signal?.throwIfAborted();
    return result.stdout.trim();
  };
  const repo = await command(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']);
  const producer = await command(['api', 'user', '--jq', '.login']);
  const queue = client ?? makeConfiguredQueueClient();
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
    signal?.throwIfAborted();
    const current = await readWorkState(effects, { target, base: state.base });
    if (
      !current.ok ||
      current.state.branch !== state.branch ||
      current.state.head !== state.head ||
      current.state.dirtySha256 !== state.dirtySha256
    )
      throw new Error('deferred invocation identity changed; replay the same successor');
    signal?.throwIfAborted();
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
    signal?.throwIfAborted();
    if (['terminal-clean', 'terminal-with-findings', 'reused'].includes(prior.queue.state)) {
      // Recovery may finish after HEAD moves. Settle the retained obligation,
      // then require a real fresh vendor invocation at the new identity.
      const completed = await consumeDeferredVendorReport(effects, queue, prior, signal, options);
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
  return loadCurrentDeferredVendorDebt(
    effects,
    target,
    state,
    effects.openLedger(state.branch).load(),
    queue,
    signal,
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

/** Latest exact enrollment only. Never fall back past a newer debt snapshot. */
export function currentLedgerDebt(
  ledger: DevLedgerFile,
  target: string,
  state: Pick<WorkState, 'head' | 'base' | 'dirtySha256'>,
): DeferredVendorDebt | undefined {
  const entry = ledger.records.filter((record) => record.kind === 'vendor-debt').at(-1);
  if (!entry) return undefined;
  const debt = DeferredVendorDebtSchema.parse(entry.debt);
  const binding = debt.reference.binding;
  if (binding.kind !== 'deferred-author') throw new Error('deferred author binding required');
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
  options?: {
    onEvidenceImported?: (evidence: { receiptId: string; path: string }) => Promise<void>;
  },
): Promise<DeferredVendorDebt | undefined> {
  const debt = currentLedgerDebt(ledger, target, state);
  if (!debt) return undefined;
  signal?.throwIfAborted();
  const repo = await effects.runCommand(
    'gh',
    ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'],
    { timeoutMs: 30_000, ...(signal ? { signal } : {}) },
  );
  if (repo.exitCode !== 0 || repo.timedOut || repo.stdout.trim() !== debt.reference.binding.repo)
    throw new Error('cannot verify the deferred debt repository');
  const queue = client ?? makeConfiguredQueueClient();
  let fresh = await refreshDeferredVendorDebt(queue, debt);
  if (
    debt.vendorCompleted ||
    ['terminal-clean', 'terminal-with-findings', 'reused'].includes(fresh.queue.state)
  ) {
    fresh = await consumeDeferredVendorReport(effects, queue, fresh, signal, options);
  }
  signal?.throwIfAborted();
  const current = await readWorkState(effects, { target, base: state.base });
  const latest = effects.openLedger(state.branch).load();
  if (
    !current.ok ||
    current.state.branch !== state.branch ||
    current.state.head !== state.head ||
    current.state.base !== state.base ||
    current.state.dirtySha256 !== state.dirtySha256 ||
    !isDeepStrictEqual(latest, ledger)
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
    signal?.throwIfAborted();
    await effects.openLedger(state.branch).mutate((retained) => {
      if (!isDeepStrictEqual(retained, ledger))
        throw new Error('ledger changed before vendor settlement');
      return {
        ledger: {
          ...retained,
          records: [
            ...retained.records,
            { kind: 'vendor-debt' as const, debt: fresh, at: effects.nowIso() },
          ],
        },
        value: undefined,
      };
    });
  }
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
