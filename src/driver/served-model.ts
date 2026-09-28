// Shared served-model assertion (ADR-0002 §2.6) — the post-dispatch defence
// against the silent-remap footgun, applied to EVERY factory-resolved driver.
//
// A driver reports the model id it OBSERVED on the response; callers must not
// silently accept a response served by a different model than the invocation
// requested. This wrapper is deliberately fail-closed and has no record mode
// and no off switch: the only safe action on a mismatch is to return an error
// verdict (the spend was real — usage/cost/session evidence is kept — but the
// payload is not a model outcome the requested model produced).
//
// ADR-0002 §2.6 design, locked:
//   - Lane-scoped policy: normalisation and aliases are declared PER LANE,
//     never global. `WorkerResult.model` keeps the RAW observation on every
//     verdict (v1 meaning unchanged); only the CHECK normalises.
//   - No narration wire field: the frozen WorkerResult shape gains nothing.
//     The "record" of a pass is the exported pure helper's return value
//     ({@link servedModelCheck}), which tests and the conformance suite
//     consume directly.
//   - The wrapper forwards the `RunOptions` second parameter to the inner
//     driver UNCHANGED — a fewer-parameter wrapper would compile and then
//     silently drop the cancellation signal (conformance leg b-v catches a
//     lane that does that; this wrapper must not be the offender).
import { boundedErrorText } from './error-text.js';
import type { Driver, OpInvocation, RunOptions, WorkerResult } from './types.js';

/**
 * The four first-party lanes (ADR-0002 §2.5/§2.6). One definition, shared
 * with the driver factory — never duplicated per module.
 */
export type LaneId = 'ai-sdk' | 'claude-agent' | 'subprocess' | 'acp';

/**
 * Per-lane served-model policy (ADR-0002 §2.6):
 *   - `aliases` — declared wire remaps, LANE-scoped: lane → provider →
 *     requested id → admitted served ids. Keys and members are compared in
 *     NORMALISED form ({@link normaliseModelId}), so a declaration admits a
 *     wire spelling of the same id on that lane only.
 *   - `requireObserved` — per lane: must a completed run report a served id?
 *     Default TRUE on every lane; `false` admits an UNOBSERVED id (a lane
 *     that cannot observe it) — never an observed-but-mismatching one.
 */
export interface ServedModelPolicy {
  /** Declared wire remaps, LANE-scoped: lane → provider → requested id → admitted served ids (normalised). */
  aliases?: Readonly<
    Partial<Record<LaneId, Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>>>
  >;
  /** Per lane: must a completed run report a served id? Default true on every lane. */
  requireObserved?: Readonly<Partial<Record<LaneId, boolean>>>;
}

/** The lane + policy pair every served-model entry point takes. */
export interface ServedModelOptions {
  /** The lane whose normalisation and policy scope apply. */
  lane: LaneId;
  /** The deployment's declared remaps/observation requirements. */
  policy?: ServedModelPolicy;
}

/**
 * Lane-declared, ANCHORED model-id normalisation (ADR-0002 §2.6):
 *   - ai-sdk / claude-agent / subprocess — IDENTITY (no case-folding: model
 *     ids are compared byte-exactly, as the lanes report them);
 *   - acp — strips EXACTLY ONE leading `builtin:<provider>\` namespace
 *     (the ACP wire qualifies the served id with its provider) and
 *     case-folds the remainder. A `builtin:`-less id is only case-folded;
 *     a second namespace is left in place (one strip, never a loop).
 */
export function normaliseModelId(lane: LaneId, id: string): string {
  if (lane !== 'acp') return id;
  const namespaced = /^builtin:[^\\]+\\/.exec(id);
  return (namespaced === null ? id : id.slice(namespaced[0].length)).toLowerCase();
}

