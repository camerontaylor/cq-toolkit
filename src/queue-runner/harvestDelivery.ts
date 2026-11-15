/**
 * The per-item harvest loop and the post-harvest delivery passes of `tick`
 * (crq.py:3395-3469). Inactive: nothing imports this outside tests. Every
 * effect is injected; items are plain records edited in place and the caller
 * owns tick.lock. `slot` has no delivery passes of its own (it calls
 * `collect_finished`), so nothing here is slot-specific.
 *
 * Python exceptions that are not caught inside the tick loop (KeyError on
 * `item["state"]`, any seam error outside the repair-harvest `try`) propagate
 * and abandon the rest of the pass; here they throw.
 */
export type Item = Record<string, unknown>;
export type Queue = Record<string, unknown> & { items: Item[] };

function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object' && v !== null) return Object.keys(v).length > 0;
  return Boolean(v);
}
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** Python `s[:n]` counts code points. */
export function pyPrefix(s: string, n: number): string {
  return Array.from(s).slice(0, n).join('');
}
/** Python code-point string order (not UTF-16 order). */
function cmpCodePoints(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = (x[i] as string).codePointAt(0)! - (y[i] as string).codePointAt(0)!;
    if (d !== 0) return d;
  }
  return x.length - y.length;
}
function pyStr(v: unknown): string {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  return String(v);
}

// ------------------------------------------------------------- harvest loop

export interface HarvestLoopEffects {
  liveItems(q: Queue): Item[];
  /** `local_review_runtime.KIND`. */
  readonly localReviewKind: string;
  /** `review_receipt.KIND`: its items record `repair_error`, others `last_error`. */
  readonly reviewReceiptKind: string;
  republish(q: Queue, item: Item): Promise<void>;
  /** `harvest_review(q, item, dry)`; a truthy message is logged. */
  harvestReview(q: Queue, item: Item, dry: boolean): Promise<string | null | undefined>;
  /** `repair_tick.harvest(module, q, item)`: log lines to append. */
  repairHarvest(q: Queue, item: Item): Promise<string[]>;
}

function stateOf(item: Item): unknown {
  if (!('state' in item)) throw new TypeError('item.state missing');
  return item.state;
}

export async function harvestLoop(
  q: Queue,
  log: string[],
  dry: boolean,
  fx: HarvestLoopEffects,
): Promise<void> {
  for (const item of [...fx.liveItems(q)]) {
    if (!dry && item.kind === fx.localReviewKind && truthy(item.publication_pending))
      await fx.republish(q, item);
    if (stateOf(item) === 'reviewing') {
      const msg = await fx.harvestReview(q, item, dry);
      if (msg) log.push(msg);
    }
    // Re-read: the harvest may have changed the state.
    if (stateOf(item) === 'addressing' && !dry) {
      item.state = 'repair_failed';
      item.last_error = 'legacy addressing retained for manual reconciliation; no new dispatch';
    }
    if (!dry && truthy(item.repair_runs)) {
      try {
        log.push(...(await fx.repairHarvest(q, item)));
      } catch (error) {
        // Python reads item["kind"] inside the handler: a missing kind is a KeyError that escapes.
        if (!('kind' in item)) throw new TypeError('item.kind missing');
        const key = item.kind === fx.reviewReceiptKind ? 'repair_error' : 'last_error';
        item[key] = 'repair harvest failed: ' + pyPrefix(message(error), 300);
      }
    }
  }
}

// ---------------------------------------------------------- delivery passes

export interface DeliveryEffects {
  liveItems(q: Queue): Item[];
  /** `push_current.KIND`. */
  readonly pushCurrentKind: string;
  reconcileCompleted(q: Queue): Promise<void>;
  iso(): string;
  /** `_deliver_push_findings(q, item)`. */
  deliverPushFindings(q: Queue, item: Item): Promise<string | null | undefined>;
  deliverPendingPrReviews(q: Queue): Promise<string[]>;
  deliverPendingCleanReviews(q: Queue): Promise<string[]>;
  deliverPendingReviewRefreshes(q: Queue): Promise<string[]>;
  repairBackfill(q: Queue): Promise<void>;
  repairArchiveLegacy(q: Queue): Promise<void>;
  /**
   * `with forge_window(ForgeBudget(requests=80, seconds=60)): repair_tick.reconcile_fix_prs(...)`.
   * The binding owns the budget; the result is anything the Python seam returned.
   */
  reconcileFixPrs(q: Queue): Promise<unknown>;
  /** `event(kind, **data)`. */
  event(kind: string, data: Record<string, unknown>): Promise<void>;
}

/** Findings-issue retries are capped per tick so no gh call delays harvesting. */
export const MAX_PUSH_FINDINGS_RETRIES = 2;

export async function deliveryPasses(
  q: Queue,
  log: string[],
  dry: boolean,
  fx: DeliveryEffects,
): Promise<void> {
  if (dry) return;
  await fx.reconcileCompleted(q);
  // Rotation by last attempt keeps a failing delivery from starving later ones.
  const candidates = fx
    .liveItems(q)
    .filter((i) => truthy(i.issue_pending) && i.kind === fx.pushCurrentKind)
    .map((item) => ({
      item,
      key: (truthy(item.issue_attempt_at) ? item.issue_attempt_at : '') as string,
    }))
    .sort((a, b) => cmpCodePoints(a.key, b.key));
  for (const { item: pending } of candidates.slice(0, MAX_PUSH_FINDINGS_RETRIES)) {
    pending.issue_attempt_at = fx.iso();
    const msg = await fx.deliverPushFindings(q, pending);
    if (msg) log.push(msg);
  }
  log.push(...(await fx.deliverPendingPrReviews(q)));
  log.push(...(await fx.deliverPendingCleanReviews(q)));
  log.push(...(await fx.deliverPendingReviewRefreshes(q)));
  await fx.repairBackfill(q);
  await fx.repairArchiveLegacy(q);
  const result = await fx.reconcileFixPrs(q);
  // Only a counts dict is a report; anything else reports nothing.
  const r: Record<string, unknown> =
    typeof result === 'object' && result !== null && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : {};
  const get = (k: string): unknown => (k in r ? r[k] : 0);
  if (truthy(r.examined)) {
    log.push(
      `reconcile: ${pyStr(get('examined'))} examined, ${pyStr(get('projected'))} projected, ` +
        `${pyStr(get('starved'))} starved, ${pyStr(get('deferred'))} deferred`,
    );
  }
  if (truthy(r.starved) || truthy(r.deferred)) {
    await fx.event('reconcile_incomplete', {
      examined: get('examined'),
      projected: get('projected'),
      starved: get('starved'),
      deferred: get('deferred'),
      errors: truthy(r.errors) ? r.errors : [],
    });
  }
}
