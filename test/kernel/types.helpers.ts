// Split provenance: test/kernel/types.test.ts was split by subject into
// types.roundtrip.test.ts, types.encoded-couplings.test.ts,
// types.mirror-tightenings.test.ts, types.worker-result-wire.test.ts,
// types.seam.test.ts and types.dispatch-errors.test.ts. This module holds
// the shared seeded PRNG, instance generators and schema assertions.
//
// T1.1 slice 2 — serializability property tests for the frozen kernel and
// driver-seam types. This file is the goal's test evidence.
//
// What is pinned here:
//   1. JSON round-trip: every persisted/kernel type, as generated instances,
//      stringifies, parses back, passes its matching zod mirror from
//      src/kernel/schema.ts, and deep-equals the original.
//   2. Plain-data invariant: no function-valued fields anywhere in persisted
//      shapes (recursive walk over every generated instance). Registry
//      entries (OpRegistryEntry/PlanRegistryEntry) are the deliberate
//      exception — runtime-only with lazy importer functions, so schema.ts
//      mirrors NOTHING for them (absence check + compile-time guard below).
//   3. Vendor-vocabulary frozen claim: persisted-shape schemas are
//      `.strict()`, so a WorkerResult-shaped object polluted with an extra
//      key named for a vendor message type (SDKMessage, BaseMessage,
//      RunState) FAILS parsing.
//   4. Encoded couplings (review round 3): `earlyStopReason` is present
//      exactly when `stoppedEarly` is true (RunReportSchema and
//      RunFinishedJournalEventSchema), and `attempt` is 1-based
//      (JobStartedJournalEventSchema).
//   7. RD-B review debt: RunOptionsSchema mirrors the frozen maxTokens cap
//      (mirror-only tightening, .positive()), and WorkerResultSchema
//      encodes the DD-9 wire coupling — costBasis present exactly when
//      costUSD is.
//   8. Post-freeze seam migration: WorkerResultSchema encodes the new wire
//      coupling — `error` is present only on a `stopReason: 'error'`
//      verdict, and it is non-empty and bounded to the producer's
//      500-chars-plus-marker shape.
//   9. Seam v2 (ADR-0002): `errorClass` follows the same one-directional
//      wire rule as `error` (present ⇒ stopReason 'error'; an 'error'
//      verdict without one still parses), `providerSignals` are allowed on
//      ANY verdict, `outputSchema`/`workspace` ride the invocation,
//      SEAM_VERSION pins 3 (v3 adds usageProvenance), and `errorClassOf` extracts a dispatch class
//      from tagged throws only — never guessing.
//
// Determinism: hand-rolled mulberry32 PRNG, fixed seeds derived from test
// names. No Date.now(), no Math.random(), no new dependencies — vitest only.
import { expect } from 'vitest';
import type { z } from 'zod';
import * as kernelSchema from '../../src/kernel/schema.js';
import type {
  Job,
  JobFinishedJournalEvent,
  JobOutcome,
  JobStartedJournalEvent,
  JobState,
  JobStatus,
  JournalEvent,
  Limits,
  OpResult,
  Plan,
  RunFinishedJournalEvent,
  RunOptions,
  RunReport,
  RunStartedJournalEvent,
} from '../../src/kernel/types.js';
import type {
  Budget,
  DriverStopReason,
  ModelSpec,
  OpInvocation,
  OutputSchema,
  ProviderSignals,
  SandboxPolicy,
  ToolDenial,
  ToolPolicy,
  Usage,
  WorkerErrorClass,
  WorkerResult,
  WorkspaceBinding,
} from '../../src/driver/types.js';

// ---------------------------------------------------------------------------
// Deterministic seeded PRNG (mulberry32) + tiny generator helpers
// ---------------------------------------------------------------------------

type Rng = () => number;

