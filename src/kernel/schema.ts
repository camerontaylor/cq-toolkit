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

export const UsageSchema: z.ZodType<Usage> = z
  .object({
    // Mirror-only tightening (review-debt #17, PR #7 Major/P2): token counts
    // are cardinalities — non-negative integers. The frozen Usage type is
    // untouched; a negative or fractional count is malformed at the mirror
    // exactly like the CLI lanes' own wire gates.
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
    cacheRead: z.number().int().nonnegative(),
    cacheWrite: z.number().int().nonnegative(),
    reasoning: z.number().int().nonnegative().optional(),
  })
  .strict();

export const DriverStopReasonSchema: z.ZodType<DriverStopReason> = z.enum([
  'complete',
  'aborted',
  'budget',
  'error',
]);

export const ModelSpecSchema: z.ZodType<ModelSpec> = z
  .object({
    model: z.string(),
    provider: z.string(),
  })
  .strict();

export const ToolPolicyModeSchema: z.ZodType<ToolPolicyMode> = z.enum([
  'allowlist',
  'unrestricted',
  'none',
]);

export const ToolPolicySchema: z.ZodType<ToolPolicy> = z
  .object({
    allow: z.array(z.string()),
    mode: ToolPolicyModeSchema.optional(),
  })
  .strict();

export const SandboxLevelSchema: z.ZodType<SandboxLevel> = z.enum([
  'none',
  'workspace-write',
  'read-only',
]);

export const SandboxPolicySchema: z.ZodType<SandboxPolicy> = z
  .object({
    level: SandboxLevelSchema,
  })
  .strict();

export const BudgetSchema: z.ZodType<Budget> = z
  .object({
    // Mirror-only tightening (review-debt #17): a negative USD cap is
    // malformed — the frozen RunOptions type is untouched.
    maxUsd: z.number().nonnegative().optional(),
    maxTokens: z.number().optional(),
    wallClockMs: z.number().optional(),
    maxAttempts: z.number().optional(),
  })
  .strict();

export const ToolDenialSchema: z.ZodType<ToolDenial> = z
  .object({
    tool: z.string(),
    reason: z.string(),
  })
  .strict();

export const OpInvocationSchema: z.ZodType<OpInvocation> = z
  .object({
    prompt: z.string(),
    modelSpec: ModelSpecSchema,
    toolPolicy: ToolPolicySchema,
    sandboxPolicy: SandboxPolicySchema,
    sessionRef: z.string().optional(),
    budget: BudgetSchema,
  })
  .strict();

export const WorkerResultSchema: z.ZodType<WorkerResult> = z
  .object({
    model: z.string().optional(),
    structuredOutput: z.unknown().optional(),
    usage: UsageSchema,
    costUSD: z.number().optional(),
    costBasis: z.enum(['modeled', 'billed']).optional(),
    sessionId: z.string().optional(),
    denials: z.array(ToolDenialSchema),
    stopReason: DriverStopReasonSchema,
  })
  .strict()
  // DD-9 cost pairing, wire schema only: costBasis is present EXACTLY when
  // costUSD is — a priced result carries both, an unpriced result carries
  // neither. Mirror-only tightening (same recorded precedent as the
  // RunOptions bounds): the frozen WorkerResult type is untouched — the
  // type-level half of this coupling is a post-freeze note.
  .superRefine((result, ctx) => {
    if (result.costUSD !== undefined && result.costBasis === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'costBasis is required when costUSD is present',
        path: ['costBasis'],
      });
    }
    if (result.costUSD === undefined && result.costBasis !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'costBasis must be omitted when costUSD is absent',
        path: ['costBasis'],
      });
    }
  });

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

export const JobStatusSchema: z.ZodType<JobStatus> = z
  .object({
    jobId: z.string(),
    state: JobStateSchema,
  })
  .strict();

export const JobSchema: z.ZodType<Job> = z
  .object({
    id: z.string(),
    op: z.string(),
    input: z.unknown(),
    dependsOn: z.array(z.string()).optional(),
  })
  .strict();

export const PlanSchema: z.ZodType<Plan> = z
  .object({
    id: z.string(),
    label: z.string().optional(),
    jobs: z.array(JobSchema),
  })
  .strict();

