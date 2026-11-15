/** Error handling around the receipt lane of `repair_tick.reconcile_fix_prs`.
 *
 * Python wraps `reconcile_current_fix(c, item)` and, when it raises anything
 * but `RefreshExhausted`, rewrites the item before the pass counts the error:
 * the trusted `remediation` is dropped, a `fixed` state falls back to
 * `pending-merged-evidence`, and `repair_error` records the message. Starvation
 * changes nothing. The item is immutable here, so the mutation is returned to
 * a `persist` seam; the caller installs it in its tick-owned queue.
 */
import { JsonObject } from '../../../policy/crq/jsonValue.js';
import { RefreshExhausted } from '../../../policy/crq/forgeBudget.js';
import { withObjectKeys, withoutObjectKey } from '../../../policy/crq/queueDoc.js';

export interface ReceiptLaneEffects {
  /** `reconcile_current_fix`: resolves with its skip report. */
  reconcile(item: JsonObject): Promise<unknown>;
  /** Install the rewritten item before the error is rethrown for counting. */
  persist(item: JsonObject): void | Promise<void>;
}

/** `str(exc)[:300]`, by code point as Python slices. */
function errorText(error: unknown): string {
  return Array.from(error instanceof Error ? error.message : String(error))
    .slice(0, 300)
    .join('');
}

/** The item as Python leaves it after a swallowed, non-starvation reconcile error. */
export function receiptLaneFailed(item: JsonObject, error: unknown): JsonObject {
  let next = withoutObjectKey(item, 'remediation');
  if (next.get('remediation_state') === 'fixed')
    next = withObjectKeys(next, [['remediation_state', 'pending-merged-evidence']]);
  return withObjectKeys(next, [['repair_error', errorText(error)]]);
}

/** Run the lane; mutate and persist on a genuine error, never on starvation.
 * Always rethrows so the envelope counts the error (`recordSwallowed`). */
export async function reconcileReceiptLane(
  item: JsonObject,
  effects: ReceiptLaneEffects,
): Promise<unknown> {
  try {
    return await effects.reconcile(item);
  } catch (error) {
    if (!(error instanceof RefreshExhausted)) await effects.persist(receiptLaneFailed(item, error));
    throw error;
  }
}
