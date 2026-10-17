// Shared verdict semantics for the Claude Code lane — Phase 1.9: the ONE
// stop-reason map, the ONE structured-output judge (with the D-E′ refusal
// void), and the signal predicates both transports fold by. Consolidates
// the two former lanes' per-lane copies, whose divergence here was drift,
// not intent.
//
// STOP REASON (frozen DriverStopReason) — THE mapping, checked in order:
//   1. the governed signal fired → 'aborted'
//   2. a harness failure terminated or invalidated the run → 'error'
//   3. an oversized stdout/stderr line (CLI transport protocol break) →
//      'error'
//   4. real usage folded ≥ Budget.maxTokens → 'budget'
//   5. the result frame's status: 'success' → 'complete';
//      'cap' (the substrate's own caps — error_max_turns /
//      error_max_budget_usd, a stop ON a cap) → 'budget'; 'error' →
//      'error'; 'none' (no result event) → 'error'
// Both transports classify the cap subtypes as 'budget' (the former
// claude-agent rule, now the lane's rule: a stop on the vendor's turn/USD
// cap is a budget stop, frozen DriverStopReason — the former subprocess
// table's "any other result status → error" is superseded for exactly
// those two subtypes, which carry is_error:true on both transports).
//
// REFUSAL (D-E′ F2): `stop_reason: 'refusal'` is the substrate's
// structured statement that the model ENDED ITS RESPONSE BY REFUSING.
// Available on the wire since the 0.3.162-era SDK/CLI vocabulary. The
// pre-0.3.302 defect delivered refused responses THROUGH
// `structured_output`, so a refusal whose payload happens to match the
// requested schema would validate — the payload is NOT a model outcome
// the invocation asked for. THE REFUSAL VOID: when a refusal is observed
// on the run (assistant message or result frame), any structured payload
// is void — the judge settles error/'output-invalid' and the payload
// never reaches the seam, whatever its shape. A refusal on a run with no
// schema request is a normal model outcome (the transcript carries the
// refusal text); the narration marker makes it observable either way.
import type { OutputSchema, Usage, WorkerResult } from '../types.js';
import { validateStructured } from '../common/structured.js';
import { totalTokensOf } from './usage.js';

/**
 * The stable leading text of a harness-classified error verdict
 * (`WorkerResult.error`) — the machine-readable classification prefix
 * beside `errorClass: 'harness'`.
 */
export const HARNESS_ERROR_PREFIX = 'claude-code driver: harness failure';

/**
 * The substrate-internal tool the init frame lists whenever structured
 * output is requested (its native structured-output tool, auto-approved).
 * Pinned into the init-surface assertion's expected set.
 */
export const STRUCTURED_OUTPUT_TOOL = 'StructuredOutput';

/** The terminal result frame's status class for the stop-reason table. */
export type ResultStatus = 'success' | 'cap' | 'error' | 'none';

/**
 * 'success' iff the result frame says so (subtype 'success' AND is_error
 * ≠ true); the substrate's own cap subtypes (error_max_turns /
 * error_max_budget_usd — which carry is_error: true) are checked FIRST and
 * classify as 'cap', a stop ON A CAP is a budget stop; anything else (or
 * no frame) is 'error'/'none'.
 */
export function resultStatusOf(result: Record<string, unknown> | undefined): ResultStatus {
  if (result === undefined) return 'none';
  const subtype = typeof result['subtype'] === 'string' ? (result['subtype'] as string) : undefined;
  if (subtype === 'error_max_turns' || subtype === 'error_max_budget_usd') return 'cap';
  if (result['is_error'] === true) return 'error';
  return subtype === 'success' ? 'success' : 'error';
}

/** Inputs to the frozen stop-reason mapping (header table). */
export interface StopReasonInputs {
  aborted: boolean;
  /** A harness failure terminated or invalidated the run (always an 'error'). */
  harnessFailure?: boolean;
  /** The child flushed an oversized stdout/stderr line (CLI transport only). */
  oversizedLine?: boolean;
  maxTokens: number | undefined;
  usage: Usage;
  resultStatus: ResultStatus;
}

