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
//
// Determinism: hand-rolled mulberry32 PRNG, fixed seeds derived from test
// names. No Date.now(), no Math.random(), no new dependencies — vitest only.
import { describe, expect, test } from 'vitest';
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
  OpRegistryEntry,
  OpResult,
  Plan,
  PlanRegistryEntry,
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
  SandboxPolicy,
  ToolDenial,
  ToolPolicy,
  Usage,
  WorkerResult,
} from '../../src/driver/types.js';

// ---------------------------------------------------------------------------
// Deterministic seeded PRNG (mulberry32) + tiny generator helpers
// ---------------------------------------------------------------------------

type Rng = () => number;

/** Hand-rolled mulberry32 — tiny, deterministic, dependency-free. */
function mulberry32(seed: number): Rng {
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
function seedFor(text: string): number {
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
  return b;
}

const STOP_REASONS: readonly DriverStopReason[] = ['complete', 'aborted', 'budget', 'error'];

function genToolDenial(r: Rng): ToolDenial {
  return { tool: id(r, 'tool-'), reason: id(r, 'why-') };
}

function genWorkerResult(r: Rng): WorkerResult {
  const denials: ToolDenial[] = Array.from({ length: intBetween(r, 0, 3) }, () => genToolDenial(r));
  const result: WorkerResult = {
    usage: genUsage(r),
    denials,
    stopReason: pick(r, STOP_REASONS),
  };
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
  // A driver-level failure carries its caught cause (issues #203/#204); the
  // generator only sets it on an 'error' verdict, honoring the wire
  // refinement (error present only when stopReason is 'error').
  if (result.stopReason === 'error') {
    const error = sometimes(r, () => id(r, 'err-'));
    if (error !== undefined) result.error = error;
  }
  return result;
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
  return invocation;
}

/** All five frozen statuses, random branch each call. */
function genOpResult(r: Rng): OpResult<unknown> {
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

function genRunReport(r: Rng): RunReport {
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

function genRunStarted(r: Rng): RunStartedJournalEvent {
  return {
    type: 'run-started',
    runId: id(r, 'run-'),
    at: isoTimestamp(r),
    planId: id(r, 'plan-'),
  };
}

function genJobStarted(r: Rng): JobStartedJournalEvent {
  return {
    type: 'job-started',
    runId: id(r, 'run-'),
    at: isoTimestamp(r),
    jobId: id(r, 'job-'),
    op: id(r, 'op-'),
    attempt: intBetween(r, 1, 3),
  };
}

function genJobFinished(r: Rng): JobFinishedJournalEvent {
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

function genRunFinished(r: Rng): RunFinishedJournalEvent {
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

function genJournalEvent(r: Rng): JournalEvent {
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
function roundTripsThrough(schema: z.ZodType<unknown>, instance: unknown): void {
  const roundTripped: unknown = JSON.parse(JSON.stringify(instance));
  expect(roundTripped).toEqual(instance);
  const parsed = schema.parse(roundTripped);
  expect(parsed).toEqual(roundTripped);
}

/** Plain-data walk: no leaf anywhere in the value may be typeof 'function'. */
function assertNoFunctions(value: unknown, path: string): void {
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
const ROUND_TRIP_CASES: ReadonlyArray<readonly [string, z.ZodType<unknown>, Generator]> = [
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

const ITERATIONS = 32;

// ---------------------------------------------------------------------------
// 1. JSON round-trip serializability (the property)
// ---------------------------------------------------------------------------

describe('JSON round-trip serializability (seeded property)', () => {
  for (const [name, schema, gen] of ROUND_TRIP_CASES) {
    test(`${name} round-trips JSON through ${name}Schema`, () => {
      const r = mulberry32(seedFor(name));
      for (let i = 0; i < ITERATIONS; i++) {
        roundTripsThrough(schema, gen(r));
      }
    });
  }

  test('all four journal event variants also parse through the JournalEventSchema union', () => {
    const r = mulberry32(seedFor('journal-union'));
    const events: JournalEvent[] = [
      genRunStarted(r),
      genJobStarted(r),
      genJobFinished(r),
      genRunFinished(r),
    ];
    for (const event of events) {
      const parsed = kernelSchema.JournalEventSchema.parse(JSON.parse(JSON.stringify(event)));
      expect(parsed).toEqual(event);
    }
  });

  test('random OpResult generation covers all five frozen statuses', () => {
    const r = mulberry32(seedFor('opresult-coverage'));
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(genOpResult(r).status);
    expect([...seen].sort()).toEqual([
      'budget-exhausted',
      'failed',
      'indeterminate',
      'needs-human',
      'ok',
    ]);
  });

  test('random journal generation covers all four event types', () => {
    const r = mulberry32(seedFor('journal-coverage'));
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(genJournalEvent(r).type);
    expect([...seen].sort()).toEqual([
      'job-finished',
      'job-started',
      'run-finished',
      'run-started',
    ]);
  });

  test('RunReport honest-stop variant round-trips (stoppedEarly + budget reason)', () => {
    // Explicit honest-stop instance: the run stopped early on budget.
    const honestStop: RunReport = {
      runId: 'run-honest',
      stoppedEarly: true,
      earlyStopReason: 'budget',
      counts: {
        queued: 1,
        running: 0,
        blocked: 0,
        done: 2,
        failed: 0,
        'budget-exhausted': 0,
      },
      jobs: [{ jobId: 'job-a', op: 'op-a', result: { status: 'budget-exhausted' } }],
      usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 },
      costUSD: 0.42,
    };
    roundTripsThrough(kernelSchema.RunReportSchema, honestStop);

    // Plus randomized honest-stop instances from the generator.
    const r = mulberry32(seedFor('honest-stop'));
    let seen = 0;
    for (let i = 0; seen < 8 && i < 500; i++) {
      const instance = genRunReport(r);
      if (!instance.stoppedEarly) continue;
      expect(instance.earlyStopReason).toBe('budget');
      roundTripsThrough(kernelSchema.RunReportSchema, instance);
      seen++;
    }
    expect(seen).toBeGreaterThanOrEqual(8);
  });
});

// ---------------------------------------------------------------------------
// 2. Plain-data invariant: no function-valued fields in persisted shapes
// ---------------------------------------------------------------------------

describe('plain-data invariant', () => {
  // Honest scope note (VB1A): this walk covers generator-emitted fields only —
  // it is a generator-drift tripwire, not a proof of the plain-data invariant.
  // The proof is the type system (persisted types declare no functions) plus
  // the strict zod mirrors rejecting unexpected keys.
  test('no generated persisted instance contains a function-valued field', () => {
    for (const [name, , gen] of ROUND_TRIP_CASES) {
      const r = mulberry32(seedFor(`functions:${name}`));
      for (let i = 0; i < ITERATIONS; i++) {
        assertNoFunctions(gen(r), `${name}#${i}`);
      }
    }
  });

  test('registry entries are runtime-only: schema.ts mirrors nothing for them', () => {
    // Runtime absence check: a zod schema for OpRegistryEntry/PlanRegistryEntry
    // would be wrong by construction — the lazy importer is a function, and
    // functions are not JSON. If a *Registry* export ever appears in
    // kernel/schema.ts, the runtime-only contract has drifted.
    const exportedNames = Object.keys(kernelSchema);
    expect(exportedNames.filter((name) => /Registry/i.test(name))).toEqual([]);

    // Compile-time half of the claim: the registry entry types DO carry the
    // runtime importer functions. If this stops compiling, the types drifted
    // away from the runtime-only shape (or lost their importer).
    type HasRuntimeImporter<E> = E extends { importer: () => Promise<unknown> } ? true : false;
    const opRegistry: HasRuntimeImporter<OpRegistryEntry> = true;
    const planRegistry: HasRuntimeImporter<PlanRegistryEntry> = true;
    expect(opRegistry).toBe(true);
    expect(planRegistry).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Vendor-vocabulary frozen claim: strict persisted shapes reject pollution
// ---------------------------------------------------------------------------

const VENDOR_KEYS = ['SDKMessage', 'BaseMessage', 'RunState'] as const;

describe('vendor-vocabulary frozen claim (strict persisted shapes)', () => {
  test('a valid WorkerResult parses', () => {
    const r = mulberry32(seedFor('worker-result-valid'));
    for (let i = 0; i < ITERATIONS; i++) {
      const result = kernelSchema.WorkerResultSchema.safeParse(genWorkerResult(r));
      expect(result.success, `valid instance #${i} must parse`).toBe(true);
    }
  });

  test.each(VENDOR_KEYS)(
    'WorkerResultSchema rejects an extra %s key (vendor message shape)',
    (vendorKey) => {
      const r = mulberry32(seedFor(`polluted:${vendorKey}`));
      const polluted = { ...genWorkerResult(r), [vendorKey]: { role: 'assistant' } };
      const result = kernelSchema.WorkerResultSchema.safeParse(polluted);
      if (result.success) {
        throw new Error(`WorkerResultSchema must reject ${vendorKey} pollution`);
      }
      expect(JSON.stringify(result.error.issues)).toContain(vendorKey);
    },
  );
});

// ---------------------------------------------------------------------------
// 4. Encoded couplings (review round 3): honest-stop pairing, 1-based attempts
// ---------------------------------------------------------------------------

/** Minimal valid RunReport with stoppedEarly=false and no optional fields. */
function validRunReportBase(): RunReport {
  return {
    runId: 'run-coupling',
    stoppedEarly: false,
    counts: {
      queued: 0,
      running: 0,
      blocked: 0,
      done: 0,
      failed: 0,
      'budget-exhausted': 0,
    },
    jobs: [],
  };
}

/** Asserts the instance FAILS schema.parse, naming the expectation on failure. */
function failsParse(schema: z.ZodType<unknown>, instance: unknown, why: string): void {
  const result = schema.safeParse(instance);
  if (result.success) {
    throw new Error(`${why} must fail parsing`);
  }
}

describe('mirror-only domain tightenings (review-debt #17, PR #7 non-frozen items)', () => {
  test('UsageSchema rejects negative and fractional token counts (cardinalities)', () => {
    const base = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
    for (const bad of [
      { ...base, input: -1 },
      { ...base, output: -5 },
      { ...base, cacheRead: 0.5 },
      { ...base, cacheWrite: 1.5 },
      { ...base, reasoning: -1 },
    ]) {
      failsParse(kernelSchema.UsageSchema, bad, `usage ${JSON.stringify(bad)}`);
    }
    expect(kernelSchema.UsageSchema.safeParse({ ...base, reasoning: 3 }).success).toBe(true);
  });

  test('RunCountsSchema rejects negative and fractional counts', () => {
    const base = { queued: 0, running: 0, blocked: 0, done: 1, failed: 0, 'budget-exhausted': 0 };
    failsParse(kernelSchema.RunCountsSchema, { ...base, done: -1 }, 'negative count');
    failsParse(kernelSchema.RunCountsSchema, { ...base, failed: 1.5 }, 'fractional count');
    expect(kernelSchema.RunCountsSchema.safeParse(base).success).toBe(true);
  });

  test('RunOptionsSchema rejects a negative maxUsd; LimitsSchema rejects a sub-1 inFlightCeiling', () => {
    failsParse(
      kernelSchema.RunOptionsSchema,
      { concurrency: 2, stopOnError: false, maxUsd: -0.01 },
      'negative maxUsd',
    );
    expect(
      kernelSchema.RunOptionsSchema.safeParse({ concurrency: 2, stopOnError: false, maxUsd: 0 })
        .success,
    ).toBe(true);
    // inFlightCeiling is a LIMITS field (the issue's schema.ts:200 drifted
    // into the Limits block): the ceiling bound lives on LimitsSchema.
    failsParse(kernelSchema.LimitsSchema, { inFlightCeiling: 0 }, 'zero inFlightCeiling');
    failsParse(kernelSchema.LimitsSchema, { inFlightCeiling: 1.5 }, 'fractional inFlightCeiling');
    expect(kernelSchema.LimitsSchema.safeParse({ inFlightCeiling: 1 }).success).toBe(true);
    failsParse(kernelSchema.LimitsSchema, { maxUsd: -1 }, 'negative limits maxUsd');
    failsParse(kernelSchema.LimitsSchema, { perJobWallClockMs: -1 }, 'negative duration');
    failsParse(kernelSchema.LimitsSchema, { maxAttemptsPerJob: 0 }, 'zero attempts');
  });

  test('journal at timestamps must be ISO-8601 UTC', () => {
    const base = { runId: 'r', planId: 'p' } as const;
    failsParse(
      kernelSchema.RunStartedJournalEventSchema,
      { type: 'run-started', ...base, at: 't' },
      'bare-word timestamp',
    );
    failsParse(
      kernelSchema.RunStartedJournalEventSchema,
      { type: 'run-started', ...base, at: '2026-09-16T00:00:00+02:00' },
      'offset timestamp (UTC-only)',
    );
    expect(
      kernelSchema.RunStartedJournalEventSchema.safeParse({
        type: 'run-started',
        ...base,
        at: '2026-09-16T00:00:00.000Z',
      }).success,
    ).toBe(true);
  });
});

describe('encoded couplings (honest-stop pairing, 1-based attempts)', () => {
  test('RunReportSchema: stoppedEarly=true WITH earlyStopReason parses and round-trips', () => {
    const instance: RunReport = {
      ...validRunReportBase(),
      stoppedEarly: true,
      earlyStopReason: 'budget',
    };
    roundTripsThrough(kernelSchema.RunReportSchema, instance);
  });

  test('RunReportSchema: stoppedEarly=true WITHOUT earlyStopReason fails', () => {
    failsParse(
      kernelSchema.RunReportSchema,
      { ...validRunReportBase(), stoppedEarly: true },
      'stoppedEarly=true without earlyStopReason',
    );
  });

  test('RunReportSchema: stoppedEarly=false WITH earlyStopReason fails', () => {
    failsParse(
      kernelSchema.RunReportSchema,
      { ...validRunReportBase(), earlyStopReason: 'budget' },
      'stoppedEarly=false with earlyStopReason',
    );
  });

  test('RunFinishedJournalEventSchema mirrors the honest-stop coupling (both directions, incl. via the union)', () => {
    const base = {
      type: 'run-finished' as const,
      runId: 'run-x',
      at: '2026-01-01T00:00:00.000Z',
    };
    const good: RunFinishedJournalEvent = {
      ...base,
      stoppedEarly: true,
      earlyStopReason: 'budget',
    };
    roundTripsThrough(kernelSchema.RunFinishedJournalEventSchema, good);
    failsParse(
      kernelSchema.RunFinishedJournalEventSchema,
      { ...base, stoppedEarly: true },
      'run-finished stoppedEarly=true without earlyStopReason',
    );
    failsParse(
      kernelSchema.RunFinishedJournalEventSchema,
      { ...base, stoppedEarly: false, earlyStopReason: 'budget' },
      'run-finished stoppedEarly=false with earlyStopReason',
    );
    // The coupling holds when the event is routed through the union too.
    failsParse(
      kernelSchema.JournalEventSchema,
      { ...base, stoppedEarly: true },
      'JournalEventSchema stoppedEarly=true without earlyStopReason',
    );
  });

  test('JobStartedJournalEventSchema: attempt is 1-based (attempt=0 fails, attempt=1 parses)', () => {
    const base = {
      type: 'job-started' as const,
      runId: 'run-x',
      at: '2026-01-01T00:00:00.000Z',
      jobId: 'job-x',
      op: 'op-x',
    };
    failsParse(kernelSchema.JobStartedJournalEventSchema, { ...base, attempt: 0 }, 'attempt=0');
    const one: JobStartedJournalEvent = { ...base, attempt: 1 };
    roundTripsThrough(kernelSchema.JobStartedJournalEventSchema, one);
  });
});

// ---------------------------------------------------------------------------
// 5. VB1A: resumed-run usage rollup + bogus-discriminant rejection
// ---------------------------------------------------------------------------

describe('JobFinishedJournalEvent optional usage (VB1A: resumed-run rollups)', () => {
  const base = {
    type: 'job-finished' as const,
    runId: 'run-x',
    at: '2026-01-01T00:00:00.000Z',
    jobId: 'job-x',
    opId: 'op-x',
    inputsHash: 'hash-x',
    result: { status: 'ok' as const, value: 42 },
  };

  test('job-finished WITH usage parses and round-trips', () => {
    const event: JobFinishedJournalEvent = {
      ...base,
      usage: { input: 11, output: 7, cacheRead: 2, cacheWrite: 0, reasoning: 1 },
    };
    roundTripsThrough(kernelSchema.JobFinishedJournalEventSchema, event);
    const parsed = kernelSchema.JournalEventSchema.parse(JSON.parse(JSON.stringify(event)));
    expect(parsed).toEqual(event);
  });

  test('job-finished WITHOUT usage parses and round-trips (usage stays optional)', () => {
    const event: JobFinishedJournalEvent = { ...base };
    roundTripsThrough(kernelSchema.JobFinishedJournalEventSchema, event);
    const parsed = kernelSchema.JournalEventSchema.parse(JSON.parse(JSON.stringify(event)));
    expect(parsed).toEqual(event);
  });
});

describe('bogus discriminant rejection (VB1A)', () => {
  test('OpResultSchema rejects a bogus status (cancelled)', () => {
    failsParse(
      kernelSchema.OpResultSchema,
      { status: 'cancelled', value: 1 },
      "bogus OpResult status 'cancelled'",
    );
  });

  test('JobStateSchema rejects a bogus state string (success)', () => {
    // JobStateSchema validates the BARE state string (a zod enum), so the
    // rejection must be exercised with the string itself — an object payload
    // would fail on shape, not on the bogus value.
    failsParse(kernelSchema.JobStateSchema, 'success', "bogus JobState 'success'");
  });

  test('JobStatusSchema rejects an object carrying a bogus state (success)', () => {
    failsParse(
      kernelSchema.JobStatusSchema,
      { jobId: 'job-x', state: 'success' },
      "bogus JobState 'success' on JobStatus",
    );
  });
});

// ---------------------------------------------------------------------------
// 6. RunOptionsSchema concurrency bound — the promised T1.1 record item:
//    review round-4 medium finding, recorded in PR 7's 'Accepted at merge'
//    notes as "folded into the next kernel-schema-touching PR (T1.2)".
//    Mirror-only tightening (concurrency is a pool size; < 1 is
//    meaningless); the frozen RunOptions type is untouched.
// ---------------------------------------------------------------------------

describe('RunOptionsSchema concurrency bound (round-4 finding, folded from T1.1)', () => {
  test('concurrency 0 and negatives fail; 1 and 16 parse and round-trip', () => {
    failsParse(
      kernelSchema.RunOptionsSchema,
      { concurrency: 0, stopOnError: false },
      'concurrency 0',
    );
    failsParse(
      kernelSchema.RunOptionsSchema,
      { concurrency: -3, stopOnError: false },
      'negative concurrency',
    );
    roundTripsThrough(kernelSchema.RunOptionsSchema, { concurrency: 1, stopOnError: true });
    roundTripsThrough(kernelSchema.RunOptionsSchema, { concurrency: 16, stopOnError: false });
  });
});

// ---------------------------------------------------------------------------
// 7. RD-B review debt: the maxTokens mirror (#14-3) and the DD-9
//    costUSD/costBasis wire pairing (#14-4)
// ---------------------------------------------------------------------------

describe('RunOptionsSchema maxTokens mirror (DD-9 cap, mirror-only tightening)', () => {
  test('maxTokens 0 and negatives fail; a positive value parses and round-trips', () => {
    failsParse(
      kernelSchema.RunOptionsSchema,
      { concurrency: 1, stopOnError: false, maxTokens: 0 },
      'maxTokens 0',
    );
    failsParse(
      kernelSchema.RunOptionsSchema,
      { concurrency: 1, stopOnError: false, maxTokens: -5 },
      'negative maxTokens',
    );
    roundTripsThrough(kernelSchema.RunOptionsSchema, {
      concurrency: 1,
      stopOnError: false,
      maxTokens: 100,
    });
  });
});

describe('WorkerResultSchema costUSD/costBasis pairing (DD-9 wire coupling)', () => {
  const base = {
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    denials: [],
    stopReason: 'complete' as const,
  };

  test('both fields parse; either field ALONE fails; neither parses', () => {
    // Priced: costUSD and its basis together.
    roundTripsThrough(kernelSchema.WorkerResultSchema, {
      ...base,
      costUSD: 0.5,
      costBasis: 'modeled',
    });
    // Unpriced: neither field.
    roundTripsThrough(kernelSchema.WorkerResultSchema, { ...base });
    // Half a pairing is a fabrication either way.
    failsParse(
      kernelSchema.WorkerResultSchema,
      { ...base, costBasis: 'modeled' },
      'costBasis without costUSD',
    );
    failsParse(
      kernelSchema.WorkerResultSchema,
      { ...base, costUSD: 0.5 },
      'costUSD without costBasis',
    );
  });
});

describe('WorkerResult.error surfaces a driver-level failure cause (issues #203/#204)', () => {
  test('a WorkerResult carrying error round-trips JSON and parses through the strict mirror', () => {
    roundTripsThrough(kernelSchema.WorkerResultSchema, {
      usage: { input: 7, output: 0, cacheRead: 0, cacheWrite: 0 },
      denials: [],
      stopReason: 'error',
      error: 'ai-sdk driver: run failed — Error: scripted model failure',
    });
  });

  test('error on a non-error stopReason is rejected, naming the error path', () => {
    const parsed = kernelSchema.WorkerResultSchema.safeParse({
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      denials: [],
      stopReason: 'complete',
      error: 'ai-sdk driver: run failed — Error: boom',
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return; // narrow for TS
    expect(parsed.error.issues.some((issue) => issue.path[0] === 'error')).toBe(true);
  });
});

describe('exact optional schema boundaries', () => {
  test('absence survives parsing while explicit undefined cannot satisfy a typed optional field', () => {
    expect(kernelSchema.BudgetSchema.parse({})).toEqual({});
    expect(kernelSchema.BudgetSchema.safeParse({ maxUsd: undefined }).success).toBe(false);
    expect(kernelSchema.BudgetSchema.parse({ maxUsd: 0 })).toEqual({ maxUsd: 0 });
    const plan = { id: 'optional-boundary', jobs: [] };
    expect(kernelSchema.PlanSchema.parse(plan)).toEqual(plan);
    expect(kernelSchema.PlanSchema.safeParse({ ...plan, label: undefined }).success).toBe(false);
    expect(kernelSchema.PlanSchema.parse({ ...plan, label: '' }).label).toBe('');
  });
});
