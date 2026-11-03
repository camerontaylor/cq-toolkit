// Types for scripts/measurement-inputs.mjs (measurement slice M10b). The attempt
// row is the ADR-0008 payload verbatim; identity fields are added around it.
import type { AttemptFinishedPayload, AvailabilityRecord } from '../src/kernel/types.js';

export type UnknownMeasurementInputKind =
  | 'missing'
  | 'corrupt'
  | 'untrusted'
  | 'unsupported'
  | 'conflict'
  | 'unavailable';

export interface MeasurementInputRecord extends AttemptFinishedPayload {
  /** Archive-safe opaque remote digest, or null when no remote exists. */
  repo: string | null;
  /** Composition run identity from the attempt envelope. */
  runId: string;
  /** Bundle directory and artifact path the row came from. */
  source: string;
}

export interface MeasurementParentRecord {
  runId: string;
  parentWorkId: string | null;
  tokens: number | null;
  wallMs: number | null;
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
