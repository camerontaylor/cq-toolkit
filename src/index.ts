// cq-toolkit public barrel — re-export only, no logic: the frozen T1.1
// driver-seam and kernel types, the kernel's zod schema mirrors (schema
// values, generic op-result factory included), the T1.2 kernel runtime
// surface (runner, journal, manifest, output helpers), and the T1.3 budget
// governor + rescue lane.
export type {
  Budget,
  // Aliased (seam v2, lane decision O-1 treatment): the kernel governor's
  // `BudgetReservation` keeps the root-barrel name (explicit export above);
  // the driver seam's plain-data reservation rides under `DriverBudgetReservation`.
  BudgetReservation as DriverBudgetReservation,
  Driver,
  // Aliased (seam v2, lane decision O-1): the kernel plan-run `RunOptions`
  // keeps the root-barrel name (explicit export above); the seam's
  // runtime-only per-call options ride under `DriverRunOptions`. An explicit
  // export beats the driver star-export at the barrel tail, so both are
  // deliberate, non-shadowed surface.
  RunOptions as DriverRunOptions,
  DriverStopReason,
  JsonSchema,
  ModelSpec,
  OpInvocation,
  OutputSchema,
  ProviderSignals,
  SandboxLevel,
  SandboxPolicy,
  ToolDenial,
  ToolPolicy,
  ToolPolicyMode,
  Usage,
  WorkerErrorClass,
  WorkerResult,
  WorkspaceBinding,
} from './driver/types.js';
// Driver seam values + pre-dispatch errors (seam v2) — re-export only.
export { SEAM_VERSION } from './driver/types.js';
export { DispatchError, errorClassOf } from './driver/errors.js';
export type { DispatchErrorClass } from './driver/errors.js';
export type {
  Job,
  JobFinishedJournalEvent,
  JobOutcome,
  JobQuarantinedJournalEvent,
  JobStartedJournalEvent,
  JobState,
  JobStatus,
  JournalEvent,
  GovernanceOptIn,
  GovernanceRecord,
  Limits,
  Op,
  OpRegistryEntry,
  OpResult,
  Plan,
  PlanRegistryEntry,
  QuarantineReleasedJournalEvent,
  ReservationChargeBasis,
  ReservationClass,
  ReservationOpenedJournalEvent,
  ReservationRefusedJournalEvent,
  ReservationRefusalReason,
  ReservationSettledJournalEvent,
  RunCounts,
  RunEarlyStopReason,
  RunFinishedJournalEvent,
  RunOptions,
  RunReport,
  RunStartedJournalEvent,
  BudgetTrippedJournalEvent,
} from './kernel/types.js';
export {
  BudgetSchema,
  BudgetTrippedJournalEventSchema,
  DriverStopReasonSchema,
  GovernanceRecordSchema,
  JobFinishedJournalEventSchema,
  JobOutcomeSchema,
  JobQuarantinedJournalEventSchema,
  JobSchema,
  JobStartedJournalEventSchema,
  JobStateSchema,
  JobStatusSchema,
  JournalEventSchema,
  LimitsSchema,
  ModelSpecSchema,
  OpInvocationSchema,
  OpResultSchema,
  OutputSchemaSchema,
  PlanSchema,
  ProviderSignalsSchema,
  QuarantineReleasedJournalEventSchema,
  ReservationOpenedJournalEventSchema,
  ReservationRefusedJournalEventSchema,
  ReservationSettledJournalEventSchema,
  RunCountsSchema,
  RunEarlyStopReasonSchema,
  RunFinishedJournalEventSchema,
  RunOptionsSchema,
  RunReportSchema,
  RunStartedJournalEventSchema,
  SandboxLevelSchema,
  SandboxPolicySchema,
  ToolDenialSchema,
  ToolPolicyModeSchema,
  ToolPolicySchema,
  UsageSchema,
  WorkerErrorClassSchema,
  WorkerResultSchema,
  WorkspaceBindingSchema,
  opResultSchema,
} from './kernel/schema.js';
// Kernel runtime surface (T1.2) — re-export only, no logic: the plan runner,
// the NDJSON journal, the run manifest, and the I1 output helpers. Pure
// types ride along as `export type`.
export type { ManifestJob, RunManifest } from './kernel/manifest.js';
export type { OpRegistryView } from './kernel/runner.js';
export type { RunLog } from './kernel/journal.js';
export { canonicalJson, hashInputs, makeManifest, topoOrder } from './kernel/manifest.js';
export { deriveJobStatuses, openRunLog } from './kernel/journal.js';
export { runPlan } from './kernel/runner.js';
export { emitReport, narrate, renderHuman } from './kernel/output.js';
// Budget governor + rescue lane (T1.3) — re-export only, no logic: the
// per-run enforcer behind `runPlan`'s Governance handle, the escalation
// ladder, and the rescue policy table + decision engine. Pure types ride
// along as `export type`.
export type {
  AdmissionDecision,
  BudgetReservation,
  Clock,
  Governance,
  Governor,
  GovernorConfig,
  GovernorEvent,
  JobCancelPort,
  JobGovernance,
  LadderOutcome,
  LadderRung,
  LadderRungMarker,
  LadderSpec,
  ReserveOutcome,
  TripKind,
} from './kernel/governor.js';
export {
  BudgetGovernor,
  createGovernor,
  currentJobContext,
  DEFAULT_ABORT_GRACE_MS,
  DEFAULT_KILL_GRACE_MS,
  governorConfig,
  realClock,
  runLadder,
  validSpendEvidence,
} from './kernel/governor.js';
// Per-lane budget classification (W2.3, ADR-0003 §2.4) — re-export only.
export { classifyDispatch, LANE_CLASSIFICATION } from './kernel/lanes.js';
export type { BudgetClass, LaneClassificationRow } from './kernel/lanes.js';
export type {
  RescueAction,
  RescueDecision,
  RescueEscalation,
  RescueGuard,
  RescueInput,
  RescueOutcome,
  RescuePolicy,
  RescuePolicyRow,
} from './kernel/rescue.js';
export {
  attemptsFromJournal,
  CONSERVATIVE_RESCUE_POLICY,
  decideRescue,
  rescueInputFromJournal,
} from './kernel/rescue.js';
// Composition harness (T1.4) — re-export only, no logic: the R4 per-op
// config schema + conservative defaults, the toolkit's minimal read/edit/run
// tool surface with its per-op allowlists, and the JSONL session store
// backing the I6 isolation contract.
export type {
  FileToolConfig,
  HarnessConfig,
  HarnessToolConfig,
  PromptBudgetConfig,
  RunToolConfig,
} from './harness/config.js';
export {
  defaultHarnessConfig,
  FileToolConfigSchema,
  HarnessConfigSchema,
  HarnessToolConfigSchema,
  PromptBudgetConfigSchema,
  RunToolConfigSchema,
} from './harness/config.js';
export type {
  EditToolInput,
  ReadToolInput,
  RunToolInput,
  ToolExecuteOptions,
  ToolkitTool,
  ToolkitToolName,
  ToolkitToolResult,
} from './harness/tools.js';
export {
  buildTools,
  compileCommandPatterns,
  compilePathPatterns,
  EditToolInputSchema,
  ReadToolInputSchema,
  RunToolInputSchema,
} from './harness/tools.js';
// The shared harness tool-surface core (W1.4, ADR-0002 Annex A.1) —
// re-export only: naming, selection, the driver-authored manifest, the
// bound serialized surface, the stable denial classifier and the
// init-surface comparator both driver lanes (and third-party MCP hosts of
// the `cq-harness-mcp` bin) share.
export type {
  ExpectedInitSurface,
  HarnessCallOutcome,
  HarnessManifest,
  HarnessSurface,
  HarnessSurfaceTool,
  InitSurfaceVerdict,
  ManifestInputs,
  McpCallToolResult,
  ServerStatus,
} from './harness/surface.js';
export {
  buildManifest,
  compareInitSurface,
  createHarnessSurface,
  HARNESS_DENIAL_PREFIXES,
  HARNESS_MCP_SERVER_NAME,
  HarnessManifestSchema,
  harnessToolName,
  isHarnessDenial,
  isQualifiedHarnessTool,
  qualifiedToolName,
  selectHarnessSurface,
  selectToolNames,
  toCallToolResult,
} from './harness/surface.js';
export type {
  SessionHeaderLine,
  SessionLine,
  SessionMessage,
  SessionMessageLine,
  SessionRecord,
} from './harness/session.js';
export {
  assertSafeSessionId,
  SessionHeaderLineSchema,
  SessionLineSchema,
  SessionMessageLineSchema,
  SessionMessageSchema,
  SessionRecordSchema,
  SessionStore,
  tempWorkspace,
} from './harness/session.js';
// W1.11 sandbox policy: conservative configuration resolution, certified
// backend selection, the mandatory launcher environment scrub, and the
// shared run gate every harness surface applies.
export type {
  HarnessRunGate,
  ResolveSandboxOptions,
  SandboxBackend,
  SandboxConfig,
  SandboxMode,
  SandboxNetwork,
  SandboxOptIn,
  SandboxPlatform,
} from './sandbox/index.js';
export {
  assertRunToolAvailable,
  buildSandboxLauncherEnv,
  certifiedAutoOrder,
  harnessRunGate,
  resolveSandboxConfig,
  runToolAvailable,
} from './sandbox/index.js';
// First-party driver + price map (T1.4) — re-export only, no logic: the
// in-process ai-sdk driver on the frozen seam, and the models.dev-derived
// price map behind the derived-only costUSD rule.
export type { AiSdkDriverOptions, ProviderFactory } from './driver/ai-sdk/index.js';
export { AiSdkDriver } from './driver/ai-sdk/index.js';
export type { PerMillionRates, PriceTable } from './driver/pricing/index.js';
export { computeCostUSD, priceOf } from './driver/pricing/index.js';
export { PRICE_TABLE } from './driver/pricing/data.js';
// Claude Code lane (Phase 1.9, D-E′ option A) — re-export only, no logic:
// the merged lane (the former subprocess + claude-agent drivers) on the
// frozen seam: the headless CLI transport primary, the agent-SDK transport
// optional (a lazily loaded optional peer — importing THIS barrel never
// requires it to be installed; the install-matrix workflow proves both
// halves). Its env-based model routing (CONFIG — model/provider choices are
// never src literals), the ONE shared worker-accounting fold (per-model
// aggregates, provenance, resumed-session semantics) and failure classifier,
// and the process-lifecycle helpers — the documented extension surface for
// future CLI drivers (I8: the grace ladder lives in
// driver/<name>/process.ts, the hygiene scan's one exempt path).
export type { ClaudeCodeDriverOptions, ClaudeCodeTransport } from './driver/claude-code/index.js';
export { ClaudeCodeDriver } from './driver/claude-code/index.js';
export type {
  ArgBuildInputs,
  CliToolSurface,
  CliTransportOptions,
  SpawnFn,
} from './driver/claude-code/cli.js';
export { allowedToolNames, buildArgs, HARNESS_MCP_CONFIG_FILE } from './driver/claude-code/cli.js';
export type {
  AgentSdkModule,
  SdkLoader,
  SdkTransportOptions,
  SdkToolCallResult,
} from './driver/claude-code/sdk.js';
export { SDK_MODULE_SPECIFIER } from './driver/claude-code/sdk.js';
export type { Route, RoutingEndpoint, RoutingTable } from './driver/claude-code/routing.js';
export {
  defaultRoutingTable,
  resolveRoute,
  RoutingEndpointSchema,
  RoutingTableSchema,
} from './driver/claude-code/routing.js';
export type { ResultStatus, StopReasonInputs } from './driver/claude-code/verdict.js';
export {
  HARNESS_ERROR_PREFIX,
  resultStatusOf,
  stopReasonOf,
  STRUCTURED_OUTPUT_TOOL,
} from './driver/claude-code/verdict.js';
export type { FailureClassInputs, FailureClassification } from './driver/claude-code/failures.js';
export {
  classifyFailure,
  isCodexBinary,
  resetAtFromLimitText,
} from './driver/claude-code/failures.js';
export { CLI_SESSION_FILE } from './driver/claude-code/sessions.js';
export type { MeasuredUsage } from './driver/claude-code/usage.js';
export {
  addUsage,
  measureResultUsage,
  totalTokensOf,
  usageFromWire,
  zeroUsage,
} from './driver/claude-code/usage.js';
export type {
  GraceLadderOptions,
  ManagedChild,
  ProcessClose,
  SpawnOptions,
  TerminationOutcome,
  TerminationRungMarker,
} from './shared/proc.js';
export {
  // Aliased: the governor's DEFAULT_KILL_GRACE_MS (the escalation ladder's
  // rung-2→3 grace) is already exported above; this is the grace ladder's
  // SIGKILL→force-resolve window.
  DEFAULT_KILL_GRACE_MS as CLAUDE_CODE_DEFAULT_KILL_GRACE_MS,
  DEFAULT_TERM_GRACE_MS,
  spawnManaged,
  terminateGracefully,
} from './shared/proc.js';
// Acp driver (T1.8) — re-export only, no logic: the FOURTH lane, speaking
// OUR transcription of the Agent Client Protocol (newline-delimited
// JSON-RPC 2.0 over stdio) to operator-installed vendor harness binaries
// (zcode-acp-server; dsh-acp as the fast-follow endpoint). NO vendor
// package anywhere — the wire vocabulary lives in driver/acp/protocol.ts
// (I10), the binaries registry is discovery-only (never bundled, never a
// dependency), and the observed-model check reads the POST-MATERIALIZATION
// config_option_update value only (the session/new entry is the lazy
// default — docs/acp-driver-strategy.md §5). The permission answer table
// helpers are exported because the table IS the lane's public contract.
export type { AcpDriverOptions } from './driver/acp/index.js';
export {
  AcpDriver,
  ACP_SESSION_FILE,
  composePrompt,
  decidePermission,
} from './driver/acp/index.js';
export type {
  AcpEndpointEntry,
  AcpEndpointTable,
  ResolvedAcpCommand,
} from './driver/acp/binaries.js';
export {
  AcpEndpointSchema,
  AcpEndpointTableSchema,
  DEFAULT_ACP_ENDPOINT,
  defaultAcpEndpointTable,
  resolveAcpCommand,
} from './driver/acp/binaries.js';
export type {
  PermissionOption,
  PermissionOptionKind,
  RequestPermissionParams,
} from './driver/acp/protocol.js';
export {
  ACP_METHODS,
  ACP_PROTOCOL_VERSION,
  permissionToolIdentity,
  selectAllowOptionId,
  selectPermissionAnswer,
  selectRejectOptionId,
} from './driver/acp/protocol.js';
// Registry + CLI family lines (T1.4-era barrel rule: one `export *` line per
// planned op family, added ahead of time by lane I; family index modules are
// empty until each family's owning lane populates them). The REGISTRY line is
// deliberately NOT a star-export: the generic `list`/`get` names would sit on
// the root barrel and silently collide with the first family barrel that ever
// exports either name (star-export ambiguity), so they are re-exported
// aliased as `listOps`/`getOp`; `defaultOpsRoot` is distinctive enough to
// stay bare.
export {
  defaultOpsRoot,
  list as listOps,
  get as getOp,
  listWithDiagnostics as listOpsWithDiagnostics,
} from './registry/index.js';
export * from './ops/gates/index.js';
export * from './ops/ledger/index.js';
export * from './ops/review/index.js';
export * from './ops/merge/index.js';
export * from './ops/ratchet/index.js';
export * from './ops/sweep/index.js';
export * from './ops/pr/index.js';
export * from './ops/dev/index.js';
export * from './ops/analyze/index.js';
export * from './plans/index.js';
export * from './driver/index.js';
