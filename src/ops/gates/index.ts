// Gates lane (C1–C3) — public surface. Re-export only, no logic: the
// CheckRunner contract + pure parse core + op factory, the three named
// wire-format adapters, the C2 baseline tooling — fingerprints, the
// regression gate, and the baseline probe — and the C3 tamper guard: the
// hack detector and the commit gate; W1.9 adds the D11 policy check.
export type {
  AdapterName,
  CheckAdapter,
  CheckCommand,
  CheckFailure,
  CheckParseResult,
  CheckRunnerInput,
  FailureSet,
  RawCheckOutput,
  RunCheck,
} from './checkRunner.js';
export {
  adapterByName,
  makeCheckRunner,
  parseCheckOutput,
  subprocessRunCheck,
} from './checkRunner.js';
export { vitestJsonAdapter } from './adapters/vitest.js';
export { eslintJsonAdapter } from './adapters/eslint.js';
export { tscLinesAdapter } from './adapters/tsc.js';
export type { BailConfig, BaselineProbeInput, ProbeReport, ProbeVerdict } from './baselineProbe.js';
export { DEFAULT_BAIL_PATTERNS, makeBaselineProbe } from './baselineProbe.js';
export type { FingerprintConfig } from './fingerprint.js';
export {
  fingerprintFailure,
  fingerprintKey,
  fingerprintPairs,
  fingerprintSet,
  fnv1a32Hex,
} from './fingerprint.js';
export type { RegressionGateInput, RegressionReport, RegressionVerdict } from './regressionGate.js';
export { regressionGate } from './regressionGate.js';
export { CheckFailureSchema, FailureSetSchema, FingerprintConfigSchema } from './registry.js';
export type {
  CommitGateConfig,
  CommitGateInput,
  CommitGateReport,
  CommitViolation,
  SubjectImplication,
  TrailerRule,
} from './commitGate.js';
export {
  DEFAULT_COMMIT_IMPLICATIONS,
  DEFAULT_COMMIT_TRAILERS,
  DEFAULT_OUTCOME_TRAILER,
  DEFAULT_SUBJECT_PATTERN,
  commitGate,
} from './commitGate.js';
export type {
  HackDetectorInput,
  SuppressionPattern,
  TamperConfig,
  TamperFinding,
  TamperFindingKind,
} from './hackDetector.js';
export {
  DEFAULT_SKIP_ONLY_PATTERN,
  DEFAULT_SUPPRESSION_PATTERNS,
  DEFAULT_TEST_FILE_PATTERNS,
  hackDetector,
} from './hackDetector.js';
export { CommitGateInputSchema, HackDetectorInputSchema } from './registry.js';
// W1.9 (D11) — the protected-path policy check: the op factory and its
// posture resolver, the override-label record, and the workflow scanner.
export type {
  PolicyDiffInput,
  PolicyDiffOutcome,
  PolicyFinding,
  PolicyFindingKind,
} from './policyDiff.js';
export { LABEL_EVENTS_MAX_BYTES, POLICY_LIST_PATH, createPolicyDiff } from './policyDiff.js';
export type {
  ProtectedPathsConfig,
  ProtectedPathsOptIn,
  ProtectedPathsPosture,
} from './policyConfig.js';
export {
  PROTECTED_PATHS_ENV,
  PROTECTED_PATHS_OPT_IN,
  resolveProtectedPathsConfig,
} from './policyConfig.js';
export type { OverrideEvaluation, OverrideEvent } from './overrideRecord.js';
export {
  C3_ATTESTATION_PATH,
  OVERRIDE_LABEL,
  evaluateOverrideLabel,
  formatOverride,
  headObservationEpoch,
} from './overrideRecord.js';
export type {
  WorkflowFinding,
  WorkflowFindingKind,
  WorkflowJob,
  WorkflowScan,
} from './workflowScan.js';
export { diffWorkflow, isWorkflowPath, lintWorkflow, scanWorkflow } from './workflowScan.js';
export { PolicyDiffInputSchema } from './registry.js';