/** Hand-rolled mulberry32 — tiny, deterministic, dependency-free. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a over the test name: stable per-case seeds, no magic-number table. */
export function seedFor(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function intBetween(r: Rng, min: number, max: number): number {
  return min + Math.floor(r() * (max - min + 1));
}

function bool(r: Rng): boolean {
  return r() < 0.5;
}

function pick<T>(r: Rng, values: readonly T[]): T {
  const value = values[Math.floor(r() * values.length)];
  if (value === undefined) throw new Error('pick requires a populated array and an in-range RNG');
  return value;
}

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789-_';

function id(r: Rng, prefix: string): string {
  const len = intBetween(r, 1, 8);
  let out = prefix;
  for (let i = 0; i < len; i++) out += ID_ALPHABET[intBetween(r, 0, ID_ALPHABET.length - 1)];
  return out;
}

function isoTimestamp(r: Rng): string {
  const seconds = String(intBetween(r, 0, 59)).padStart(2, '0');
  const millis = String(intBetween(r, 0, 999)).padStart(3, '0');
  return `2026-01-01T00:00:${seconds}.${millis}Z`;
}

/** Bounded, deterministic JSON value (null / int / string / array / nested object). */
function jsonValue(r: Rng, depth: number): unknown {
  const kind = depth <= 0 ? intBetween(r, 0, 2) : intBetween(r, 0, 4);
  switch (kind) {
    case 0:
      return null;
    case 1:
      return intBetween(r, -1000, 1000);
    case 2:
      return id(r, 'v-');
    case 3: {
      const n = intBetween(r, 0, 3);
      return Array.from({ length: n }, () => jsonValue(r, depth - 1));
    }
    default: {
      const n = intBetween(r, 0, 3);
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < n; i++) obj[id(r, 'k-')] = jsonValue(r, depth - 1);
      return obj;
    }
  }
}

/** Draws an optional value; callers add the key only when defined, so no generated instance ever holds an explicit `undefined` (JSON would drop it). */
function sometimes<T>(r: Rng, make: () => T): T | undefined {
  return bool(r) ? make() : undefined;
}

// ---------------------------------------------------------------------------
// Instance generators — one per persisted/kernel shape
// ---------------------------------------------------------------------------

function genUsage(r: Rng): Usage {
  const u: Usage = {
    input: intBetween(r, 0, 1_000_000),
    output: intBetween(r, 0, 1_000_000),
    cacheRead: intBetween(r, 0, 1_000_000),
    cacheWrite: intBetween(r, 0, 1_000_000),
  };
  const reasoning = sometimes(r, () => intBetween(r, 0, 100_000));
  if (reasoning !== undefined) u.reasoning = reasoning;
  return u;
}

const PROVIDERS = ['anthropic', 'zai', 'deepseek', 'openai'] as const;

function genModelSpec(r: Rng): ModelSpec {
  return { model: id(r, 'model-'), provider: pick(r, PROVIDERS) };
}

const TOOL_MODES = ['allowlist', 'unrestricted', 'none'] as const;

function genToolPolicy(r: Rng): ToolPolicy {
  const policy: ToolPolicy = { allow: [id(r, 'tool-'), id(r, 'tool-')] };
  const mode = sometimes(r, () => pick(r, TOOL_MODES));
  if (mode !== undefined) policy.mode = mode;
  return policy;
}

const SANDBOX_LEVELS = ['none', 'workspace-write', 'read-only'] as const;

function genSandboxPolicy(r: Rng): SandboxPolicy {
  return { level: pick(r, SANDBOX_LEVELS) };
}

