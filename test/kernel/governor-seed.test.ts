// Governor tests (split from test/kernel/governor.test.ts — pure move): seedFromJournal — USD pricing (#14-5/#15-1), own-run dedupe (review r1), jobId attempt keying (W2.2), multi-run usage dedupe (review F4).

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { openRunLog } from '../../src/kernel/journal.js';
import { makeManifest } from '../../src/kernel/manifest.js';
import { BudgetGovernor } from '../../src/kernel/governor.js';
import type { JournalEvent, Plan } from '../../src/kernel/types.js';

// ---------------------------------------------------------------------------
// 2d. RD-B review debt — seed-time USD pricing (#14-5), cost validation
// (#15-1), and the reasoning-once token fold (#14-6)
// ---------------------------------------------------------------------------

describe('seedFromJournal USD pricing — fail loud at seed time (#14-5/#15-1)', () => {
  const SEED_USAGE = { input: 7, output: 3, cacheRead: 1, cacheWrite: 2 };
  const seededEvents = (finish?: { costUSD?: number }): JournalEvent[] => [
    { type: 'run-started', runId: 'r1', at: '2026-09-16T00:00:00.000Z', planId: 'plan-seed-usd' },
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
      usage: SEED_USAGE,
      ...(finish?.costUSD !== undefined ? { costUSD: finish.costUSD } : {}),
    },
  ];

  test('seeded usage + maxUsd + NO costUSD anywhere in the fold trips LOUD before the resumed run admits anything', () => {
    const governor = new BudgetGovernor({ maxUsd: 1.0 });
    governor.seedFromJournal(seededEvents());
    expect(governor.usage).toEqual(SEED_USAGE);
    expect(governor.tripped).toBe(true); // the seed alone trips — never fail open
    expect(governor.tripReason).toMatch(/prior usage/);
    expect(governor.tripReason).toMatch(/cannot be fully priced/);
    expect(governor.tripReason).toMatch(/USD cap 1 cannot bind/);
    expect(governor.tripReason).toMatch(/DD-9/);
    expect(governor.admit('c1')).toEqual({ decision: 'reject', reason: 'budget' });
  });

  test('a folded job-finished carrying costUSD prices the seed and does NOT trip', () => {
    // v2 governed journals carry costUSD on priced finishes — the seed is
    // priced from the LEDGER, not from a caller-supplied price map.
    const governor = new BudgetGovernor({ maxUsd: 1.0 });
    governor.seedFromJournal(seededEvents({ costUSD: 0.1 }));
    expect(governor.usdSpent).toBe(0.1);
    expect(governor.tripped).toBe(false);
    expect(governor.admit('c1')).toEqual({ decision: 'admit', attempt: 2 });
  });

  test('a MIXED fold — one priced and one unpriced closing finish — trips exhausted (no finish prices another)', () => {
    // The unpriced dispatch's usage cannot enter the USD rollup, so maxUsd
    // would silently bind only the priced subset of the prior spend — DD-9
    // refuses exactly that (review cycle 1, runner-governed seam).
    const events: JournalEvent[] = [
      { type: 'run-started', runId: 'r1', at: '2026-09-16T00:00:00.000Z', planId: 'plan-seed-usd' },
      {
        type: 'job-started',
        runId: 'r1',
        at: '2026-09-16T00:00:00.000Z',
        jobId: 'c1',
        op: 'fake',
        attempt: 1,
      },
      {
        type: 'job-started',
        runId: 'r1',
        at: '2026-09-16T00:00:00.000Z',
        jobId: 'c2',
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
        result: { status: 'ok', value: null },
        usage: SEED_USAGE,
        costUSD: 0.2,
      },
      {
        type: 'job-finished',
        runId: 'r1',
        at: '2026-09-16T00:00:00.000Z',
        jobId: 'c2',
        opId: 'fake',
        inputsHash: 'h2',
        result: { status: 'ok', value: null },
        usage: SEED_USAGE, // real usage, NO costUSD — the unpriced-model shape
      },
    ];
    const governor = new BudgetGovernor({ maxUsd: 1.0 });
    governor.seedFromJournal(events);
    expect(governor.tripped).toBe(true);
    expect(governor.tripKind).toBe('exhausted');
    expect(governor.tripReason).toMatch(/cannot be fully priced/);
    expect(governor.admit('c1')).toEqual({ decision: 'reject', reason: 'budget' });
  });

  test('a seeded costUSD of NaN throws at seed time (construction-time: fail loud and early)', () => {
    const governor = new BudgetGovernor({ maxUsd: 1.0 });
    expect(() => governor.seedFromJournal(seededEvents({ costUSD: Number.NaN }))).toThrowError(
      /seeded costUSD must be a finite number >= 0, got NaN/,
    );
    expect(governor.usdSpent).toBe(0); // the rollup was never poisoned
  });

  test('a seeded negative costUSD throws likewise', () => {
    const governor = new BudgetGovernor({ maxUsd: 1.0 });
    expect(() => governor.seedFromJournal(seededEvents({ costUSD: -1 }))).toThrowError(
      /seeded costUSD must be a finite number >= 0, got -1/,
    );
  });
});

