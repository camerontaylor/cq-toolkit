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
import { assertJsonLossless } from '../shared/jsonLossless.js';
import type {
  AttemptBudget,
  AttemptBudgetAmount,
  AttemptError,
  AttemptStopClass,
  AttemptTimeout,
  AvailabilityRecord,
  AvailabilityState,
  CorrelationRecord,
  GovernanceRecord,
  Job,
  JobOutcome,
  JobState,
  JobStatus,
  JournalEvent,
  KnownUsageSummary,
  Limits,
  OpResult,
  OpResultArtifact,
  Plan,
  ProvenanceRecord,
  RunCounts,
  RunEarlyStopReason,
  RunOptions,
  RunReport,
  RunStartedV3JournalEvent,
  WitnessesRecord,
  CompositionStartedJournalEvent,
  CompositionStartedPayload,
  KernelRunLinkedJournalEvent,
  KernelRunLinkedPayload,
  ObservationEvent,
  ObservationStream,
  AttemptFinishedJournalEvent,
  AttemptFinishedPayload,
  ApprovalJournalEvent,
  ApprovalPayload,
  GateVerdictJournalEvent,
  GateVerdictPayload,
  TaskFinishedJournalEvent,
  TaskFinishedPayload,
  WriteObservationJournalEvent,
  WriteObservationPayload,
  AcceptancePayload,
  DispositionPayload,
  FindingDispositionJournalEvent,
  FindingFingerprint,
  HeadAcceptanceJournalEvent,
  ReviewObservedJournalEvent,
  ReviewObservedPayload,
  BaselineFailureRecord,
  ClosureRecord,
  MeasurementSummaryJournalEvent,
  MeasurementSummaryPayload,
  MetricRecord,
  ReportV2,
} from './types.js';

// ---------------------------------------------------------------------------
// Driver seam mirrors — the schema definitions LIVE in the driver family
// (src/driver/schema.ts, seam v2: the shipped conformance suite binds the
// one-directional rule that src/driver never imports src/kernel); this
// module re-exports every name so the kernel's and the root barrel's public
// mirror surface is unchanged. `UsageSchema` is imported for value use in
// the kernel schemas below.
// ---------------------------------------------------------------------------

export {
  BudgetSchema,
  DriverStopReasonSchema,
  ModelSpecSchema,
  OpInvocationSchema,
  OutputSchemaSchema,
  ProviderSignalsSchema,
  SandboxLevelSchema,
  SandboxPolicySchema,
  ToolDenialSchema,
  ToolPolicyModeSchema,
  ToolPolicySchema,
  UsageSchema,
  WorkerErrorClassSchema,
  WorkerResultSchema,
  WorkspaceBindingSchema,
} from '../driver/schema.js';
import { ModelSpecSchema, UsageSchema } from '../driver/schema.js';

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

const NonnegativeSafeCountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** Lowercase full Git object ID (ADR-0008 wire rule for SHA fields). */
const ShaSchema = z.string().regex(/^[0-9a-f]{40}$/);

/** `sha256:` + 64 lowercase hex characters over UTF-8 bytes (ADR-0008). */
const HashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

/** Typed, strict optional result envelope; absent usage stays distinct from zero. */
export const KnownUsageSummarySchema: z.ZodType<KnownUsageSummary> = z
  .object({
    usage: UsageSchema.exactOptional(),
    costUSD: z.number().finite().nonnegative().exactOptional(),
    knownCount: NonnegativeSafeCountSchema,
    unknownCount: NonnegativeSafeCountSchema,
    unpricedCount: NonnegativeSafeCountSchema,
  })
  .strict();

