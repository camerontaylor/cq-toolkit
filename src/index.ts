// cq-toolkit public barrel — re-export only, no logic: the frozen T1.1
// driver-seam and kernel types, the kernel's zod schema mirrors (schema
// values, generic op-result factory included), the T1.2 kernel runtime
// surface (runner, journal, manifest, output helpers), and the T1.3 budget
// governor + rescue lane.
export type {
  Budget,
  Driver,
  DriverStopReason,
  ModelSpec,
  OpInvocation,
  SandboxLevel,
  SandboxPolicy,
  ToolDenial,
  ToolPolicy,
  ToolPolicyMode,
  Usage,
  WorkerResult,
} from './driver/types.js';
export type {
  Job,
  JobFinishedJournalEvent,
  JobOutcome,
  JobStartedJournalEvent,
  JobState,
  JobStatus,
  JournalEvent,
  Limits,
  Op,
  OpRegistryEntry,
  OpResult,
  Plan,
  PlanRegistryEntry,
  RunCounts,
  RunEarlyStopReason,
  RunFinishedJournalEvent,
  RunOptions,
  RunReport,
  RunStartedJournalEvent,
} from './kernel/types.js';
export {
  BudgetSchema,
  DriverStopReasonSchema,
  JobFinishedJournalEventSchema,
  JobOutcomeSchema,
  JobSchema,
  JobStartedJournalEventSchema,
  JobStateSchema,
  JobStatusSchema,
  JournalEventSchema,
  LimitsSchema,
  ModelSpecSchema,
  OpInvocationSchema,
  OpResultSchema,
  PlanSchema,
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
  WorkerResultSchema,
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
// governed-registry seam, the escalation ladder, the honest-stop marker, and
// the rescue policy table + decision engine. Pure types ride along as
// `export type`.
export type {
  AdmissionDecision,
  Clock,
  GovernorConfig,
  GovernorEvent,
  JobCancelPort,
  JobGovernance,
  LadderOutcome,
  LadderRung,
  LadderRungMarker,
  LadderSpec,
} from './kernel/governor.js';
export {
  BudgetGovernor,
  currentJobContext,
  DEFAULT_ABORT_GRACE_MS,
  DEFAULT_KILL_GRACE_MS,
  governRegistry,
  governorConfig,
  realClock,
  runLadder,
  seedFromRunLog,
  withBudgetStop,
} from './kernel/governor.js';
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
// First-party driver + price map (T1.4) — re-export only, no logic: the
// in-process ai-sdk driver on the frozen seam, and the models.dev-derived
// price map behind the derived-only costUSD rule.
export type { AiSdkDriverOptions, ProviderFactory } from './driver/ai-sdk/index.js';
export { AiSdkDriver } from './driver/ai-sdk/index.js';
export type { PerMillionRates, PriceTable } from './driver/pricing/index.js';
export { computeCostUSD, priceOf } from './driver/pricing/index.js';
export { PRICE_TABLE } from './driver/pricing/data.js';
// Subprocess driver (T1.5) — re-export only, no logic: the out-of-process
// driver that runs an existing agent CLI headless on the frozen seam, its
// env-based model routing (CONFIG, with the DeepSeek silent-remap footgun
// enforced at route time), and its process-lifecycle helpers — the
// documented extension surface for future CLI drivers (I8: the grace
// ladder lives in driver/<name>/process.ts, the hygiene scan's one exempt
// path).
export type {
  ArgBuildInputs,
  ResultStatus,
  SpawnFn,
  StopReasonInputs,
  SubprocessDriverOptions,
} from './driver/subprocess/index.js';
export {
  allowedToolNames,
  buildArgs,
  CLI_SESSION_FILE,
  NARRATION_TOOL,
  resultStatusOf,
  stopReasonOf,
  SubprocessDriver,
  usageFromCli,
} from './driver/subprocess/index.js';
export type { Route, RoutingEndpoint, RoutingTable } from './driver/subprocess/routing.js';
export {
  defaultRoutingTable,
  routeFor,
  RoutingEndpointSchema,
  RoutingTableSchema,
} from './driver/subprocess/routing.js';
export type {
  GraceLadderOptions,
  ManagedChild,
  ProcessClose,
  SpawnOptions,
  TerminationOutcome,
  TerminationRungMarker,
} from './driver/subprocess/process.js';
export {
  // Aliased: the governor's DEFAULT_KILL_GRACE_MS (the escalation ladder's
  // rung-2→3 grace) is already exported above; this is the subprocess
  // grace ladder's SIGKILL→force-resolve window.
  DEFAULT_KILL_GRACE_MS as SUBPROCESS_DEFAULT_KILL_GRACE_MS,
  DEFAULT_TERM_GRACE_MS,
  spawnManaged,
  terminateGracefully,
} from './driver/subprocess/process.js';
// Claude-agent driver (T1.6) — re-export only, no logic: the THIRD lane, the
// OPTIONAL-PEER agent-SDK driver on the frozen seam. The peer
// (@anthropic-ai/claude-agent-sdk) is loaded lazily by dynamic import at
// run() time and feature-detected — importing THIS barrel never requires it
// to be installed (the install-matrix workflow proves both halves). No model
// allowlist: routing is by provider endpoint only; the observed-model check
// is the silent-remap defence.
export type { ClaudeAgentDriverOptions } from './driver/claude-agent/index.js';
export { ClaudeAgentDriver } from './driver/claude-agent/index.js';
export type {
  EndpointEntry,
  EndpointTable,
  ResolvedEndpoint,
} from './driver/claude-agent/routing.js';
export {
  defaultEndpointTable,
  resolveEndpoint,
  EndpointEntrySchema,
  EndpointTableSchema,
} from './driver/claude-agent/routing.js';
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
export * from './ops/analyze/index.js';
export * from './plans/index.js';
export * from './driver/index.js';
