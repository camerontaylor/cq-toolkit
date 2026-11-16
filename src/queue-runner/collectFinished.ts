/**
 * `collect_finished` (crq.py:3238): harvest terminal detached reviews only; no
 * enrollment, repairs or promotion audits. Inactive: nothing imports this
 * outside tests. Every effect is injected; items are plain records edited in
 * place and the caller owns tick.lock.
 */
export type Item = Record<string, unknown>;
export type Queue = Record<string, unknown> & { items: Item[] };

export interface CollectFinishedEffects {
  /** `live_items(q)`; read once, as Python's `list(live_items(q))`. */
  liveItems(q: Queue): Item[];
  /** `local_review_runtime.KIND`. */
  readonly localReviewKind: string;
  /** `local_review_runtime.republish(module, q, item)`. */
  republish(q: Queue, item: Item): Promise<void>;
  /** `(RUNS / run_id / "exit.json").exists()`. */
  exitFileExists(runId: string): Promise<boolean>;
  /** `run_liveness(rdir, item, run, True)`; only "harvest" may be collected. */
  runLiveness(runId: string, item: Item, run: Item): Promise<string>;
  /** `harvest_review(q, item, False)`; a truthy message is logged. */
  harvestReview(q: Queue, item: Item): Promise<string | null | undefined>;
  /** `local_review_runtime.reconcile_completed(module, q)`. */
  reconcileCompleted(q: Queue): Promise<void>;
}

function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object' && v !== null) return Object.keys(v).length > 0;
  return Boolean(v);
}

/**
 * Errors from any seam propagate and skip the remaining items and the final
 * reconcile, exactly as an uncaught Python exception does. `item["state"]` and
 * `run["run_id"]` are KeyError in Python, so a missing value throws here.
 */
export async function collectFinished(
  q: Queue,
  log: string[],
  fx: CollectFinishedEffects,
): Promise<void> {
  for (const item of [...fx.liveItems(q)]) {
    if (item.kind === fx.localReviewKind && truthy(item.publication_pending))
      await fx.republish(q, item);
    if (!('state' in item)) throw new TypeError('item.state missing');
    if (item.state !== 'reviewing' || !truthy(item.run)) continue;
    const run = item.run as Item;
    if (typeof run.run_id !== 'string') throw new TypeError('run.run_id missing');
    if (!(await fx.exitFileExists(run.run_id))) continue;
    // Live or unverifiable owners retain their capacity.
    if ((await fx.runLiveness(run.run_id, item, run)) !== 'harvest') continue;
    const msg = await fx.harvestReview(q, item);
    if (msg) log.push(msg);
  }
  await fx.reconcileCompleted(q);
}
