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
export type {
  ManifestJob,
  RunManifest,
} from './kernel/manifest.js';
export type { OpRegistryView } from './kernel/runner.js';
export type { RunLog } from './kernel/journal.js';
export {
  canonicalJson,
  hashInputs,
  makeManifest,
  topoOrder,
} from './kernel/manifest.js';
export {
  deriveJobStatuses,
  openRunLog,
} from './kernel/journal.js';
export { runPlan } from './kernel/runner.js';
export { emitReport, narrate, renderHuman } from './kernel/output.js';
// Budget governor + rescue lane (T1.3) — re-export only, no logic: the
// governed-registry seam, the escalation ladder, the honest-stop marker, and
// the rescue policy table + decision engine. Pure types ride along as
// `export type`.
export type {
  AdmissionDecision,
  BudgetGovernor,
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
  DEFAULT_ABORT_GRACE_MS,
  DEFAULT_KILL_GRACE_MS,
  governRegistry,
  governorConfig,
  realClock,
  runLadder,
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