/** Consumer envelope only; the frozen base taxonomy remains strict and unchanged. */
export const OpResultArtifactSchema = z
  .unknown()
  .transform((raw, ctx): OpResultArtifact<unknown> => {
    let base = raw;
    const hasReport = typeof raw === 'object' && raw !== null && Object.hasOwn(raw, 'report');
    const hasUsageSummary =
      typeof raw === 'object' && raw !== null && Object.hasOwn(raw, 'usageSummary');
    if (hasReport || hasUsageSummary) {
      const {
        report: _report,
        usageSummary: _usageSummary,
        ...rest
      } = raw as Record<string, unknown>;
      base = rest;
    }
    const parsed = OpResultSchema.safeParse(base);
    if (!parsed.success) {
      ctx.addIssue({ code: 'custom', message: 'invalid strict OpResult base' });
      return z.NEVER;
    }
    if (hasReport) {
      try {
        const report = (raw as Record<string, unknown>).report;
        JSON.stringify(report, (_key, value: unknown) => {
          if (value === undefined) throw new Error('undefined member in report');
          return value;
        });
        assertJsonLossless(report);
      } catch (error) {
        ctx.addIssue({ code: 'custom', message: `non-lossless report: ${String(error)}` });
        return z.NEVER;
      }
    }
    if (hasUsageSummary) {
      const usageSummary = (raw as Record<string, unknown>).usageSummary;
      const summary = KnownUsageSummarySchema.safeParse(usageSummary);
      if (!summary.success) {
        ctx.addIssue({ code: 'custom', message: 'invalid usageSummary' });
        return z.NEVER;
      }
      try {
        JSON.stringify(usageSummary, (_key, value: unknown) => {
          if (value === undefined) throw new Error('undefined member in usageSummary');
          return value;
        });
        assertJsonLossless(usageSummary);
      } catch (error) {
        ctx.addIssue({ code: 'custom', message: `non-lossless usageSummary: ${String(error)}` });
        return z.NEVER;
      }
    }
    return raw as OpResultArtifact<unknown>;
  });

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
    // WHO set allowAdvisory ('operator' = the CLI flag, 'product' = an
    // unattended-by-design product path) — present only alongside it.
    allowAdvisoryProvenance: z.enum(['operator', 'product']).exactOptional(),
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
  .strict()
  // Provenance coupling (W2.3 fix round): the escape's provenance is
  // meaningful only alongside the escape itself.
  .superRefine((record, ctx) => {
    if (record.allowAdvisoryProvenance !== undefined && record.allowAdvisory !== true) {
      ctx.addIssue({
        code: 'custom',
        message: 'allowAdvisoryProvenance is only meaningful when allowAdvisory is true',
        path: ['allowAdvisoryProvenance'],
      });
    }
  });

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
    result: OpResultArtifactSchema,
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

// The v1/v2 union members stay inferred ZodObjects (discriminatedUnion needs
// the discriminant metadata); the annotated v3 carriers compose with them in
// the top-level JournalEventSchema (z.union over the v1/v2 discriminated
// union plus the v3 carriers) whose annotation transitively forces every
// member output into the frozen JournalEvent union.

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
    result: OpResultArtifactSchema,
    // Per-job usage rollup for resumed runs (USD stays derived-only downstream).
    usage: UsageSchema.exactOptional(),
    // v1.1 journal v2 (ADR-0003 annex §2): the job's modeled USD rollup,
    // written by the governed runner when cost was observed.
    costUSD: z.number().exactOptional(),
    // W2.3 (reservation-era runs): the job's reservation-side charge — the
    // ledger truth that includes a full reservation charge behind an abort.
    charged: z.number().nonnegative().exactOptional(),
    // Session-log preservation (plan item 1.3, journal v2 additive fields,
    // 2026-10-24): the correlation facts. ABSENT on every pre-existing
    // line (optional here ⇒ old v1/v2 readers ignore them; old STRICT
    // readers that reject unknown keys are the annex §4 fail-closed case —
    // none ship in-repo). `workId` mints the work-unit identity, `role`
    // names the lane's function, `sessions` links every driver session the
    // job produced: our store id, the harness-native id when one was
    // observed (item 1.5), and the store file's expected path.
    workId: z.string().min(1).exactOptional(),
    role: z.string().min(1).exactOptional(),
    sessions: z
      .array(
        z
          .object({
            driver: z.string(),
            sessionId: z.string().min(1),
            nativeSessionId: z.string().min(1).exactOptional(),
            path: z.string().min(1).exactOptional(),
          })
          .strict(),
      )
      .exactOptional(),
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
    // PRICE PRESENCE (H2/DD-9): a `costUSD` (zero included) was observed on
    // the channel. Optional in the schema so an older in-flight journal
    // still parses; the fold treats ABSENT as unpriced (fail loud).
    priced: z.boolean().exactOptional(),
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
    // The run file's total event count (comp 2's line-deletion detector).
    eventCount: z.number().int().positive().exactOptional(),
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

// ---------------------------------------------------------------------------
// Kernel: journal v3 header + attempt schemas (ADR-0008, T25 — schema only;
// no writer is enabled by this slice)
// ---------------------------------------------------------------------------

export const AvailabilityStateSchema: z.ZodType<AvailabilityState> = z.enum([
  'known-zero',
  'not-collected',
  'unavailable',
  'partial',
  'n-a',
  'known',
]);

export const AvailabilityRecordSchema: z.ZodType<AvailabilityRecord> = z
  .object({
    state: AvailabilityStateSchema,
    reason: z.string(),
    source: z.string().nullable(),
  })
  .strict();

