/**
 * The reconcile pass envelope (`repair_tick.reconcile_fix_prs`).
 *
 * This module owns the part of the reconcile pass that is independent of forge
 * and repair semantics: item traversal, the examined/projected/starved/deferred
 * counters, the five-error cap, and the honest tick report. The per-item
 * advance effects (a receipt lane and one fix-PR refresh) are injected, because
 * their repair/publication bodies are owned by the pending repair slice; this
 * envelope will call them unchanged when that slice lands.
 *
 * Counts are inputs, never constants:
 *
 * - a receipt-kind item is examined even when the lane skips everything;
 * - an eligible repair run is examined only when it has an unmerged, open fix
 *   PR (`fix_pr` truthy and neither `fix_merged` nor `fix_closed` set);
 * - `projected` increments only for a run the effect advanced;
 * - `starved` is `RefreshExhausted`; everything else is `deferred`.
 */
import {
  isJsonRecord,
  pyTruthy,
  recordEntries,
  recordGet,
  type JsonRecordLike,
} from '../../policy/crq/queueDoc.js';
import {
  countExamined,
  countProjected,
  itemIdentity,
  newReconcileStats,
  recordLaneSkips,
  recordSwallowed,
  type ReconcileStats,
} from '../../policy/crq/reconcileReport.js';

/** One `item.repair_runs` entry. */
export interface ReconcileFixRun {
  readonly run: string;
  readonly record: JsonRecordLike;
}

/** Every effect the pass may perform, one item/run at a time. */
export interface ReconcileFixPrEffects {
  /** `q["items"]`, in queue order. */
  items(): readonly JsonRecordLike[];
  /** `item["kind"] == review_receipt.KIND`. */
  isReceipt(item: JsonRecordLike): boolean;
  /**
   * The receipt lane's reconcile; resolves with its `{starved, deferred,
   * errors}` skip report (or anything non-object, which counts zero skips).
   */
  reconcileReceipt(item: JsonRecordLike): Promise<unknown>;
  /** `item.get("repair_runs", {}).items()`, in queue order. */
  repairRuns(item: JsonRecordLike): readonly ReconcileFixRun[];
  /**
   * Advance one eligible fix run. Resolves `projected` only when the run
   * reached its merged state; `skipped` covers terminal/ancestor/no-proof
   * outcomes that are not errors.
   */
  advanceFixRun(item: JsonRecordLike, entry: ReconcileFixRun): Promise<'projected' | 'skipped'>;
}

/**
 * `if not pr or record.get("fix_merged") or record.get("fix_closed"): continue`
 * as one predicate, so the traversal and the count use the same rule.
 */
export function fixRunEligible(record: JsonRecordLike): boolean {
  const fixPr = recordGet(record, 'fix_pr');
  return (
    pyTruthy(fixPr) &&
    !pyTruthy(recordGet(record, 'fix_merged')) &&
    !pyTruthy(recordGet(record, 'fix_closed'))
  );
}

/** `item.get("repair_runs", {})` as ordered run entries. */
export function repairRunEntries(item: JsonRecordLike): readonly ReconcileFixRun[] {
  const runs = recordGet(item, 'repair_runs');
  if (!isJsonRecord(runs)) return [];
  return recordEntries(runs)
    .filter(([, record]) => isJsonRecord(record))
    .map(([run, record]) => ({ run, record: record as JsonRecordLike }));
}

/** Run the reconcile traversal and return its real counts. */
export async function runReconcileFixPrs(
  effects: ReconcileFixPrEffects,
): Promise<ReconcileStats> {
  const stats = newReconcileStats();
  for (const item of effects.items()) {
    const identity = itemIdentity(item);
    if (effects.isReceipt(item)) {
      countExamined(stats);
      try {
        const skips = await effects.reconcileReceipt(item);
        recordLaneSkips(stats, skips, identity.id, identity.run);
      } catch (error) {
        // Starvation is not the item's fault; a genuine error is. Either way
        // the run's own state is the effect's business, not this envelope's.
        recordSwallowed(stats, error, identity.id, identity.run);
      }
      continue;
    }
    for (const entry of effects.repairRuns(item)) {
      if (!fixRunEligible(entry.record)) continue;
      countExamined(stats);
      try {
        const outcome = await effects.advanceFixRun(item, entry);
        if (outcome === 'projected') countProjected(stats);
      } catch (error) {
        recordSwallowed(stats, error, identity.id, entry.run);
      }
    }
  }
  return stats;
}