function genBudget(r: Rng): Budget {
  const b: Budget = {};
  const maxUsd = sometimes(r, () => intBetween(r, 0, 10_000) / 100);
  if (maxUsd !== undefined) b.maxUsd = maxUsd;
  const maxTokens = sometimes(r, () => intBetween(r, 1, 1_000_000));
  if (maxTokens !== undefined) b.maxTokens = maxTokens;
  const wallClockMs = sometimes(r, () => intBetween(r, 1, 600_000));
  if (wallClockMs !== undefined) b.wallClockMs = wallClockMs;
  const maxAttempts = sometimes(r, () => intBetween(r, 1, 5));
  if (maxAttempts !== undefined) b.maxAttempts = maxAttempts;
  const maxSteps = sometimes(r, () => intBetween(r, 1, 50));
  if (maxSteps !== undefined) b.maxSteps = maxSteps;
  return b;
}

const STOP_REASONS: readonly DriverStopReason[] = ['complete', 'aborted', 'budget', 'error'];

function genToolDenial(r: Rng): ToolDenial {
  return { tool: id(r, 'tool-'), reason: id(r, 'why-') };
}

const WORKER_ERROR_CLASSES: readonly WorkerErrorClass[] = [
  'output-invalid',
  'served-model-mismatch',
  'transient',
  'rate-limit',
  'quota',
  'auth',
  'provider-error',
  'harness',
  'unknown',
];

/** One provider-reported limit window; every field but the id is optional. */
function genProviderWindow(r: Rng): NonNullable<ProviderSignals['windows']>[number] {
  const window: NonNullable<ProviderSignals['windows']>[number] = {
    id: pick(r, ['5h', '7d', 'rolling', 'requests']),
  };
  const utilization = sometimes(r, () => intBetween(r, 0, 100) / 100);
  if (utilization !== undefined) window.utilization = utilization;
  const remaining = sometimes(r, () => {
    const counts: NonNullable<NonNullable<ProviderSignals['windows']>[number]['remaining']> = {};
    const requests = sometimes(r, () => intBetween(r, 0, 1_000));
    if (requests !== undefined) counts.requests = requests;
    const tokens = sometimes(r, () => intBetween(r, 0, 1_000_000));
    if (tokens !== undefined) counts.tokens = tokens;
    return counts;
  });
  if (remaining !== undefined) window.remaining = remaining;
  const resetAt = sometimes(r, () => isoTimestamp(r));
  if (resetAt !== undefined) window.resetAt = resetAt;
  return window;
}

function genProviderSignals(r: Rng): ProviderSignals {
  const signals: ProviderSignals = {};
  const retryAfterMs = sometimes(r, () => intBetween(r, 0, 3_600_000));
  if (retryAfterMs !== undefined) signals.retryAfterMs = retryAfterMs;
  const windows = sometimes(
    r,
    () => Array.from({ length: intBetween(r, 1, 2) }, () => genProviderWindow(r)), // several windows may be live at once
  );
  if (windows !== undefined) signals.windows = windows;
  return signals;
}

export function genWorkerResult(r: Rng): WorkerResult {
  const denials: ToolDenial[] = Array.from({ length: intBetween(r, 0, 3) }, () => genToolDenial(r));
  const result: WorkerResult = {
    usage: genUsage(r),
    denials,
    stopReason: pick(r, STOP_REASONS),
  };
  const steps = sometimes(r, () => intBetween(r, 0, 50));
  if (steps !== undefined) result.steps = steps;
  const structuredOutput = sometimes(r, () => jsonValue(r, 2));
  if (structuredOutput !== undefined) result.structuredOutput = structuredOutput;
  // DD-9 wire pairing (mirror refinement): costBasis is present exactly
  // when costUSD is — a priced result carries both, an unpriced result
  // carries neither.
  const costUSD = sometimes(r, () => intBetween(r, 0, 10_000) / 100);
  if (costUSD !== undefined) {
    result.costUSD = costUSD;
    result.costBasis = pick(r, ['modeled', 'billed'] as const);
  }
  const sessionId = sometimes(r, () => id(r, 'sess-'));
  if (sessionId !== undefined) result.sessionId = sessionId;
  // A driver-level failure carries its caught cause (post-freeze seam
  // migration); the generator only sets it on an 'error' verdict, honoring
  // the wire refinement (error present only when stopReason is 'error').
  if (result.stopReason === 'error') {
    const error = sometimes(r, () => id(r, 'err-'));
    if (error !== undefined) result.error = error;
    // Seam v2 one-directional wire rule (ADR-0002 §2.2): errorClass rides
    // ONLY an 'error' verdict — an 'error' verdict without one still
    // generates, so pre-S3 producer shapes stay covered.
    const errorClass = sometimes(r, () => pick(r, WORKER_ERROR_CLASSES));
    if (errorClass !== undefined) result.errorClass = errorClass;
  }
  // Seam v2: providerSignals are allowed on ANY verdict.
  const providerSignals = sometimes(r, () => genProviderSignals(r));
  if (providerSignals !== undefined) result.providerSignals = providerSignals;
  return result;
}