/** Availability map keyed by JSON Pointer (empty or leading '/') relative to the containing payload. */
export const AvailabilityMapSchema: z.ZodType<Record<string, AvailabilityRecord>> = z.record(
  z.string().regex(/^$|^\//),
  AvailabilityRecordSchema,
);

export const WitnessesRecordSchema: z.ZodType<WitnessesRecord> = z
  .object({
    base: ShaSchema,
    admitted: ShaSchema.nullable(),
    execution: ShaSchema.nullable(),
    reviewed: ShaSchema.nullable(),
    accepted: ShaSchema.nullable(),
  })
  .strict();

export const ProvenanceRecordSchema: z.ZodType<ProvenanceRecord> = z
  .object({
    cqVersion: z.string(),
    producerVersion: z.string(),
    repoId: HashSchema.nullable(),
    cqJsonHash: HashSchema,
    baseSha: ShaSchema,
    runPrefix: z.string(),
    startedAt: z.iso.datetime(),
    endedAt: z.iso.datetime().nullable(),
    journalLink: z.string(),
    reportLink: z.string(),
    witnesses: WitnessesRecordSchema,
  })
  .strict();

export const CorrelationRecordSchema: z.ZodType<CorrelationRecord> = z
  .object({
    workId: z.uuid(),
    parentWorkId: z.uuid().nullable(),
    branch: z.string(),
    commitSha: ShaSchema.nullable(),
    sessionId: z.string().min(1).nullable(),
    agentId: z.string().min(1).nullable(),
  })
  .strict();

export const RunStartedV3JournalEventSchema: z.ZodType<RunStartedV3JournalEvent> = z
  .object({
    type: z.literal('run-started'),
    runId: z.string(),
    at: z.iso.datetime({ precision: 3 }),
    planId: z.string(),
    journalVersion: z.literal(3),
    seq: z.number().int().positive(),
    governance: GovernanceRecordSchema.exactOptional(),
    ungoverned: z
      .object({ optIn: z.literal(true) })
      .strict()
      .exactOptional(),
    provenance: ProvenanceRecordSchema,
    correlation: CorrelationRecordSchema,
    availability: AvailabilityMapSchema,
  })
  .strict()
  // Envelope couplings (ADR-0008), encoded per the refinements policy:
  // exactly one of governance/ungoverned, as in v2; the header's baseSha and
  // witnesses.base must agree.
  .superRefine((event, ctx) => {
    const hasGovernance = event.governance !== undefined;
    const hasUngoverned = event.ungoverned !== undefined;
    if (hasGovernance && hasUngoverned) {
      ctx.addIssue({
        code: 'custom',
        message: 'governance and ungoverned are mutually exclusive',
        path: ['ungoverned'],
      });
    }
    if (!hasGovernance && !hasUngoverned) {
      ctx.addIssue({
        code: 'custom',
        message: 'a v3 run-started requires exactly one of governance or ungoverned',
        path: ['governance'],
      });
    }
    if (event.provenance.baseSha !== event.provenance.witnesses.base) {
      ctx.addIssue({
        code: 'custom',
        message: 'provenance.baseSha and provenance.witnesses.base must agree',
        path: ['provenance'],
      });
    }
  });

export const AttemptStopClassSchema: z.ZodType<AttemptStopClass> = z.enum([
  'retriable',
  'terminal',
  'infrastructure',
  'budget',
  'human',
]);

export const AttemptErrorSchema: z.ZodType<AttemptError> = z
  .object({
    type: z.string().nullable(),
    code: z.string().nullable(),
    providerFinishReason: z.string().nullable(),
    source: z.string(),
    certainty: z.enum(['observed', 'inferred', 'unknown']),
  })
  .strict();

export const AttemptTimeoutSchema: z.ZodType<AttemptTimeout> = z
  .object({
    scope: z.enum(['request', 'step', 'attempt', 'run']),
    boundMs: z.number().nonnegative(),
    source: z.string(),
  })
  .strict();

export const AttemptBudgetAmountSchema: z.ZodType<AttemptBudgetAmount> = z
  .object({
    tokens: NonnegativeSafeCountSchema.nullable(),
    wallMs: z.number().nonnegative().nullable(),
  })
  .strict();

export const AttemptBudgetSchema: z.ZodType<AttemptBudget> = z
  .object({
    allowed: AttemptBudgetAmountSchema,
    spent: AttemptBudgetAmountSchema,
    remaining: AttemptBudgetAmountSchema,
  })
  .strict();

export const AttemptFinishedPayloadSchema: z.ZodType<AttemptFinishedPayload> = z
  .object({
    tier: z.enum(['worker', 'rescue']),
    invocation: z.string(),
    model: ModelSpecSchema.nullable(),
    provider: z.string(),
    requestedModel: z.string(),
    servedModel: z.string().nullable(),
    tokens: NonnegativeSafeCountSchema.nullable(),
    usageChannels: z.record(z.string(), NonnegativeSafeCountSchema.nullable()),
    requests: NonnegativeSafeCountSchema.nullable(),
    wallMs: z.number().nonnegative().nullable(),
    modeledUsd: z.number().nonnegative().nullable(),
    priceTableRevision: z.string().nullable(),
    priceCoverage: z.string().nullable(),
    stopReason: z.string(),
    stopCode: z.string(),
    class: AttemptStopClassSchema,
    error: AttemptErrorSchema.nullable(),
    timeout: AttemptTimeoutSchema.nullable(),
    budget: AttemptBudgetSchema,
    availability: AvailabilityMapSchema,
  })
  .strict();

export const AttemptFinishedJournalEventSchema: z.ZodType<AttemptFinishedJournalEvent> = z
  .object({
    type: z.literal('attempt-finished'),
    runId: z.string(),
    at: z.iso.datetime({ precision: 3 }),
    unitId: z.string().min(1),
    jobId: z.string().min(1).nullable(),
    taskId: z.string().min(1),
    attempt: z.number().int().min(1),
    payload: AttemptFinishedPayloadSchema,
  })
  .strict();

// ---------------------------------------------------------------------------
// Kernel: journal v3 gate/task/approval/write schemas (ADR-0008, T26 —
// schema only; reserved members parse without producers, no writer enabled)
// ---------------------------------------------------------------------------

export const GateVerdictPayloadSchema: z.ZodType<GateVerdictPayload> = z
  .object({
    gate: z.string().min(1),
    verdict: z.enum(['pass', 'fail', 'indeterminate', 'needs-human']),
    bail: z.string().min(1).exactOptional(),
    fingerprintVersion: z.number().int().nonnegative().nullable(),
    availability: AvailabilityMapSchema,
  })
  .strict();

export const GateVerdictJournalEventSchema: z.ZodType<GateVerdictJournalEvent> = z
  .object({
    type: z.literal('gate-verdict'),
    runId: z.string(),
    at: z.iso.datetime({ precision: 3 }),
    unitId: z.string().min(1),
    jobId: z.string().min(1).nullable(),
    taskId: z.string().min(1),
    attempt: z.number().int().min(1),
    payload: GateVerdictPayloadSchema,
  })
  .strict();

export const TaskFinishedPayloadSchema: z.ZodType<TaskFinishedPayload> = z
  .object({
    taskId: z.string().min(1),
    changed: z.boolean(),
    availability: AvailabilityMapSchema,
  })
  .strict();

export const TaskFinishedJournalEventSchema: z.ZodType<TaskFinishedJournalEvent> = z
  .object({
    type: z.literal('task-finished'),
    runId: z.string(),
    at: z.iso.datetime({ precision: 3 }),
    unitId: z.string().min(1),
    jobId: z.string().min(1).nullable(),
    taskId: z.string().min(1),
    attempt: z.number().int().min(1),
    payload: TaskFinishedPayloadSchema,
  })
  .strict();

export const ApprovalPayloadSchema: z.ZodType<ApprovalPayload> = z
  .object({
    approvalId: HashSchema,
    reason: z.string(),
    availability: AvailabilityMapSchema,
  })
  .strict();

export const ApprovalJournalEventSchema: z.ZodType<ApprovalJournalEvent> = z
  .object({
    type: z.enum(['approval-granted', 'approval-expired']),
    runId: z.string(),
    at: z.iso.datetime({ precision: 3 }),
    unitId: z.string().min(1).nullable(),
    jobId: z.string().min(1).nullable(),
    taskId: z.string().min(1).nullable(),
    attempt: z.number().int().min(1).nullable(),
    payload: ApprovalPayloadSchema,
  })
  .strict();

export const WriteObservationPayloadSchema: z.ZodType<WriteObservationPayload> = z
  .object({
    path: z.string(),
    reason: z.string(),
    cap: NonnegativeSafeCountSchema.nullable(),
    observed: NonnegativeSafeCountSchema.nullable(),
    availability: AvailabilityMapSchema,
  })
  .strict();

export const WriteObservationJournalEventSchema: z.ZodType<WriteObservationJournalEvent> = z
  .object({
    type: z.enum(['write-path-denied', 'write-path-cap-tripped']),
    runId: z.string(),
    at: z.iso.datetime({ precision: 3 }),
    unitId: z.string().min(1).nullable(),
    jobId: z.string().min(1).nullable(),
    taskId: z.string().min(1).nullable(),
    attempt: z.number().int().min(1).nullable(),
    payload: WriteObservationPayloadSchema,
  })
  .strict();

// ---------------------------------------------------------------------------
// Kernel: journal v3 disposition/acceptance/review schemas (ADR-0008, T27 —
// schema only; no evidence importer and no acceptance authority added)
// ---------------------------------------------------------------------------

export const FindingFingerprintSchema: z.ZodType<FindingFingerprint> = z
  .object({
    version: z.literal(1),
    checkId: z.string().min(1),
    rule: z.string().min(1).nullable(),
    path: z.string(),
    spanContentHash: HashSchema.nullable(),
  })
  .strict();

export const DispositionPayloadSchema: z.ZodType<DispositionPayload> = z
  .object({
    fingerprint: FindingFingerprintSchema,
    status: z.enum(['fixed', 'rejected', 'deferred']),
    reason: z.string(),
    owner: z.string().min(1),
    evidence: z.array(z.string()),
    reviewTrigger: z.string().min(1).nullable(),
    observedHead: ShaSchema,
    observedAt: z.iso.datetime({ precision: 3 }),
    acceptedRisk: z.string().nullable(),
    availability: AvailabilityMapSchema,
  })
  .strict()
  .refine(
    (payload) =>
      payload.status !== 'deferred' ||
      (payload.reviewTrigger !== null && payload.reviewTrigger.length > 0),
    { message: 'a deferred disposition requires a nonempty reviewTrigger' },
  );

export const FindingDispositionJournalEventSchema: z.ZodType<FindingDispositionJournalEvent> = z
  .object({
    type: z.literal('finding-disposition'),
    runId: z.string(),
    at: z.iso.datetime({ precision: 3 }),
    unitId: z.string().min(1).nullable(),
    jobId: z.string().min(1).nullable(),
    taskId: z.string().min(1).nullable(),
    attempt: z.number().int().min(1).nullable(),
    payload: DispositionPayloadSchema,
  })
  .strict();

export const AcceptancePayloadSchema: z.ZodType<AcceptancePayload> = z
  .object({
    headSha: ShaSchema,
    reviewedBaseSha: ShaSchema,
    reviewerId: z.string().min(1),
    authorId: z.string().min(1),
    independent: z.boolean(),
    verdict: z.enum(['PASS', 'HOLD', 'RETRACT']),
    evidence: z.array(z.string()),
    availability: AvailabilityMapSchema,
  })
  .strict();

export const HeadAcceptanceJournalEventSchema: z.ZodType<HeadAcceptanceJournalEvent> = z
  .object({
    type: z.literal('head-acceptance'),
    runId: z.string(),
    at: z.iso.datetime({ precision: 3 }),
    unitId: z.string().min(1).nullable(),
    jobId: z.string().min(1).nullable(),
    taskId: z.string().min(1).nullable(),
    attempt: z.number().int().min(1).nullable(),
    payload: AcceptancePayloadSchema,
  })
  .strict();

export const ReviewObservedPayloadSchema: z.ZodType<ReviewObservedPayload> = z
  .object({
    baseSha: ShaSchema,
    headSha: ShaSchema,
    findingFingerprints: z.array(FindingFingerprintSchema),
    coverage: z.string(),
    initialBlocking: z.array(FindingFingerprintSchema).nullable(),
    reviewerId: z.string().min(1),
    source: z.string().min(1),
    round: NonnegativeSafeCountSchema,
    delivered: z.array(z.string()),
    completed: z.array(z.string()),
    omissions: z.array(z.string()),
    vendorCompletion: z.enum(['completed', 'not-completed', 'unknown']),
    availability: AvailabilityMapSchema,
  })
  .strict();

export const ReviewObservedJournalEventSchema: z.ZodType<ReviewObservedJournalEvent> = z
  .object({
    type: z.literal('review-observed'),
    runId: z.string(),
    at: z.iso.datetime({ precision: 3 }),
    unitId: z.string().min(1).nullable(),
    jobId: z.string().min(1).nullable(),
    taskId: z.string().min(1).nullable(),
    attempt: z.number().int().min(1).nullable(),
    payload: ReviewObservedPayloadSchema,
  })
  .strict();

// ---------------------------------------------------------------------------
// Kernel: journal v3 metric + report v2 root schemas (ADR-0008, T28 — schema
// only; composes previously landed payload schemas, writer disabled)
// ---------------------------------------------------------------------------

export const ClosureRecordSchema: z.ZodType<ClosureRecord> = z
  .object({
    commitSha: ShaSchema,
    taskIds: z.array(z.string().min(1)),
    findingFingerprints: z.array(FindingFingerprintSchema),
    verificationEvidence: z.array(z.string()),
    todo: z.boolean(),
  })
  .strict();

export const BaselineFailureRecordSchema: z.ZodType<BaselineFailureRecord> = z
  .object({
    unitId: z.string().min(1),
    probeHead: ShaSchema.nullable(),
    completed: z.boolean(),
    count: NonnegativeSafeCountSchema.nullable(),
    unknownReason: z.string().nullable(),
  })
  .strict();

export const MetricRecordSchema: z.ZodType<MetricRecord> = z
  .object({
    fixesPerRun: z
      .object({
        numerator: NonnegativeSafeCountSchema.nullable(),
        denominator: NonnegativeSafeCountSchema.nullable(),
      })
      .strict(),
    verifiedCommits: z.array(ShaSchema),
    closures: z.array(ClosureRecordSchema),
    baselineFailures: z.array(BaselineFailureRecordSchema),
  })
  .strict();

/**
 * ADR-0008 availability discipline over a metric paired with its containing
 * availability map: every null in `fixesPerRun.numerator`/`.denominator` and
 * `baselineFailures[i].count` requires an availability record at its JSON
 * Pointer (relative to the containing payload/report), unknown never becomes
 * zero, and any unknown baseline count makes the aggregate denominator
 * unknown. The count/unknownReason coupling on BaselineFailureRecord is left
 * to T34; the ADR does not state it, so it is not refined here.
 * `verifiedCommits` uniqueness and closure projection are enforced too: it is
 * the deduplicated projection of verified non-todo closures.
 */
function checkMetric(
  metric: MetricRecord,
  availability: Record<string, AvailabilityRecord>,
  ctx: {
    addIssue: (issue: { code: 'custom'; message: string; path?: (string | number)[] }) => void;
  },
): void {
  const pointer = (p: string): void => {
    const record = availability[p];
    if (record === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: `a null metric value requires an availability entry at ${p}`,
        path: ['metric'],
      });
      // P3-3 coordinator ruling: a null value is not a known zero — a 'known'
      // or 'known-zero' state on a null contradicts the record.
    } else if (record.state === 'known' || record.state === 'known-zero') {
      ctx.addIssue({
        code: 'custom',
        message: `a null metric value cannot carry availability state '${record.state}' at ${p}`,
        path: ['metric'],
      });
    }
  };
  if (metric.fixesPerRun.numerator === null) pointer('/metric/fixesPerRun/numerator');
  if (metric.fixesPerRun.denominator === null) pointer('/metric/fixesPerRun/denominator');
  let unknownCount = false;
  metric.baselineFailures.forEach((row, i) => {
    if (row.count === null) {
      pointer(`/metric/baselineFailures/${i}/count`);
      unknownCount = true;
    }
  });
  if (unknownCount && metric.fixesPerRun.denominator !== null) {
    ctx.addIssue({
      code: 'custom',
      message: 'an unknown baselineFailures count requires a null denominator',
      path: ['metric', 'fixesPerRun', 'denominator'],
    });
  }
  const closureCommits = new Set(metric.closures.filter((c) => !c.todo).map((c) => c.commitSha));
  const seen = new Set<string>();
  metric.verifiedCommits.forEach((sha, i) => {
    if (seen.has(sha)) {
      ctx.addIssue({
        code: 'custom',
        message: 'verifiedCommits must be unique (deduplicated projection)',
        path: ['metric', 'verifiedCommits', i],
      });
    }
    seen.add(sha);
    if (!closureCommits.has(sha)) {
      ctx.addIssue({
        code: 'custom',
        message: 'each verifiedCommits entry must be the commitSha of a non-todo closure',
        path: ['metric', 'verifiedCommits', i],
      });
    }
  });
}

