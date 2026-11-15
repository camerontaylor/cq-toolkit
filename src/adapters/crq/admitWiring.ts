/**
 * `TickPhases.admit` bound to `admitAvailable`: the gate and budget come from
 * `admissionDecision`, the loop from `admitAvailable`, and each launch from the
 * injected per-kind `startOne`. Inactive: nothing imports this from a runtime
 * entry point.
 *
 * Python's `admit_available` mutates the queue, so its effect counters see what
 * `start_one` wrote. Here the live queue is a closed-over variable that each
 * `startOne` result replaces, and the counters read it on every call.
 */
import { JsonObject, toPlainJson } from '../../policy/crq/jsonValue.js';
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

export function bindAdmit(env: AdmitEnv): TickPhases['admit'] {
  return async (queue, request): Promise<AdmissionOutcome> => {
    const usage = (request.usage ?? null) as VendorUsage | null;
    const held = request.reserved as readonly ReservationHold[];
    let live = queue;
    const decision = admissionDecision({
      queue: toPlainJson(queue) as Record<string, unknown>,
      usage,
      held,
      config: env.config,
      nowMicros: env.nowMicros(),
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
