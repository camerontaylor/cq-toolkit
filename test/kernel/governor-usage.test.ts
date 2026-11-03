// Governor tests (split from test/kernel/governor.test.ts — pure move): DD-9 parallel token rollup + api-equivalent USD (T1.6b), the token-side NaN fail-open (review round 2), totalTokensOf reasoning-once.

import { match } from '../helpers/matchers.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { openRunLog } from '../../src/kernel/journal.js';
import { makeManifest } from '../../src/kernel/manifest.js';
import {
  BudgetGovernor,
  createGovernor,
  currentJobContext,
  governorConfig,
} from '../../src/kernel/governor.js';
import { runPlan } from '../../src/kernel/runner.js';
import { entry, independentPlan, okOp, rowStatuses, viewWith } from './governor.helpers.js';
import type { JournalEvent, OpResult, Plan } from '../../src/kernel/types.js';

// ---------------------------------------------------------------------------
// 2b. DD-9 (T1.6b): parallel token rollup + api-equivalent USD
// ---------------------------------------------------------------------------

describe('DD-9 (T1.6b): parallel token rollup + api-equivalent USD', () => {
  /** Real usage, no cost — the subscription-routed lane's evidence shape (costUSD absent). */
  const UNPRICED_USAGE = { input: 80, output: 40, cacheRead: 0, cacheWrite: 0 }; // 120 tokens
  const usageOnlyOp = async (raw: unknown): Promise<OpResult<unknown>> => {
    const ctx = currentJobContext();
    if (ctx !== undefined) {
      ctx.reportResult({ usage: UNPRICED_USAGE });
    }
    return okOp(raw);
  };

  test('maxTokens is an independent cap: trip reason names the token rollup; admission refuses', async () => {
    const governor = new BudgetGovernor({ maxTokens: 100 });
    // Boundary first: a fold AT the cap does not trip (same exceeds semantics as USD).
    governor.observeResult('j1', { usage: { input: 60, output: 40, cacheRead: 0, cacheWrite: 0 } });
    expect(governor.tripped).toBe(false);

    // The over-cap fold trips on the TOKEN rollup — no maxUsd anywhere in this config.
    governor.observeResult('j2', { usage: { input: 60, output: 40, cacheRead: 0, cacheWrite: 0 } });
    expect(governor.tripped).toBe(true);
    expect(governor.tripReason).toMatch(/token rollup 200 exceeded cap 100/);

    // A post-trip admission is refused as 'budget' (I9 — the governed
    // runner's dispatch never runs the op on a rejection).
    expect(governor.admit('j3')).toEqual({ decision: 'reject', reason: 'budget' });

    // Control: a governor whose fold stays UNDER the cap never trips.
    const control = new BudgetGovernor({ maxTokens: 100 });
    control.observeResult('c1', { usage: { input: 25, output: 25, cacheRead: 0, cacheWrite: 0 } });
    expect(control.tripped).toBe(false);
  });

  test('THE d02a107 acceptance check: usage without costUSD still stops the run at maxTokens (the subscription case)', async () => {
    const governor = createGovernor(
      governorConfig({ concurrency: 1, stopOnError: false, maxTokens: 150 }, {}),
    );
    const plan = independentPlan('plan-dd9-tokens', 3, 'usagey');
    const registry = viewWith(entry('usagey', usageOnlyOp));

    const report = await runPlan(plan, { concurrency: 1, stopOnError: false }, registry, {
      governor,
      allowAdvisory: true,
    });

    // The run did NOT continue past the cap: j1 folded 120 tokens (under),
    // j2's fold hit 240 (over) and tripped mid-run — j2 keeps its real
    // result; j3 (same wave, admitted before the trip landed) was killed by
    // the budget-while-queued check at its slot — a REAL budget-exhausted
    // verdict row. I9 honesty: every row is real evidence, nothing was
    // re-marked, so the report carries NO stoppedEarly claim.
    expect(report.stoppedEarly).toBe(false);
    expect(report.earlyStopReason).toBeUndefined();
    expect(report.jobs[0]?.result).toEqual({ status: 'ok', value: 'j1' });
    expect(report.jobs[1]?.result).toEqual({ status: 'ok', value: 'j2' });
    expect(rowStatuses(report)).toEqual(['ok', 'ok', 'budget-exhausted']);
    expect(report.counts).toEqual({
      queued: 0,
      running: 0,
      blocked: 0,
      done: 2,
      failed: 0,
      'budget-exhausted': 1,
    });
    // The evidence trail: usage rolled up, and the budget-tripped event
    // carries the TOKEN reason (the governor's event journal).
    expect(governor.usage).toEqual({ input: 160, output: 80, cacheRead: 0, cacheWrite: 0 });
    expect(governor.usdSpent).toBe(0); // no cost was ever reported
    const trip = governor.events.find((event) => event.kind === 'budget-tripped');
    expect(trip).toBeDefined();
    expect((trip as { reason: string }).reason).toMatch(/token rollup 240 exceeded cap 150/);
  });

  test('maxUsd stays PRIMARY and trips on MODELED cost — the run that previously failed open', async () => {
    const governor = new BudgetGovernor({ maxUsd: 0.5 });
    // A subscription-routed result folded through the price map carries a
    // real usage figure and a MODELED costBasis:'modeled' costUSD — the USD
    // cap must bind through that modeled number.
    governor.observeResult('j1', { usage: UNPRICED_USAGE, costUSD: 0.6 });
    expect(governor.tripped).toBe(true);
    expect(governor.tripReason).toMatch(/usd rollup 0\.6 exceeded cap 0\.5/);
    expect(governor.usdSpent).toBeCloseTo(0.6);
    expect(governor.usage).toEqual(UNPRICED_USAGE);
  });

  test('unpriced usage under a USD cap fails LOUD; without maxUsd the same fold is not a budget event; zero usage folds nothing', async () => {
    // Under a USD cap, real usage with NO costUSD (no price known for the
    // model) trips — a silently unlimited run is the failure DD-9 prevents.
    const loud = new BudgetGovernor({ maxUsd: 1 });
    loud.observeResult('j1', { usage: UNPRICED_USAGE });
    expect(loud.tripped).toBe(true);
    expect(loud.tripReason).toMatch(/unpriced usage under a USD cap/);
    expect(loud.tripReason).toMatch(/unpriced model/);

    // The same fold WITHOUT a USD cap is not a budget event — the usage
    // still rolls up (maxTokens would bind it), but nothing trips.
    const noUsdCap = new BudgetGovernor({});
    noUsdCap.observeResult('j1', { usage: UNPRICED_USAGE });
    expect(noUsdCap.tripped).toBe(false);
    expect(noUsdCap.usage).toEqual(UNPRICED_USAGE);

    // A zero-usage result folds NOTHING under a USD cap — nothing was
    // measured (I9), so there is no unpriced evidence to fail loud about.
    const zero = new BudgetGovernor({ maxUsd: 1 });
    zero.observeResult('j1', { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
    expect(zero.tripped).toBe(false);
    expect(zero.usage).toBeUndefined();
  });

  test('independence cuts both ways: each trip reason names ITS cap, not the other', async () => {
    // Cost overage with tokens safely under: the USD (modeled) cap trips.
    const overCost = new BudgetGovernor({ maxTokens: 10_000, maxUsd: 0.5 });
    overCost.observeResult('j1', {
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
      costUSD: 0.9,
    });
    expect(overCost.tripped).toBe(true);
    expect(overCost.tripReason).toMatch(/usd rollup 0\.9 exceeded cap 0\.5/);
    expect(overCost.tripReason).not.toMatch(/token rollup/);

    // Token overage with USD safely under: the token cap trips.
    const overTokens = new BudgetGovernor({ maxTokens: 10, maxUsd: 50 });
    overTokens.observeResult('j1', {
      usage: { input: 100, output: 5, cacheRead: 0, cacheWrite: 0 },
      costUSD: 0.1,
    });
    expect(overTokens.tripped).toBe(true);
    expect(overTokens.tripReason).toMatch(/token rollup 105 exceeded cap 10/);
    expect(overTokens.tripReason).not.toMatch(/usd rollup/);
  });

  test('the SEED path honors maxTokens: a journaled rollup already over the cap trips before the resumed run admits anything', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cq-gov-dd9-seed-'));
    try {
      const log = openRunLog(dir);
      const plan: Plan = {
        id: 'plan-dd9-seed',
        jobs: [{ id: 'c1', op: 'usagey', input: { jobId: 'c1' } }],
      };
      const manifest = makeManifest(plan);
      // Prior run: c1 reached a terminal budget-exhausted record, usage
      // journaled (the same shape as the seeded-USD test).
      await log.append('plan-dd9-seed--prior--aa', {
        type: 'run-started',
        runId: 'plan-dd9-seed--prior--aa',
        at: '2026-09-16T00:00:00.000Z',
        planId: 'plan-dd9-seed',
      });
      await log.append('plan-dd9-seed--prior--aa', {
        type: 'job-started',
        runId: 'plan-dd9-seed--prior--aa',
        at: '2026-09-16T00:00:00.000Z',
        jobId: 'c1',
        op: 'usagey',
        attempt: 1,
      });
      await log.append('plan-dd9-seed--prior--aa', {
        type: 'job-finished',
        runId: 'plan-dd9-seed--prior--aa',
        at: '2026-09-16T00:00:00.000Z',
        jobId: 'c1',
        opId: 'usagey',
        inputsHash: manifest.jobs[0]?.inputsHash ?? '',
        result: { status: 'budget-exhausted' },
        usage: UNPRICED_USAGE,
      });
      const events = await log.read('plan-dd9-seed--prior--aa');

      // The journaled usage alone overruns the token cap: the SEED trips —
      // before the resumed run admits or dispatches anything, even if no
      // further usage-reporting op ever folds.
      const governor = new BudgetGovernor({ maxTokens: 100 });
      governor.seedFromJournal(events);
      expect(governor.usage).toEqual(UNPRICED_USAGE);
      expect(governor.tripped).toBe(true);
      expect(governor.tripReason).toMatch(/seeded token rollup 120 exceeded cap 100/);
      expect(governor.admit('c1')).toEqual({ decision: 'reject', reason: 'budget' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 2b-bis. RD-B review round 2 — the token-side fail-open closed: a lying
// usage measurement fails loud (live + seed paths) or folds nothing
// (WorkerResult guard), and never poisons the rollup.
// ---------------------------------------------------------------------------

describe('token-side NaN fail-open closed (review round 2)', () => {
  const GOOD = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 };

  test('(a) reportUsage with a NaN/negative field throws BEFORE the rollup; the cap stays enforceable', () => {
    const governor = new BudgetGovernor({ maxTokens: 100 });
    governor.observeUsage('j1', GOOD);
    expect(() =>
      governor.observeUsage('j2', { input: 10, output: Number.NaN, cacheRead: 0, cacheWrite: 0 }),
    ).toThrowError(/usage\.output must be a finite number >= 0, got NaN/);
    expect(() =>
      governor.observeUsage('j2', {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: Infinity,
      }),
    ).toThrowError(/usage\.reasoning must be a finite number >= 0, got Infinity/);
    expect(() =>
      governor.observeUsage('j2', { input: -5, output: 1, cacheRead: 0, cacheWrite: 0 }),
    ).toThrowError(/usage\.input must be a finite number >= 0, got -5/);
    // The poisoned folds never landed.
    expect(governor.usage).toEqual(GOOD);
    // The cap still binds: a real over-cap fold trips.
    governor.observeUsage('j3', { input: 90, output: 20, cacheRead: 0, cacheWrite: 0 });
    expect(governor.tripped).toBe(true);
    expect(governor.tripReason).toMatch(/token rollup 125 exceeded cap 100/);
  });

  test('(b) a returned WorkerResult carrying NaN usage folds NOTHING — and the runner fails the lossy job loud', async () => {
    const governor = createGovernor(
      governorConfig({ concurrency: 1, stopOnError: false, maxTokens: 100 }, {}),
    );
    // The defensive WorkerResult guard rejects the lying measurement BEFORE
    // the completion-time fold: nothing folds, nothing throws post-record.
    // DOWNSTREAM, the runner (RD-C, post-rebase contract) independently
    // rejects the non-serializable (NaN-bearing) result as an honest per-job
    // failure — two fail-loud layers, neither poisons the rollup.
    const lyingOp = async (): Promise<OpResult<unknown>> => ({
      status: 'ok',
      value: {
        usage: { input: Number.NaN, output: 50, cacheRead: 0, cacheWrite: 0 },
        denials: [],
        stopReason: 'complete',
      },
    });
    const plan = independentPlan('plan-lying-worker', 1, 'lying');
    const report = await runPlan(
      plan,
      { concurrency: 1, stopOnError: false },
      viewWith(entry('lying', lyingOp)),
      { governor, allowAdvisory: true },
    );
    expect(report.jobs[0]?.result.status).toBe('failed');
    expect(report.jobs[0]?.result).toMatchObject({
      status: 'failed',
      error: match.stringMatching(/non-serializable result/),
    });
    expect(governor.usage).toBeUndefined(); // folded NOTHING
    expect(governor.tripped).toBe(false);

    // (b2, review 9-2) A lying COST — NaN or negative — must fold NOTHING
    // through the governed dispatch either: the completion-time guard
    // rejects the WHOLE result, so no assertValidUsd throw escapes after
    // the completed event, no usage folds, and no cost is claimed. (The
    // runner's serialization layer separately fails the lossy row — the
    // point here is the fold, which stays silent and empty.)
    for (const badCost of [Number.NaN, -0.5]) {
      const costGovernor = createGovernor(
        governorConfig({ concurrency: 1, stopOnError: false, maxTokens: 100, maxUsd: 5 }, {}),
      );
      const costlyOp = async (): Promise<OpResult<unknown>> => ({
        status: 'ok' as const,
        value: {
          usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
          denials: [] as never[],
          stopReason: 'complete' as const,
          costUSD: badCost,
        },
      });
      await runPlan(
        independentPlan('plan-cost-lying', 1, 'costly'),
        { concurrency: 1, stopOnError: false },
        viewWith(entry('costly', costlyOp)),
        { governor: costGovernor, allowAdvisory: true },
      );
      expect(costGovernor.usage).toBeUndefined(); // the WHOLE lying result folded nothing
      expect(costGovernor.usdSpent).toBe(0); // no cost claimed
      expect(costGovernor.tripped).toBe(false); // zero evidence, not a trip
    }
  });

  test('(c) a seeded journal event with negative usage throws at seed time', () => {
    const governor = new BudgetGovernor({ maxTokens: 100 });
    const events: JournalEvent[] = [
      {
        type: 'run-started',
        runId: 'r1',
        at: '2026-09-16T00:00:00.000Z',
        planId: 'plan-seed-lying',
      },
      {
        type: 'job-started',
        runId: 'r1',
        at: '2026-09-16T00:00:00.000Z',
        jobId: 'c1',
        op: 'fake',
        attempt: 1,
      },
      {
        type: 'job-finished',
        runId: 'r1',
        at: '2026-09-16T00:00:00.000Z',
        jobId: 'c1',
        opId: 'fake',
        inputsHash: 'h1',
        result: { status: 'budget-exhausted' },
        usage: { input: -5, output: 3, cacheRead: 0, cacheWrite: 0 },
      },
    ];
    expect(() => governor.seedFromJournal(events)).toThrowError(
      /seeded usage\.input must be a finite number >= 0, got -5/,
    );
  });

  test('(d) valid folds are untouched: the cap trips exactly as before', () => {
    const governor = new BudgetGovernor({ maxTokens: 100 });
    governor.observeUsage('j1', {
      input: 60,
      output: 40,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
    });
    governor.observeUsage('j2', { input: 60, output: 40, cacheRead: 0, cacheWrite: 0 });
    expect(governor.tripped).toBe(true);
    expect(governor.tripReason).toMatch(/token rollup 200 exceeded cap 100/);
  });
});

describe('totalTokensOf counts ADDITIVE reasoning once (T-usage reasoning conflict)', () => {
  // The old comment here claimed a producer must never report additive
  // reasoning, contradicting the Usage type docs (src/driver/types.ts).
  // Owner decision 2026-11-03: the declared contract is additive-only —
  // reasoning counts once; an output-includes-reasoning lane omits the
  // field, so adding it on top never double-counts.
  test('reasoning IS added on top of output: the token-cap fold', () => {
    const usage = { input: 10, output: 20, cacheRead: 5, cacheWrite: 0, reasoning: 8 };
    // Boundary: the fold is 43 (10+20+5+0+8) — counted exactly once.
    const atCap = new BudgetGovernor({ maxTokens: 43 });
    atCap.observeUsage('j1', usage);
    expect(atCap.tripped).toBe(false); // 43 ≤ 43 — the same exceeds semantics
    const overCap = new BudgetGovernor({ maxTokens: 42 });
    overCap.observeUsage('j1', usage);
    expect(overCap.tripped).toBe(true);
    expect(overCap.tripReason).toMatch(/token rollup 43 exceeded cap 42/);
  });

  test('an omitting lane (no reasoning field) folds the same total — no double count', () => {
    // The lane whose SDK counts thinking INSIDE output omits the field;
    // the same figures land at the same 43-token boundary through the
    // observeResult gate alone (no observeUsage on this instance).
    const under = new BudgetGovernor({ maxTokens: 43 });
    under.observeResult('j2', { usage: { input: 10, output: 28, cacheRead: 5, cacheWrite: 0 } });
    expect(under.tripped).toBe(false); // 43 ≤ 43
    const over = new BudgetGovernor({ maxTokens: 42 });
    over.observeResult('j3', { usage: { input: 10, output: 28, cacheRead: 5, cacheWrite: 0 } });
    expect(over.tripped).toBe(true); // 43 > 42
  });

  test('T-usage reasoning-only: a reasoning-only measurement trips maxTokens through observeResult', () => {
    // Reasoning-only usage: the old fold computed 0 tokens, so the
    // hasRealUsage gate saw NO real usage and the cap could not bind.
    // The reasoning-inclusive fold counts 9 tokens: under a tight cap it
    // trips, proving the reasoning-only measurement is real evidence.
    const under = new BudgetGovernor({ maxTokens: 9 });
    under.observeResult('j1', {
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 9 },
    });
    expect(under.tripped).toBe(false); // 9 ≤ 9
    const over = new BudgetGovernor({ maxTokens: 8 });
    over.observeResult('j1', {
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 9 },
    });
    expect(over.tripped).toBe(true);
    expect(over.tripReason).toMatch(/token rollup 9 exceeded cap 8/);
  });

  test('T-usage reasoning once: two executed jobs — one reasoning-bearing, one omitting — roll up once', async () => {
    // Mixed run: j1 meters {3,4,1,2,reasoning:7} (additive lane), j2
    // meters {10,28,5,0} (omitting lane, thinking inside output). The
    // run rollup keeps reasoning 7 exactly once, and the governor's
    // token total (3+4+1+2+7 + 10+28+5+0 = 60) trips at the boundary.
    const mixedThenPlainOp = async (raw: unknown): Promise<OpResult<unknown>> => {
      const jobId = (raw as { jobId: string }).jobId;
      currentJobContext()?.reportResult({
        usage:
          jobId === 'j1'
            ? { input: 3, output: 4, cacheRead: 1, cacheWrite: 2, reasoning: 7 }
            : { input: 10, output: 28, cacheRead: 5, cacheWrite: 0 },
      });
      return { status: 'ok', value: jobId };
    };
    const plan: Plan = {
      id: 'plan-reasoning-mixed',
      jobs: [
        { id: 'j1', op: 'fake', input: { jobId: 'j1' }, dependsOn: [] },
        { id: 'j2', op: 'fake', input: { jobId: 'j2' }, dependsOn: ['j1'] },
      ],
    };
    const governor = createGovernor(
      governorConfig({ concurrency: 1, stopOnError: false, maxTokens: 60 }, {}),
    );
    const report = await runPlan(
      plan,
      { concurrency: 1, stopOnError: false },
      viewWith(entry('fake', mixedThenPlainOp)),
      { governor, allowAdvisory: true },
    );
    expect(report.jobs.map((row) => row.usage)).toEqual([
      { input: 3, output: 4, cacheRead: 1, cacheWrite: 2, reasoning: 7 },
      { input: 10, output: 28, cacheRead: 5, cacheWrite: 0 },
    ]);
    expect(report.usage).toEqual({
      input: 13,
      output: 32,
      cacheRead: 6,
      cacheWrite: 2,
      reasoning: 7,
    });
    // Governor total 60 ≤ cap 60: no trip — the boundary proves reasoning
    // entered the cap fold exactly once.
    expect(governor.tripped).toBe(false);
    // A tight 59 cap (one under the 60-token total) trips on the fold —
    // the boundary proof that reasoning entered the cap exactly once.
    const tight = createGovernor(
      governorConfig({ concurrency: 1, stopOnError: false, maxTokens: 59 }, {}),
    );
    await runPlan(
      plan,
      { concurrency: 1, stopOnError: false },
      viewWith(entry('fake', mixedThenPlainOp)),
      { governor: tight, allowAdvisory: true },
    );
    expect(tight.tripped).toBe(true);
    expect(tight.tripReason).toMatch(/token rollup 60 exceeded cap 59/);
    expect(tight.usage).toEqual({
      input: 13,
      output: 32,
      cacheRead: 6,
      cacheWrite: 2,
      reasoning: 7,
    });
  });
});