export const MeasurementSummaryPayloadSchema: z.ZodType<MeasurementSummaryPayload> = z
  .object({
    metric: MetricRecordSchema,
    availability: AvailabilityMapSchema,
  })
  .strict()
  .superRefine((payload, ctx) => {
    checkMetric(payload.metric, payload.availability, ctx);
  });

export const MeasurementSummaryJournalEventSchema: z.ZodType<MeasurementSummaryJournalEvent> = z
  .object({
    type: z.literal('measurement-summary'),
    runId: z.string(),
    at: z.iso.datetime({ precision: 3 }),
    unitId: z.string().min(1).nullable(),
    jobId: z.string().min(1).nullable(),
    taskId: z.string().min(1).nullable(),
    attempt: z.number().int().min(1).nullable(),
    payload: MeasurementSummaryPayloadSchema,
  })
  .strict();

export const ReportV2Schema: z.ZodType<ReportV2> = z
  .object({
    reportVersion: z.literal(2),
    provenance: ProvenanceRecordSchema,
    correlation: CorrelationRecordSchema,
    tasks: z.array(TaskFinishedPayloadSchema),
    attempts: z.array(AttemptFinishedJournalEventSchema),
    gates: z.array(GateVerdictJournalEventSchema),
    dispositions: z.array(DispositionPayloadSchema),
    acceptances: z.array(AcceptancePayloadSchema),
    reviews: z.array(ReviewObservedPayloadSchema),
    approvals: z.array(ApprovalJournalEventSchema),
    writeDecisions: z.array(WriteObservationJournalEventSchema),
    metric: MetricRecordSchema,
    availability: AvailabilityMapSchema,
  })
  .strict()
  .superRefine((report, ctx) => {
    checkMetric(report.metric, report.availability, ctx);
  });

