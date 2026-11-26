/**
 * `HarvestReviewEffects.backfillHarvest`: Python `backfill_runtime.harvest`
 * (`backfill_runtime.py:355`) as one effect over the plain queue the harvest
 * phase holds. Inactive: nothing imports this from a runtime entry point, and
 * it is not routed.
 *
 * Signature mapping (Python caller `crq.py:2824`
 * `backfill_runtime.harvest(sys.modules[__name__], q, item, rdir, meta, cls, exit_code,
 * terminal_verified=(state == "harvest"))`):
 * - `c` (the crq module)      -> the injected deps below (`stateEvent`, `saveQueue`,
 *   `cleanup` = `remove_worktree`, `defaultBackoffMinutes` = `CONFIG`, `stateRoot` = `c.STATE`)
 * - `queue`, `item`           -> `q`, `item` (plain, mutated in place; `item` keeps its identity)
 * - `rdir`                    -> `stateRoot/runs/<runId>`, read through the run-artifact readers
 * - `meta`, `exit_code`       -> re-read from `meta.json` / `exit.json` and checked against
 *   `runId`, `item.id`, `attempt_id` and the passed `exitCode`
 * - `classification`          -> `cls`: only `counted` picks the arm; the bytes are re-classified
 * - `terminal_verified`       -> `terminalVerified`, which must be `true` (see below)
 * - return `"backfill <state>"` / the retain-ownership strings -> the same strings
 *
 * Bound: the dispatch, the plain/immutable queue bridge, and the two harvest arms
 * (`harvestBackfillCounted`, `harvestBackfillFailure`). Left injected: git (`repo`), the
 * publication outbox, the finding inbox, the durable artifact store, `state_event`,
 * queue save and worktree cleanup.
 *
 * Deliberate deviations from Python (each pinned by `backfillHarvestEffect.test.ts`):
 * - Python trusts the passed `meta`/`exit_code` and only checks identity for the quota and
 *   mixed-cause arms; this effect always requires `terminalVerified === true` and a matching
 *   `meta.json`/`exit.json`, and throws `LedgerIntegrityError` otherwise. Python's unverified
 *   return strings ("retain run ownership") are therefore unbound, as is Python finishing a
 *   plain failure when `terminal_verified` is false.
 * - Where a quota refusal has no usable cooldown, or every cause is vendor quota but the outcome
 *   is not `rate_limited`, Python returns a retain-ownership string or terminals with that
 *   outcome; the ops port leaves the queue untouched. This effect throws `LedgerIntegrityError`
 *   rather than silently skip it.
 * - For a non-quota failure Python trusts the passed `cls` for `outcome`, `retry_after` and
 *   `message` (`backfill_runtime.py:408-409`); the failure port uses the re-classified bytes
 *   (the same values whenever `cls` describes those bytes, the only case the oracle can drive).
 * - A missing reservation is a `TypeError` here where Python returns the unverified string.
 * - On a quota+hard-cause mix Python saves the new cooldown before the terminal; the ops port
 *   saves once, at the end.
 * - Python's `KeyError` for an `exit.json` without `ended_at` is a `LedgerTypeError` here.
 * - The ops harvest appends the attempt record Python's caller (`harvest_review`) appends; the
 *   TS caller (`harvestReview.ts`) re-checks and only appends when absent, so the end state agrees.
 */
import {
  harvestBackfillFailure,
  type BackfillFailureHarvestEffects,
} from '../../ops/crq/internal/backfillHarvest.js';
import { harvestBackfillCounted } from '../../ops/crq/internal/backfillHarvestCounted.js';
import { type JsonObject, toPlainJsonRetainingNumbers } from '../../policy/crq/jsonValue.js';
import { LedgerIntegrityError } from '../../policy/crq/ledger.js';
import { fromPlainJson } from '../../policy/crq/queueDoc.js';
import { type HarvestReviewEffects, py } from '../../queue-runner/harvestReview.js';
import { backfillCountedEffects } from './backfillCountedEffects.js';
import { backfillArtifactReader } from './backfillHarvestArtifacts.js';
import { readBackfillRollout } from './backfillRollout.js';

