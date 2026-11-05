// Types for scripts/measurement-acceptance.mjs (measurement slice M4b1).
// The input is one recorded PR-comment snapshot read as raw JSON; every
// field is validated at runtime, so no snapshot type is asserted here.
import type { AcceptancePayload } from '../src/kernel/types.js';

/** One unknown entry, the M10e shape verbatim. */
export interface UnknownEntry {
  source: string;
  kind: string;
  reason: string;
}

/** Parallel to `acceptances` (same index): the comment's capture instant. */
export interface ImportedAcceptanceMeta {
  /** Comment `created_at`, strict UTC, normalised to milliseconds. */
  at: string;
}

export interface ImportAcceptanceResult {
  /** Self-declared acceptance rows; M10e's acceptances input, unchanged. */
  acceptances: AcceptancePayload[];
  /** Beside the rows: the payload schema is strict, so an inline `at`
   * field would fail parsing (the parallel-array choice). */
  meta: ImportedAcceptanceMeta[];
  /** Near-miss, base-less, conflicting or corrupt comments, with a reason. */
  unknown: UnknownEntry[];
}

/** Import self-declared acceptances from one recorded snapshot; pure. */
export declare function importAcceptance(snapshot: unknown): ImportAcceptanceResult;