// ---------------------------------------------------------------------------
// Kernel: journal v3 composition header/link schemas (ADR-0008, T29 — the
// composition stream carries exactly one composition-started header; the
// kernel RunLog never carries these composition-only carriers)
// ---------------------------------------------------------------------------

export const CompositionStartedPayloadSchema: z.ZodType<CompositionStartedPayload> = z
  .object({
    journalVersion: z.literal(3),
    provenance: ProvenanceRecordSchema,
    correlation: CorrelationRecordSchema,
  })
  .strict()
  // Envelope coupling (ADR-0008): the header's baseSha and witnesses.base
  // must agree, as on the kernel v3 header.
  .superRefine((payload, ctx) => {
    if (payload.provenance.baseSha !== payload.provenance.witnesses.base) {
      ctx.addIssue({
        code: 'custom',
        message: 'provenance.baseSha and provenance.witnesses.base must agree',
        path: ['provenance'],
      });
    }
  });

export const CompositionStartedJournalEventSchema: z.ZodType<CompositionStartedJournalEvent> = z
  .object({
    type: z.literal('composition-started'),
    runId: z.string(),
    at: z.iso.datetime({ precision: 3 }),
    // Envelope for new event kinds is exactly
    // {type,runId,at,unitId,jobId,taskId,attempt,payload} (ADR-0008): these
    // are run-scoped here, so the scope fields are null (required, not
    // absent). T04 owns filling the header handoff later.
    unitId: z.string().min(1).nullable(),
    jobId: z.string().min(1).nullable(),
    taskId: z.string().min(1).nullable(),
    attempt: z.number().int().min(1).nullable(),
    payload: CompositionStartedPayloadSchema,
  })
  .strict();

