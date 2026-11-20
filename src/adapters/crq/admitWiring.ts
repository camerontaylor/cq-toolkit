/**
 * `TickPhases.admit` bound to `admitAvailable`: the gate and budget come from
 * `admissionDecision`, the loop from `admitAvailable`, and each launch from the
 * injected per-kind `startOne`. Inactive: nothing imports this from a runtime
 * entry point.
 *
 * Before the gate, Python's `admit_available` records the usage read
 * (`q["usage"]`), binds it to the local holds (`backfill_runtime.usage_context`:
 * `backfill_usage`, reflected and expired backfill holds) and stamps
 * `backfill_starts_at_observation`. That happens whatever the gate then says,
 * dry runs included, so it is applied to the queue first and the decision reads
 * the bound queue, as Python's mutated `q` does.
 *
 * Python's `admit_available` mutates the queue, so its effect counters see what
 * `start_one` wrote. Here the live queue is a closed-over variable that each
 * `startOne` result replaces, and the counters read it on every call.
 */
import { usageContext } from '../../ops/crq/internal/backfillGate.js';
import { JsonNumber, JsonObject, toPlainJson, type JsonValue } from '../../policy/crq/jsonValue.js';
import { fromPlainJson, withObjectKeys } from '../../policy/crq/queueDoc.js';
import {
  admissionDecision,
  type AdmissionConfig,
  type ReservationHold,
} from '../../policy/crq/tickAdmission.js';
import { inflight } from '../../policy/crq/tickSchedule.js';
import type { VendorUsage } from '../../policy/crq/usageSlots.js';
import { admitAvailable } from '../../queue-runner/admitAvailable.js';
import type { AdmissionOutcome, TickPhases } from '../../queue-runner/tickOrchestrator.js';

export interface StartOneContext {
  readonly dry: boolean;
  readonly only: string | null;
  readonly ignoreQuiet: boolean;
}

export interface StartOneResult {
  readonly queue: JsonObject;
  /** The operator lines `start_one` appended (its own, not the gate's). */
  readonly log: readonly string[];
  readonly hasCoverage: boolean;
}

export interface AdmitEnv {
  /** `config.max_*`, read once per tick. */
  readonly config: AdmissionConfig;
  /** `crq.now()` in epoch microseconds. */
  nowMicros(): bigint;
  /** `start_one`: select and launch one candidate, returning the new queue. */
  startOne(queue: JsonObject, context: StartOneContext): Promise<StartOneResult>;
}

const startsCount = (queue: JsonObject): number => {
  const starts = queue.get('starts');
  return Array.isArray(starts) ? starts.length : 0;
};

/** `crq.iso()`: whole seconds, UTC, trailing `Z` (Python's `strftime` floors). */
const isoSeconds = (micros: bigint): string =>
  `${new Date(Number(micros / 1000n)).toISOString().slice(0, 19)}Z`;

/**
 * `q["usage"] = usage`, `backfill_runtime.usage_context(...)` and
 * `q["backfill_starts_at_observation"] = len(q["starts"])`, in Python's order so
 * the saved queue keeps Python's key order.
 */
function bindUsage(
  queue: JsonObject,
  usage: VendorUsage | null,
  held: readonly ReservationHold[],
  nowMicros: bigint,
): JsonObject {
  const observed = usage === null ? null : fromPlainJson(usage);
  if (observed !== null && !(observed instanceof JsonObject))
    throw new TypeError('usage must be an object or null');
  // A missing `run.started_at` is Python's `None`, which `usage_context` matches
  // against a represented item that also has no start time.
  const stamps: JsonValue[] = held.map((hold) => fromPlainJson(hold.startedAt ?? null));
  const recorded = withObjectKeys(queue, [['usage', observed]]);
  const bound = usageContext(recorded, observed, stamps, isoSeconds(nowMicros));
  return withObjectKeys(bound, [
    ['backfill_starts_at_observation', JsonNumber.int(startsCount(bound))],
  ]);
}

export function bindAdmit(env: AdmitEnv): TickPhases['admit'] {
  return async (queue, request): Promise<AdmissionOutcome> => {
    const usage = (request.usage ?? null) as VendorUsage | null;
    const held = request.reserved as readonly ReservationHold[];
    const nowMicros = env.nowMicros();
    let live = bindUsage(queue, usage, held, nowMicros);
    const decision = admissionDecision({
      queue: toPlainJson(live) as Record<string, unknown>,
      usage,
      held,
      config: env.config,
      nowMicros,
    });
    const lines: string[] = [];
    const only = request.only === null || request.only === '' ? undefined : request.only;
    const result = await admitAvailable(
      { decision, maxInflight: env.config.maxInflight, dry: request.dry, only },
      {
        startsCount: () => startsCount(live),
        inflightCount: () => inflight(toPlainJson(live) as Record<string, unknown>).length,
        startOne: async () => {
          const out = await env.startOne(live, {
            dry: request.dry,
            only: request.only,
            ignoreQuiet: request.ignoreQuiet,
          });
          live = out.queue;
          lines.push(...out.log);
          return { hasCoverage: out.hasCoverage };
        },
      },
    );
    return {
      queue: live,
      log: [...result.log, ...lines],
      hasCoverage: result.hasCoverage,
      globalGate: result.gate,
      remaining: result.remaining,
    };
  };
}
