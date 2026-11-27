/**
 * The seam between the serial item loop (`processRepairItem`, Python
 * `process_item`) and the rung machine (`runRepairProcess`, Python `process`).
 *
 * `process_item` calls `process(config, job, wt)` with a parsed job dict and
 * reads `res.get('retry_after')`, `res['verdict']` and `res['commits'][-1]`
 * from the dict it returns. The two ports speak different value models: the
 * item loop works on `JsonObject` (order-keeping, `JsonNumber` leaves), the rung
 * machine on plain objects that retain `JsonNumber` leaves. This module owns
 * only that conversion and the composition; every decision stays in the two
 * ports, and every effect stays injected.
 *
 * INERT: nothing imports this outside tests. It does not bind
 * `RepairDrainEffects.processItem` (see `REPAIR_UNIT_MISSING_EFFECTS`), is not
 * routed, spawns nothing and reaches no provider.
 *
 * Known representation limit, inherited from the rung machine: a result is a
 * plain object, so integer-like keys would sort ahead of other keys on the way
 * back to a `JsonObject`. Every key a repair result carries is non-integer.
 */
import type { RepairItemContext, RepairItemEffects } from '../ops/crq/internal/repairItemLoop.js';
import { processRepairItem, RepairItemShapeError } from '../ops/crq/internal/repairItemLoop.js';
import {
  JsonNumber,
  JsonObject,
  toPlainJsonRetainingNumbers,
  type JsonValue,
} from '../policy/crq/jsonValue.js';
import { runRepairProcess, type RepairRungEffects } from './repairRungMachine.js';

/** What the item loop's `process` effect needs besides the job and its worktree. */
export interface RepairProcessBinding {
  /** The loaded crq config as plain JSON (numbers retained as `JsonNumber`). */
  readonly config: unknown;
  /** `ROOT`: the state root whose `state/repair/<job>` holds each job's directory. */
  readonly root: string;
  readonly effects: RepairRungEffects;
}

/** Plain parsed JSON (numbers as `JsonNumber`, native ints/floats, dicts as objects) as a `JsonValue`. */
export function toJsonValue(value: unknown): JsonValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean' || typeof value === 'string') return value;
  if (value instanceof JsonNumber || value instanceof JsonObject) return value;
  if (typeof value === 'bigint') return JsonNumber.int(value);
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? JsonNumber.int(value) : JsonNumber.float(value);
  }
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (typeof value === 'object') {
    return new JsonObject(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        toJsonValue(entry),
      ]),
    );
  }
  throw new TypeError(`not a JSON value: ${typeof value}`);
}

/**
 * `process(config, job, wt)` as `RepairItemEffects.process`. Errors the rung
 * machine lets escape propagate unchanged, as they escape Python's `process`.
 * A result that is not an object (a hand-edited `result.json` returned as the
 * prior) fails at the caller's `res.get(...)`, so it is refused here with the
 * item loop's shape error.
 */
export function bindRepairProcess(binding: RepairProcessBinding): RepairItemEffects['process'] {
  return async (job: JsonObject, worktree: string): Promise<JsonObject> => {
    const result = await runRepairProcess(
      {
        config: binding.config,
        job: toPlainJsonRetainingNumbers(job),
        worktree,
        root: binding.root,
      },
      binding.effects,
    );
    const converted = toJsonValue(result);
    if (!(converted instanceof JsonObject)) {
      throw new RepairItemShapeError('AttributeError: result has no attribute get');
    }
    return converted;
  };
}

/**
 * `RepairDrainEffects.processItem` over injected effects: the serial loop with
 * its `process` effect bound to the rung machine. The item effects' own
 * `process` is replaced, so a caller cannot half-bind the two.
 */
export function bindRepairProcessItem(
  binding: RepairProcessBinding,
  itemEffects: Omit<RepairItemEffects, 'process'>,
): (jobs: JsonObject[], context: RepairItemContext) => Promise<string | null> {
  const process = bindRepairProcess(binding);
  return (jobs, context) => processRepairItem(jobs, context, { ...itemEffects, process });
}