function genOutputSchema(r: Rng): OutputSchema {
  return { name: id(r, 'contract-'), schema: { type: 'object', additionalProperties: bool(r) } };
}

function genWorkspaceBinding(r: Rng): WorkspaceBinding {
  return { path: `/tmp/workspaces/${id(r, 'ws-')}` };
}

function genOpInvocation(r: Rng): OpInvocation {
  const invocation: OpInvocation = {
    prompt: id(r, 'prompt-'),
    modelSpec: genModelSpec(r),
    toolPolicy: genToolPolicy(r),
    sandboxPolicy: genSandboxPolicy(r),
    budget: genBudget(r),
  };
  const sessionRef = sometimes(r, () => id(r, 'sess-'));
  if (sessionRef !== undefined) invocation.sessionRef = sessionRef;
  // Seam v2: the structured-output request and the workspace binding ride
  // the invocation as plain data.
  const outputSchema = sometimes(r, () => genOutputSchema(r));
  if (outputSchema !== undefined) invocation.outputSchema = outputSchema;
  const workspace = sometimes(r, () => genWorkspaceBinding(r));
  if (workspace !== undefined) invocation.workspace = workspace;
  return invocation;
}

/** All five frozen statuses, random branch each call. */
export function genOpResult(r: Rng): OpResult<unknown> {
  switch (intBetween(r, 0, 4)) {
    case 0:
      return { status: 'ok', value: jsonValue(r, 2) };
    case 1:
      return { status: 'failed', error: id(r, 'err-') };
    case 2:
      return { status: 'needs-human', reason: id(r, 'why-') };
    case 3:
      return { status: 'budget-exhausted' };
    default:
      return { status: 'indeterminate', detail: id(r, 'det-') };
  }
}

const JOB_STATES: readonly JobState[] = [
  'queued',
  'running',
  'blocked',
  'done',
  'failed',
  'budget-exhausted',
];

function genJobState(r: Rng): JobState {
  return pick(r, JOB_STATES);
}

function genJobStatus(r: Rng): JobStatus {
  return { jobId: id(r, 'job-'), state: genJobState(r) };
}

function genJob(r: Rng): Job {
  const job: Job = { id: id(r, 'job-'), op: id(r, 'op-'), input: jsonValue(r, 2) };
  const dependsOn = sometimes(r, () => [id(r, 'job-'), id(r, 'job-')]);
  if (dependsOn !== undefined) job.dependsOn = dependsOn;
  return job;
}

function genPlan(r: Rng): Plan {
  const jobs: Job[] = Array.from({ length: intBetween(r, 1, 4) }, () => genJob(r));
  const plan: Plan = { id: id(r, 'plan-'), jobs };
  const label = sometimes(r, () => id(r, 'label-'));
  if (label !== undefined) plan.label = label;
  return plan;
}

function genRunOptions(r: Rng): RunOptions {
  const options: RunOptions = { concurrency: intBetween(r, 1, 16), stopOnError: bool(r) };
  const journalDir = sometimes(r, () => id(r, 'journal-'));
  if (journalDir !== undefined) options.journalDir = journalDir;
  const maxUsd = sometimes(r, () => intBetween(r, 0, 10_000) / 100);
  if (maxUsd !== undefined) options.maxUsd = maxUsd;
  const resume = sometimes(r, () => bool(r));
  if (resume !== undefined) options.resume = resume;
  return options;
}

