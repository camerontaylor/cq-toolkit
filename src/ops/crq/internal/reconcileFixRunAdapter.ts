/** Plug one fix-run advance into the reconcile pass envelope.
 *
 * `runReconcileFixPrs` owns traversal and counting; the per-run body
 * (`reconcileFixRun`) is a pure function that returns the updated item. This
 * adapter threads the two together: it feeds each run the latest copy of its
 * item, persists whatever the body returns (an `error` result carries the
 * partial state Python leaves in place), and only then rethrows the error so
 * the envelope classifies it as starved or deferred. Seams are local types so
 * this module depends on no unmerged code.
 */
import { JsonObject } from '../../../policy/crq/jsonValue.js';
import type { JsonRecordLike } from '../../../policy/crq/queueDoc.js';
import {
  repairRunEntries,
  type ReconcileFixPrEffects,
  type ReconcileFixRun,
} from '../reconcileFixPrs.js';

export type FixRunAdvance =
  | { readonly kind: 'projected' | 'pending' | 'skipped' | 'closed'; readonly item: JsonObject }
  | { readonly kind: 'error'; readonly item: JsonObject; readonly error: unknown };

export interface FixRunAdapterInput {
  readonly items: readonly JsonRecordLike[];
  isReceipt(item: JsonRecordLike): boolean;
  reconcileReceipt(item: JsonRecordLike): Promise<unknown>;
  /** The per-run body; receives the latest copy of the item. */
  reconcile(item: JsonObject, run: string): Promise<FixRunAdvance>;
  /** Durably store the item the body returned, before any error is surfaced. */
  persist(item: JsonObject, run: string): Promise<void>;
}

export interface FixRunAdapter {
  readonly effects: ReconcileFixPrEffects;
  /** Every item with all returned updates applied, in queue order. */
  current(): readonly JsonRecordLike[];
}

export function makeFixRunAdapter(input: FixRunAdapterInput): FixRunAdapter {
  const latest = new Map<JsonRecordLike, JsonRecordLike>();
  const effects: ReconcileFixPrEffects = {
    items: () => input.items,
    isReceipt: (item) => input.isReceipt(item),
    reconcileReceipt: (item) => input.reconcileReceipt(item),
    repairRuns: (item): readonly ReconcileFixRun[] => repairRunEntries(item),
    advanceFixRun: async (item, entry) => {
      const base = latest.get(item) ?? item;
      if (!(base instanceof JsonObject)) throw new Error('repair queue item is not a JSON object');
      const result = await input.reconcile(base, entry.run);
      latest.set(item, result.item);
      await input.persist(result.item, entry.run);
      if (result.kind === 'error') throw result.error;
      return result.kind === 'projected' ? 'projected' : 'skipped';
    },
  };
  return { effects, current: () => input.items.map((item) => latest.get(item) ?? item) };
}
