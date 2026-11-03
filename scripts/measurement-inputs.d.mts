// Types for scripts/measurement-inputs.mjs (measurement slice M10b). Attempt
// rows are admitted only after the containing report passes the strict v2
// report schema, so the row is the ADR-0008 payload verbatim; identity fields
// are added around it.
import type { AttemptFinishedPayload, AvailabilityRecord } from '../src/kernel/types.js';

export type UnknownMeasurementInputKind =
  | 'missing'
  | 'corrupt'
  | 'untrusted'
  | 'unsupported'
  | 'conflict'
  | 'partial'
  | 'unavailable';

export interface MeasurementInputRecord extends AttemptFinishedPayload {
  /**
   * Archive-safe opaque remote digest, or null when no remote exists. A null
   * repo and any named repo are distinct dedup identities: a null-repo row
   * never adopts a named repo's rows and vice versa.
   */
  repo: string | null;
  /** Composition work identity from the report correlation. */
  workId: string;
  /** Composition run identity from the attempt envelope. */
  runId: string;
  /** Bundle directory and artifact path the row came from. */
  source: string;
}

export interface MeasurementParentRecord {
  /** Archive-safe opaque remote digest; null when no remote exists. */
  repo: string | null;
  runId: string;
  workId: string;
  parentWorkId: string | null;
  /** Attempt count the row states for the run (leaf-completeness check). */
  attempts: number;
  tokens: number | null;
  wallMs: number | null;
  /** Bundle directory and artifact path the row came from. */
  source: string;
  /** True when leaf attempts for this run were observed; the aggregate is not added. */
  mirrored: boolean;
}

export interface UnknownMeasurementInput {
  source: string;
  kind: UnknownMeasurementInputKind;
  reason: string;
}

export interface MeasurementTotals {
  attempts: number;
  tokens: number | null;
  wallMs: number | null;
  modeledUsd: number | null;
  availability: Record<string, AvailabilityRecord>;
}

export interface MeasurementInputs {
  inputs: MeasurementInputRecord[];
  parents: MeasurementParentRecord[];
  unknown: UnknownMeasurementInput[];
  totals: MeasurementTotals;
}

export declare function readMeasurementInputs(input: {
  dirs: string[];
}): Promise<MeasurementInputs>;
