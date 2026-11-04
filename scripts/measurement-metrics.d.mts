// Types for scripts/measurement-metrics.mjs (measurement slice M10c): pure
// fix and cost panel computation over M10b-admitted evidence rows. Fix
// evidence and run windows arrive as explicit inputs in the merged ADR-0008
// vocabulary; session-index parent aggregates stay in the reader's totals.
import type {
  AvailabilityRecord,
  BaselineFailureRecord,
  ClosureRecord,
} from '../src/kernel/types.js';
import type { MeasurementInputRecord, UnknownMeasurementInput } from './measurement-inputs.mjs';

/** One measured composition run: admitted attempt leaves, ADR-0008 fix evidence and the provenance window. */
export interface MeasurementPanelRun {
  repo: string | null;
  runId: string;
  attempts: MeasurementInputRecord[];
  /** Verified closure rows; omit when no closure evidence was collected. */
  closures?: ClosureRecord[];
  /** Baseline evidence for every planned unit; omit when none was collected. */
  baselineFailures?: BaselineFailureRecord[];
  /**
   * Producer-recorded numerator (the report metric scalar): null means the
   * producer declared it unknown while closure evidence exists (unreadable
   * trailer commits) and the count is withheld, never recomputed; a number is
   * cross-checked against the distinct verified SHA count and a disagreement
   * withholds it, exactly as reportFold does.
   */
  recordedNumerator?: number | null;
  /** Report provenance window; a null endedAt leaves run elapsed unknown. */
  startedAt: string | null;
  endedAt: string | null;
}

/** Per-run fix figures; fixesPerRun never aggregates across runs. */
export interface FixPanelRun {
  repo: string | null;
  runId: string;
  fixesPerRun: { numerator: number | null; denominator: number | null };
  /** Deduplicated projection of the verified non-todo closure commits. */
  verifiedCommits: string[];
}

/** Cost figures: deduplicated usage channels, attempt wall beside run elapsed, explicit modeled price coverage. */
export interface CostPanel {
  usageChannels: Record<string, number | null>;
  /** Summed attempt wall over deduped leaves. */
  attemptWallMs: number | null;
  /** Observed provenance windows; beside, never in place of, attemptWallMs. */
  runElapsedMs: number | null;
  modeledUsd: number | null;
  /** Uniform non-null price statement across attempts, else null. */
  priceTableRevision: string | null;
  priceCoverage: string | null;
  availability: Record<string, AvailabilityRecord>;
}

export interface MeasurementPanels {
  fix: { runs: FixPanelRun[] };
  cost: CostPanel;
}

export declare function computeMeasurementPanels(input: {
  runs: MeasurementPanelRun[];
  /** Reader unknown bucket; any entry degrades cost completeness. */
  unknown?: UnknownMeasurementInput[];
  /**
   * Reader totals availability (or a report availability map): a non-known
   * state at '', '/attempts', '/usageChannels', an escaped
   * '/usageChannels/<name>', '/wallMs' or '/modeledUsd' degrades the matching
   * cost totals, so evidence the reader calls partial is never known here.
   */
  evidenceAvailability?: Record<string, AvailabilityRecord>;
}): MeasurementPanels;
