export { validateFix } from './validate.js';
export { makeFixRun } from './runFix.js';
export type { FixRunInput, FixRunReport, FixRunResult, FixRunDeps } from './runFix.js';
export {
  failureRowsOf,
  fixRunCounters,
  neverStartedRow,
  plannedTaskRowOf,
  unitLabelOf,
} from './report.js';
export type {
  FixRunCounters,
  FixTaskAttemptFailure,
  FixTaskFailure,
  FixTaskNoArtifactFailure,
  FixTaskOutcome,
  PlannedTaskRow,
} from './report.js';
export type { FixGate, FixGateRecord, ValidationInput, ValidationVerdict } from './validate.js';
