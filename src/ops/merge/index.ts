// merge op family barrel — goal F1 (ws-f): the I2 merge-acceptance decision
// table. Re-export only, no logic. ./threads.js (review/) remains the single
// shared vocabulary with the review family — F1 imports it and NOTHING else
// from review/; ./classify.config.js is the R3 landing site for merge policy
// (structure frozen; R3 tunes values AS DATA, never the decision table).
export type { ClassifyPrConfig } from './classify.config.js';
export { REVIEW_ACCEPT_SETTLE_MS, defaultClassifyPrConfig } from './classify.config.js';
export type { PrCandidate, PrClassification, PrMergeVerdict } from './classifyPrs.js';
export { classifyPr } from './classifyPrs.js';
