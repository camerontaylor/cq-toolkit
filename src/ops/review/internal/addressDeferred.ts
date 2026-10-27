import { makeSubprocessDevEffects, type DevEffects } from '../../dev/effects.js';
import type { DeferredQueueClient } from './queueProtocol.js';
import { loadCurrentDeferredVendorDebt } from '../../dev/internal/deferredLedger.js';
import {
  deferredReceiptFindings,
  type DeferredReviewIdentity,
  type DeferredVendorDebt,
} from '../../dev/internal/deferredReview.js';
import { readWorkState } from '../../dev/internal/workState.js';
import type { Finding, FindingsRecord } from '../findings.js';

export interface DeferredVendorContextRequest {
  repoRoot: string;
  target: string;
  base: string | undefined;
  record: FindingsRecord;
  signal?: AbortSignal;
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
  );
  if (!debt) return undefined;
  const binding = debt.reference.binding;
  const ledger = effects.openLedger(state.branch).load();
  const dispositions = new Map(
    ledger.records
      .filter((entry) => entry.kind === 'disposition')
      .map((entry) => [entry.findingId, entry]),
  );
  // Configuration selects coverage, never which retained findings exist.
  // Address import cycles may repeat an ID; conflicting contents fail closed.
  const findings = new Map<string, Finding>();
  const retained = [
    ...ledger.records
      .filter((entry) => entry.kind === 'cycle')
      .flatMap((entry) =>
        entry.findings.map((finding): Finding => ({
          id: finding.id,
          source: entry.reviewer,
          severity: finding.severity,
          text: finding.excerpt ?? '',
          status: 'open',
          ...(finding.fileName ? { file: finding.fileName } : {}),
        })),
      ),
    ...deferredReceiptFindings(
      ledger.records.filter((entry) => entry.kind === 'vendor-debt').map((entry) => entry.debt),
    ),
  ];
  for (const finding of retained) {
    const previous = findings.get(finding.id);
    if (
      previous &&
      (previous.text !== finding.text ||
        previous.file !== finding.file ||
        previous.severity !== finding.severity)
    )
      throw new Error('conflicting retained finding identity');
    const disposition = dispositions.get(finding.id);
    findings.set(finding.id, {
      ...finding,
      status: disposition?.action ?? finding.status,
      ...(disposition ? { reason: disposition.why } : {}),
    });
  }
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
    findings: [...findings.values()],
  };
}
