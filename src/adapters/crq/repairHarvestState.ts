/**
 * The three state-facing seams `repair_tick.harvest` still needed, bound to one `state/`
 * root. Inactive: nothing imports this from a runtime entry point.
 *
 * - `saveQueue`: `c.save_queue(q)` = `atomic(QUEUE, q)` (`publicationFiles.ts`, already
 *   differential-tested against Python's writer). The admission-history compaction log
 *   Python appends afterwards is not reproduced here (`fileRepairSaveQueue` in
 *   `repairHarvestForge.ts` reproduces it): the production TS queue loader refuses a queue
 *   that needs compaction, so there is none to log on this path. A float the harvest stamped (`replay_attempted`)
 *   keeps its `.0` because the writer takes retained `JsonNumber`s.
 * - `requireCanonicalDelivery`: `repairCanonicalDelivery.ts` with `root = dirname(stateRoot)`
 *   (Python's `c.STATE.parent`).
 * - `replayBudget`: `begin_tick(c)` binds a fresh `ReplayBudget()` once per tick, so one call
 *   of this factory is one tick. Python's defaults (25 runs, 240 s, 900 s retry) are the
 *   class's own.
 */
import { dirname } from 'node:path';
import type { JsonValue } from '../../policy/crq/jsonValue.js';
import { ReplayBudget, type RepairHarvestEffects } from '../../queue-runner/repairHarvest.js';
import { filePublicationEffects } from './publicationFiles.js';
import { canonicalDelivery } from './repairCanonicalDelivery.js';

export interface RepairHarvestStateOptions {
  /** `c.STATE`. */
  readonly stateRoot: string;
  /** `finding_inbox(c).publication.retained()`; absent makes a written-back row fail closed. */
  readonly retained?: () => Promise<readonly JsonValue[]>;
}

export type RepairHarvestState = Pick<
  RepairHarvestEffects,
  'requireCanonicalDelivery' | 'saveQueue' | 'replayBudget'
>;

export function repairHarvestState(options: RepairHarvestStateOptions): RepairHarvestState {
  const files = filePublicationEffects({ stateRoot: options.stateRoot });
  return {
    ...canonicalDelivery({
      root: dirname(options.stateRoot),
      ...(options.retained === undefined ? {} : { retained: options.retained }),
    }),
    saveQueue: (q) => files.saveQueue(q),
    // Python's `begin_tick`: one budget per tick. This object owns exactly one, so the
    // caller must build it once per tick; a longer-lived object spends the 25 runs once.
    replayBudget: new ReplayBudget(),
  };
}
