// The GOVERNED runner (W2.2, ADR-0003 §2) — runPlan's 4th `gov` parameter.
//
// Pinned here:
//   1. Caps without governance are refused before anything runs (a cap with
//      no admission gate is a lie, not a limit).
//   2. Governed basics: admission keyed on the REAL plan job id (two jobs
//      sharing one op are independent attempts — the old op-name fallback
//      keying is gone), per-job/per-run spend rollups on the report rows,
//      and honest silence when nothing was spent (no fabricated costUSD 0).
//   3. Trip → honest stop: a budget-family trip re-marks only rows whose
//      non-execution is transitively budget-caused (a genuinely-failed dep
//      keeps its real verdict all the way down) and claims
//      stoppedEarly/earlyStopReason 'budget' with the ledger's cost rollup.
//   4. Run signal: a pre-aborted signal stops before any dispatch (rows stay
//      queued, 'signal' — never budget-exhausted); a mid-run abort lets the
//      admitted job keep its post-abort verdict and leaves the rest queued.
//   5. Journal v2 + resume: seq claims, the governance block (caps,
//      attendance, legacyJournal reset, raiseCap), attempt continuation from
//      the seeded fold, the three refusals (ungoverned over governed
//      history / unaccounted v1 dispatches / cap raise) and their opt-ins,
//      the ungoverned-marked escape hatch, spend-seeded resume tripping, and
//      the seq-ordered fold beating reversed fake-clock `at` stamps.
//
// The fold-ordering unit rules themselves live in journal-v2.test.ts — this
// file pins only the runner's USE of that order.
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { z } from 'zod';
import { currentJobContext, createGovernor } from '../../src/kernel/governor.js';
import type { GovernorEvent } from '../../src/kernel/governor.js';
import { openRunLog } from '../../src/kernel/journal.js';
import { makeManifest } from '../../src/kernel/manifest.js';
import { runPlan, type OpRegistryView } from '../../src/kernel/runner.js';
import type {
  JournalEvent,
  Op,
  OpRegistryEntry,
  OpResult,
  Plan,
  RunReport,
} from '../../src/kernel/types.js';

// ---------------------------------------------------------------------------
// Fakes — the runner.test.ts registry/plan patterns, plus spend/flag variants
// ---------------------------------------------------------------------------

// Non-strict on purpose: replay tests add keys to an input to change its hash.
const jobInputSchema = z.object({ jobId: z.string() });

function entry(
  name: string,
  op: (raw: unknown) => Promise<OpResult<unknown>>,
  schema: z.ZodType<unknown> = jobInputSchema,
): OpRegistryEntry<never, never> {
  return {
    name: name,
    inputSchema: schema as unknown as z.ZodType<never>,
    importer: () => Promise.resolve(op as unknown as Op<never, never>),
  };
}

function viewWith(...entries: OpRegistryEntry<never, never>[]): OpRegistryView {
  const map = new Map(
    entries.map((candidate): [string, OpRegistryEntry<never, never>] => [
      candidate.name,
      candidate,
    ]),
  );
  return { get: (name) => map.get(name) };
}

function independentPlan(id: string, n: number, op = 'fake'): Plan {
  return {
    id: id,
    jobs: Array.from({ length: n }, (_, i) => {
      const jobId = `j${i + 1}`;
      return { id: jobId, op: op, input: { jobId: jobId } };
    }),
  };
}

const okOp = async (raw: unknown): Promise<OpResult<unknown>> => {
  const jobId = (raw as { jobId: string }).jobId;
  return { status: 'ok', value: jobId };
};

const failOp = async (raw: unknown): Promise<OpResult<unknown>> => {
  const jobId = (raw as { jobId: string }).jobId;
  return { status: 'failed', error: `real failure ${jobId}` };
};

/** A counting op: records invocations, optionally streams a cost through the job context. */
function countingOp(calls: string[], spendUSD?: number) {
  return async (raw: unknown): Promise<OpResult<unknown>> => {
    const jobId = (raw as { jobId: string }).jobId;
    calls.push(jobId);
    if (spendUSD !== undefined) {
      currentJobContext()?.reportResult({
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
        costUSD: spendUSD,
      });
    }
    return okOp(raw);
  };
}

