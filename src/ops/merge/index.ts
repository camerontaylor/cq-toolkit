// merge op family barrel — goals F1+F2+F3 (ws-f): the I2 merge-acceptance
// decision table, the stacked-PR merge plan, and the plan's executor (the
// injectable effects seam + the failure post-mortem). Re-export only, no
// logic. ./threads.js (review/) remains the single shared vocabulary with
// the review family — F1 imports it and NOTHING else from review/ (F2
// imports no review/ surface at all; F3 imports only the GhFn transport
// types/maker from review/gh.js); ./classify.config.js is the R3 landing
// site for merge policy (structure frozen; R3 tunes values AS DATA, never
// the decision table).
export type { ClassifyPrConfig } from './classify.config.js';
export { REVIEW_ACCEPT_SETTLE_MS, defaultClassifyPrConfig } from './classify.config.js';
export type { PrCandidate, PrClassification, PrMergeVerdict } from './classifyPrs.js';
export { classifyPr } from './classifyPrs.js';
export type {
  PlanBlockReason,
  PlanMergeInput,
  PlanMergeResult,
  PlannedMergeEntry,
  PlannedPr,
} from './planMergeOrder.js';
export { planMergeOrder } from './planMergeOrder.js';
export type { MergeEffects, RealMergeEffectsOpts, SafeArgsOpts } from './effects.js';
export {
  DEFAULT_PROTECTED_BRANCH,
  UnsafeMergeArgsError,
  headRefFor,
  realMergeEffects,
  safeArgs,
  safeRunner,
} from './effects.js';
export type {
  ExecuteMergeInput,
  ExecutionBlockReason,
  ExecutionReport,
} from './executeMerges.js';
export { DEFAULT_MAX_RETRIES, executeMerges } from './executeMerges.js';
export type { MergeFailureCause, MergeFailureDiagnosis } from './diagnoseMergeFailure.js';
export { diagnoseMergeFailure } from './diagnoseMergeFailure.js';