export const KernelRunLinkedPayloadSchema: z.ZodType<KernelRunLinkedPayload> = z
  .object({
    // Filesystem-safe: a kernelRunId becomes `<runId>.ndjson` at the
    // descriptor read side (readKernelRunDescriptors), so the journal's
    // runId grammar applies here too — no separators, no traversal.
    kernelRunId: z
      .string()
      .min(1)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    planId: z.string().min(1),
    round: NonnegativeSafeCountSchema,
  })
  .strict();

export const KernelRunLinkedJournalEventSchema: z.ZodType<KernelRunLinkedJournalEvent> = z
  .object({
    type: z.literal('kernel-run-linked'),
    runId: z.string(),
    at: z.iso.datetime({ precision: 3 }),
    unitId: z.string().min(1).nullable(),
    jobId: z.string().min(1).nullable(),
    taskId: z.string().min(1).nullable(),
    attempt: z.number().int().min(1).nullable(),
    payload: KernelRunLinkedPayloadSchema,
  })
  .strict();

/** One observation stream line (ADR-0008): composition carriers plus the v3 observational carriers. */
export const ObservationEventSchema: z.ZodType<ObservationEvent> = z.union([
  CompositionStartedJournalEventSchema,
  KernelRunLinkedJournalEventSchema,
  AttemptFinishedJournalEventSchema,
  GateVerdictJournalEventSchema,
  TaskFinishedJournalEventSchema,
  ApprovalJournalEventSchema,
  WriteObservationJournalEventSchema,
  FindingDispositionJournalEventSchema,
  HeadAcceptanceJournalEventSchema,
  ReviewObservedJournalEventSchema,
  MeasurementSummaryJournalEventSchema,
]);

