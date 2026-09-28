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
//   6. Honest-stop attribution (the coverage the deleted withBudgetStop
//      helper owned, re-homed here against the runner-owned pass — W2.2
//      slice C): dispatch-quota stops re-mark, silent trips stay silent,
//      fabricated `queued:` verdicts from admitted ops never rewrite, and
//      diamond-shaped BLOCKED rows over a refused dispatch re-mark
//      transitively through memoized causality.
//   7. Chained governed resumes: the fold reads ALL runs (a spent
//      dispatch quota carries across resumes) and a corrupt sibling-plan
//      journal cannot block the fold.
//
// The fold-ordering unit rules themselves live in journal-v2.test.ts — this
// file pins only the runner's USE of that order.
import { appendFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { z } from 'zod';
import { currentJobContext, createGovernor } from '../../src/kernel/governor.js';
import type { Governance, GovernorEvent } from '../../src/kernel/governor.js';
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
type ShortCircuitEvent = Extract<GovernorEvent, { kind: 'short-circuited' }>;
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
// 1b. Governance without a governor — the caps guard's mirror (review M4)
// ---------------------------------------------------------------------------

describe('governance requires a governor', () => {
  test('a { governor: undefined } Governance handle throws before anything runs', async () => {
    // Without this guard the handle degrades to a silent no-op run that still
    // journals a governed-looking v2 record (seq claimed, governance block) —
    // the exact dishonesty the caps guard exists to prevent for caps.
    const calls: string[] = [];
    await expect(
      runPlan(
        independentPlan('plan-gov-no-governor', 1),
        { concurrency: 1, stopOnError: false },
        viewWith(entry('fake', countingOp(calls))),
        { governor: undefined } as unknown as Governance,
      ),
    ).rejects.toThrow('runPlan: governance requires a governor');
    expect(calls).toEqual([]); // no op ran — no silent ungoverned dispatch
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
      { governor, allowAdvisory: true },
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
      { governor, allowAdvisory: true },
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
      { governor, allowAdvisory: true },
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
      { governor, allowAdvisory: true },
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
// 3b. Honest-stop attribution — the cases the deleted withBudgetStop helper
//     owned, re-homed against the runner-owned honest-stop pass (W2.2 C)
// ---------------------------------------------------------------------------

describe('honest-stop attribution through the governed runner (#15-4/#15-6)', () => {
  test('a dispatch-quota stop re-marks queued rows budget-exhausted (#15-4a)', async () => {
    const calls: string[] = [];
    const governor = createGovernor({ runDispatchQuota: 2 });
    const plan: Plan = {
      id: 'plan-quota-stop',
      jobs: [
        { id: 'j1', op: 'fake', input: { jobId: 'j1' } },
        { id: 'j2', op: 'fake', input: { jobId: 'j2' } },
        { id: 'j3', op: 'fake', input: { jobId: 'j3' } }, // refused: dispatch-quota
        { id: 'j4', op: 'fake', input: { jobId: 'j4' }, dependsOn: ['j2'] }, // wave 2 — never dispatched → queued
      ],
    };
    // j3's refusal is a non-ok terminal → stopOnError halts dispatching; j4
    // never dispatched (its dep j2 is done) → queued, then re-marked by the
    // honest-stop pass: a quota stop is budget-family even though `tripped`
    // stays false (an attempt-cap is per-job and must NOT trigger this).
    const report = await runPlan(
      plan,
      { concurrency: 1, stopOnError: true },
      viewWith(entry('fake', countingOp(calls))),
      { governor, allowAdvisory: true },
    );
    expect(governor.tripped).toBe(false); // a quota stop is NOT a USD/token trip
    const refusals = governor.events.filter(
      (event): event is ShortCircuitEvent => event.kind === 'short-circuited',
    );
    expect(refusals.map((event) => event.reason)).toEqual(['dispatch-quota']);
    expect(rowStatuses(report)).toEqual(['ok', 'ok', 'budget-exhausted', 'budget-exhausted']);
    expect(report.jobs[3]?.result).toEqual({ status: 'budget-exhausted' });
    expect(report.stoppedEarly).toBe(true);
    expect(report.earlyStopReason).toBe('budget');
    expect(report.counts).toEqual({
      queued: 0,
      running: 0,
      blocked: 0,
      done: 2,
      failed: 0,
      'budget-exhausted': 2,
    });
  });

  test('a trip that gated NOTHING stays silent: zero re-marked rows → no stoppedEarly claim (#15-4b)', async () => {
    const calls: string[] = [];
    const governor = createGovernor({ maxUsd: 0.5 });
    // j1's cost trips the cap mid-run; j2 (same wave, admitted at its pool
    // slot) is killed budget-while-queued — both rows are real terminal
    // verdicts; nothing was ever queued or blocked.
    const spendy2 = countingOp(calls, 0.6);
    const report = await runPlan(
      independentPlan('plan-trip-no-gate', 2, 'spendy'),
      { concurrency: 1, stopOnError: false },
      viewWith(entry('spendy', spendy2)),
      { governor, allowAdvisory: true },
    );
    expect(governor.tripped).toBe(true);
    expect(rowStatuses(report)).toEqual(['ok', 'budget-exhausted']);
    // I9 honesty: no row was re-marked → no stoppedEarly claim. The report
    // still carries the ledger's derived cost rollup the governor OBSERVED.
    expect(report.stoppedEarly).toBe(false);
    expect(report.earlyStopReason).toBeUndefined();
    expect(report.costUSD).toBe(0.6); // only j1's evidence ever folded
    expect(report.counts['budget-exhausted']).toBe(1);
  });

  test('a fabricated queued: detail from an ADMITTED op is NOT rewritten (#15-6)', async () => {
    const governor = createGovernor({ maxUsd: 1.0 });
    // The op RAN (the governor admitted it) and returned an indeterminate
    // verdict claiming the runner's never-dispatched marker — executed code
    // fabricating `queued: …`. The honest-stop pass re-marks only rows it
    // never dispatched (its own admission records), so the lie keeps the
    // op's real verdict.
    const lyingOp = async (): Promise<OpResult<unknown>> => {
      currentJobContext()?.reportResult({ costUSD: 2.0 }); // trips the 1.0 cap mid-run
      return { status: 'indeterminate', detail: 'queued: (fabricated by the op itself)' };
    };
    const report = await runPlan(
      independentPlan('plan-queued-fabricated', 1, 'lying'),
      { concurrency: 1, stopOnError: false },
      viewWith(entry('lying', lyingOp)),
      { governor, allowAdvisory: true },
    );
    const admissions = governor.events.filter(
      (event): event is AdmittedEvent => event.kind === 'admitted',
    );
    expect(admissions.map((event) => event.jobKey)).toEqual(['j1']); // the governor ADMITTED this job
    expect(governor.tripped).toBe(true);
    expect(rowStatuses(report)).toEqual(['indeterminate']);
    // The row keeps its REAL verdict — and with nothing re-marked there is
    // no stoppedEarly claim either.
    expect(report.jobs[0]?.result).toEqual({
      status: 'indeterminate',
      detail: 'queued: (fabricated by the op itself)',
    });
    expect(report.stoppedEarly).toBe(false);
  });

  test('a fabricated queued: row does not condemn its DEPENDENTS either (#15-6, review round 3)', async () => {
    const governor = createGovernor({ maxUsd: 1.0 });
    // The ADMITTED op fabricates `queued: …` AND has a dependent: the
    // budgetCaused walk reads the row too, so a lying row must not get the
    // dependent re-marked budget-exhausted.
    const lyingOp = async (): Promise<OpResult<unknown>> => {
      currentJobContext()?.reportResult({ costUSD: 2.0 }); // trips the 1.0 cap mid-run
      return { status: 'indeterminate', detail: 'queued: (fabricated by the op itself)' };
    };
    const plan: Plan = {
      id: 'plan-queued-fabricated-dep',
      jobs: [
        { id: 'f1', op: 'lying', input: { jobId: 'f1' } },
        { id: 'd1', op: 'fake', input: { jobId: 'd1' }, dependsOn: ['f1'] },
      ],
    };
    const report = await runPlan(
      plan,
      { concurrency: 1, stopOnError: false },
      viewWith(entry('lying', lyingOp), entry('fake', countingOp([]))),
      { governor, allowAdvisory: true },
    );
    expect(governor.tripped).toBe(true);
    // f1 indeterminate → the runner counts it failed; d1 is blocked by it.
    expect(rowStatuses(report)).toEqual(['indeterminate', 'failed']);
    // The fabricated row keeps its verdict…
    expect(report.jobs[0]?.result).toEqual({
      status: 'indeterminate',
      detail: 'queued: (fabricated by the op itself)',
    });
    // …and the dependent is NOT re-marked budget-exhausted off the lie: it
    // stays honestly blocked on an unresolved row.
    expect(report.jobs[1]?.result).toMatchObject({
      status: 'failed',
      error: /blocked: dependency 'f1'/,
    });
    expect(report.stoppedEarly).toBe(false); // nothing was re-marked
  });

  test('a diamond of BLOCKED rows over a refused dispatch re-marks transitively (memoized causality)', async () => {
    const calls: string[] = [];
    const governor = createGovernor({ runDispatchQuota: 2 });
    // j1, j2 spend the quota; j3 is REFUSED (a real budget-exhausted row);
    // j4/j5 are BLOCKED on j3; the diamond root j6 is blocked on BOTH
    // branches — the causality walk must reuse each branch's memoized
    // verdict to re-mark the root (the old visited-marker bug kept roots
    // dishonestly blocked).
    const plan: Plan = {
      id: 'plan-quota-diamond',
      jobs: [
        { id: 'j1', op: 'fake', input: { jobId: 'j1' } },
        { id: 'j2', op: 'fake', input: { jobId: 'j2' } },
        { id: 'j3', op: 'fake', input: { jobId: 'j3' } }, // refused: dispatch-quota
        { id: 'j4', op: 'fake', input: { jobId: 'j4' }, dependsOn: ['j3'] }, // blocked on the refusal
        { id: 'j5', op: 'fake', input: { jobId: 'j5' }, dependsOn: ['j3'] }, // blocked on the refusal
        { id: 'j6', op: 'fake', input: { jobId: 'j6' }, dependsOn: ['j4', 'j5'] }, // the diamond root
      ],
    };
    const report = await runPlan(
      plan,
      { concurrency: 1, stopOnError: false },
      viewWith(entry('fake', countingOp(calls))),
      { governor, allowAdvisory: true },
    );
    expect(calls).toEqual(['j1', 'j2']); // the quota gated everything after j2
    expect(governor.tripped).toBe(false); // quota refusal, not a USD/token trip
    expect(rowStatuses(report)).toEqual([
      'ok',
      'ok',
      'budget-exhausted',
      'budget-exhausted',
      'budget-exhausted',
      'budget-exhausted',
    ]);
    expect(report.jobs[3]?.result).toEqual({ status: 'budget-exhausted' }); // blocked → re-marked
    expect(report.jobs[5]?.result).toEqual({ status: 'budget-exhausted' }); // the root
    expect(report.stoppedEarly).toBe(true);
    expect(report.earlyStopReason).toBe('budget');
    expect(report.counts).toEqual({
      queued: 0,
      running: 0,
      blocked: 0,
      done: 2,
      failed: 0,
      'budget-exhausted': 4,
    });
  });

  test('a BLOCKED row over an ok dep and a refused dep re-marks budget-exhausted (successful deps do not veto causality)', async () => {
    const calls: string[] = [];
    const governor = createGovernor({ runDispatchQuota: 2 });
    // j1, j2 spend the quota; j3 is REFUSED (a real budget-exhausted row);
    // j4 depends on the OK j1 AND the refused j3 — j3 alone blocked it (a
    // succeeded dep blocks nothing), so the causality walk must ignore the
    // successful dep instead of letting it veto the re-mark.
    const plan: Plan = {
      id: 'plan-quota-mixed-deps',
      jobs: [
        { id: 'j1', op: 'fake', input: { jobId: 'j1' } },
        { id: 'j2', op: 'fake', input: { jobId: 'j2' } },
        { id: 'j3', op: 'fake', input: { jobId: 'j3' } }, // refused: dispatch-quota
        { id: 'j4', op: 'fake', input: { jobId: 'j4' }, dependsOn: ['j1', 'j3'] }, // blocked by j3 only
      ],
    };
    const report = await runPlan(
      plan,
      { concurrency: 1, stopOnError: false },
      viewWith(entry('fake', countingOp(calls))),
      { governor, allowAdvisory: true },
    );
    expect(calls).toEqual(['j1', 'j2']); // the quota gated everything after j2
    expect(rowStatuses(report)).toEqual(['ok', 'ok', 'budget-exhausted', 'budget-exhausted']);
    expect(report.jobs[3]?.result).toEqual({ status: 'budget-exhausted' }); // blocked → re-marked
    expect(report.stoppedEarly).toBe(true);
    expect(report.earlyStopReason).toBe('budget');
    expect(report.counts).toEqual({
      queued: 0,
      running: 0,
      blocked: 0,
      done: 2,
      failed: 0,
      'budget-exhausted': 2,
    });
  });
});

// ---------------------------------------------------------------------------
// 3c. Chained governed resumes — the deleted seedFromRunLog helper's pins,
//     now against the runner's own fold (W2.2 slice C)
// ---------------------------------------------------------------------------

describe('the governed fold reads ALL chained runs (review VB1B)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cq-runner-chained-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('a spent dispatch quota carries across TWO governed resumes', async () => {
    const calls: string[] = [];
    const plan: Plan = {
      id: 'plan-chained-quota',
      jobs: [
        { id: 'j1', op: 'fake', input: { jobId: 'j1' } },
        { id: 'j2', op: 'fake', input: { jobId: 'j2' } },
        { id: 'j3', op: 'fake', input: { jobId: 'j3' } },
      ],
    };
    // Run 1: j1 and j2 spend the quota of 2; j3 is refused.
    const report1 = await runPlan(
      plan,
      { concurrency: 1, stopOnError: false, journalDir: dir },
      viewWith(entry('fake', countingOp(calls))),
      { governor: createGovernor({ runDispatchQuota: 2 }), allowAdvisory: true },
    );
    expect(rowStatuses(report1)).toEqual(['ok', 'ok', 'budget-exhausted']);
    expect(calls).toEqual(['j1', 'j2']);

    // Resume with a FRESH governor: the fold seeds the spent quota (ALL
    // prior runs, not just the latest), so j3 stays refused — while j1/j2
    // replay-skip (a replay consumes no quota).
    const governor2 = createGovernor({ runDispatchQuota: 2 });
    const report2 = await runPlan(
      plan,
      { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
      viewWith(entry('fake', countingOp(calls))),
      { governor: governor2, allowAdvisory: true },
    );
    expect(calls).toEqual(['j1', 'j2']); // UNCHANGED — j3 never runs the op
    expect(rowStatuses(report2)).toEqual(['ok', 'ok', 'budget-exhausted']);
    const refusals = governor2.events.filter(
      (event): event is ShortCircuitEvent => event.kind === 'short-circuited',
    );
    expect(refusals.map((event) => event.reason)).toEqual(['dispatch-quota']);
    expect(governor2.dispatchCount).toBe(2); // seeded from the fold; refusals do not consume
  });

  test('a corrupt sibling-plan journal cannot block this plan’s governed resume ("a" vs "a--b", shared filter)', async () => {
    // Review VB1C r1: a prefix-only candidate filter read a corrupt journal
    // of plan 'a--b' into plan 'a's fold. The shared candidateRunsForPlan
    // filter rejects it (the runId remainder after 'a--' is THREE segments,
    // not the exact two-segment tail), so the governed run below — which
    // folds the whole dir — never parses the corrupt file.
    const log = openRunLog(dir);
    const plan: Plan = {
      id: 'a',
      jobs: [{ id: 'j1', op: 'fake', input: { jobId: 'j1' } }],
    };
    const hash = makeManifest(plan).jobs[0]?.inputsHash ?? '';
    const runId = 'a--r1--aa';
    await log.append(runId, {
      type: 'run-started',
      runId,
      at: '2026-01-01T00:00:00.000Z',
      planId: 'a',
      journalVersion: 2,
      seq: 1,
      governance: { attended: false },
    });
    await log.append(runId, {
      type: 'job-started',
      runId,
      at: '2026-01-01T00:00:00.000Z',
      jobId: 'j1',
      op: 'fake',
      attempt: 1,
    });
    await log.append(runId, {
      type: 'job-finished',
      runId,
      at: '2026-01-01T00:00:01.000Z',
      jobId: 'j1',
      opId: 'fake',
      inputsHash: hash,
      result: { status: 'ok', value: 'j1' },
    });
    // A corrupt MIDDLE line in the sibling plan's file (prefix 'a--' matches).
    await appendFile(
      join(dir, 'a--b--k3y--c0ffee.ndjson'),
      `${JSON.stringify({ type: 'run-started', runId: 'a--b--k3y--c0ffee', at: '2026-01-01T00:00:00.000Z', planId: 'a--b' })}\n{"type":"job-started","runI\n`,
      'utf8',
    );

    const calls: string[] = [];
    const report = await runPlan(
      plan,
      { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
      viewWith(entry('fake', countingOp(calls))),
      { governor: createGovernor({}), allowAdvisory: true },
    );
    expect(calls).toEqual([]); // j1 replayed from the fold — no corrupt-read blowup
    expect(report.counts.done).toBe(1);
  });

  test('a dependency cycle throws BEFORE anything is claimed or journalled', async () => {
    // Plan corruption is invalid input: the rejection must precede the seq
    // claim and the governed run-started append, or the failed invocation
    // would permanently establish governed history and refuse later
    // corrected (uncapped, opt-in-free) runs as ungoverned-over-governed.
    const calls: string[] = [];
    const plan: Plan = {
      id: 'plan-gov-cycle',
      jobs: [
        { id: 'j1', op: 'fake', input: { jobId: 'j1' }, dependsOn: ['j2'] },
        { id: 'j2', op: 'fake', input: { jobId: 'j2' }, dependsOn: ['j1'] },
      ],
    };
    await expect(
      runPlan(
        plan,
        { concurrency: 1, stopOnError: false, journalDir: dir },
        viewWith(entry('fake', countingOp(calls))),
        { governor: createGovernor({ maxUsd: 5 }), allowAdvisory: true },
      ),
    ).rejects.toThrow(/dependency cycle/);
    expect(calls).toEqual([]); // nothing dispatched either
    // The journal dir stays empty: no claim tombstone, no run-started file.
    expect(await readdir(dir)).toEqual([]);
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
  test('a PRE-aborted signal over a dependency CHAIN: both rows stay queued, none blocked, earlyStopReason signal (cycle 4)', async () => {
    // The sweep's undefined-dep rule ("never classified counts as not-ok")
    // is a PLAIN-path honesty rule: under a governed signal stop the dep did
    // not fail — the run was cancelled before it could dispatch — so the
    // dependent row is queued (re-runnable on resume), never blocked.
    const calls: string[] = [];
    const governor = createGovernor({});
    const external = new AbortController();
    external.abort();
    const plan: Plan = {
      id: 'plan-signal-pre-chain',
      jobs: [
        { id: 'a', op: 'fake', input: { jobId: 'a' } },
        { id: 'b', op: 'fake', input: { jobId: 'b' }, dependsOn: ['a'] },
      ],
    };
    const report = await runPlan(
      plan,
      { concurrency: 2, stopOnError: false },
      viewWith(entry('fake', countingOp(calls))),
      { governor, signal: external.signal, allowAdvisory: true },
    );
    expect(calls).toEqual([]); // nothing dispatched
    expect(rowStatuses(report)).toEqual(['indeterminate', 'indeterminate']);
    expect(report.counts.queued).toBe(2);
    expect(report.counts.blocked).toBe(0);
    expect(report.counts['budget-exhausted']).toBe(0);
    expect(report.stoppedEarly).toBe(true);
    expect(report.earlyStopReason).toBe('signal');
  });

  test('a PRE-aborted signal stops before any dispatch: rows stay queued, earlyStopReason signal', async () => {
    const calls: string[] = [];
    const governor = createGovernor({});
    const external = new AbortController();
    external.abort();
    const report = await runPlan(
      independentPlan('plan-signal-pre', 2),
      { concurrency: 2, stopOnError: false },
      viewWith(entry('fake', countingOp(calls))),
      { governor, signal: external.signal, allowAdvisory: true },
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
      { governor, signal: external.signal, allowAdvisory: true },
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

  test('a trip while a dispatch WAITS FOR A SLOT: signal → indeterminate + cancelled-while-queued, never budget-exhausted (cycle 2)', async () => {
    // The slot-wait window: j2 is ADMITTED and parked on the in-flight slot
    // when the trip lands — the short-circuit must not claim a budget
    // exhaustion for a cancel (the TripKind taxonomy's rule), and the row
    // must stay re-runnable (indeterminate, not budget-exhausted).
    const calls: string[] = [];
    const governor = createGovernor({ inFlightCeiling: 1 });
    const external = new AbortController();
    let j1Entered = false;
    const hangUntilAbort = async (): Promise<OpResult<unknown>> => {
      j1Entered = true;
      await new Promise<void>((resolve) => {
        currentJobContext()?.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return { status: 'indeterminate', detail: 'cancelled by run signal' };
    };
    const plan: Plan = {
      id: 'plan-signal-slot',
      jobs: [
        { id: 'j1', op: 'hang', input: { jobId: 'j1' } },
        { id: 'j2', op: 'fake', input: { jobId: 'j2' } },
      ],
    };
    const runPromise = runPlan(
      plan,
      { concurrency: 2, stopOnError: false },
      viewWith(entry('hang', hangUntilAbort), entry('fake', countingOp(calls))),
      { governor, signal: external.signal, allowAdvisory: true },
    );
    await waitFor(() => j1Entered, 'j1 to enter');
    external.abort(); // j2 is admitted, waiting on the single in-flight slot
    const report = await runPromise;
    expect(calls).toEqual([]); // j2 never ran
    expect(report.jobs[1]?.result).toMatchObject({ status: 'indeterminate' });
    expect(report.jobs[1]?.result.status).not.toBe('budget-exhausted');
    expect(report.stoppedEarly).toBe(true);
    expect(report.earlyStopReason).toBe('signal');
    const shortCircuits = governor.events.filter((event) => event.kind === 'short-circuited');
    expect(shortCircuits.map((event) => event.reason)).toContain('cancelled-while-queued');
  });

  test('a MID-RUN abort over an a→b→c chain never fabricates blocked rows: [done, queued, queued] (r1 major)', async () => {
    // cancelledRun is a PREDICATE, not a run-start snapshot: the signal lands
    // DURING wave 1 (while a runs), so at wave 3 the old snapshot (still
    // false) fell back to the plain rule and marked c BLOCKED on b's missing
    // entry — the cancel fabricating a failure. The predicate sees the trip
    // at c's own decision point; b and c stay queued (re-runnable on resume).
    const calls: string[] = [];
    const governor = createGovernor({});
    const external = new AbortController();
    let aEntered = false;
    const okAfterAbort = async (): Promise<OpResult<unknown>> => {
      aEntered = true;
      // The op observes the composed cancel and completes with a REAL ok
      // verdict — a keeps its outcome; only the undispatched tail is
      // cancelled.
      await new Promise<void>((resolve) => {
        currentJobContext()?.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return okOp({ jobId: 'a' });
    };
    const plan: Plan = {
      id: 'plan-signal-mid-chain',
      jobs: [
        { id: 'a', op: 'hang', input: { jobId: 'a' } },
        { id: 'b', op: 'fake', input: { jobId: 'b' }, dependsOn: ['a'] },
        { id: 'c', op: 'fake', input: { jobId: 'c' }, dependsOn: ['b'] },
      ],
    };
    const runPromise = runPlan(
      plan,
      { concurrency: 1, stopOnError: false },
      viewWith(entry('hang', okAfterAbort), entry('fake', countingOp(calls))),
      { governor, signal: external.signal, allowAdvisory: true },
    );
    await waitFor(() => aEntered, 'a to enter');
    external.abort(); // mid-run: b and c are still undispatched
    const report = await runPromise;
    expect(calls).toEqual([]); // b and c never ran
    expect(rowStatuses(report)).toEqual(['ok', 'indeterminate', 'indeterminate']);
    expect(report.jobs[1]?.result).toEqual({
      status: 'indeterminate',
      detail: 'queued: run stopped before dispatch',
    });
    expect(report.counts).toEqual({
      queued: 2,
      running: 0,
      blocked: 0, // the point: no fabricated blocked rows
      done: 1,
      failed: 0,
      'budget-exhausted': 0,
    });
    expect(report.stoppedEarly).toBe(true);
    expect(report.earlyStopReason).toBe('signal');
  });

  test('a slot-wait cancel over a chain: the cancelled-while-queued dep stays UNRESOLVED — its dependent is queued, never blocked (composition H1)', async () => {
    // The cycle-2 slot-wait shape extended to a chain: j2 parks on the single
    // in-flight slot, the trip lands, and j2's row is written `indeterminate`
    // (a cancel, not a verdict). stateFromResult maps indeterminate → failed,
    // so the old sweep read j3's dependency as DEFINITIVELY failed and
    // fabricated a blocked row; under a cancel that indeterminate is
    // unresolved — j3 stays queued, re-runnable on resume.
    const calls: string[] = [];
    const governor = createGovernor({ inFlightCeiling: 1 });
    const external = new AbortController();
    let j1Entered = false;
    const hangUntilAbort = async (): Promise<OpResult<unknown>> => {
      j1Entered = true;
      await new Promise<void>((resolve) => {
        currentJobContext()?.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return { status: 'indeterminate', detail: 'cancelled by run signal' };
    };
    const plan: Plan = {
      id: 'plan-signal-slot-chain',
      jobs: [
        { id: 'j1', op: 'hang', input: { jobId: 'j1' } },
        { id: 'j2', op: 'fake', input: { jobId: 'j2' } },
        { id: 'j3', op: 'fake', input: { jobId: 'j3' }, dependsOn: ['j2'] },
      ],
    };
    const runPromise = runPlan(
      plan,
      { concurrency: 2, stopOnError: false },
      viewWith(entry('hang', hangUntilAbort), entry('fake', countingOp(calls))),
      { governor, signal: external.signal, allowAdvisory: true },
    );
    await waitFor(() => j1Entered, 'j1 to enter');
    external.abort(); // j2 is admitted, waiting on the single in-flight slot
    const report = await runPromise;
    expect(calls).toEqual([]); // j2 and j3 never ran the op
    expect(report.jobs[1]?.result).toMatchObject({ status: 'indeterminate' }); // j2 cancelled-while-queued
    expect(report.jobs[2]?.result).toEqual({
      status: 'indeterminate',
      detail: 'queued: run stopped before dispatch',
    }); // j3 NOT blocked
    expect(report.counts.blocked).toBe(0);
    expect(report.counts.queued).toBe(1);
    expect(report.stoppedEarly).toBe(true);
    expect(report.earlyStopReason).toBe('signal');
    const shortCircuits = governor.events.filter((event) => event.kind === 'short-circuited');
    expect(shortCircuits.map((event) => event.reason)).toContain('cancelled-while-queued');
  });

  test('a trip BEFORE a queued dispatch is ADMITTED: the row stays queued for the stop sweep, never budget-exhausted (cycle 3)', async () => {
    // The admission-gate window: with concurrency 1, j2's dispatch starts
    // only after j1 finishes — by then the cancel has tripped the governor,
    // and admit() answers reason 'budget' for every tripped kind. The cancel
    // is not a budget event: the gate must return without classifying, so
    // the row stays re-runnable on resume, never a budget refusal.
    const calls: string[] = [];
    const governor = createGovernor({ maxUsd: 1 });
    const external = new AbortController();
    let j1Entered = false;
    const hangUntilAbort = async (): Promise<OpResult<unknown>> => {
      j1Entered = true;
      await new Promise<void>((resolve) => {
        currentJobContext()?.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return { status: 'indeterminate', detail: 'cancelled by run signal' };
    };
    const plan: Plan = {
      id: 'plan-signal-admission',
      jobs: [
        { id: 'j1', op: 'hang', input: { jobId: 'j1' } },
        { id: 'j2', op: 'fake', input: { jobId: 'j2' } },
      ],
    };
    const runPromise = runPlan(
      plan,
      { concurrency: 1, stopOnError: false },
      viewWith(entry('hang', hangUntilAbort), entry('fake', countingOp(calls))),
      { governor, signal: external.signal, allowAdvisory: true },
    );
    await waitFor(() => j1Entered, 'j1 to enter');
    external.abort(); // j2 is submitted but not yet dispatched (concurrency 1)
    const report = await runPromise;
    expect(calls).toEqual([]); // j2 never ran
    expect(report.jobs[1]?.result).toMatchObject({ status: 'indeterminate' });
    expect(report.jobs[1]?.result.status).not.toBe('budget-exhausted');
    expect(report.stoppedEarly).toBe(true);
    expect(report.earlyStopReason).toBe('signal');
    // The gate left NO j2 evidence: no admission, no short-circuit record,
    // no journalled refusal — the stop sweep owns the queued classification.
    expect(
      governor.events.some((event) => event.kind === 'short-circuited' && event.jobKey === 'j2'),
    ).toBe(false);
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
      { governor, allowAdvisory: true },
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

  test('a governed run over a NOT-YET-EXISTING journal dir creates it (the seq claim mkdirs)', async () => {
    // The v1 append path created the journal dir lazily on first write; the
    // v2 seq claim (exclusive create) runs BEFORE any append, so it must
    // carry the same lazy-create contract — a first governed run with a
    // fresh `--journal-dir` is the CLI's ordinary case.
    const freshDir = join(dir, 'fresh-sub');
    const report = await runPlan(
      independentPlan('plan-gov-fresh-dir', 1, 'ok'),
      { concurrency: 1, stopOnError: false, journalDir: freshDir },
      viewWith(entry('ok', okOp)),
      { governor: createGovernor({ maxUsd: 5 }), allowAdvisory: true },
    );
    const events = await openRunLog(freshDir).read(report.runId);
    expect(events[0]).toMatchObject({ type: 'run-started', journalVersion: 2, seq: 1 });
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
      { governor: createGovernor({ maxUsd: 5 }), allowAdvisory: true },
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
      { governor: createGovernor({ maxUsd: 5 }), allowAdvisory: true },
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
      { governor: governor1, allowAdvisory: true },
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
      { governor: markerGovernor, optIn: ['budget.ungovernedOverGoverned'], allowAdvisory: true },
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

  test('caps + budget.ungovernedOverGoverned refuse — the marker cannot carry unenforceable caps (cycle 2)', async () => {
    // The ungoverned marker dispatches with NO admission, so caps riding it
    // would be silently dead config — fail closed naming both resolutions.
    const calls: string[] = [];
    for (const cap of [{ maxUsd: 1 }, { maxTokens: 100 }] as const) {
      await expect(
        runPlan(
          independentPlan('plan-ungov-caps', 1),
          { concurrency: 1, stopOnError: false, ...cap },
          viewWith(entry('fake', countingOp(calls))),
          {
            governor: createGovernor(cap),
            optIn: ['budget.ungovernedOverGoverned'],
          },
        ),
      ).rejects.toThrow(/marks the run ungoverned.*drop the caps or drop the opt-in/);
    }
    expect(calls).toEqual([]); // never dispatched
  });

  test("an uncapped governed run does not clobber the ledger cap — the raise refusal still sees run 1's cap (cycle 4)", async () => {
    // The ledger's C only moves UP with budget.raiseCap. A capless governed
    // run (an opt-in-only handle) journals governance WITHOUT capUsd; if the
    // fold let that undefined clobber prevCapUsd, the next capped run could
    // raise freely — the refusal must still see run 1's cap.
    const view = viewWith(entry('fake', okOp));
    const plan = independentPlan('plan-cap-carry', 1);
    // r1: governed, capped at 1.
    await runPlan(plan, { concurrency: 1, stopOnError: false, journalDir: dir, maxUsd: 1 }, view, {
      governor: createGovernor({ maxUsd: 1 }),
    });
    // r2: governed, NO cap — the opt-in-free handle is a legal governed shape.
    await runPlan(plan, { concurrency: 1, stopOnError: false, journalDir: dir }, view, {
      governor: createGovernor({}),
    });
    // r3: a raise over r1's 1 refuses without the opt-in...
    await expect(
      runPlan(plan, { concurrency: 1, stopOnError: false, journalDir: dir, maxUsd: 5 }, view, {
        governor: createGovernor({ maxUsd: 5 }),
      }),
    ).rejects.toThrow(/cap raised from 1 to 5/);
    // ...and proceeds WITH it, recording the raise against r1's cap.
    const report = await runPlan(
      plan,
      { concurrency: 1, stopOnError: false, journalDir: dir, maxUsd: 5 },
      view,
      { governor: createGovernor({ maxUsd: 5 }), optIn: ['budget.raiseCap'], allowAdvisory: true },
    );
    const started = (await openRunLog(dir).read(report.runId))[0];
    expect(started).toMatchObject({ governance: { raiseCap: { from: 1, to: 5 } } });
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
        { governor: createGovernor({}), allowAdvisory: true },
      ),
    ).rejects.toThrow(
      'runPlan: governed resume over v1 journals with unaccounted dispatches (1 jobs in plan-gov-v1--legacy--aa); v1 journals carry no spend. Pass --opt-in budget.legacyJournal=reset.',
    );
    await expect(
      runPlan(
        plan,
        { concurrency: 1, stopOnError: false, journalDir: dir },
        viewWith(entry('fake', countingOp(calls))),
        { governor: createGovernor({}), allowAdvisory: true },
      ),
    ).rejects.toThrow(/unaccounted dispatches/);
    expect(calls).toEqual([]);

    // With the opt-in the reset is HONOURED (it was needed) and recorded.
    const report1 = await runPlan(
      plan,
      { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
      viewWith(entry('fake', countingOp(calls))),
      { governor: createGovernor({}), optIn: ['budget.legacyJournal=reset'], allowAdvisory: true },
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
      { governor: createGovernor({}), allowAdvisory: true },
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
        { governor: createGovernor({}), allowAdvisory: true },
      ),
    ).rejects.toThrow(/unaccounted dispatches \(1 jobs in plan-gov-v1--legacy2--bb\)/);
  });

  test('an honoured reset excludes a v1 finish\u2019s usage from the ledger seed — reset means charged 0 (annex §4)', async () => {
    // A versionless journal whose job-finished carries usage (the frozen v1
    // schema permits the field; v1 writers never emitted it). The reset
    // charges those dispatches 0, so the usage must not seed the ledger:
    // neither the DD-9 unpriced fold nor the token/USD seed caps may see it.
    const plan: Plan = {
      id: 'plan-gov-v1spend',
      jobs: [{ id: 'j1', op: 'fake', input: { jobId: 'j1' } }],
    };
    const log = openRunLog(dir);
    const v1RunId = 'plan-gov-v1spend--legacy--cc';
    await log.append(v1RunId, {
      type: 'run-started',
      runId: v1RunId,
      at: '2026-01-03T00:00:00.000Z',
      planId: 'plan-gov-v1spend',
    });
    await log.append(v1RunId, {
      type: 'job-started',
      runId: v1RunId,
      at: '2026-01-03T00:00:00.000Z',
      jobId: 'j1',
      op: 'fake',
      attempt: 1,
    });
    await log.append(v1RunId, {
      type: 'job-finished',
      runId: v1RunId,
      at: '2026-01-03T00:01:00.000Z',
      jobId: 'j1',
      opId: 'fake',
      inputsHash: 'h1',
      result: { status: 'failed', error: 'seeded legacy failure' },
      usage: { input: 100, output: 100, cacheRead: 0, cacheWrite: 0 },
    });

    // A TIGHT maxTokens (the seeded usage alone would exceed it) proves the
    // exclusion: the run admits and completes instead of tripping at seed.
    const governor = createGovernor({ maxUsd: 1, maxTokens: 150 });
    const calls: string[] = [];
    const report = await runPlan(
      plan,
      { concurrency: 1, stopOnError: false, journalDir: dir },
      viewWith(entry('fake', countingOp(calls))),
      { governor, optIn: ['budget.legacyJournal=reset'], allowAdvisory: true },
    );
    expect(report.counts.done).toBe(1);
    expect(governor.tripped).toBe(false);
    expect(governor.usage).toBeUndefined(); // the v1 usage never entered the ledger
    expect(governor.usdSpent).toBe(0);
    // The reset is recorded for stickiness.
    const events = await log.read(report.runId);
    expect(events[0]).toMatchObject({
      type: 'run-started',
      journalVersion: 2,
      governance: {
        capUsd: 1,
        capTokens: 150,
        attended: false,
        legacyJournal: { mode: 'reset', v1RunIds: ['plan-gov-v1spend--legacy--cc'] },
      },
    });
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
      { governor: createGovernor({ maxUsd: 5 }), allowAdvisory: true },
    );
    const runsBefore = await openRunLog(dir).runs();

    // Raising 5 → 10 without the opt-in refuses BEFORE anything is written.
    const calls: string[] = [];
    await expect(
      runPlan(
        plan,
        { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
        viewWith(entry('fake', countingOp(calls))),
        { governor: createGovernor({ maxUsd: 10 }), allowAdvisory: true },
      ),
    ).rejects.toThrow('runPlan: cap raised from 5 to 10');
    expect(calls).toEqual([]);
    expect(await openRunLog(dir).runs()).toEqual(runsBefore); // no seq claim, no run file

    // With budget.raiseCap the run proceeds and records the transition.
    const report = await runPlan(
      plan,
      { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
      viewWith(entry('fake', countingOp(calls))),
      { governor: createGovernor({ maxUsd: 10 }), optIn: ['budget.raiseCap'], allowAdvisory: true },
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
      { governor: createGovernor({ maxUsd: 5 }), allowAdvisory: true },
    );
    // Run 2 (resume): the seed carries the 3; j1's fresh 2.5 pushes the
    // rollup to 5.5 — the cap trips mid-run, and queued j2 is re-marked.
    behave = 'spend2.5-ok';
    const report2 = await runPlan(
      plan,
      { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
      viewWith(entry('ledger', ledgerOp)),
      { governor: createGovernor({ maxUsd: 5 }), allowAdvisory: true },
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
      { governor: createGovernor({}), allowAdvisory: true },
    );
    expect(calls).toEqual(['j1']);
    const events = await log.read(report.runId);
    expect(events[0]).toMatchObject({ type: 'run-started', journalVersion: 2, seq: 3 });
    expect(jobStarts(events).map((event) => event.attempt)).toEqual([3]);
    expect(report.counts.done).toBe(1);
  });

  test('budget.ungovernedOverGoverned with NO governed history refuses — the marker names a condition the plan does not have (composition H3)', async () => {
    // Fresh dir: no prior runs. Honouring the marker here would dispatch the
    // ops ungoverned and strand this run's spend outside every future ledger
    // — a silent forfeit. The refusal names the condition and the resolution.
    const calls: string[] = [];
    await expect(
      runPlan(
        independentPlan('plan-gov-mark-nohistory', 1),
        { concurrency: 1, stopOnError: false, journalDir: dir },
        viewWith(entry('fake', countingOp(calls))),
        {
          governor: createGovernor({}),
          optIn: ['budget.ungovernedOverGoverned'],
          allowAdvisory: true,
        },
      ),
    ).rejects.toThrow(
      'runPlan: budget.ungovernedOverGoverned marks the run ungoverned, but plan plan-gov-mark-nohistory has no governed history',
    );
    expect(calls).toEqual([]); // never dispatched
    expect(await readdir(dir)).toEqual([]); // nothing claimed or emitted — before any state
  });

  test('replay-skip re-attestation copies the prior finish\u2019s costUSD, not just usage (composition M2)', async () => {
    const USAGE = { input: 6, output: 3, cacheRead: 0, cacheWrite: 0 };
    const calls: string[] = [];
    const spendy = async (raw: unknown): Promise<OpResult<unknown>> => {
      calls.push((raw as { jobId: string }).jobId);
      currentJobContext()?.reportResult({ usage: USAGE, costUSD: 0.25 });
      return { status: 'ok', value: 'done' };
    };
    const plan = independentPlan('plan-gov-reattest-cost', 1, 'spendy');
    await runPlan(
      plan,
      { concurrency: 1, stopOnError: false, journalDir: dir },
      viewWith(entry('spendy', spendy)),
      { governor: createGovernor({ maxUsd: 5 }), allowAdvisory: true },
    );
    // Resume: the job replay-skips (zero invocation); the re-attested
    // finish-only event must carry usage AND costUSD (annex §3 rule 1) so
    // this run's journal self-containedly prices the fold.
    const report2 = await runPlan(
      plan,
      { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
      viewWith(entry('spendy', spendy)),
      { governor: createGovernor({ maxUsd: 5 }), allowAdvisory: true },
    );
    expect(calls).toEqual(['j1']); // run 1 only — the resume skipped
    const events2 = await openRunLog(dir).read(report2.runId);
    expect(jobFinishes(events2)).toMatchObject([
      { jobId: 'j1', result: { status: 'ok' }, usage: USAGE, costUSD: 0.25 },
    ]);
  });

  test('a claim tombstone beyond the highest folded seq refuses the fold — a deleted run file cannot silently lower the seed (composition H2)', async () => {
    const plan: Plan = {
      id: 'plan-gov-seqgap',
      jobs: [{ id: 'j1', op: 'fake', input: { jobId: 'j1' } }],
    };
    const log = openRunLog(dir);
    const run1 = 'plan-gov-seqgap--r1--aa';
    await log.append(run1, {
      type: 'run-started',
      runId: run1,
      at: '2026-01-01T00:00:00.000Z',
      planId: 'plan-gov-seqgap',
      journalVersion: 2,
      seq: 1,
      governance: { attended: false },
    });
    // The seq-2 claim tombstone EXISTS but its run file does not: a deleted
    // run (or an orphaned claim). The fold sees maxPriorSeq 1 and must refuse
    // — governed AND plain — instead of silently forgetting the missing
    // run's spend.
    await appendFile(join(dir, 'plan-gov-seqgap.seq.2'), '', 'utf8');
    const calls: string[] = [];
    await expect(
      runPlan(
        plan,
        { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
        viewWith(entry('fake', countingOp(calls))),
        { governor: createGovernor({}), allowAdvisory: true },
      ),
    ).rejects.toThrow(/journal: corrupt — seq gap for plan 'plan-gov-seqgap'/);
    await expect(
      runPlan(
        plan,
        { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
        viewWith(entry('fake', countingOp(calls))),
      ),
    ).rejects.toThrow(/seq gap/);
    expect(calls).toEqual([]);
  });

  test('ANNEX §5 golden: a verbatim v1 journal replays with a zero-invocation skip and a v1-shaped run-started', async () => {
    // The golden replay rule (annex §5), against a file written RAW exactly
    // as a v1 binary wrote it — versionless run-started, attempt-1
    // job-started, the frozen replay record, run-finished. The ungoverned
    // resume must skip the job (ok + same op + same inputsHash) with zero op
    // invocation and write its OWN run-started still v1-shaped.
    const plan: Plan = {
      id: 'plan-gov-golden-v1',
      jobs: [{ id: 'j1', op: 'fake', input: { jobId: 'j1' } }],
    };
    const hash = makeManifest(plan).jobs[0]?.inputsHash ?? '';
    const v1RunId = 'plan-gov-golden-v1--20260101--abcd1234';
    const v1Lines = [
      JSON.stringify({
        type: 'run-started',
        runId: v1RunId,
        at: '2026-01-01T00:00:00.000Z',
        planId: 'plan-gov-golden-v1',
      }),
      JSON.stringify({
        type: 'job-started',
        runId: v1RunId,
        at: '2026-01-01T00:00:00.000Z',
        jobId: 'j1',
        op: 'fake',
        attempt: 1,
      }),
      JSON.stringify({
        type: 'job-finished',
        runId: v1RunId,
        at: '2026-01-01T00:00:01.000Z',
        jobId: 'j1',
        opId: 'fake',
        inputsHash: hash,
        result: { status: 'ok', value: 'j1' },
      }),
      JSON.stringify({
        type: 'run-finished',
        runId: v1RunId,
        at: '2026-01-01T00:00:02.000Z',
        stoppedEarly: false,
      }),
    ];
    await appendFile(join(dir, `${v1RunId}.ndjson`), `${v1Lines.join('\n')}\n`, 'utf8');

    const calls: string[] = [];
    const report = await runPlan(
      plan,
      { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
      viewWith(entry('fake', countingOp(calls))),
    );
    expect(calls).toEqual([]); // the v1 ok finish skips — zero invocation
    expect(report.counts.done).toBe(1);
    const log = openRunLog(dir);
    const runs = await log.runs();
    expect(runs).toHaveLength(2);
    const events = await log.read(report.runId);
    const started = events[0] as { type: string; journalVersion?: unknown; seq?: unknown };
    expect(started.type).toBe('run-started');
    expect('journalVersion' in started).toBe(false); // the new run is v1-shaped too
    expect('seq' in started).toBe(false);
    // The self-contained re-attestation: this run's journal carries the
    // finish-only event for j1.
    expect(jobFinishes(events)).toMatchObject([
      { jobId: 'j1', opId: 'fake', result: { status: 'ok' } },
    ]);
  });

  test('ANNEX §4 row 1: an ungoverned run over v1-only history works unchanged (skip + re-run, no refusal)', async () => {
    // v1 history: j1 finished ok (skips), j2 started and never finished (the
    // crash — re-runs). The plain path neither refuses nor changes shape.
    const plan: Plan = {
      id: 'plan-gov-v1row1',
      jobs: [
        { id: 'j1', op: 'fake', input: { jobId: 'j1' } },
        { id: 'j2', op: 'fake', input: { jobId: 'j2' } },
      ],
    };
    const manifest = makeManifest(plan);
    const v1RunId = 'plan-gov-v1row1--20260101--beefcafe';
    const log = openRunLog(dir);
    await log.append(v1RunId, {
      type: 'run-started',
      runId: v1RunId,
      at: '2026-01-01T00:00:00.000Z',
      planId: 'plan-gov-v1row1',
    });
    await log.append(v1RunId, {
      type: 'job-started',
      runId: v1RunId,
      at: '2026-01-01T00:00:00.000Z',
      jobId: 'j1',
      op: 'fake',
      attempt: 1,
    });
    await log.append(v1RunId, {
      type: 'job-finished',
      runId: v1RunId,
      at: '2026-01-01T00:00:01.000Z',
      jobId: 'j1',
      opId: 'fake',
      inputsHash: manifest.jobs[0]?.inputsHash ?? '',
      result: { status: 'ok', value: 'j1' },
    });
    await log.append(v1RunId, {
      type: 'job-started',
      runId: v1RunId,
      at: '2026-01-01T00:00:01.000Z',
      jobId: 'j2',
      op: 'fake',
      attempt: 1,
    });

    const calls: string[] = [];
    const report = await runPlan(
      plan,
      { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
      viewWith(entry('fake', countingOp(calls))),
    );
    expect(calls).toEqual(['j2']); // j1 skipped (verified ok); j2 re-runs
    expect(report.counts.done).toBe(2);
    const events = await log.read(report.runId);
    expect(jobStarts(events).map((event) => event.jobId)).toEqual(['j2']); // j1 was never re-dispatched
  });
});

// ---------------------------------------------------------------------------
// W2.3 — reserve-then-settle (the plan's §6 W2.3 row + adversarial rows
// A12b/A12c). The write-ahead reservation journal, the unresolved-reservation
// quarantine, the ADVISORY gate, abort-on-trip, and the cap inheritance.
// ---------------------------------------------------------------------------

describe('W2.3 reserve-then-settle', () => {
  let w3dir: string;
  beforeEach(async () => {
    w3dir = await mkdtemp(join(tmpdir(), 'w23-reserve-'));
  });
  afterEach(async () => {
    await rm(w3dir, { recursive: true, force: true });
  });

  const spendOnce =
    (calls: string[], usd: number) =>
    async (raw: unknown): Promise<OpResult<unknown>> => {
      const jobId = (raw as { jobId: string }).jobId;
      calls.push(jobId);
      currentJobContext()?.reportResult({
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
        costUSD: usd,
      });
      return okOp(raw);
    };

  test('journal order pins write-ahead: reservation-opened (durable) before the dispatch, settled before the finish', async () => {
    const calls: string[] = [];
    const report = await runPlan(
      independentPlan('w23-order', 1),
      { concurrency: 1, stopOnError: false, journalDir: w3dir },
      viewWith(entry('fake', spendOnce(calls, 0.1))),
      { governor: createGovernor({ maxUsd: 1 }), allowAdvisory: true },
    );
    expect(report.counts.done).toBe(1);
    const events = await openRunLog(w3dir).read(report.runId);
    const types = events.map((event) => event.type);
    expect(types).toEqual([
      'run-started',
      'job-started',
      'reservation-opened',
      'reservation-settled',
      'job-finished',
      'run-finished',
    ]);
    const opened = events.find(
      (event): event is Extract<JournalEvent, { type: 'reservation-opened' }> =>
        event.type === 'reservation-opened',
    );
    expect(opened).toMatchObject({
      jobId: 'j1',
      attempt: 1,
      reservationId: `${report.runId}:j1:1:1`,
      usd: 1, // the fair share C/concurrency = 1/1
      class: 'advisory',
    });
    const settled = events.find(
      (event): event is Extract<JournalEvent, { type: 'reservation-settled' }> =>
        event.type === 'reservation-settled',
    );
    expect(settled).toMatchObject({ charged: 0.1, basis: 'observed', priced: true });
    const finished = events.find((event): event is FinishedEvent => event.type === 'job-finished');
    expect(finished).toMatchObject({ charged: 0.1, costUSD: 0.1 });
  });

  test('capacity waits FIFO behind outstanding reservations, then admits (settled + outstanding + proposed ≤ cap)', async () => {
    const calls: string[] = [];
    // cap 1.0, concurrency 4 → share 0.25 each; three jobs reserve 0.75,
    // the fourth parks until a settle frees capacity.
    const report = await runPlan(
      independentPlan('w23-fifo', 4),
      { concurrency: 4, stopOnError: false, journalDir: w3dir },
      viewWith(entry('fake', spendOnce(calls, 0.1))),
      { governor: createGovernor({ maxUsd: 1 }), allowAdvisory: true },
    );
    expect(calls).toEqual(['j1', 'j2', 'j3', 'j4']); // every job eventually ran
    expect(report.counts.done).toBe(4);
    expect(report.costUSD).toBeCloseTo(0.4); // the seeded-less ledger: Σ charged
    const governor = (report as unknown as { __gov?: never })['__gov'];
    void governor;
  });

  test('A12c: an unattended governed run refuses every ADVISORY dispatch without the escape', async () => {
    const calls: string[] = [];
    const governor = createGovernor({ maxUsd: 5 });
    const report = await runPlan(
      independentPlan('w23-a12c', 2),
      { concurrency: 1, stopOnError: false, journalDir: w3dir },
      viewWith(entry('fake', countingOp(calls))),
      { governor }, // no attended, no allowAdvisory — the v1.1 default
    );
    expect(calls).toEqual([]); // nothing dispatched
    expect(rowStatuses(report)).toEqual(['budget-exhausted', 'budget-exhausted']);
    const events = await openRunLog(w3dir).read(report.runId);
    expect(events.filter((event) => event.type === 'reservation-refused')).toHaveLength(2);
    expect(events.filter((event) => event.type === 'job-started')).toHaveLength(0);
    const started = events[0] as Extract<JournalEvent, { type: 'run-started' }>;
    expect(started.governance).toMatchObject({ attended: false, capUsd: 5 });
    expect(started.governance?.allowAdvisory).toBeUndefined();
    // The refusal rows are terminal budget evidence; nothing was gated into
    // a stop claim (I9, both directions like the admission refusals).
    expect(report.stoppedEarly).toBe(false);
    const shorts = governor.events.filter(
      (event): event is ShortCircuitEvent => event.kind === 'short-circuited',
    );
    expect(shorts.map((event) => event.reason)).toEqual(['advisory-lane', 'advisory-lane']);
  });

  test('A12c: allowAdvisory and attended are the two named escapes, and the journal records WHO set the escape (r1 M4)', async () => {
    for (const escape of [
      { allowAdvisory: true, allowAdvisoryProvenance: 'product' as const },
      { allowAdvisory: true, allowAdvisoryProvenance: 'operator' as const },
      { attended: true },
    ] as const) {
      const w3dirEscape = await mkdtemp(join(tmpdir(), 'w23-escape-'));
      try {
        const calls: string[] = [];
        const report = await runPlan(
          independentPlan('w23-escape', 1),
          { concurrency: 1, stopOnError: false, journalDir: w3dirEscape },
          viewWith(entry('fake', countingOp(calls))),
          { governor: createGovernor({}), ...escape },
        );
        expect(calls).toEqual(['j1']);
        expect(report.counts.done).toBe(1);
        const events = await openRunLog(w3dirEscape).read(report.runId);
        const started = events[0] as Extract<JournalEvent, { type: 'run-started' }>;
        if ('allowAdvisory' in escape) {
          expect(started.governance?.allowAdvisory).toBe(true);
          // The provenance rides the escape (ADR §2.3: allowAdvisory
          // admissions sit OUTSIDE C_max — the breach must be attributable).
          expect(started.governance?.allowAdvisoryProvenance).toBe(escape.allowAdvisoryProvenance);
        } else {
          expect(started.governance?.attended).toBe(true);
          expect(started.governance?.allowAdvisory).toBeUndefined();
        }
      } finally {
        await rm(w3dirEscape, { recursive: true, force: true });
      }
    }
  });

  test('A12c: dependents of advisory-refused jobs re-mark budget-exhausted transitively, not fabricated failed', async () => {
    const calls: string[] = [];
    const governor = createGovernor({ maxUsd: 5 });
    const plan: Plan = {
      id: 'w23-a12c-chain',
      jobs: [
        { id: 'j1', op: 'fake', input: { jobId: 'j1' } },
        { id: 'j2', op: 'fake', input: { jobId: 'j2' }, dependsOn: ['j1'] },
      ],
    };
    const report = await runPlan(
      plan,
      { concurrency: 1, stopOnError: false, journalDir: w3dir },
      viewWith(entry('fake', countingOp(calls))),
      { governor }, // unattended, no escape — both dispatches refuse
    );
    expect(calls).toEqual([]);
    // j1: the refusal row IS its terminal budget verdict. j2: blocked by j1,
    // and the CAUSE is the advisory refusal → re-marked budget-exhausted
    // (ADR §2.9), never a fabricated `failed` row.
    expect(rowStatuses(report)).toEqual(['budget-exhausted', 'budget-exhausted']);
    expect(report.counts['budget-exhausted']).toBe(2);
    expect(report.counts.blocked).toBe(0);
    // The stop gated j2's undispatched work — the honest-stop claim holds.
    expect(report.stoppedEarly).toBe(true);
    expect(report.earlyStopReason).toBe('budget');
  });

  test('comp 1: stopOnError halts on an advisory refusal WITHOUT re-marking the sibling or claiming a budget stop', async () => {
    const calls: string[] = [];
    const governor = createGovernor({ maxUsd: 5 });
    // Unattended, no escape: j1's dispatch is refused by the A12c gate. The
    // operator's stopOnError halts the run there — but a classification
    // refusal is a per-row terminal verdict, NOT a governor trip, so the
    // honest-stop pass must NOT re-mark j2 budget-exhausted (it stays
    // queued, re-runnable) and the run must NOT claim `earlyStopReason:
    // 'budget'` the journal has no budget-tripped fact for (the run spent
    // $0 and no bound fired).
    const report = await runPlan(
      independentPlan('w23-comp1', 2),
      { concurrency: 1, stopOnError: true, journalDir: w3dir },
      viewWith(entry('fake', countingOp(calls))),
      { governor }, // no attended, no allowAdvisory
    );
    expect(calls).toEqual([]); // nothing dispatched
    // j1: the refusal row is its terminal budget verdict. j2: queued.
    expect(rowStatuses(report)).toEqual(['budget-exhausted', 'indeterminate']);
    expect(report.jobs.find((row) => row.jobId === 'j2')?.result).toMatchObject({
      status: 'indeterminate',
    });
    // No budget stop claimed, no budget-tripped event journalled: the
    // report and the journal agree (I9).
    expect(report.stoppedEarly).toBe(false);
    expect(report.earlyStopReason).toBeUndefined();
    const events = await openRunLog(w3dir).read(report.runId);
    expect(events.some((event) => event.type === 'budget-tripped')).toBe(false);
    expect(events.filter((event) => event.type === 'reservation-refused')).toHaveLength(1);
    const finished = events.find(
      (event): event is Extract<JournalEvent, { type: 'run-finished' }> =>
        event.type === 'run-finished',
    );
    expect(finished).toMatchObject({ stoppedEarly: false });
    // The writer half of the line-count check (comp 2): the total matches,
    // run-finished included.
    expect(finished?.eventCount).toBe(events.length);
  });

  test('A12b: an unresolved reservation charges IN FULL and QUARANTINES the job (never re-run)', async () => {
    // Run 1 "crashes" mid-dispatch: run-started v2 (capped), job-started,
    // reservation-opened — no settle, no finish. The resumed run must charge
    // the full reservation and refuse to re-run the job.
    const log = openRunLog(w3dir);
    const plan: Plan = {
      id: 'w23-a12b',
      jobs: [
        { id: 'j1', op: 'fake', input: { jobId: 'j1' } },
        { id: 'j2', op: 'fake', input: { jobId: 'j2' }, dependsOn: ['j1'] },
      ],
    };
    const crashRunId = 'w23-a12b--r1--aa';
    await log.append(crashRunId, {
      type: 'run-started',
      runId: crashRunId,
      at: '2026-01-01T00:00:00.000Z',
      planId: 'w23-a12b',
      journalVersion: 2,
      seq: 1,
      governance: { capUsd: 5, attended: false },
    });
    await log.append(crashRunId, {
      type: 'job-started',
      runId: crashRunId,
      at: '2026-01-01T00:00:01.000Z',
      jobId: 'j1',
      op: 'fake',
      attempt: 1,
    });
    await log.append(crashRunId, {
      type: 'reservation-opened',
      runId: crashRunId,
      at: '2026-01-01T00:00:01.500Z',
      jobId: 'j1',
      op: 'fake',
      attempt: 1,
      reservationId: `${crashRunId}:j1:1:1`,
      usd: 0.75,
      class: 'advisory',
    });

    const calls: string[] = [];
    const governor = createGovernor({ maxUsd: 5 });
    const report = await runPlan(
      plan,
      { concurrency: 1, stopOnError: false, journalDir: w3dir, resume: true },
      viewWith(entry('fake', countingOp(calls))),
      { governor, allowAdvisory: true },
    );
    // The seed charged the crash window IN FULL before anything ran.
    expect(governor.usdSpent).toBe(0.75);
    // j1: quarantined — needs-human, never dispatched.
    const j1 = report.jobs.find((row) => row.jobId === 'j1');
    expect(j1?.result.status).toBe('needs-human');
    if (j1?.result.status !== 'needs-human') throw new Error('expected needs-human');
    expect(j1.result.reason).toContain('quarantined');
    expect(calls).not.toContain('j1');
    // j2: blocked by its quarantined dependency.
    expect(report.jobs.find((row) => row.jobId === 'j2')?.result.status).toBe('failed');
    // Journal evidence: the quarantine stands, no dispatch happened for j1.
    const events = await openRunLog(w3dir).read(report.runId);
    const quarantined = events.find(
      (event): event is Extract<JournalEvent, { type: 'job-quarantined' }> =>
        event.type === 'job-quarantined',
    );
    expect(quarantined).toMatchObject({
      jobId: 'j1',
      reservationId: `${crashRunId}:j1:1:1`,
      chargedUsd: 0.75,
      reason: 'unresolved-reservation',
    });
    expect(events.some((event) => event.type === 'job-started' && event.jobId === 'j1')).toBe(
      false,
    );
  });

  test('A12b: the quarantine re-attests each run; releaseQuarantine re-runs the job but never refunds', async () => {
    const log = openRunLog(w3dir);
    const plan: Plan = {
      id: 'w23-release',
      jobs: [{ id: 'j1', op: 'fake', input: { jobId: 'j1' } }],
    };
    const hash = makeManifest(plan).jobs[0]?.inputsHash ?? '';
    const crashRunId = 'w23-release--r1--aa';
    await log.append(crashRunId, {
      type: 'run-started',
      runId: crashRunId,
      at: '2026-01-01T00:00:00.000Z',
      planId: 'w23-release',
      journalVersion: 2,
      seq: 1,
      governance: { capUsd: 5, attended: false },
    });
    await log.append(crashRunId, {
      type: 'job-started',
      runId: crashRunId,
      at: '2026-01-01T00:00:01.000Z',
      jobId: 'j1',
      op: 'fake',
      attempt: 1,
    });
    await log.append(crashRunId, {
      type: 'reservation-opened',
      runId: crashRunId,
      at: '2026-01-01T00:00:01.500Z',
      jobId: 'j1',
      op: 'fake',
      attempt: 1,
      reservationId: `${crashRunId}:j1:1:1`,
      usd: 2,
      class: 'advisory',
    });

    // Run 2 (no release): re-attested — still quarantined, still charged 2.
    const calls2: string[] = [];
    const report2 = await runPlan(
      plan,
      { concurrency: 1, stopOnError: false, journalDir: w3dir, resume: true },
      viewWith(entry('fake', countingOp(calls2))),
      { governor: createGovernor({ maxUsd: 5 }), allowAdvisory: true },
    );
    expect(report2.jobs[0]?.result.status).toBe('needs-human');
    expect(calls2).toEqual([]);
    const events2 = await openRunLog(w3dir).read(report2.runId);
    expect(events2.some((event) => event.type === 'job-quarantined')).toBe(true);

    // Run 3 (released): the job dispatches, the release is journalled with
    // provenance 'call', and the FULL charge stays in the ledger (the new
    // dispatch's own spend ADDS to it).
    const calls3: string[] = [];
    const governor3 = createGovernor({ maxUsd: 5 });
    const report3 = await runPlan(
      plan,
      { concurrency: 1, stopOnError: false, journalDir: w3dir, resume: true },
      viewWith(entry('fake', spendOnce(calls3, 0.5))),
      { governor: governor3, allowAdvisory: true, releaseQuarantine: ['j1'] },
    );
    expect(calls3).toEqual(['j1']);
    expect(report3.jobs[0]?.result.status).toBe('ok');
    const events3 = await openRunLog(w3dir).read(report3.runId);
    expect(events3.some((event) => event.type === 'quarantine-released')).toBe(true);
    // Ledger: 2 (the never-refunded crash charge) + 0.5 (the new dispatch).
    expect(governor3.usdSpent).toBeCloseTo(2.5);
    void hash;

    // Run 4 (NO release passed): the journalled release from run 3 LIFTS the
    // standing quarantine — j1 runs (or replays) normally, needs-human never
    // returns. The run-1 charge stays in the ledger forever.
    const calls4: string[] = [];
    const governor4 = createGovernor({ maxUsd: 5 });
    const report4 = await runPlan(
      plan,
      { concurrency: 1, stopOnError: false, journalDir: w3dir, resume: true },
      viewWith(entry('fake', countingOp(calls4))),
      { governor: governor4, allowAdvisory: true },
    );
    expect(report4.jobs[0]?.result.status).toBe('ok'); // replayed from run 3's verified ok
    expect(calls4).toEqual([]); // zero invocation — the replay skip, not a refusal
    expect(governor4.usdSpent).toBeCloseTo(2.5); // the crash charge + run 3's spend, still held
  });

  test('A12b: a full-charge crash window over the cap trips the resumed run at seed — before any dispatch', async () => {
    const log = openRunLog(w3dir);
    const plan: Plan = {
      id: 'w23-crashcap',
      jobs: [{ id: 'j1', op: 'fake', input: { jobId: 'j1' } }],
    };
    const crashRunId = 'w23-crashcap--r1--aa';
    await log.append(crashRunId, {
      type: 'run-started',
      runId: crashRunId,
      at: '2026-01-01T00:00:00.000Z',
      planId: 'w23-crashcap',
      journalVersion: 2,
      seq: 1,
      governance: { capUsd: 1, attended: false },
    });
    await log.append(crashRunId, {
      type: 'job-started',
      runId: crashRunId,
      at: '2026-01-01T00:00:01.000Z',
      jobId: 'j1',
      op: 'fake',
      attempt: 1,
    });
    await log.append(crashRunId, {
      type: 'reservation-opened',
      runId: crashRunId,
      at: '2026-01-01T00:00:01.500Z',
      jobId: 'j1',
      op: 'fake',
      attempt: 1,
      reservationId: `${crashRunId}:j1:1:1`,
      usd: 1.5,
      class: 'advisory',
    });

    const calls: string[] = [];
    const governor = createGovernor({ maxUsd: 1 });
    const report = await runPlan(
      plan,
      { concurrency: 1, stopOnError: false, journalDir: w3dir, resume: true },
      viewWith(entry('fake', countingOp(calls))),
      { governor, allowAdvisory: true },
    );
    expect(calls).toEqual([]); // the seeded overrun trips BEFORE any dispatch
    expect(governor.tripped).toBe(true);
    expect(governor.tripKind).toBe('exhausted');
    // The row is QUARANTINED (needs-human), not re-marked: the quarantine
    // pass runs before the waves and the honest-stop walk never touches
    // quarantined rows — a quarantine verdict outranks the budget re-mark,
    // and both facts (the job-quarantined event and the trip) are on the
    // journal for the operator.
    expect(rowStatuses(report)).toEqual(['needs-human']);
    expect(report.stoppedEarly).toBe(false);
  });

  test('abort-on-trip: a budget trip aborts the IN-FLIGHT dispatch; its reservation settles and the slot is held until then', async () => {
    const calls: string[] = [];
    let observedAbort = false;
    const slowOp = async (raw: unknown): Promise<OpResult<unknown>> => {
      const jobId = (raw as { jobId: string }).jobId;
      calls.push(jobId);
      const ctx = currentJobContext();
      await new Promise<void>((resolve) => {
        ctx?.signal.addEventListener('abort', () => {
          observedAbort = true;
          resolve();
        });
      });
      // Post-abort evidence: the dispatch was mid-flight when the trip landed.
      ctx?.reportResult({
        usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0 },
        costUSD: 0.2,
      });
      return { status: 'ok', value: jobId };
    };
    const governor = createGovernor({ maxUsd: 1 });
    const plan: Plan = {
      id: 'w23-abort',
      jobs: [
        { id: 'j1', op: 'slow', input: { jobId: 'j1' } },
        { id: 'j2', op: 'spendy', input: { jobId: 'j2' } },
      ],
    };
    const report = await runPlan(
      plan,
      { concurrency: 2, stopOnError: false, journalDir: w3dir },
      viewWith(entry('slow', slowOp), entry('spendy', spendOnce(calls, 1.5))),
      { governor, allowAdvisory: true },
    );
    // j2's observed spend (1.5) crossed the cap → exhausted; j1 was aborted
    // in-flight and kept its real post-abort verdict.
    expect(observedAbort).toBe(true);
    expect(governor.tripped).toBe(true);
    expect(governor.tripKind).toBe('exhausted');
    // Every row kept its real post-abort verdict and nothing was gated (both
    // jobs ran; there was nothing left undispatched), so no early-stop claim
    // is honest here (I9, both directions).
    expect(report.stoppedEarly).toBe(false);
    // Both dispatches settled: the journal carries exactly two
    // reservation-settled events, and the run-level ledger moved by their
    // charges (j2 1.5 via fold + breach-safe settle; j1 0.2 observed).
    const events = await openRunLog(w3dir).read(report.runId);
    const settles = events.filter(
      (event): event is Extract<JournalEvent, { type: 'reservation-settled' }> =>
        event.type === 'reservation-settled',
    );
    expect(settles).toHaveLength(2);
    const j2 = settles.find((event) => event.jobId === 'j2');
    expect(j2).toMatchObject({ charged: 1.5, basis: 'observed' }); // the fold was the evidence
    const j1 = settles.find((event) => event.jobId === 'j1');
    expect(j1).toMatchObject({ charged: 0.2, basis: 'observed' });
    // The trip EVIDENCE event lands before run-finished.
    expect(events[events.length - 1]?.type).toBe('run-finished');
    expect(events[events.length - 2]).toMatchObject({
      type: 'budget-tripped',
      tripKind: 'exhausted',
    });
  });

  test('dispatch-closed guard: late evidence from a killed op is dropped (usdSpent equals the journal charged)', async () => {
    // A local virtual clock (the governor suite owns the shared one): the
    // kill rungs must fire deterministically for the detached-promise test.
    let nowMs = 1_000_000;
    const timers: Array<{ at: number; fn: () => void }> = [];
    const clock = {
      now: () => nowMs,
      setTimeout(fn: () => void, ms: number) {
        const timer = { at: nowMs + ms, fn };
        timers.push(timer);
        return timer;
      },
      clearTimeout(handle: unknown) {
        const index = timers.indexOf(handle as { at: number; fn: () => void });
        if (index >= 0) timers.splice(index, 1);
      },
      advance(ms: number) {
        const target = nowMs + ms;
        for (;;) {
          const due = timers.filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at)[0];
          if (due === undefined) break;
          nowMs = due.at;
          timers.splice(timers.indexOf(due), 1);
          due.fn();
        }
        nowMs = target;
      },
    };
    const pump = async (promise: Promise<unknown>): Promise<void> => {
      let settled = false;
      void promise.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      for (let i = 0; i < 1000 && !settled; i++) {
        clock.advance(10);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      if (!settled) throw new Error('pump: run did not settle');
    };
    const calls: string[] = [];
    let held: ReturnType<typeof currentJobContext>;
    let runReport: RunReport | undefined;
    const hangThenReport = async (raw: unknown): Promise<OpResult<unknown>> => {
      const jobId = (raw as { jobId: string }).jobId;
      calls.push(jobId);
      held = currentJobContext();
      await new Promise<never>(() => {}); // hangs — killed at the final rung
      return okOp(raw); // unreachable
    };
    const governor = createGovernor(
      { maxUsd: 5, perJobWallClockMs: 100, abortGraceMs: 10, killGraceMs: 20 },
      clock,
    );
    const plan: Plan = { id: 'w23-late', jobs: [{ id: 'j1', op: 'hang', input: { jobId: 'j1' } }] };
    await pump(
      runPlan(
        plan,
        { concurrency: 1, stopOnError: false, journalDir: w3dir },
        viewWith(entry('hang', hangThenReport)),
        { governor, allowAdvisory: true },
      ).then((report) => {
        runReport = report;
      }),
    );
    // The kill settled the dispatch: basis 'full', charged = the whole
    // reservation (the fair share C/concurrency = 5/1).
    const report = runReport as RunReport;
    expect(report.jobs[0]?.result.status).toBe('budget-exhausted');
    const events = await openRunLog(w3dir).read(report.runId);
    const settles = events.filter(
      (event): event is Extract<JournalEvent, { type: 'reservation-settled' }> =>
        event.type === 'reservation-settled',
    );
    expect(settles).toHaveLength(1);
    const journalCharged = settles[0]?.charged ?? 0;
    expect(journalCharged).toBeGreaterThan(0);
    expect(governor.usdSpent).toBeCloseTo(journalCharged);
    // LATE evidence from the detached promise: DROPPED — the ledger does not
    // move past the journal, and no usage event lands.
    const eventsBefore = governor.events.length;
    held?.reportResult({
      usage: { input: 99, output: 99, cacheRead: 0, cacheWrite: 0 },
      costUSD: 9,
    });
    expect(governor.usdSpent).toBeCloseTo(journalCharged);
    expect(governor.events.length).toBe(eventsBefore);
  });

  test('a capless governed run over capped history inherits C_prev conservatively and journals the inheritance', async () => {
    // Run 1: capped at 5, spends 3.
    const calls1: string[] = [];
    await runPlan(
      independentPlan('w23-inherit', 1),
      { concurrency: 1, stopOnError: false, journalDir: w3dir },
      viewWith(entry('fake', spendOnce(calls1, 3))),
      { governor: createGovernor({ maxUsd: 5 }), allowAdvisory: true },
    );
    // Run 2: governed but UNCAPPED — inherits C_prev 5 and journals it.
    const calls2: string[] = [];
    const governor2 = createGovernor({});
    const report2 = await runPlan(
      independentPlan('w23-inherit', 1),
      { concurrency: 1, stopOnError: false, journalDir: w3dir },
      viewWith(entry('fake', spendOnce(calls2, 1))),
      { governor: governor2, allowAdvisory: true },
    );
    const events2 = await openRunLog(w3dir).read(report2.runId);
    const started2 = events2[0] as Extract<JournalEvent, { type: 'run-started' }>;
    expect(started2.governance?.inheritedCapUsd).toBe(5);
    expect(started2.governance?.capUsd).toBeUndefined();
    // The inherited cap BOUND the reservations: 5 − 3 seeded = 2 capacity.
    const opens = events2.filter(
      (event): event is Extract<JournalEvent, { type: 'reservation-opened' }> =>
        event.type === 'reservation-opened',
    );
    expect(opens[0]).toMatchObject({ usd: 2, proposedUsd: 5 }); // share C/concurrency = 5/1, shrunk to capacity 2
    expect(governor2.usdSpent).toBeCloseTo(4); // 3 seeded + 1 this run
    // Run 3: a cap RAISE over C_prev still refuses — the inheritance did not move C.
    const calls3: string[] = [];
    await expect(
      runPlan(
        independentPlan('w23-inherit', 1),
        { concurrency: 1, stopOnError: false, journalDir: w3dir },
        viewWith(entry('fake', countingOp(calls3))),
        { governor: createGovernor({ maxUsd: 6 }), allowAdvisory: true },
      ),
    ).rejects.toThrow('runPlan: cap raised from 5 to 6');
  });
});
