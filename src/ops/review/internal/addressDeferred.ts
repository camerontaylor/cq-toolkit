import { makeSubprocessDevEffects, type DevEffects } from '../../dev/effects.js';
import type { DeferredQueueClient } from './queueProtocol.js';
import { loadCurrentDeferredVendorDebt } from '../../dev/internal/deferredLedger.js';
import type {
  DeferredReviewIdentity,
  DeferredVendorDebt,
} from '../../dev/internal/deferredReview.js';
import { readWorkState } from '../../dev/internal/workState.js';
import { retainedFindings } from './durableDisposition.js';
import type { Finding, FindingsRecord } from '../findings.js';

export interface DeferredVendorContextRequest {
  repoRoot: string;
  target: string;
  base: string | undefined;
  record: FindingsRecord;
  signal?: AbortSignal;
  onEvidenceImported?: (evidence: { receiptId: string; path: string }) => Promise<void>;
}

export interface DeferredVendorContext {
  debt: DeferredVendorDebt;
  identity: DeferredReviewIdentity;
  findings: Finding[];
}

/** Called inside address's bookkeeping FIFO; queue trust and local identity are
 * revalidated by the ledger loader after its bounded asynchronous reads.
 */
export async function resolveDeferredVendorContext(
  request: DeferredVendorContextRequest,
  deps: { effectsFactory?: (root: string) => DevEffects; queueClient?: DeferredQueueClient } = {},
): Promise<DeferredVendorContext | undefined> {
  if (!request.base || request.record.reviewed?.scope !== 'full') return undefined;
  const effects = (deps.effectsFactory ?? makeSubprocessDevEffects)(request.repoRoot);
  const read = await readWorkState(effects, { target: request.target, base: request.base });
  if (!read.ok) throw new Error(read.reason);
  const state = read.state;
  if (
    request.record.branch !== state.branch ||
    request.record.head !== state.head ||
    request.record.reviewed.base !== state.base
  )
    throw new Error('deferred findings record does not match current full comparison');
  const debt = await loadCurrentDeferredVendorDebt(
    effects,
    request.target,
    state,
    effects.openLedger(state.branch).load(),
    deps.queueClient,
    request.signal,
    { ...(request.onEvidenceImported ? { onEvidenceImported: request.onEvidenceImported } : {}) },
  );
  if (!debt) return undefined;
  const binding = debt.reference.binding;
  const ledger = effects.openLedger(state.branch).load();
  // Configuration selects coverage, never which retained findings exist. The shared
  // projection applies the SAME ledger-ordered, content-bound witnessed disposition that
  // every other restoration path uses: `review.address:import` cycles are repeat
  // transport and can never witness, so an import cycle cannot lend authority to a
  // later original finding (Q17b / P1 review of bf3c71d8). Conflicting contents for one
  // id still fail closed; the raw ledger is never rewritten.
  const findings = retainedFindings(ledger);
  return {
    debt,
    identity: {
      repo: binding.repo,
      producer: binding.kind === 'deferred-author' ? binding.producer : '',
      target: request.target,
      head: state.head,
      base: state.base,
      dirtySha256: state.dirtySha256,
      deferralId: debt.deferral.id,
    },
    findings,
  };
}
