// Analyze family (G1 + G2 + G3) — public surface. Re-export only, no
// logic: the FailureSet union across packages/runs (single-tool,
// exact-identity duplicate collapse), the signature clustering with honest
// confidence and the ledger noise seam, the deterministic report pair
// (markdown + remediation-driving sidecar), the codemod path, the agentic
// driver-seam path, and the family's registry slice.
export type { CollectFailuresInput } from './collectFailures.js';
export {
  collectFailures,
  collectFailuresOp,
  failureIdentity,
  sortByIdentity,
} from './collectFailures.js';
export type {
  Cluster,
  ClusterConfidence,
  ClusterErrorsInput,
  ClusterErrorsReport,
} from './clusterErrors.js';
export {
  clusterErrors,
  clusterErrorsOp,
  clusterSignature,
  messageTemplate,
} from './clusterErrors.js';
export type {
  AnalysisSidecar,
  AnalysisTargetDigest,
  ClusterEvidence,
  RenderAnalysisMeta,
  RenderAnalysisReportInput,
  RenderedAnalysis,
  RenderedAnalysisPaths,
} from './renderAnalysisReport.js';
export {
  ANALYSIS_SIDECAR_SCHEMA_VERSION,
  SidecarFormatError,
  contentDigest,
  markdownFileName,
  parseAnalysisSidecar,
  renderAnalysisReport,
  reportFingerprint,
  serializeAnalysisSidecar,
  sidecarFileName,
} from './renderAnalysisReport.js';
export type { AgenticRemediationInput } from './agenticRemediation.js';
export { agenticRemediationPrompt, makeAgenticRemediation } from './agenticRemediation.js';
export type {
  ApplyRemediationInput,
  ApplyRemediationReport,
  RemediationFileApplied,
  RemediationFileDiff,
} from './applyRemediation.js';
export { makeApplyRemediation } from './applyRemediation.js';
export type {
  AstGrepCodemodInput,
  AstGrepScanRequest,
  AstGrepScanResult,
  CodemodFileApplied,
  CodemodFileDiff,
  CodemodReport,
  PlannedEdit,
  ScanOutcome,
} from './codemod/astGrep.js';
export {
  applyEditsToBytes,
  findCollision,
  makeAstGrepCodemod,
  makeAstGrepScan,
  parseAstGrepJson,
  renderUnifiedDiff,
} from './codemod/astGrep.js';
// The registry ARRAY is deliberately not re-exported here (the gates
// precedent): `registry` would collide with the ledger family's export on
// the root barrel (star-export ambiguity is a compile error, TS2308) — the
// central op-registry scanner and tests import ./registry.js directly.
export {
  AgenticRemediationInputSchema,
  AnalyzeReportSchema,
  ApplyRemediationInputSchema,
  AstGrepCodemodInputSchema,
  ClusterErrorsInputSchema,
  CollectFailuresInputSchema,
  LedgerViewSchema,
  RenderAnalysisReportInputSchema,
} from './registry.js';
export type { AnalyzeFileStore } from './analysisStore.js';
export { AnalysisStoreError, pathAnalysisFileStore } from './analysisStore.js';
// The G3 playbook lane (authored remediation playbooks: format, verifier,
// quarantine state machine, playbook registry + dispatch op factory) —
// re-exported wholesale from the playbooks barrel (its exports are
// explicit and collision-checked there).
export * from './playbooks/index.js';