export const RunOptionsSchema: z.ZodType<RunOptions> = z
  .object({
    // Concurrency is a pool size, so < 1 is meaningless: .min(1) tightens the
    // T1.1 mirror (round-4 medium finding, recorded in PR 7's 'Accepted at
    // merge' notes as folded into the next kernel-schema-touching PR — this
    // one, T1.2). Mirror-only tightening; the frozen RunOptions type is
    // untouched. The runner enforces the same bound at runtime.
    concurrency: z.number().int().min(1),
    stopOnError: z.boolean(),
    journalDir: z.string().optional(),
    // Mirror-only tightening (review-debt #17): a negative USD cap is
    // malformed — the frozen RunOptions type is untouched.
    maxUsd: z.number().nonnegative().optional(),
    // maxTokens (DD-9's token rollup cap) mirrors the frozen RunOptions field
    // with the same mirror-tightening precedent as `concurrency` above
    // (recorded pattern: mirror-only tightening, the frozen RunOptions type is
    // untouched; the governor validates finite > 0 at construction). Optional
    // in the frozen type, so the mirror stays optional — the .positive() bound
    // is the tightening.
    maxTokens: z.number().positive().optional(),
    resume: z.boolean().optional(),
  })
  .strict();

export const LimitsSchema: z.ZodType<Limits> = z
  .object({
    // Mirror-only tightenings (review-debt #17, PR #7 Major/P2): USD caps and
    // wall-clock durations are non-negative quantities; attempts are positive
    // integers — the frozen Limits type is untouched.
    maxUsd: z.number().nonnegative().optional(),
    perJobWallClockMs: z.number().nonnegative().optional(),
    maxAttemptsPerJob: z.number().int().positive().optional(),
    // Mirror-only tightening (review-debt #17, PR #7 P2): a pool ceiling
    // below 1 is meaningless, exactly like `concurrency` above — the frozen
    // type is untouched; the runner enforces the same bound at runtime.
    inFlightCeiling: z.number().int().min(1).optional(),
    runDispatchQuota: z.number().optional(),
  })
  .strict();

export const RunEarlyStopReasonSchema: z.ZodType<RunEarlyStopReason> = z.literal('budget');

/** Mirrors `RunCounts`: all six states required, so a missing key fails the ZodType annotation. */
export const RunCountsSchema: z.ZodType<RunCounts> = z
  .object({
    // Mirror-only tightening (review-debt #17, PR #7 Major/P2): counts are
    // cardinalities — non-negative integers; the frozen RunCounts type is
    // untouched.
    queued: z.number().int().nonnegative(),
    running: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
    done: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    'budget-exhausted': z.number().int().nonnegative(),
  })
  .strict();

export const JobOutcomeSchema: z.ZodType<JobOutcome> = z
  .object({
    jobId: z.string(),
    op: z.string(),
    result: OpResultSchema,
    usage: UsageSchema.optional(),
    costUSD: z.number().optional(),
  })
  .strict();

export const RunReportSchema: z.ZodType<RunReport> = z
  .object({
    runId: z.string(),
    stoppedEarly: z.boolean(),
    earlyStopReason: RunEarlyStopReasonSchema.optional(),
    counts: RunCountsSchema,
    jobs: z.array(JobOutcomeSchema),
    usage: UsageSchema.optional(),
    costUSD: z.number().optional(),
  })
  .strict()
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

export const RunStartedJournalEventSchema = z
  .object({
    type: z.literal('run-started'),
    runId: z.string(),
    // ISO-8601 UTC timestamps (review-debt #17, PR #7 Minor): the journal
    // contract already emits z.iso datetime strings (now() in runner.ts);
    // the mirror now rejects anything else.
    at: z.iso.datetime(),
    planId: z.string(),
  })
  .strict();

export const JobStartedJournalEventSchema = z
  .object({
    type: z.literal('job-started'),
    runId: z.string(),
    at: z.iso.datetime(),
    jobId: z.string(),
    op: z.string(),
    // 1-based (frozen): the first dispatch of a job is attempt 1.
    attempt: z.number().int().min(1),
  })
  .strict();

export const JobFinishedJournalEventSchema = z
  .object({
    type: z.literal('job-finished'),
    runId: z.string(),
    at: z.iso.datetime(),
    jobId: z.string(),
    // Replay record (frozen verbatim): opId + inputsHash + result.
    opId: z.string(),
    inputsHash: z.string(),
    result: OpResultSchema,
    // Per-job usage rollup for resumed runs (USD stays derived-only downstream).
    usage: UsageSchema.optional(),
  })
  .strict();

export const RunFinishedJournalEventSchema = z
  .object({
    type: z.literal('run-finished'),
    runId: z.string(),
    at: z.iso.datetime(),
    stoppedEarly: z.boolean(),
    earlyStopReason: RunEarlyStopReasonSchema.optional(),
  })
  .strict()
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