/**
 * The verdict of one served-model check. Frozen `via` vocabulary:
 *   - `'exact'`             — the normalised served id equals the normalised
 *                             requested id;
 *   - `'alias'`             — the normalised pair is a declared alias for
 *                             THIS lane (`aliases[lane][provider][requested]`
 *                             includes the normalised served id);
 *   - `'unobserved-allowed'` — no id was observed and the lane's
 *                             `requireObserved` is false. An OBSERVED id is
 *                             never admitted through this branch.
 * A failure carries the bounded-shape mismatch text that becomes the error
 * verdict's `error` field verbatim.
 */
export type ServedModelCheck =
  | { pass: true; via: 'exact' | 'alias' | 'unobserved-allowed' }
  | { pass: false; reason: string };

/** Own-property-guarded alias lookup: normalised pair declared for this lane? */
function declaredAlias(
  opts: ServedModelOptions,
  provider: string,
  requestedNormalised: string,
  servedNormalised: string,
): boolean {
  const laneAliases = opts.policy?.aliases?.[opts.lane];
  if (laneAliases === undefined || !Object.prototype.hasOwnProperty.call(laneAliases, provider)) {
    return false;
  }
  const byRequested = laneAliases[provider];
  if (byRequested === undefined) return false;
  if (!Object.prototype.hasOwnProperty.call(byRequested, requestedNormalised)) return false;
  const admitted = byRequested[requestedNormalised];
  return admitted !== undefined && admitted.includes(servedNormalised);
}

/**
 * The pure served-model judgment of ONE result on ONE lane (the exported
 * record the wrapper's decision is made from — tests and the conformance
 * suite consume it directly; there is no narration wire field). Judges the
 * served-id observation only; the wrapper applies it exclusively to
 * `stopReason: 'complete'` results.
 */
export function servedModelCheck(
  invocation: OpInvocation,
  result: WorkerResult,
  opts: ServedModelOptions,
): ServedModelCheck {
  const requested = invocation.modelSpec.model;
  if (result.model === undefined) {
    if (opts.policy?.requireObserved?.[opts.lane] === false) {
      return { pass: true, via: 'unobserved-allowed' };
    }
    return { pass: false, reason: `requested '${requested}', served unobserved` };
  }
  const servedNormalised = normaliseModelId(opts.lane, result.model);
  if (servedNormalised === normaliseModelId(opts.lane, requested)) {
    return { pass: true, via: 'exact' };
  }
  if (
    declaredAlias(
      opts,
      invocation.modelSpec.provider,
      normaliseModelId(opts.lane, requested),
      servedNormalised,
    )
  ) {
    return { pass: true, via: 'alias' };
  }
  return { pass: false, reason: `requested '${requested}', served '${result.model}'` };
}

/** A completed result minus its structured payload (the mismatch verdict drops it). */
function withoutStructuredOutput<T extends WorkerResult>(value: T): T {
  if (value.structuredOutput === undefined) return value;
  const { structuredOutput: _discarded, ...rest } = value;
  return rest as T;
}

/**
 * Wrap a concrete driver with the shared fail-closed served-model contract
 * (ADR-0002 §2.6). Only `stopReason: 'complete'` results are judged — a
 * failed/aborted/budget verdict is already not a model outcome. On a mismatch
 * the verdict is rewritten to `stopReason: 'error'` with
 * `errorClass: 'served-model-mismatch'` and the bounded mismatch text, the
 * structuredOutput is DROPPED, and every spend fact (usage, costUSD,
 * costBasis, sessionId, denials, providerSignals — and the RAW observed id)
 * is KEPT. The `RunOptions` second parameter is forwarded to the inner
 * driver unchanged.
 */
export function withServedModelAssertion(driver: Driver, opts: ServedModelOptions): Driver {
  return {
    async run(invocation: OpInvocation, options?: RunOptions): Promise<WorkerResult> {
      const result = await driver.run(invocation, options);
      if (result.stopReason !== 'complete') return result;
      const check = servedModelCheck(invocation, result, opts);
      if (check.pass) return result;
      return withoutStructuredOutput({
        ...result,
        stopReason: 'error',
        errorClass: 'served-model-mismatch',
        error: boundedErrorText(check.reason),
      });
    },
  };
}