describe('seedFromJournal dedupe closes a finish only against ITS OWN run\u2019s start (review r1)', () => {
  // Run R0 completed c1 (priced, counted). Run A started c1 and died before
  // its finish. Run B re-attested c1 finish-only (the replay re-attestation,
  // restating R0's already-counted spend). A jobId-only openStarts key let
  // B's orphan finish CLOSE A's open start — charging R0's spend a second
  // time and, when the re-attestation carried usage without costUSD,
  // tripping a spurious DD-9 `exhausted` at the next seed.
  const PRICED = { input: 7, output: 3, cacheRead: 1, cacheWrite: 2 };
  const runStart = (runId: string, at: string): JournalEvent => ({
    type: 'run-started',
    runId,
    at,
    planId: 'plan-seed-dedupe',
  });
  const started = (runId: string, at: string, attempt: number): JournalEvent => ({
    type: 'job-started',
    runId,
    at,
    jobId: 'c1',
    op: 'fake',
    attempt,
  });
  const finished = (runId: string, at: string, costUSD?: number): JournalEvent => ({
    type: 'job-finished',
    runId,
    at,
    jobId: 'c1',
    opId: 'fake',
    inputsHash: 'h1',
    result: { status: 'ok', value: 'c1' },
    usage: PRICED,
    ...(costUSD !== undefined ? { costUSD } : {}),
  });
  // Run R0: c1 completed ok, priced and counted. Run A: a start with no
  // finish (the crash). Run B: the finish-only re-attestation (no start of
  // its own), restating R0's already-counted spend.
  const base: JournalEvent[] = [
    runStart('r0', '2026-09-16T00:00:00.000Z'),
    started('r0', '2026-09-16T00:00:00.000Z', 1),
    finished('r0', '2026-09-16T00:00:01.000Z', 0.1),
    runStart('rA', '2026-09-16T00:01:00.000Z'),
    started('rA', '2026-09-16T00:01:00.000Z', 2),
    runStart('rB', '2026-09-16T00:02:00.000Z'),
    finished('rB', '2026-09-16T00:02:01.000Z', 0.1),
  ];

  test('a cross-run close is unreachable: the re-attested spend is charged ONCE (R0\u2019s finish)', () => {
    const governor = new BudgetGovernor({ maxUsd: 1.0 });
    governor.seedFromJournal(base);
    expect(governor.usdSpent).toBe(0.1); // R0's finish only — B's restatement skipped
    expect(governor.usage).toEqual(PRICED);
    expect(governor.tripped).toBe(false);
    // Both prior starts (R0's and A's) still seed the attempt count.
    expect(governor.attemptsFor('c1')).toBe(2);
  });

  test('an UNPRICED re-attestation does not trip a spurious seed exhausted off a dead run\u2019s open start', () => {
    // Same shape, but B's re-attestation restates usage with no costUSD (the
    // v1-era finish shape). It closes nothing, so it prices nothing — the
    // unpriced rule fires only for CLOSING finishes.
    const events: JournalEvent[] = [
      ...base.slice(0, 5), // R0's priced pair + A's unfinishable start
      runStart('rB', '2026-09-16T00:02:00.000Z'),
      finished('rB', '2026-09-16T00:02:01.000Z'), // usage, no costUSD
    ];
    const governor = new BudgetGovernor({ maxUsd: 1.0 });
    governor.seedFromJournal(events);
    expect(governor.usdSpent).toBe(0.1);
    expect(governor.tripped).toBe(false); // no spurious exhausted
  });
});