function genLimits(r: Rng): Limits {
  const limits: Limits = {};
  const maxUsd = sometimes(r, () => intBetween(r, 0, 10_000) / 100);
  if (maxUsd !== undefined) limits.maxUsd = maxUsd;
  const perJobWallClockMs = sometimes(r, () => intBetween(r, 1, 600_000));
  if (perJobWallClockMs !== undefined) limits.perJobWallClockMs = perJobWallClockMs;
  const maxAttemptsPerJob = sometimes(r, () => intBetween(r, 1, 5));
  if (maxAttemptsPerJob !== undefined) limits.maxAttemptsPerJob = maxAttemptsPerJob;
  const inFlightCeiling = sometimes(r, () => intBetween(r, 1, 64));
  if (inFlightCeiling !== undefined) limits.inFlightCeiling = inFlightCeiling;
  const runDispatchQuota = sometimes(r, () => intBetween(r, 1, 10_000));
  if (runDispatchQuota !== undefined) limits.runDispatchQuota = runDispatchQuota;
  return limits;
}

function genJobCounts(r: Rng): Record<JobState, number> {
  return {
    queued: intBetween(r, 0, 4),
    running: intBetween(r, 0, 4),
    blocked: intBetween(r, 0, 4),
    done: intBetween(r, 0, 4),
    failed: intBetween(r, 0, 4),
    'budget-exhausted': intBetween(r, 0, 4),
  };
}

function genJobOutcome(r: Rng): JobOutcome {
  const outcome: JobOutcome = { jobId: id(r, 'job-'), op: id(r, 'op-'), result: genOpResult(r) };
  const usage = sometimes(r, () => genUsage(r));
  if (usage !== undefined) outcome.usage = usage;
  const costUSD = sometimes(r, () => intBetween(r, 0, 10_000) / 100);
  if (costUSD !== undefined) outcome.costUSD = costUSD;
  return outcome;
}

export function genRunReport(r: Rng): RunReport {
  const stoppedEarly = bool(r);
  const report: RunReport = {
    runId: id(r, 'run-'),
    stoppedEarly,
    counts: genJobCounts(r),
    jobs: Array.from({ length: intBetween(r, 1, 4) }, () => genJobOutcome(r)),
  };
  if (stoppedEarly) report.earlyStopReason = 'budget';
  const usage = sometimes(r, () => genUsage(r));
  if (usage !== undefined) report.usage = usage;
  const costUSD = sometimes(r, () => intBetween(r, 0, 10_000) / 100);
  if (costUSD !== undefined) report.costUSD = costUSD;
  return report;
}

export function genRunStarted(r: Rng): RunStartedJournalEvent {
  return {
    type: 'run-started',
    runId: id(r, 'run-'),
    at: isoTimestamp(r),
    planId: id(r, 'plan-'),
  };
}

export function genJobStarted(r: Rng): JobStartedJournalEvent {
  return {
    type: 'job-started',
    runId: id(r, 'run-'),
    at: isoTimestamp(r),
    jobId: id(r, 'job-'),
    op: id(r, 'op-'),
    attempt: intBetween(r, 1, 3),
  };
}

export function genJobFinished(r: Rng): JobFinishedJournalEvent {
  const event: JobFinishedJournalEvent = {
    type: 'job-finished',
    runId: id(r, 'run-'),
    at: isoTimestamp(r),
    jobId: id(r, 'job-'),
    opId: id(r, 'op-'),
    inputsHash: id(r, 'hash-'),
    result: genOpResult(r),
  };
  // Sometimes carry the optional usage rollup so the seeded property
  // round-trip and the plain-data walk exercise both shapes.
  const usage = sometimes(r, () => genUsage(r));
  if (usage !== undefined) event.usage = usage;
  return event;
}

