// Types for scripts/measurement-rollup.mjs (measurement slice M10d): the
// local monthly readout renders already-computed panels verbatim — the M10c
// measurement panels, the M10e outcome panels and the M10b reader
// totals/unknown bucket — over one explicit UTC [start,end) 30-day window,
// and computes nothing of its own: no cross-run success ratio, no causal
// score, unknown never zero.
import type { MeasurementPanels } from './measurement-metrics.mjs';
import type { MeasurementTotals, UnknownMeasurementInput } from './measurement-inputs.mjs';
import type { OutcomePanels } from './measurement-outcomes.mjs';

/** Explicit UTC observation window; exactly 30 days, half-open [start,end). */
export interface ReadoutWindow {
  start: string;
  end: string;
}

export interface MeasurementReadoutInput {
  window: ReadoutWindow;
  /** Evidence artifact references (rendered sorted, deduplicated). */
  artifacts?: string[];
  /** computeMeasurementPanels output, verbatim; pass the reader's totals.availability there. */
  measurement: MeasurementPanels;
  /** computeOutcomePanels output, verbatim. */
  outcome: OutcomePanels;
  /** readMeasurementInputs output; totals and the unknown bucket render as given. */
  reader: { totals: MeasurementTotals; unknown: UnknownMeasurementInput[] };
}

export interface MeasurementReadout {
  window: { start: string; end: string; days: 30 };
  artifacts: string[];
  panels: {
    fix: MeasurementPanels['fix'];
    cost: MeasurementPanels['cost'];
    harm: OutcomePanels['harm'];
    missed: OutcomePanels['missed'];
    population: OutcomePanels['population'];
  };
  reader: { totals: MeasurementTotals };
  /** Reader then outcome unknown-evidence rows, in that order; never a count. */
  unknown: Array<{ source: string; kind: string; reason: string }>;
}

export interface RenderedMeasurementReport {
  report: MeasurementReadout;
  /** Deterministic JSON serialization of report (two-space indent). */
  json: string;
  /** Deterministic Markdown; every panel section states the window. */
  markdown: string;
}

export declare function renderMeasurementReport(
  input: MeasurementReadoutInput,
): RenderedMeasurementReport;