/** THE mapping (checked in order): aborted → harness failure → oversized line → budget → cap → error → complete. */
export function stopReasonOf(inputs: StopReasonInputs): WorkerResult['stopReason'] {
  if (inputs.aborted) return 'aborted';
  if (inputs.harnessFailure === true) return 'error';
  if (inputs.oversizedLine === true) return 'error';
  if (inputs.maxTokens !== undefined && totalTokensOf(inputs.usage) >= inputs.maxTokens)
    return 'budget';
  if (inputs.resultStatus === 'success') return 'complete';
  if (inputs.resultStatus === 'cap') return 'budget';
  return 'error';
}

/** The refusal stop reason, as the substrate spells it on the wire. */
const REFUSAL_STOP_REASON = 'refusal';

/**
 * Whether one wire frame (an assistant message's inner Message, or the
 * result frame) carries the structured refusal stop reason. Defensive: a
 * frame without a string `stop_reason` is simply not a refusal.
 */
export function frameCarriesRefusal(frame: unknown): boolean {
  if (typeof frame !== 'object' || frame === null) return false;
  return (frame as Record<string, unknown>)['stop_reason'] === REFUSAL_STOP_REASON;
}

/** The `model-refusal` narration marker — persisted evidence of the observation. */
export function refusalNarrationMarker(): string {
  return JSON.stringify({ cq: 'model-refusal', stop_reason: REFUSAL_STOP_REASON });
}

/**
 * The §2.3 structured-output judgment (ONE shared judge): the payload is
 * validated over the SAME document that was sent. Returns the validated
 * payload, or the miss reason that settles error/'output-invalid'.
 *
 * THE REFUSAL VOID (header): a refusal observed anywhere on the run voids
 * the payload outright — before the missing-payload and validation checks,
 * so a refused response can never become valid structured output, whatever
 * its shape (the pre-0.3.302 delivered-refusal defect is structurally
 * unreachable through this judge).
 */
export function judgeStructuredOutput(
  schema: OutputSchema,
  result: Record<string, unknown> | undefined,
  refusalSeen: boolean,
): { structured: unknown; miss: string | undefined } {
  if (refusalSeen) {
    return {
      structured: undefined,
      miss: 'the model refused (stop_reason refusal) — the delivered payload is not a model outcome and is void',
    };
  }
  const subtype = typeof result?.['subtype'] === 'string' ? result['subtype'] : undefined;
  if (subtype === 'error_max_structured_output_retries') {
    return {
      structured: undefined,
      miss:
        `the substrate exhausted its native structured-output retries ` +
        `(subtype '${subtype}') without producing the required object`,
    };
  }
  if (resultStatusOf(result) !== 'success') {
    // The caller's guard (schema set, not aborted, no harness failure, a
    // result frame present) plus a non-success frame: the frame failed for
    // its own reason — not an output outcome at all. No miss, no payload:
    // the failure classifier names it.
    return { structured: undefined, miss: undefined };
  }
  const raw = result?.['structured_output'];
  if (raw === undefined) {
    return {
      structured: undefined,
      miss: 'the result frame carried no structured_output (the substrate never produced the required object)',
    };
  }
  const check = validateStructured(schema, raw);
  if (check.ok) {
    return { structured: check.value, miss: undefined };
  }
  return {
    structured: undefined,
    miss: `the result does not validate against schema '${schema.name}' — ${check.reason}`,
  };
}

/**
 * The LIVE aborted state of the run signal. Deliberately a function, never an
 * inline `signal?.aborted === true` at a use site: the entry and late rechecks
 * read the SAME RunOptions.signal through this boundary, so TypeScript cannot
 * narrow the property to `false | undefined` after the entry check and reject
 * the late recheck as an impossible comparison (the setup between them may have
 * aborted the signal asynchronously).
 */
export function signalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** Abort-shaped throw: the governor's cancellation, not an error (I8). */
export function isAbortShaped(err: unknown): boolean {
  const name = err instanceof Error ? err.name : undefined;
  return name === 'AbortError';
}
