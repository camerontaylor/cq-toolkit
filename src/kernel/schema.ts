// Zod mirrors of the frozen kernel + driver-seam types — T1.1 types freeze.
//
// The hand-written types in ./types.js and ../driver/types.js are the single
// source of truth; these zod v4 schemas mirror them for serializability
// tests and journal parsing.
//
// Freeze check (one-directional, per the freeze contract): every schema is
// annotated `z.ZodType<Frozen>`, so the schema's inferred OUTPUT must be
// assignable to the hand-written frozen type — a schema that drifts loose
// fails typecheck. Full two-way checking is awkward in zod v4, so the
// one-directional guarantee is the accepted one. Union-member schemas stay
// unannotated ZodObjects (zod's discriminatedUnion needs their internal
// discriminant metadata); annotating the exported unions transitively
// forces every member output into the frozen union.
//
// Every persisted-shape schema is `.strict()`: objects carrying extra keys
// (for instance a key named for a vendor message type) FAIL parsing instead
// of being silently stripped. This backs the vendor-vocabulary frozen claim
// exercised in test/kernel/types.test.ts.
//
// Documented couplings are encoded as refinements, not just prose:
// `earlyStopReason` is present exactly when `stoppedEarly` is true
// (RunReportSchema, RunFinishedJournalEventSchema) and `attempt` is 1-based
// (JobStartedJournalEventSchema).
import { z } from 'zod';
import type {
  Budget,
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
} from '../driver/types.js';
import type {
  Job,
  JobOutcome,
  JobState,
  JobStatus,
  JournalEvent,
  Limits,
  OpResult,
  Plan,
  RunCounts,
  RunEarlyStopReason,
  RunOptions,
  RunReport,
} from './types.js';

// ---------------------------------------------------------------------------
// Driver seam — serializable parts (everything except the Driver interface)
// ---------------------------------------------------------------------------

export const UsageSchema: z.ZodType<Usage> = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  reasoning: z.number().optional(),
}).strict();

export const DriverStopReasonSchema: z.ZodType<DriverStopReason> = z.enum([
  'complete',
  'aborted',
  'budget',
  'error',
]);

export const ModelSpecSchema: z.ZodType<ModelSpec> = z.object({
  model: z.string(),
  provider: z.string(),
}).strict();

export const ToolPolicyModeSchema: z.ZodType<ToolPolicyMode> = z.enum([
  'allowlist',
  'unrestricted',
  'none',
]);

export const ToolPolicySchema: z.ZodType<ToolPolicy> = z.object({
  allow: z.array(z.string()),
  mode: ToolPolicyModeSchema.optional(),
}).strict();

export const SandboxLevelSchema: z.ZodType<SandboxLevel> = z.enum([
  'none',
  'workspace-write',
  'read-only',
]);

export const SandboxPolicySchema: z.ZodType<SandboxPolicy> = z.object({
  level: SandboxLevelSchema,
}).strict();

export const BudgetSchema: z.ZodType<Budget> = z.object({
  maxUsd: z.number().optional(),
  maxTokens: z.number().optional(),
  wallClockMs: z.number().optional(),
  maxAttempts: z.number().optional(),
}).strict();

export const ToolDenialSchema: z.ZodType<ToolDenial> = z.object({
  tool: z.string(),
  reason: z.string(),
}).strict();

export const OpInvocationSchema: z.ZodType<OpInvocation> = z.object({
  prompt: z.string(),
  modelSpec: ModelSpecSchema,
  toolPolicy: ToolPolicySchema,
  sandboxPolicy: SandboxPolicySchema,
  sessionRef: z.string().optional(),
  budget: BudgetSchema,
}).strict();

export const WorkerResultSchema: z.ZodType<WorkerResult> = z.object({
  structuredOutput: z.unknown().optional(),
  usage: UsageSchema,
  costUSD: z.number().optional(),
  sessionId: z.string().optional(),
  denials: z.array(ToolDenialSchema),
  stopReason: DriverStopReasonSchema,
}).strict();

// ---------------------------------------------------------------------------
// Kernel: op result taxonomy
// ---------------------------------------------------------------------------

/**
 * Generic factory for the frozen result taxonomy over a specific value
 * schema. The value-less export below covers the `unknown` instantiation
 * used by journals and run reports.
 */
export function opResultSchema<R>(value: z.ZodType<R>): z.ZodType<OpResult<R>> {
  return z.discriminatedUnion('status', [
    z.object({ status: z.literal('ok'), value }).strict(),
    z.object({ status: z.literal('failed'), error: z.string() }).strict(),
    z.object({ status: z.literal('needs-human'), reason: z.string() }).strict(),
    z.object({ status: z.literal('budget-exhausted') }).strict(),
    z.object({ status: z.literal('indeterminate'), detail: z.string() }).strict(),
  ]);
}

export const OpResultSchema: z.ZodType<OpResult<unknown>> = opResultSchema(z.unknown());

// ---------------------------------------------------------------------------
// Kernel: jobs, plans, run options, limits, reports
// ---------------------------------------------------------------------------

export const JobStateSchema: z.ZodType<JobState> = z.enum([
  'queued',
  'running',
  'blocked',
  'done',
  'failed',
  'budget-exhausted',
]);

