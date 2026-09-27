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
  GovernanceRecord,
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
    reasoning: z.number().int().nonnegative().exactOptional(),
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
    mode: ToolPolicyModeSchema.exactOptional(),
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
    maxUsd: z.number().nonnegative().exactOptional(),
    maxTokens: z.number().exactOptional(),
    wallClockMs: z.number().exactOptional(),
    maxAttempts: z.number().exactOptional(),
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
    sessionRef: z.string().exactOptional(),
    budget: BudgetSchema,
  })
  .strict();

export const WorkerResultSchema: z.ZodType<WorkerResult> = z
  .object({
    model: z.string().exactOptional(),
    structuredOutput: z.unknown().optional(),
    usage: UsageSchema,
    costUSD: z.number().exactOptional(),
    costBasis: z.enum(['modeled', 'billed']).exactOptional(),
    sessionId: z.string().exactOptional(),
    denials: z.array(ToolDenialSchema),
    // Mirror-only tightening: the frozen doc says "message", not "non-empty" — and the producer bound is 500 chars plus the 13-char '… [truncated]' marker from PR-B's error-text.ts, so the mirror allows 513.
    error: z.string().min(1).max(513).exactOptional(),
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
    // Mirror the frozen type's documented contract: `error` rides only a
    // driver-level failure verdict (stopReason 'error').
    if (result.error !== undefined && result.stopReason !== 'error') {
      ctx.addIssue({
        code: 'custom',
        message: "error is only allowed when stopReason is 'error'",
        path: ['error'],
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
    dependsOn: z.array(z.string()).exactOptional(),
  })
  .strict();

export const PlanSchema: z.ZodType<Plan> = z
  .object({
    id: z.string(),
    label: z.string().exactOptional(),
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
    journalDir: z.string().exactOptional(),
    // Mirror-only tightening (review-debt #17): a negative USD cap is
    // malformed — the frozen RunOptions type is untouched.
    maxUsd: z.number().nonnegative().exactOptional(),
    // maxTokens (DD-9's token rollup cap) mirrors the frozen RunOptions field
    // with the same mirror-tightening precedent as `concurrency` above
    // (recorded pattern: mirror-only tightening, the frozen RunOptions type is
    // untouched; the governor validates finite > 0 at construction). Optional
    // in the frozen type, so the mirror stays optional — the .positive() bound
    // is the tightening.
    maxTokens: z.number().positive().exactOptional(),
    resume: z.boolean().exactOptional(),
  })
  .strict();

export const LimitsSchema: z.ZodType<Limits> = z
  .object({
    // Mirror-only tightenings (review-debt #17, PR #7 Major/P2): USD caps and
    // wall-clock durations are non-negative quantities; attempts are positive
    // integers — the frozen Limits type is untouched.
    maxUsd: z.number().nonnegative().exactOptional(),
    perJobWallClockMs: z.number().nonnegative().exactOptional(),
    maxAttemptsPerJob: z.number().int().positive().exactOptional(),
    // Mirror-only tightening (review-debt #17, PR #7 P2): a pool ceiling
    // below 1 is meaningless, exactly like `concurrency` above — the frozen
    // type is untouched; the runner enforces the same bound at runtime.
    inFlightCeiling: z.number().int().min(1).exactOptional(),
    runDispatchQuota: z.number().exactOptional(),
  })
  .strict();

export const RunEarlyStopReasonSchema: z.ZodType<RunEarlyStopReason> = z.enum(['budget', 'signal']);

/**
 * Mirrors `GovernanceRecord` (run-started.governance — ADR-0003 annex §2).
 * Strict: an unknown governance key fails the journal line, per the
 * persisted-shape rule.
 */
export const GovernanceRecordSchema: z.ZodType<GovernanceRecord> = z
  .object({
    // Mirror-only tightenings (review-debt #17 precedent): caps are
    // non-negative quantities; the frozen type is untouched.
    capUsd: z.number().nonnegative().exactOptional(),
    capTokens: z.number().positive().exactOptional(),
    attended: z.boolean(),
    // W2.3 (A12c): the ADVISORY escape, recorded when the operator passed it.
    allowAdvisory: z.boolean().exactOptional(),
    // W2.3: a capless governed run's conservative inheritance of the
    // previous governed run's capUsd (the ledger's C never silently
    // disappears between runs).
    inheritedCapUsd: z.number().nonnegative().exactOptional(),
    legacyJournal: z
      .object({
        mode: z.literal('reset'),
        v1RunIds: z.array(z.string()),
      })
      .strict()
      .exactOptional(),
    raiseCap: z
      .object({
        from: z.number().nonnegative(),
        to: z.number().nonnegative(),
      })
      .strict()
      .exactOptional(),
  })
  .strict();

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
    usage: UsageSchema.exactOptional(),
    costUSD: z.number().exactOptional(),
  })
  .strict();

export const RunReportSchema: z.ZodType<RunReport> = z
  .object({
    runId: z.string(),
    stoppedEarly: z.boolean(),
    earlyStopReason: RunEarlyStopReasonSchema.exactOptional(),
    counts: RunCountsSchema,
    jobs: z.array(JobOutcomeSchema),
    usage: UsageSchema.exactOptional(),
    costUSD: z.number().exactOptional(),
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
    // Journal v2 (ADR-0003 annex §2), all optional; absent ⇒ v1 record.
    // An OLD strict v1 reader rejects a v2 line on `journalVersion` itself —
    // fail closed (annex §4).
    journalVersion: z.literal(2).exactOptional(),
    seq: z.number().int().positive().exactOptional(),
    governance: GovernanceRecordSchema.exactOptional(),
    ungoverned: z
      .object({ optIn: z.literal(true) })
      .strict()
      .exactOptional(),
  })
  .strict()
  // v2 couplings (annex §2), encoded per the refinements policy above: a v2
  // record carries EXACTLY ONE of the two governance markers (and both ride
  // `journalVersion: 2` only, as does `seq`). No writer emits any other
  // shape, so an occurrence is corruption — folding a marker-bearing line as
  // v1 would silently downgrade the governed-history refusals (the fold sees
  // no governed run), a both-markers line would sit inside AND outside the
  // ledger at once (cap provenance from one marker, spend excluded by the
  // other), and a markerless v2 line would be ledger-invisible history:
  // dispatched dispatches no later run is ever refused over (review threads).
  .superRefine((event, ctx) => {
    if (
      event.journalVersion === undefined &&
      (event.governance !== undefined || event.ungoverned !== undefined || event.seq !== undefined)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'journalVersion: 2 is required when governance, ungoverned, or seq is present',
        path: ['journalVersion'],
      });
    }
    if (event.governance !== undefined && event.ungoverned !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'governance and ungoverned are mutually exclusive',
        path: ['ungoverned'],
      });
    }
    if (
      event.journalVersion !== undefined &&
      event.governance === undefined &&
      event.ungoverned === undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'a v2 run-started requires exactly one of governance or ungoverned',
        path: ['governance'],
      });
    }
  });

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
    usage: UsageSchema.exactOptional(),
    // v1.1 journal v2 (ADR-0003 annex §2): the job's modeled USD rollup,
    // written by the governed runner when cost was observed.
    costUSD: z.number().exactOptional(),
    // W2.3 (reservation-era runs): the job's reservation-side charge — the
    // ledger truth that includes a full reservation charge behind an abort.
    charged: z.number().nonnegative().exactOptional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Kernel: reservation-era events (journal v2, W2.3 — ADR-0003 §2.8)