export type BackfillHarvestEffectDeps = Parameters<typeof backfillCountedEffects>[0] & {
  /** `c.CONFIG["rate_limit_default_backoff_min"]`. */
  readonly defaultBackoffMinutes?: number;
};

type Plain = Record<string, unknown>;

/** Replace `target`'s own keys with `source`'s, keeping the object's identity. */
function replaceContents(target: Plain, source: Plain): void {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, source);
}

export const UNSUPPORTED_SCOPE_MESSAGE =
  'backfill terminal unverified scope; quarantine and retain evidence';
export const UNBOUND_QUOTA_OUTCOME =
  'backfill harvest: quota failure the ops port leaves unhandled (no usable cooldown, or quota causes without a rate_limited outcome)';

export function backfillHarvestEffect(
  deps: BackfillHarvestEffectDeps,
): HarvestReviewEffects['backfillHarvest'] {
  return async (q, item, runId, _meta, cls, exitCode, terminalVerified) => {
    // `settings(c.STATE)` is read first; an unconfigured rollout cannot harvest.
    if ((await readBackfillRollout(deps.stateRoot)) === null)
      throw new LedgerIntegrityError(
        'cannot harvest backfill without durable rollout configuration',
      );
    const plainQueue = q as unknown as Plain;
    const index = Array.isArray(plainQueue.items) ? plainQueue.items.indexOf(item) : -1;
    if (index < 0) throw new LedgerIntegrityError('backfill item is not in the queue');
    if (terminalVerified !== true || exitCode === null)
      throw new LedgerIntegrityError('backfill terminal ownership not verified');
    // `if meta.get("worktree") and meta.get("wt_branch")` sits inside Python `harvest`.
    const cleanup: BackfillFailureHarvestEffects['cleanup'] = async (meta) => {
      if (py(meta.get('worktree')) && py(meta.get('wt_branch'))) await deps.cleanup(meta);
    };
    const proof = { runId, exitCode, terminalVerified: true } as const;
    const initial = fromPlainJson(q) as JsonObject;
    const classification = fromPlainJson(cls) as JsonObject;
    let next: JsonObject;
    let message: string | null = null;
    if (py(cls.counted)) {
      const done = await harvestBackfillCounted(
        initial,
        index,
        proof,
        backfillCountedEffects({ ...deps, cleanup }),
        classification,
      );
      next = done.queue;
      if (done.status === 'unsupported') message = UNSUPPORTED_SCOPE_MESSAGE;
    } else {
      const effects: BackfillFailureHarvestEffects = {
        readArtifacts: backfillArtifactReader(deps.stateRoot),
        retain: async (bytes) => {
          await deps.store.put(bytes);
        },
        stateEvent: deps.stateEvent,
        saveQueue: deps.saveQueue,
        cleanup,
      };
      const done = await harvestBackfillFailure(
        initial,
        index,
        proof,
        effects,
        deps.defaultBackoffMinutes,
      );
      if (done.status === 'unhandled') throw new LedgerIntegrityError(UNBOUND_QUOTA_OUTCOME);
      next = done.queue;
    }
    // Python mutates `queue` and `item` in place and the caller keeps using both.
    const rebuilt = toPlainJsonRetainingNumbers(next) as Plain;
    const oldItems = plainQueue.items as Plain[];
    const isRecord = (v: unknown): v is Plain =>
      typeof v === 'object' && v !== null && !Array.isArray(v);
    (rebuilt.items as unknown[]).forEach((row, i) => {
      // Slots the schedule never visits (null, scalars) have no identity to keep: take the new value.
      const slot: unknown = oldItems[i];
      if (isRecord(slot) && isRecord(row)) replaceContents(slot, row);
      else oldItems[i] = row as Plain;
    });
    replaceContents(plainQueue, { ...rebuilt, items: oldItems });
    return message ?? `backfill ${String(item.state)}`;
  };
}
