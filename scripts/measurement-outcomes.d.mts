// Types for scripts/measurement-outcomes.mjs (measurement slice M10e).
// Review, disposition and acceptance rows are the ADR-0008 report v2 payload
// shapes verbatim; CI red observations and population rows are this slice's
// explicit inputs. Nothing here assumes unmerged lineage inputs.
import type {
  AcceptancePayload,
  DispositionPayload,
  ReviewObservedPayload,
} from '../src/kernel/types.js';

/** One post-merge CI red observation; `classification` is the system's own call. */
export interface CiRedObservation {
  sha: string;
  source: string;
  /** 'flake' | 'regression' | 'infrastructure' | 'unknown'; else unknown evidence. */
  classification: string;
}

/** One declared PR of the measurable population. */
export interface PopulationRow {
  /** The PR merge head; eligibility requires a PASS acceptance at this head. */
  headSha: string;
  /** ISO datetime of merge; drives maturity and right censoring. */
  mergedAt: string;
}

export interface CiRedCounts {
  flake: number | null;
  regression: number | null;
  infrastructure: number | null;
  unknown: number | null;
  /** Heads whose CI was examined (sorted); null when CI was not examined. */
  observedHeads: string[] | null;
  /** Eligible heads whose CI was not examined (sorted); null when CI was not examined. */
  unobservedHeads: string[] | null;
}

export interface OutcomePanels {
  /** Reviewed-range re-fixes: candidates until prior-correctness/finding-edit evidence. */
  harm: {
    refix: { candidates: number; explained: number; unknown: number };
    /** Counts are null (unknown, never zero) unless ciObservedHeads states the examined heads. */
    ciRed: CiRedCounts;
  };
  /** Restored crq findings: missed only when they existed at the pre-merge covered range. */
  missed: { restored: { missed: number; notMissed: number; unknown: number } };
  /** Eligible = independent PASS acceptance at the exact head; mature once the window elapsed. */
  population: { eligible: number; mature: number; rightCensored: number; followUpDays: number };
  /** Malformed, conflicting or missing-lineage rows with a reason, never a count. */
  unknown: Array<{ source: string; kind: string; reason: string }>;
}

export interface OutcomePanelsInput {
  reviews?: ReviewObservedPayload[];
  dispositions?: DispositionPayload[];
  acceptances?: AcceptancePayload[];
  ciRed?: CiRedObservation[];
  population?: PopulationRow[];
  /** Heads whose CI was examined; omit it and the CI red counts are null, never zero. */
  ciObservedHeads?: string[];
  /** Follow-up window in days a PR must age past to be mature. */
  followUpDays: number;
  /** ISO datetime the panels are computed at (the right-censoring instant). */
  observedAt: string;
}

export declare function computeOutcomePanels(input: OutcomePanelsInput): OutcomePanels;