// ---------------------------------------------------------------------------
// Review round 1 — the seed keys attempts on the journal jobId (F4, W2.2):
// admission on the governed runner path is keyed on the real plan job id,
// so the seed must never fall back to the op name either.
// ---------------------------------------------------------------------------

describe('seedFromJournal keys attempts on the journal jobId — never the op name (W2.2)', () => {
  test('seedFromJournal keys attempts on the journal jobId — never the op name (W2.2)', () => {
    // Two journal jobs sharing op 'solo', one start each: each jobId seeds
    // its OWN prior-start count and the op NAME seeds nothing — admission on
    // the governed runner path is keyed on the real plan job id, so the old
    // op-name sum-seed (whose fallback key was the op name) is gone.
    const events: JournalEvent[] = [
      {
        type: 'run-started',
        runId: 'r1',
        at: '2026-09-16T00:00:00.000Z',
        planId: 'plan-seed-jobid',
      },
      {
        type: 'job-started',
        runId: 'r1',
        at: '2026-09-16T00:00:00.000Z',
        jobId: 'x1',
        op: 'solo',
        attempt: 1,
      },
      {
        type: 'job-started',
        runId: 'r1',
        at: '2026-09-16T00:00:00.000Z',
        jobId: 'x2',
        op: 'solo',
        attempt: 1,
      },
    ];
    // Cap 2: one seeded start each — the next dispatch is attempt 2.
    const governor = new BudgetGovernor({ maxAttemptsPerJob: 2 });
    governor.seedFromJournal(events);
    expect(governor.attemptsFor('x1')).toBe(1); // one prior start each — seeded per jobId
    expect(governor.attemptsFor('x2')).toBe(1);
    expect(governor.attemptsFor('solo')).toBe(0); // the op name is not a seed key
    expect(governor.dispatchCount).toBe(2); // the dispatch quota seeds from all starts
    // Both jobs were genuinely dispatched once: each admits one more attempt.
    expect(governor.admit('x1')).toEqual({ decision: 'admit', attempt: 2 });
    expect(governor.admit('x2')).toEqual({ decision: 'admit', attempt: 2 });
  });
});