export function genRunFinished(r: Rng): RunFinishedJournalEvent {
  const stoppedEarly = bool(r);
  const event: RunFinishedJournalEvent = {
    type: 'run-finished',
    runId: id(r, 'run-'),
    at: isoTimestamp(r),
    stoppedEarly,
  };
  if (stoppedEarly) event.earlyStopReason = 'budget';
  return event;
}

export function genJournalEvent(r: Rng): JournalEvent {
  switch (intBetween(r, 0, 3)) {
    case 0:
      return genRunStarted(r);
    case 1:
      return genJobStarted(r);
    case 2:
      return genJobFinished(r);
    default:
      return genRunFinished(r);
  }
}

// ---------------------------------------------------------------------------
// Shared assertions
// ---------------------------------------------------------------------------

/** JSON round-trip: stringify → parse → deep-equal original → zod mirror parses → deep-equal. */
export function roundTripsThrough(schema: z.ZodType<unknown>, instance: unknown): void {
  const roundTripped: unknown = JSON.parse(JSON.stringify(instance));
  expect(roundTripped).toEqual(instance);
  const parsed = schema.parse(roundTripped);
  expect(parsed).toEqual(roundTripped);
}

/** Plain-data walk: no leaf anywhere in the value may be typeof 'function'. */
export function assertNoFunctions(value: unknown, path: string): void {
  if (typeof value === 'function') {
    throw new Error(`function-valued field at ${path}`);
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assertNoFunctions(child, `${path}.${key}`);
  }
}

/** (case name, matching zod mirror, instance generator) — every persisted/kernel shape. */
type Generator = (r: Rng) => unknown;
export const ROUND_TRIP_CASES: ReadonlyArray<readonly [string, z.ZodType<unknown>, Generator]> = [
  ['OpResult', kernelSchema.OpResultSchema, genOpResult],
  ['Usage', kernelSchema.UsageSchema, genUsage],
  ['ModelSpec', kernelSchema.ModelSpecSchema, genModelSpec],
  ['ToolPolicy', kernelSchema.ToolPolicySchema, genToolPolicy],
  ['SandboxPolicy', kernelSchema.SandboxPolicySchema, genSandboxPolicy],
  ['Budget', kernelSchema.BudgetSchema, genBudget],
  ['ToolDenial', kernelSchema.ToolDenialSchema, genToolDenial],
  ['WorkerResult', kernelSchema.WorkerResultSchema, genWorkerResult],
  ['OpInvocation', kernelSchema.OpInvocationSchema, genOpInvocation],
  ['Job', kernelSchema.JobSchema, genJob],
  ['Plan', kernelSchema.PlanSchema, genPlan],
  ['RunOptions', kernelSchema.RunOptionsSchema, genRunOptions],
  ['Limits', kernelSchema.LimitsSchema, genLimits],
  ['JobStatus', kernelSchema.JobStatusSchema, genJobStatus],
  ['RunReport', kernelSchema.RunReportSchema, genRunReport],
  ['RunStartedJournalEvent', kernelSchema.RunStartedJournalEventSchema, genRunStarted],
  ['JobStartedJournalEvent', kernelSchema.JobStartedJournalEventSchema, genJobStarted],
  ['JobFinishedJournalEvent', kernelSchema.JobFinishedJournalEventSchema, genJobFinished],
  ['RunFinishedJournalEvent', kernelSchema.RunFinishedJournalEventSchema, genRunFinished],
];

export const ITERATIONS = 32;

/** Asserts the instance FAILS schema.parse, naming the expectation on failure. */
export function failsParse(schema: z.ZodType<unknown>, instance: unknown, why: string): void {
  const result = schema.safeParse(instance);
  if (result.success) {
    throw new Error(`${why} must fail parsing`);
  }
}