export const JobStatusSchema: z.ZodType<JobStatus> = z.object({
  jobId: z.string(),
  state: JobStateSchema,
}).strict();

export const JobSchema: z.ZodType<Job> = z.object({
  id: z.string(),
  op: z.string(),
  input: z.unknown(),
  dependsOn: z.array(z.string()).optional(),
}).strict();

export const PlanSchema: z.ZodType<Plan> = z.object({
  id: z.string(),
  label: z.string().optional(),
  jobs: z.array(JobSchema),
}).strict();

export const RunOptionsSchema: z.ZodType<RunOptions> = z.object({
  concurrency: z.number().int(),
  stopOnError: z.boolean(),
  journalDir: z.string().optional(),
  maxUsd: z.number().optional(),
  resume: z.boolean().optional(),
}).strict();

export const LimitsSchema: z.ZodType<Limits> = z.object({
  maxUsd: z.number().optional(),
  perJobWallClockMs: z.number().optional(),
  maxAttemptsPerJob: z.number().optional(),
  inFlightCeiling: z.number().optional(),
  runDispatchQuota: z.number().optional(),
}).strict();

export const RunEarlyStopReasonSchema: z.ZodType<RunEarlyStopReason> = z.literal('budget');

/** Mirrors `RunCounts`: all six states required, so a missing key fails the ZodType annotation. */
export const RunCountsSchema: z.ZodType<RunCounts> = z.object({
  queued: z.number(),
  running: z.number(),
  blocked: z.number(),
  done: z.number(),
  failed: z.number(),
  'budget-exhausted': z.number(),
}).strict();

export const JobOutcomeSchema: z.ZodType<JobOutcome> = z.object({
  jobId: z.string(),
  op: z.string(),
  result: OpResultSchema,
  usage: UsageSchema.optional(),
  costUSD: z.number().optional(),
}).strict();

export const RunReportSchema: z.ZodType<RunReport> = z.object({
  runId: z.string(),
  stoppedEarly: z.boolean(),
  earlyStopReason: RunEarlyStopReasonSchema.optional(),
  counts: RunCountsSchema,
  jobs: z.array(JobOutcomeSchema),
  usage: UsageSchema.optional(),
  costUSD: z.number().optional(),
}).strict()
  // Honest-stop coupling (frozen): `earlyStopReason` is present exactly when
  // `stoppedEarly` is true.
  .superRefine((report, ctx) => {
    if (report.stoppedEarly && report.earlyStopReason === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'earlyStopReason is required when stoppedEarly is true',
        path: ['earlyStopReason'],
      });
    }
    if (!report.stoppedEarly && report.earlyStopReason !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'earlyStopReason must be omitted when stoppedEarly is false',
        path: ['earlyStopReason'],
      });
    }
  });

// ---------------------------------------------------------------------------
// Kernel: journal events
// ---------------------------------------------------------------------------

// Union members stay inferred ZodObjects (discriminatedUnion needs the
// discriminant metadata); the JournalEventSchema annotation transitively
// forces each member output into the frozen JournalEvent union.

export const RunStartedJournalEventSchema = z.object({
  type: z.literal('run-started'),
  runId: z.string(),
  at: z.string(),
  planId: z.string(),
}).strict();

export const JobStartedJournalEventSchema = z.object({
  type: z.literal('job-started'),
  runId: z.string(),
  at: z.string(),
  jobId: z.string(),
  op: z.string(),
  // 1-based (frozen): the first dispatch of a job is attempt 1.
  attempt: z.number().int().min(1),
}).strict();

export const JobFinishedJournalEventSchema = z.object({
  type: z.literal('job-finished'),
  runId: z.string(),
  at: z.string(),
  jobId: z.string(),
  // Replay record (frozen verbatim): opId + inputsHash + result.
  opId: z.string(),
  inputsHash: z.string(),
  result: OpResultSchema,
  // Per-job usage rollup for resumed runs (USD stays derived-only downstream).
  usage: UsageSchema.optional(),
}).strict();

export const RunFinishedJournalEventSchema = z.object({
  type: z.literal('run-finished'),
  runId: z.string(),
  at: z.string(),
  stoppedEarly: z.boolean(),
  earlyStopReason: RunEarlyStopReasonSchema.optional(),
}).strict()
  // Honest-stop coupling (frozen), mirroring RunReportSchema:
  // `earlyStopReason` is present exactly when `stoppedEarly` is true.
  .superRefine((event, ctx) => {
    if (event.stoppedEarly && event.earlyStopReason === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'earlyStopReason is required when stoppedEarly is true',
        path: ['earlyStopReason'],
      });
    }
    if (!event.stoppedEarly && event.earlyStopReason !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'earlyStopReason must be omitted when stoppedEarly is false',
        path: ['earlyStopReason'],
      });
    }
  });

export const JournalEventSchema: z.ZodType<JournalEvent> = z.discriminatedUnion('type', [
  RunStartedJournalEventSchema,
  JobStartedJournalEventSchema,
  JobFinishedJournalEventSchema,
  RunFinishedJournalEventSchema,
]);