/** Narrowed governor-event views for filter predicates. */
type AdmittedEvent = Extract<GovernorEvent, { kind: 'admitted' }>;
type TrippedEvent = Extract<GovernorEvent, { kind: 'budget-tripped' }>;
type StartedEvent = Extract<JournalEvent, { type: 'job-started' }>;
type FinishedEvent = Extract<JournalEvent, { type: 'job-finished' }>;

const jobFinishes = (events: JournalEvent[]): FinishedEvent[] =>
  events.filter((event): event is FinishedEvent => event.type === 'job-finished');
const jobStarts = (events: JournalEvent[]): StartedEvent[] =>
  events.filter((event): event is StartedEvent => event.type === 'job-started');

const rowStatuses = (report: RunReport): string[] => report.jobs.map((row) => row.result.status);

// ---------------------------------------------------------------------------
// 1. Caps without governance
// ---------------------------------------------------------------------------

describe('caps require governance', () => {
  test('opts.maxUsd without a gov handle throws before anything runs', async () => {
    const calls: string[] = [];
    await expect(
      runPlan(
        independentPlan('plan-capguard-usd', 2),
        { concurrency: 1, stopOnError: false, maxUsd: 1 },
        viewWith(entry('fake', countingOp(calls))),
      ),
    ).rejects.toThrow('runPlan: caps require governance');
    expect(calls).toEqual([]); // no op ever ran
  });

  test('opts.maxTokens without a gov handle throws likewise', async () => {
    const calls: string[] = [];
    await expect(
      runPlan(
        independentPlan('plan-capguard-tokens', 2),
        { concurrency: 1, stopOnError: false, maxTokens: 100 },
        viewWith(entry('fake', countingOp(calls))),
      ),
    ).rejects.toThrow('runPlan: caps require governance');
    expect(calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. Governed basics — job.id admission, spend rollups, honest silence
// ---------------------------------------------------------------------------

describe('governed run basics (no journal — in-memory)', () => {
  test('a 3-job plan runs to completion; no spend → no costUSD, no early stop', async () => {
    const calls: string[] = [];
    const governor = createGovernor({ maxUsd: 5, maxTokens: 1000 });
    const report = await runPlan(
      independentPlan('plan-gov-basics', 3),
      { concurrency: 2, stopOnError: false },
      viewWith(entry('fake', countingOp(calls))),
      { governor },
    );
    expect(calls).toEqual(['j1', 'j2', 'j3']); // every op executed
    expect(report.stoppedEarly).toBe(false);
    expect('earlyStopReason' in report).toBe(false);
    expect('costUSD' in report).toBe(false); // nothing reported — no fabricated 0
    expect('usage' in report).toBe(false);
    expect(report.counts.done).toBe(3);
    // Admission happened on the REAL plan job ids, once each, attempt 1.
    const admissions = governor.events.filter(
      (event): event is AdmittedEvent => event.kind === 'admitted',
    );
    expect(admissions.map((event) => [event.jobKey, event.attempt])).toEqual([
      ['j1', 1],
      ['j2', 1],
      ['j3', 1],
    ]);
  });

  test('a governed op that streams evidence gets per-job usage/costUSD rows and a run-level rollup', async () => {
    const calls: string[] = [];
    const USAGE = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 };
    const governor = createGovernor({ maxUsd: 5 });
    const spendy = async (raw: unknown): Promise<OpResult<unknown>> => {
      calls.push((raw as { jobId: string }).jobId);
      currentJobContext()?.reportResult({ usage: USAGE, costUSD: 0.25 });
      return okOp(raw);
    };
    const report = await runPlan(
      independentPlan('plan-gov-spend', 2, 'spendy'),
      { concurrency: 1, stopOnError: false },
      viewWith(entry('spendy', spendy)),
      { governor },
    );
    // Per-job rollups on the report rows…
    expect(report.jobs[0]?.usage).toEqual(USAGE);
    expect(report.jobs[0]?.costUSD).toBe(0.25);
    expect(report.jobs[1]?.usage).toEqual(USAGE);
    expect(report.jobs[1]?.costUSD).toBe(0.25);
    // …and the run-level ledger rollups.
    expect(report.usage).toEqual({ input: 20, output: 10, cacheRead: 0, cacheWrite: 0 });
    expect(report.costUSD).toBe(0.5);
    expect(governor.usdSpent).toBe(0.5);
  });
});

describe('admission is keyed on the plan job id (W2.2)', () => {
  test('two jobs sharing one op each get their own attempt under maxAttemptsPerJob: 1', async () => {
    const calls: string[] = [];
    const governor = createGovernor({ maxAttemptsPerJob: 1 });
    const plan: Plan = {
      id: 'plan-gov-jobkey',
      jobs: [
        { id: 'job-a', op: 'shared', input: { jobId: 'job-a' } },
        { id: 'job-b', op: 'shared', input: { jobId: 'job-b' } },
      ],
    };
    const report = await runPlan(
      plan,
      { concurrency: 1, stopOnError: false },
      viewWith(entry('shared', countingOp(calls))),
      { governor },
    );
    // The op-name fallback would have refused the second job as "attempt 2
    // of 'shared'"; keyed on job ids both are first attempts.
    expect(calls).toEqual(['job-a', 'job-b']);
    expect(rowStatuses(report)).toEqual(['ok', 'ok']);
    const admissions = governor.events.filter(
      (event): event is AdmittedEvent => event.kind === 'admitted',
    );
    expect(admissions.map((event) => [event.jobKey, event.attempt])).toEqual([
      ['job-a', 1],
      ['job-b', 1],
    ]);
  });
});

// ---------------------------------------------------------------------------
// 3. Trip → honest stop with transitive attribution
// ---------------------------------------------------------------------------

describe('governed trip → honest stop (I9)', () => {
  test('queued-after-trip re-marks budget-exhausted; a genuinely-failed dep keeps its verdict', async () => {
    const calls: string[] = [];
    const governor = createGovernor({ maxUsd: 1.0 });
    const spendy2 = countingOp(calls, 2.0); // trips the 1.0 cap mid-run
    const plan: Plan = {
      id: 'plan-gov-trip',
      jobs: [
        { id: 'a', op: 'fail', input: { jobId: 'a' } }, // REAL failure
        { id: 'c', op: 'spendy', input: { jobId: 'c' } }, // trips during c
        { id: 'b', op: 'ok', input: { jobId: 'b' }, dependsOn: ['a'] }, // blocked for REAL
        { id: 'd', op: 'ok', input: { jobId: 'd' }, dependsOn: ['c'] }, // queued after the trip
      ],
    };
    const report = await runPlan(
      plan,
      { concurrency: 1, stopOnError: false },
      viewWith(entry('fail', failOp), entry('spendy', spendy2), entry('ok', okOp)),
      { governor },
    );
    // a failed genuinely; b is blocked by that REAL failure (not budget);
    // c kept its ok verdict (the trip is evidence, not a rewrite); d never
    // dispatched and is transitively budget-caused → budget-exhausted.
    // Row order is dispatch order: [a, c] wave 1, [b, d] wave 2.
    expect(rowStatuses(report)).toEqual(['failed', 'ok', 'failed', 'budget-exhausted']);
    expect(report.jobs[2]?.result).toMatchObject({
      status: 'failed',
      error: "blocked: dependency 'a' did not succeed",
    });
    expect(report.stoppedEarly).toBe(true);
    expect(report.earlyStopReason).toBe('budget');
    expect(report.costUSD).toBe(2.0); // the ledger's rollup
    expect(report.counts).toEqual({
      queued: 0,
      running: 0,
      blocked: 1, // b — blocked by the REAL a failure, never the budget
      done: 1,
      failed: 1, // a
      'budget-exhausted': 1, // d
    });
    const trip = governor.events.find(
      (event): event is TrippedEvent => event.kind === 'budget-tripped',
    );
    expect(trip?.tripKind).toBe('exhausted');
    expect(trip?.reason).toMatch(/usd rollup 2 exceeded cap 1/);
  });
});

// ---------------------------------------------------------------------------
// 4. Run signal — pre-aborted and mid-run
// ---------------------------------------------------------------------------

/** One macrotask turn — lets the runner's fs/microtask work progress. */
const tick = (): Promise<void> =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

/** Poll a condition across macrotask turns (deterministic, no real time). */
async function waitFor(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 10_000 && !condition(); i++) {
    await tick();
  }
  expect(condition(), `waitFor: ${what}`).toBe(true);
}

describe('governed run signal (ADR-0003 §2.3)', () => {
  test('a PRE-aborted signal stops before any dispatch: rows stay queued, earlyStopReason signal', async () => {
    const calls: string[] = [];
    const governor = createGovernor({});
    const external = new AbortController();
    external.abort();
    const report = await runPlan(
      independentPlan('plan-signal-pre', 2),
      { concurrency: 2, stopOnError: false },
      viewWith(entry('fake', countingOp(calls))),
      { governor, signal: external.signal },
    );
    expect(calls).toEqual([]); // nothing dispatched
    // NO budget re-marking: a cancel is not a budget verdict — rows stay
    // honestly queued.
    expect(rowStatuses(report)).toEqual(['indeterminate', 'indeterminate']);
    expect(report.jobs[0]?.result).toEqual({
      status: 'indeterminate',
      detail: 'queued: run stopped before dispatch',
    });
    expect(report.counts.queued).toBe(2);
    expect(report.counts['budget-exhausted']).toBe(0);
    expect(report.stoppedEarly).toBe(true);
    expect(report.earlyStopReason).toBe('signal');
    const trip = governor.events.find(
      (event): event is TrippedEvent => event.kind === 'budget-tripped',
    );
    expect(trip?.tripKind).toBe('signal');
  });

  test('a MID-RUN abort: the admitted job keeps its post-abort verdict, queued rows stay queued', async () => {
    const calls: string[] = [];
    const governor = createGovernor({});
    const external = new AbortController();
    let entered = false;
    const hangUntilAbort = async (): Promise<OpResult<unknown>> => {
      entered = true;
      // Cooperates with rung 1: resolves when the context signal aborts
      // (composed from the external run signal) and returns its own verdict.
      await new Promise<void>((resolve) => {
        currentJobContext()?.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return { status: 'indeterminate', detail: 'cancelled by run signal' };
    };
    const plan: Plan = {
      id: 'plan-signal-mid',
      jobs: [
        { id: 'j1', op: 'hang', input: { jobId: 'j1' } },
        { id: 'j2', op: 'fake', input: { jobId: 'j2' } },
      ],
    };
    const runPromise = runPlan(
      plan,
      { concurrency: 1, stopOnError: true },
      viewWith(entry('hang', hangUntilAbort), entry('fake', countingOp(calls))),
      { governor, signal: external.signal },
    );
    await waitFor(() => entered, 'the hang op to enter');
    external.abort();
    const report = await runPromise;
    // j1's op is not the counting fake (its entry is what ran); j2 (queued
    // in the pool behind j1) never dispatched, so calls stays empty.
    expect(calls).toEqual([]);
    expect(report.jobs[0]?.result).toEqual({
      status: 'indeterminate',
      detail: 'cancelled by run signal',
    });
    expect(report.jobs[1]?.result).toEqual({
      status: 'indeterminate',
      detail: 'queued: run stopped before dispatch',
    });
    expect(report.counts.queued).toBe(1);
    expect(report.counts['budget-exhausted']).toBe(0); // no budget re-marking
    expect(report.stoppedEarly).toBe(true);
    expect(report.earlyStopReason).toBe('signal');
    // j2 was never even admitted (the stop flag gated it before admission).
    const admissions = governor.events.filter(
      (event): event is AdmittedEvent => event.kind === 'admitted',
    );
    expect(admissions.map((event) => event.jobKey)).toEqual(['j1']);
  });
});

// ---------------------------------------------------------------------------
// 5. Journal v2 + resume
// ---------------------------------------------------------------------------

describe('governed journal v2 + resume', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cq-runner-governed-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('a governed run writes run-started with journalVersion 2, seq 1 and the governance block', async () => {
    const governor = createGovernor({ maxUsd: 5 });
    const USAGE = { input: 4, output: 2, cacheRead: 0, cacheWrite: 0 };
    const spendy = async (): Promise<OpResult<unknown>> => {
      currentJobContext()?.reportResult({ usage: USAGE, costUSD: 0.25 });
      return { status: 'ok', value: 'done' };
    };
    const report = await runPlan(
      independentPlan('plan-gov-journal', 1, 'spendy'),
      { concurrency: 1, stopOnError: false, journalDir: dir },
      viewWith(entry('spendy', spendy)),
      { governor },
    );
    const events = await openRunLog(dir).read(report.runId);
    expect(events[0]).toMatchObject({
      type: 'run-started',
      planId: 'plan-gov-journal',
      journalVersion: 2,
      seq: 1,
      governance: { capUsd: 5, attended: false },
    });
    // The per-job ledger rollups ride the job-finished event.
    const finishes = jobFinishes(events);
    expect(finishes[0]).toMatchObject({ jobId: 'j1', usage: USAGE, costUSD: 0.25 });
    // The run-finished coupling (schema-enforced) stays honest.
    expect(events[events.length - 1]).toMatchObject({ type: 'run-finished', stoppedEarly: false });
    // The seq claim leaves its tombstone.
    const listing = await readdir(dir);
    expect(listing.some((name) => name === 'plan-gov-journal.seq.1')).toBe(true);
  });

  test('a governed resume continues attempt numbers (seeded fold → admission attempt 2)', async () => {
    const calls: string[] = [];
    let behave: 'fail' | 'ok' = 'fail';
    const flaky = async (raw: unknown): Promise<OpResult<unknown>> => {
      calls.push((raw as { jobId: string }).jobId);
      return behave === 'fail' ? { status: 'failed', error: 'flake' } : okOp(raw);
    };
    const plan: Plan = {
      id: 'plan-gov-attempt',
      jobs: [{ id: 'j1', op: 'flaky', input: { jobId: 'j1' } }],
    };
    const report1 = await runPlan(
      plan,
      { concurrency: 1, stopOnError: false, journalDir: dir },
      viewWith(entry('flaky', flaky)),
      { governor: createGovernor({ maxUsd: 5 }) },
    );
    const log = openRunLog(dir);
    expect(jobStarts(await log.read(report1.runId)).map((event) => event.attempt)).toEqual([1]);

    // Resume with the op fixed: the runner folds run 1, seeds attempt 1, so
    // this dispatch IS attempt 2.
    behave = 'ok';
    const report2 = await runPlan(
      plan,
      { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
      viewWith(entry('flaky', flaky)),
      { governor: createGovernor({ maxUsd: 5 }) },
    );
    expect(calls).toEqual(['j1', 'j1']);
    const events2 = await log.read(report2.runId);
    expect(events2[0]).toMatchObject({ type: 'run-started', journalVersion: 2, seq: 2 });
    expect(jobStarts(events2).map((event) => event.attempt)).toEqual([2]);
    expect(report2.counts.done).toBe(1);
  });

  test('an UNGOVERNED run over governed history refuses; the opt-in marks the run ungoverned', async () => {
    const governor1 = createGovernor({ maxUsd: 5 });
    const report1 = await runPlan(
      independentPlan('plan-gov-mark', 1),
      { concurrency: 1, stopOnError: false, journalDir: dir },
      viewWith(entry('fake', okOp)),
      { governor: governor1 },
    );
    expect(report1.counts.done).toBe(1);
    expect(await openRunLog(dir).runs()).toHaveLength(1);

    // Ungoverned over governed history → refusal, before anything is written.
    const calls: string[] = [];
    await expect(
      runPlan(
        independentPlan('plan-gov-mark', 1),
        { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
        viewWith(entry('fake', countingOp(calls))),
      ),
    ).rejects.toThrow(
      'runPlan: plan plan-gov-mark has governed history; run governed or pass --opt-in budget.ungovernedOverGoverned',
    );
    expect(calls).toEqual([]);
    expect(await openRunLog(dir).runs()).toHaveLength(1); // nothing claimed or emitted

    // The opt-in runs UNGOVERNED-MARKED: no admission, no caps, ops execute
    // exactly as the ungoverned path — and the marker is journalled.
    const markerGovernor = createGovernor({});
    const report2 = await runPlan(
      independentPlan('plan-gov-mark', 1),
      { concurrency: 1, stopOnError: false, journalDir: dir },
      viewWith(entry('fake', countingOp(calls))),
      { governor: markerGovernor, optIn: ['budget.ungovernedOverGoverned'] },
    );
    expect(calls).toEqual(['j1']); // the op ran ungoverned
    expect(markerGovernor.events.filter((event) => event.kind === 'admitted')).toEqual([]);
    const events2 = await openRunLog(dir).read(report2.runId);
    expect(events2[0]).toMatchObject({
      type: 'run-started',
      journalVersion: 2,
      seq: 2,
      ungoverned: { optIn: true },
    });
    expect('governance' in (events2[0] as { governance?: unknown })).toBe(false);
    expect(jobStarts(events2).map((event) => event.attempt)).toEqual([1]); // ungoverned attempt
  });

  test('governed over unaccounted v1 dispatches refuses; legacyJournal=reset honours and records the reset (sticky)', async () => {
    const plan: Plan = {
      id: 'plan-gov-v1',
      jobs: [{ id: 'j1', op: 'fake', input: { jobId: 'j1' } }],
    };
    const log = openRunLog(dir);
    const v1RunId = 'plan-gov-v1--legacy--aa';
    await log.append(v1RunId, {
      type: 'run-started',
      runId: v1RunId,
      at: '2026-01-01T00:00:00.000Z',
      planId: 'plan-gov-v1',
    });
    await log.append(v1RunId, {
      type: 'job-started',
      runId: v1RunId,
      at: '2026-01-01T00:00:00.000Z',
      jobId: 'j1',
      op: 'fake',
      attempt: 1,
    });
    const calls: string[] = [];

    // Refusal names the count and the runs, whether or not resume is set.
    await expect(
      runPlan(
        plan,
        { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
        viewWith(entry('fake', countingOp(calls))),
        { governor: createGovernor({}) },
      ),
    ).rejects.toThrow(
      'runPlan: governed resume over v1 journals with unaccounted dispatches (1 jobs in plan-gov-v1--legacy--aa); v1 journals carry no spend. Pass --opt-in budget.legacyJournal=reset.',
    );
    await expect(
      runPlan(
        plan,
        { concurrency: 1, stopOnError: false, journalDir: dir },
        viewWith(entry('fake', countingOp(calls))),
        { governor: createGovernor({}) },
      ),
    ).rejects.toThrow(/unaccounted dispatches/);
    expect(calls).toEqual([]);

    // With the opt-in the reset is HONOURED (it was needed) and recorded.
    const report1 = await runPlan(
      plan,
      { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
      viewWith(entry('fake', countingOp(calls))),
      { governor: createGovernor({}), optIn: ['budget.legacyJournal=reset'] },
    );
    expect(calls).toEqual(['j1']); // j1 re-dispatched (the v1 start never finished)
    const events1 = await log.read(report1.runId);
    expect(events1[0]).toMatchObject({
      type: 'run-started',
      journalVersion: 2,
      seq: 1,
      governance: {
        attended: false,
        legacyJournal: { mode: 'reset', v1RunIds: ['plan-gov-v1--legacy--aa'] },
      },
    });

    // STICKY: a second governed resume does not refuse (the reset is in the
    // folded governance record). Note the reset re-dispatch also journalled
    // a finish for j1, so this resume replays it — zero invocations.
    const calls2: string[] = [];
    const report2 = await runPlan(
      plan,
      { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
      viewWith(entry('fake', countingOp(calls2))),
      { governor: createGovernor({}) },
    );
    expect(calls2).toEqual([]);
    expect(report2.counts.done).toBe(1);

    // A NEW v1 file with dispatches is unaccounted again → refuses.
    const v1RunId2 = 'plan-gov-v1--legacy2--bb';
    await log.append(v1RunId2, {
      type: 'run-started',
      runId: v1RunId2,
      at: '2026-01-02T00:00:00.000Z',
      planId: 'plan-gov-v1',
    });
    await log.append(v1RunId2, {
      type: 'job-started',
      runId: v1RunId2,
      at: '2026-01-02T00:00:00.000Z',
      jobId: 'j2',
      op: 'fake',
      attempt: 1,
    });
    await expect(
      runPlan(
        plan,
        { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
        viewWith(entry('fake', countingOp(calls2))),
        { governor: createGovernor({}) },
      ),
    ).rejects.toThrow(/unaccounted dispatches \(1 jobs in plan-gov-v1--legacy2--bb\)/);
  });

  test('a cap raise over the ledger refuses without budget.raiseCap; honoured, it is recorded', async () => {
    const plan: Plan = {
      id: 'plan-gov-raise',
      jobs: [{ id: 'j1', op: 'fake', input: { jobId: 'j1' } }],
    };
    await runPlan(
      plan,
      { concurrency: 1, stopOnError: false, journalDir: dir },
      viewWith(entry('fake', okOp)),
      { governor: createGovernor({ maxUsd: 5 }) },
    );
    const runsBefore = await openRunLog(dir).runs();

    // Raising 5 → 10 without the opt-in refuses BEFORE anything is written.
    const calls: string[] = [];
    await expect(
      runPlan(
        plan,
        { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
        viewWith(entry('fake', countingOp(calls))),
        { governor: createGovernor({ maxUsd: 10 }) },
      ),
    ).rejects.toThrow('runPlan: cap raised from 5 to 10');
    expect(calls).toEqual([]);
    expect(await openRunLog(dir).runs()).toEqual(runsBefore); // no seq claim, no run file

    // With budget.raiseCap the run proceeds and records the transition.
    const report = await runPlan(
      plan,
      { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
      viewWith(entry('fake', countingOp(calls))),
      { governor: createGovernor({ maxUsd: 10 }), optIn: ['budget.raiseCap'] },
    );
    const events = await openRunLog(dir).read(report.runId);
    expect(events[0]).toMatchObject({
      type: 'run-started',
      journalVersion: 2,
      seq: 2,
      governance: { capUsd: 10, attended: false, raiseCap: { from: 5, to: 10 } },
    });
  });

  test('a resume seeds the ledger spend: 3 spent + 2.5 more trips the 5 cap mid-run', async () => {
    const calls: string[] = [];
    let behave: 'spend3-fail' | 'spend2.5-ok' = 'spend3-fail';
    const ledgerOp = async (raw: unknown): Promise<OpResult<unknown>> => {
      const jobId = (raw as { jobId: string }).jobId;
      calls.push(jobId);
      if (behave === 'spend3-fail') {
        currentJobContext()?.reportResult({ costUSD: 3 });
        return { status: 'failed', error: 'flake after spend' };
      }
      currentJobContext()?.reportResult({ costUSD: 2.5 });
      return okOp(raw);
    };
    const plan: Plan = {
      id: 'plan-gov-ledger',
      jobs: [
        { id: 'j1', op: 'ledger', input: { jobId: 'j1' } },
        { id: 'j2', op: 'ledger', input: { jobId: 'j2' }, dependsOn: ['j1'] },
      ],
    };
    // Run 1: j1 spends 3 (under the 5 cap) and FAILS; j2 blocked for real.
    await runPlan(
      plan,
      { concurrency: 1, stopOnError: false, journalDir: dir },
      viewWith(entry('ledger', ledgerOp)),
      { governor: createGovernor({ maxUsd: 5 }) },
    );
    // Run 2 (resume): the seed carries the 3; j1's fresh 2.5 pushes the
    // rollup to 5.5 — the cap trips mid-run, and queued j2 is re-marked.
    behave = 'spend2.5-ok';
    const report2 = await runPlan(
      plan,
      { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
      viewWith(entry('ledger', ledgerOp)),
      { governor: createGovernor({ maxUsd: 5 }) },
    );
    expect(calls).toEqual(['j1', 'j1']); // j1 re-ran (its last finish was failed)…
    expect(calls).not.toContain('j2'); // …j2 never dispatched
    expect(report2.jobs[0]?.result).toEqual({ status: 'ok', value: 'j1' }); // real verdict kept
    expect(report2.jobs[1]?.result).toEqual({ status: 'budget-exhausted' });
    expect(report2.stoppedEarly).toBe(true);
    expect(report2.earlyStopReason).toBe('budget');
    expect(report2.costUSD).toBe(5.5); // the ledger: seeded 3 + live 2.5
  });

  test('the resume fold follows seq, not a reversed fake-clock `at`', async () => {
    const plan: Plan = {
      id: 'plan-gov-seqfold',
      jobs: [{ id: 'j1', op: 'fake', input: { jobId: 'j1' } }],
    };
    const hash = makeManifest(plan).jobs[0]?.inputsHash ?? '';
    const log = openRunLog(dir);
    // seq 1 started LATE by its own `at` and finished j1 ok.
    const run1 = 'plan-gov-seqfold--late--aa';
    await log.append(run1, {
      type: 'run-started',
      runId: run1,
      at: '2026-01-02T00:00:00.000Z',
      planId: 'plan-gov-seqfold',
      journalVersion: 2,
      seq: 1,
      governance: { attended: false },
    });
    await log.append(run1, {
      type: 'job-started',
      runId: run1,
      at: '2026-01-02T00:00:00.000Z',
      jobId: 'j1',
      op: 'fake',
      attempt: 1,
    });
    await log.append(run1, {
      type: 'job-finished',
      runId: run1,
      at: '2026-01-02T00:00:01.000Z',
      jobId: 'j1',
      opId: 'fake',
      inputsHash: hash,
      result: { status: 'ok', value: 'j1' },
    });
    // seq 2 started EARLY by `at` and re-attempted j1 to a FAILED finish.
    const run2 = 'plan-gov-seqfold--early--bb';
    await log.append(run2, {
      type: 'run-started',
      runId: run2,
      at: '2026-01-01T00:00:00.000Z',
      planId: 'plan-gov-seqfold',
      journalVersion: 2,
      seq: 2,
      governance: { attended: false },
    });
    await log.append(run2, {
      type: 'job-started',
      runId: run2,
      at: '2026-01-01T00:00:00.000Z',
      jobId: 'j1',
      op: 'fake',
      attempt: 2,
    });
    await log.append(run2, {
      type: 'job-finished',
      runId: run2,
      at: '2026-01-01T00:00:01.000Z',
      jobId: 'j1',
      opId: 'fake',
      inputsHash: hash,
      result: { status: 'failed', error: 'seq-2 attempt blew up' },
    });

    // A by-`at` fold would let the seq-1 ok win (zero dispatch); the
    // seq-ordered fold correctly takes seq 2's failed finish as the last
    // word and re-dispatches — as attempt 3 (two prior starts seeded).
    const calls: string[] = [];
    const report = await runPlan(
      plan,
      { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
      viewWith(entry('fake', countingOp(calls))),
      { governor: createGovernor({}) },
    );
    expect(calls).toEqual(['j1']);
    const events = await log.read(report.runId);
    expect(events[0]).toMatchObject({ type: 'run-started', journalVersion: 2, seq: 3 });
    expect(jobStarts(events).map((event) => event.attempt)).toEqual([3]);
    expect(report.counts.done).toBe(1);
  });
});