// ---------------------------------------------------------------------------

export const ReservationOpenedJournalEventSchema = z
  .object({
    type: z.literal('reservation-opened'),
    runId: z.string(),
    at: z.iso.datetime(),
    jobId: z.string(),
    op: z.string(),
    attempt: z.number().int().min(1),
    reservationId: z.string().min(1),
    // The reserved amount r — non-negative (a zero reservation is legal:
    // capacity shrunk to the floor of the bound).
    usd: z.number().nonnegative(),
    class: z.enum(['hard', 'advisory']),
    proposedUsd: z.number().nonnegative().exactOptional(),
  })
  .strict();

export const ReservationSettledJournalEventSchema = z
  .object({
    type: z.literal('reservation-settled'),
    runId: z.string(),
    at: z.iso.datetime(),
    jobId: z.string(),
    reservationId: z.string().min(1),
    charged: z.number().nonnegative(),
    basis: z.enum(['observed', 'full']),
    usage: UsageSchema.exactOptional(),
  })
  .strict();

export const ReservationRefusedJournalEventSchema = z
  .object({
    type: z.literal('reservation-refused'),
    runId: z.string(),
    at: z.iso.datetime(),
    jobId: z.string(),
    op: z.string(),
    reason: z.enum(['advisory-lane']),
  })
  .strict();

export const JobQuarantinedJournalEventSchema = z
  .object({
    type: z.literal('job-quarantined'),
    runId: z.string(),
    at: z.iso.datetime(),
    jobId: z.string(),
    reservationId: z.string().min(1),
    chargedUsd: z.number().nonnegative(),
    reason: z.literal('unresolved-reservation'),
  })
  .strict();

export const QuarantineReleasedJournalEventSchema = z
  .object({
    type: z.literal('quarantine-released'),
    runId: z.string(),
    at: z.iso.datetime(),
    jobId: z.string(),
    provenance: z.literal('call'),
  })
  .strict();

export const BudgetTrippedJournalEventSchema = z
  .object({
    type: z.literal('budget-tripped'),
    runId: z.string(),
    at: z.iso.datetime(),
    tripKind: z.enum(['exhausted', 'token-cap', 'breach', 'signal']),
    reason: z.string(),
  })
  .strict();

export const RunFinishedJournalEventSchema = z
  .object({
    type: z.literal('run-finished'),
    runId: z.string(),
    at: z.iso.datetime(),
    stoppedEarly: z.boolean(),
    earlyStopReason: RunEarlyStopReasonSchema.exactOptional(),
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
  ReservationOpenedJournalEventSchema,
  ReservationSettledJournalEventSchema,
  ReservationRefusedJournalEventSchema,
  JobQuarantinedJournalEventSchema,
  QuarantineReleasedJournalEventSchema,
  BudgetTrippedJournalEventSchema,
]);
