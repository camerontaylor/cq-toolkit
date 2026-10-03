// Ratchet family public surface (review-debt #66): the family index was an
// empty placeholder ("populated by the family's owning lane"), so the root
// barrel's `export * from './ops/ratchet/index.js'` exported NOTHING —
// installed-package consumers could not reach any ratchet functionality
// (deep imports are blocked by the package exports map). The surface below
// is re-export only, per family: the two op factories + prune, the proposal
// op, the shared format helpers, the monotonic diff guard, the metric
// adapter registry, and the three shipped adapters. Type-only names ride as
// `export type`; no name collides with any other family barrel (checked
// against every star-exported module; the generic list/get rule keeps the
// registry seam's aliases on the root barrel).
export { createCaptureBaseline, pruneBaselines, resolveBaselinesDir } from './captureBaseline.js';
export type {
  CaptureBaselineInput,
  CaptureBaselineOutcome,
  PruneBaselinesInput,
  PruneBaselinesOutcome,
  SourceCatalog,
} from './captureBaseline.js';
export { createCheckRatchet } from './checkRatchet.js';
export type { CheckRatchetInput, CheckRatchetOutcome } from './checkRatchet.js';
export { createProposeBaselineUpdate, DEFAULT_PR_TOKEN } from './proposeBaselineUpdate.js';
export type { BaselinePrEffects, ProposeInput, ProposeOutcome } from './proposeBaselineUpdate.js';
export {
  baselineRelPath,
  isIso8601Instant,
  loosens,
  normalizeBaselineDiffValues,
  parseBaseline,
  renderBaseline,
  roundCoveragePct,
  tightens,
} from './format.js';
export type { BaselineFile, Direction } from './format.js';
export { checkDiffMonotonicity, formatViolations } from './monotonicGuard.js';
export type { BaselineViolation, DiffVerdict } from './monotonicGuard.js';
export { getAdapter, listAdapters, registerAdapter } from './metricRegistry.js';
export type { MetricAdapter, MetricReading, MetricSource } from './metricRegistry.js';
export type { MetricSourceSpec } from './sources.js';
export { makeMetricSource } from './sources.js';
export { complexity } from './adapters/complexity.js';
export { coverage } from './adapters/coverage.js';
export { typecheckCount } from './adapters/typecheckCount.js';