describe('seedFromJournal usage dedupe across multi-run journals (review F4)', () => {
  const USAGE = { input: 7, output: 3, cacheRead: 1, cacheWrite: 2 };
  const finishedWithUsage = (runId: string, jobId: string, inputsHash: string): JournalEvent => ({
    type: 'job-finished',
    runId: runId,
    at: '2026-09-16T00:00:00.000Z',
    jobId: jobId,
    opId: 'fake',
    inputsHash: inputsHash,
    result: { status: 'budget-exhausted' },
    usage: USAGE,
    costUSD: 0.4, // the v2 ledger rollup the governed runner writes
  });

  test('a re-attested (orphan) finish does NOT double-count usage or USD', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cq-gov-seed-dedupe-'));
    try {
      const log = openRunLog(dir);
      const plan: Plan = {
        id: 'plan-dedupe',
        jobs: [{ id: 'c1', op: 'fake', input: { jobId: 'c1' } }],
      };
      const manifest = makeManifest(plan);
      const inputsHash = manifest.jobs[0]?.inputsHash ?? '';
      // Run 1: dispatched + finished with usage. Run 2 (chained resume): the
      // SAME dispatch's outcome re-attested — a finish with NO start.
      await log.append('plan-dedupe--r1--aa', {
        type: 'run-started',
        runId: 'plan-dedupe--r1--aa',
        at: '2026-09-16T00:00:00.000Z',
        planId: 'plan-dedupe',
      });
      await log.append('plan-dedupe--r1--aa', {
        type: 'job-started',
        runId: 'plan-dedupe--r1--aa',
        at: '2026-09-16T00:00:00.000Z',
        jobId: 'c1',
        op: 'fake',
        attempt: 1,
      });
      await log.append(
        'plan-dedupe--r1--aa',
        finishedWithUsage('plan-dedupe--r1--aa', 'c1', inputsHash),
      );
      await log.append('plan-dedupe--r2--bb', {
        type: 'run-started',
        runId: 'plan-dedupe--r2--bb',
        at: '2026-09-16T00:00:00.000Z',
        planId: 'plan-dedupe',
      });
      await log.append(
        'plan-dedupe--r2--bb',
        finishedWithUsage('plan-dedupe--r2--bb', 'c1', inputsHash),
      );
      const events: JournalEvent[] = [
        ...(await log.read('plan-dedupe--r1--aa')),
        ...(await log.read('plan-dedupe--r2--bb')),
      ];

      const governor = new BudgetGovernor({ maxUsd: 1.0 });
      governor.seedFromJournal(events);
      expect(governor.usage).toEqual(USAGE); // once — not doubled by the re-attestation
      expect(governor.usdSpent).toBe(0.4); // the orphan's costUSD skipped with its usage
      expect(governor.tripped).toBe(false); // 0.4 ≤ 1.0: no phantom trip
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('two REAL dispatches (each start+finish) still count twice', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cq-gov-seed-dedupe2-'));
    try {
      const log = openRunLog(dir);
      const plan: Plan = {
        id: 'plan-dedupe2',
        jobs: [{ id: 'c1', op: 'fake', input: { jobId: 'c1' } }],
      };
      const manifest = makeManifest(plan);
      const inputsHash = manifest.jobs[0]?.inputsHash ?? '';
      // Two runs, each a genuine dispatch of c1 (start + finish).
      await log.append('plan-dedupe2--r1--aa', {
        type: 'run-started',
        runId: 'plan-dedupe2--r1--aa',
        at: '2026-09-16T00:00:00.000Z',
        planId: 'plan-dedupe2',
      });
      await log.append('plan-dedupe2--r1--aa', {
        type: 'job-started',
        runId: 'plan-dedupe2--r1--aa',
        at: '2026-09-16T00:00:00.000Z',
        jobId: 'c1',
        op: 'fake',
        attempt: 1,
      });
      await log.append(
        'plan-dedupe2--r1--aa',
        finishedWithUsage('plan-dedupe2--r1--aa', 'c1', inputsHash),
      );
      await log.append('plan-dedupe2--r2--bb', {
        type: 'run-started',
        runId: 'plan-dedupe2--r2--bb',
        at: '2026-09-16T00:00:00.000Z',
        planId: 'plan-dedupe2',
      });
      await log.append('plan-dedupe2--r2--bb', {
        type: 'job-started',
        runId: 'plan-dedupe2--r2--bb',
        at: '2026-09-16T00:00:00.000Z',
        jobId: 'c1',
        op: 'fake',
        attempt: 2,
      });
      await log.append(
        'plan-dedupe2--r2--bb',
        finishedWithUsage('plan-dedupe2--r2--bb', 'c1', inputsHash),
      );
      const events: JournalEvent[] = [
        ...(await log.read('plan-dedupe2--r1--aa')),
        ...(await log.read('plan-dedupe2--r2--bb')),
      ];

      const governor = new BudgetGovernor({ maxUsd: 1.0 });
      governor.seedFromJournal(events);
      expect(governor.usage).toEqual({ input: 14, output: 6, cacheRead: 2, cacheWrite: 4 }); // both dispatches counted
      expect(governor.usdSpent).toBe(0.8); // both ledger costUSD rolls counted
      expect(governor.tripped).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
