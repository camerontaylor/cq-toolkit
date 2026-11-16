/** Inactive file/git/forge binding of the tick's reconcile phase seam
 * (`ReconcilePhaseEffects`). tick.lock stays caller-owned. The counting envelope
 * (`runReconcileFixPrs`), the per-run body (`reconcileFixRun`), its adapter and the
 * receipt-lane error rewrite are the already-ported pieces; this binds their reads
 * (budgeted `gh pr view`, git ancestry) and their persistence (atomic queue.json,
 * saved after every item update and before any error is counted).
 *
 * Still caller-injected, because no TS body exists yet: merge proof selection,
 * revalidation recheck, finding outcome marking and source publication.
 */
import { join } from 'node:path';
import { JsonObject } from '../../policy/crq/jsonValue.js';
import { REVIEW_RECEIPT_KIND } from '../../policy/crq/tickSchedule.js';
import type { ForgeBudget } from '../../policy/crq/forgeBudget.js';
import { reconcileCurrentRepair } from '../../ops/crq/internal/reconcileCurrentRepair.js';
import {
  reconcileFixRun,
  type ReconcileFixRunEffects,
} from '../../ops/crq/internal/reconcileFixRun.js';
import { makeFixRunAdapter } from '../../ops/crq/internal/reconcileFixRunAdapter.js';
import { reconcileReceiptLane } from '../../ops/crq/internal/receiptLaneError.js';
import { runReconcileFixPrs } from '../../ops/crq/reconcileFixPrs.js';
import type { ReconcilePhaseEffects } from '../../queue-runner/tickDiscoveryPhase.js';
import type { GhFn } from '../forge-github/gh.js';
import type { RunGit } from './ledgerGit.js';
import { atomicWrite } from './atomic.js';
import { queueBytes } from './queueEffects.js';
import { fileCurrentRepairEffects } from './repairCurrentSource.js';

export interface ReconcilePhaseSourceOptions {
  readonly stateRoot: string;
  readonly clone: string;
  readonly repo: string;
  readonly gh?: GhFn;
  readonly runGit?: RunGit;
  readonly now?: () => Date;
  readonly fixRun: Pick<
    ReconcileFixRunEffects,
    'proveMerge' | 'recheckRevalidation' | 'markFixedOutcome' | 'publishSource'
  >;
  readonly event: ReconcilePhaseEffects['event'];
}

export function fileReconcilePhaseEffects(
  options: ReconcilePhaseSourceOptions,
): ReconcilePhaseEffects {
  const now = options.now ?? (() => new Date());
  return {
    event: options.event,
    async reconcile(queue: JsonObject, budget: ForgeBudget) {
      const rawItems = queue.get('items');
      if (!Array.isArray(rawItems)) throw new Error('queue items must be an array');
      let working = queue;
      const repair = fileCurrentRepairEffects({
        stateRoot: options.stateRoot,
        clone: options.clone,
        repo: options.repo,
        budget,
        ...(options.gh ? { gh: options.gh } : {}),
        ...(options.runGit ? { runGit: options.runGit } : {}),
      });
      /** Replace the item with the same id, then save before anything else runs. */
      const install = async (next: JsonObject): Promise<void> => {
        const list = working.get('items');
        if (!Array.isArray(list)) throw new Error('queue items must be an array');
        const at = list.findIndex((v) => v instanceof JsonObject && v.get('id') === next.get('id'));
        if (at < 0) throw new Error('reconciled item vanished from the queue');
        working = new JsonObject(
          working.entries.map(([k, v]) =>
            k === 'items' ? [k, list.map((v2, i) => (i === at ? next : v2))] : [k, v],
          ),
        );
        await atomicWrite(join(options.stateRoot, 'queue.json'), queueBytes(working));
      };
      const fixEffects: ReconcileFixRunEffects = {
        ...options.fixRun,
        prInfo: (number) => repair.prInfo(number),
        defaultTip: () => repair.resolveRef(repair.targetRef('promoted-main')),
        isAncestor: (a, d) => repair.isAncestor(a, d),
        now: () => `${now().toISOString().slice(0, 19)}Z`,
      };
      const adapter = makeFixRunAdapter({
        items: rawItems as JsonObject[],
        isReceipt: (item) => item instanceof JsonObject && item.get('kind') === REVIEW_RECEIPT_KIND,
        reconcileReceipt: (item) => {
          if (!(item instanceof JsonObject)) throw new Error('receipt item is not a JSON object');
          return reconcileReceiptLane(item, {
            async reconcile(it) {
              const result = await reconcileCurrentRepair(it, repair);
              await install(result.item);
              return {
                starved: result.starved,
                deferred: result.deferred,
                errors: result.errors,
              };
            },
            persist: install,
          });
        },
        reconcile: (item, run) => reconcileFixRun(item, run, fixEffects),
        persist: (item) => install(item),
      });
      return runReconcileFixPrs(adapter.effects);
    },
  };
}
