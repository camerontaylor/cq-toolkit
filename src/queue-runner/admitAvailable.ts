/**
 * The admission loop of `crq.admit_available`, split from the selection it
 * drives. Inactive: nothing here is bound to `tick`, `slot` or a unit.
 *
 * `admissionDecision` already computes slots, the per-tick budget and the first
 * failing global gate. What Python does next is a `while` loop that calls
 * `start_one` until the journaled reservations spent reach the budget. The loop
 * counts real `queue.starts` growth rather than assuming one call spends one
 * slot, because an unknown-delivery launch still owns its journaled admission
 * and a refusal or an empty selection reserves nothing.
 *
 * The caller owns tick.lock for the whole pass, supplies the decision, and
 * binds `startOne` to the per-kind selection (S6 remaining work). The effect
 * counters read the live queue each time, so they see what `startOne` wrote.
 */
import type { AdmissionDecision } from '../policy/crq/tickAdmission.js';

export interface AdmitAvailableEffects {
  /** `len(q.get("starts", []))`, read live. */
  startsCount(): number;
  /** `len(crq.inflight(q))`, read live. */
  inflightCount(): number;
  /** `start_one(...)`; the flag is its `has_coverage` result. */
  startOne(): Promise<{ hasCoverage: boolean }>;
}

export interface AdmitAvailableInput {
  readonly decision: AdmissionDecision;
  /** `config.max_inflight`, Python's `.get(..., 10)`. */
  readonly maxInflight: number;
  readonly dry: boolean;
  /** `only`: a non-empty item id restricts the pass to one start. */
  readonly only?: string | undefined;
}

export interface AdmitAvailableResult {
  readonly hasCoverage: boolean;
  readonly gate: AdmissionDecision['gate'];
  /** `max(0, slots - spent)`, the input to the next-slot deadline. */
  readonly remaining: number;
  /** Reservations journaled by this pass. */
  readonly spent: number;
  /** The gate's operator line(s); `startOne` appends its own through its caller. */
  readonly log: readonly string[];
}

export async function admitAvailable(
  input: AdmitAvailableInput,
  effects: AdmitAvailableEffects,
): Promise<AdmitAvailableResult> {
  const { decision, maxInflight } = input;
  const only = input.only !== undefined && input.only !== '';
  const beforeAll = effects.startsCount();
  let hasCoverage = false;
  if (decision.gate === null) {
    while (
      effects.startsCount() - beforeAll < decision.admissions &&
      effects.inflightCount() < maxInflight
    ) {
      const before = effects.startsCount();
      const started = await effects.startOne();
      hasCoverage = hasCoverage || started.hasCoverage;
      const after = effects.startsCount();
      // The journal is append-only within a pass; a shrink would spin forever.
      if (after < before) throw new Error('queue starts shrank during admission');
      // A dry run, refusal or no eligible candidate cannot reserve more.
      if (input.dry || only || after === before) break;
      if (effects.inflightCount() >= maxInflight) break;
    }
  }
  const spent = effects.startsCount() - beforeAll;
  return {
    hasCoverage,
    gate: decision.gate,
    remaining: Math.max(0, decision.slots - spent),
    spent,
    log: decision.log,
  };
}