export const ObservationStreamSchema: z.ZodType<ObservationStream> = z
  .object({
    workId: z.uuid(),
    compositionRunId: z.string().min(1),
    events: z.array(ObservationEventSchema),
    complete: z.boolean(),
  })
  .strict()
  // Stream couplings (ADR-0008), encoded per the refinements policy —
  // validated on PARSE, not only at write time (writer-side checks do not
  // validate supplied or on-disk streams):
  //   - a COMPLETE stream opens with exactly one composition-started header
  //     (an INCOMPLETE stream is exempt: a crash during the header write can
  //     leave a torn, headerless prefix);
  //   - the header's correlation.workId matches the stream's directory workId
  //     (a mismatch would misattribute the whole stream at the join);
  //   - every event's runId matches the stream's compositionRunId.
  //   The workId must be a UUID: the schema's own z.uuid() guards it.
  .superRefine((stream, ctx) => {
    // Identity of the events ALREADY PRESENT is validated even in an
    // incomplete stream: partial evidence is still attributed evidence. Only
    // the required-header check is waived for a torn/empty prefix.
    stream.events.forEach((event, i) => {
      if (event.runId !== stream.compositionRunId) {
        ctx.addIssue({
          code: 'custom',
          message:
            `event.runId '${event.runId}' does not match this stream's ` +
            `compositionRunId '${stream.compositionRunId}'`,
          path: ['events', i],
        });
      }
      if (
        event.type === 'composition-started' &&
        event.payload.correlation.workId !== stream.workId
      ) {
        ctx.addIssue({
          code: 'custom',
          message:
            `header correlation.workId '${event.payload.correlation.workId}' does not ` +
            `match this stream's workId '${stream.workId}'`,
          path: ['events', i],
        });
      }
    });
    if (!stream.complete) {
      // A duplicate or misplaced header is corrupt in BOTH modes, and only a
      // stream with NO complete event may lack its header (only the final
      // line can be torn — events without a header are a broken stream).
      const torn = stream.events.filter((e) => e.type === 'composition-started');
      if (
        torn.length > 1 ||
        (torn.length === 1 && stream.events[0]?.type !== 'composition-started')
      ) {
        ctx.addIssue({
          code: 'custom',
          message: 'a stream cannot carry a misplaced or duplicate composition-started header',
          path: ['events'],
        });
      }
      if (stream.events.length > 0 && torn.length === 0) {
        ctx.addIssue({
          code: 'custom',
          message: 'an incomplete stream with events must carry its composition-started header',
          path: ['events'],
        });
      }
      return;
    }
    const headers = stream.events.filter((e) => e.type === 'composition-started');
    if (headers.length !== 1 || stream.events[0]?.type !== 'composition-started') {
      ctx.addIssue({
        code: 'custom',
        message: 'a complete stream must open with exactly one composition-started header',
        path: ['events'],
      });
    }
  });

/**
 * The v1/v2 kernel event union exactly as it stood before the v3 dual reader
 * (ADR-0008 T02): a v3-shaped record must never parse through it.
 */
export const JournalEventV1V2Schema = z.discriminatedUnion('type', [
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

/**
 * THE FULL UNION (ADR-0008 T02 dual reader): the sequenced v1/v2 kernel
 * events joined by the v3 carriers. Dispatch on the run-started version
 * (absent → v1, 2 → v2, 3 → v3); unknown future versions fail explicitly.
 * Observational events never alter reservations, sequence claims or job
 * statuses — see `deriveJobStatuses` and `foldOrderRuns`.
 *
 * T29 ruling: observational carriers have NO kernel producer (T29 puts them
 * only in composition streams via src/kernel/observation.ts). This union
 * ACCEPTS them defensively — a composition carrier written into a kernel
 * file must be detected and refused by the kernel's per-file reader, not
 * silently parsed here; readEvents' per-file version strictness and the
 * T29 tests pin that refusal. The union stays wide so corruption surfaces
 * as a loud, classified error at the file level.
 */
export const JournalEventSchema: z.ZodType<JournalEvent> = z.union([
  JournalEventV1V2Schema,
  RunStartedV3JournalEventSchema,
  AttemptFinishedJournalEventSchema,
  GateVerdictJournalEventSchema,
  TaskFinishedJournalEventSchema,
  ApprovalJournalEventSchema,
  WriteObservationJournalEventSchema,
  FindingDispositionJournalEventSchema,
  HeadAcceptanceJournalEventSchema,
  ReviewObservedJournalEventSchema,
  MeasurementSummaryJournalEventSchema,
]);
