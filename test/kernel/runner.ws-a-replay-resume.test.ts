// THE ws-a replay-resume goal check: a 10-job chain crashed on job 5 and
// resumed from the journal. Moved verbatim from the pre-split
// test/kernel/runner.test.ts (split by subject for the 256 KiB review cap).
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { openRunLog } from '../../src/kernel/journal.js';
import { runPlan } from '../../src/kernel/runner.js';
import {
  chainPlan,
  entry,
  jobFinishes,
  jobInputSchema,
  makeFake,
  viewWith,
} from './runner.helpers.js';
describe('runPlan — ws-a replay resume (the goal check)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cq-runner-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('10-chain crashed on job 5 resumes with exactly 6 new invocations and ends 10/10 done', async () => {
    const { state, op } = makeFake();
    const registry = viewWith(entry('fake', jobInputSchema, op));
    const plan = chainPlan('plan-wsa', 10);
    state.crashOn.add('j5');

    // --- Run 1: crash on job 5, stopOnError ---
    const report1 = await runPlan(
      plan,
      { concurrency: 1, stopOnError: true, journalDir: dir },
      registry,
    );
    expect(state.calls).toEqual(['j1', 'j2', 'j3', 'j4', 'j5']); // 6-10 never started
    expect(report1.counts).toEqual({
      queued: 0,
      running: 0,
      blocked: 5, // j6..j10: transitively downstream of the failed j5
      done: 4,
      failed: 1,
      'budget-exhausted': 0,
    });
    // Journal run 1: 4 ok + 1 failed terminal records.
    const log = openRunLog(dir);
    const events1 = await log.read(report1.runId);
    const finishes1 = jobFinishes(events1);
    expect(finishes1).toHaveLength(5);
    expect(finishes1.filter((event) => event.result.status === 'ok')).toHaveLength(4);
    expect(finishes1.filter((event) => event.result.status === 'failed')).toHaveLength(1);
    expect(events1[0]).toMatchObject({ type: 'run-started', planId: 'plan-wsa' });
    expect(events1[events1.length - 1]).toMatchObject({
      type: 'run-finished',
      stoppedEarly: false,
    });

    // --- Run 2: resume with the fake fixed ---
    state.calls = [];
    state.crashOn.clear();
    const report2 = await runPlan(
      plan,
      { concurrency: 1, stopOnError: true, journalDir: dir, resume: true },
      registry,
    );
    // jobs 1-4 skip via terminal records with ZERO new invocations; job 5
    // (was failed) re-runs; 6-10 run. Exactly 6 — and the <= 6 bound.
    expect(state.calls).toEqual(['j5', 'j6', 'j7', 'j8', 'j9', 'j10']);
    expect(state.calls.length).toBe(6);
    expect(state.calls.length).toBeLessThanOrEqual(6);
    expect(report2.counts.done).toBe(10);
    expect(report2.counts.failed).toBe(0);
    expect(report2.jobs).toHaveLength(10);
    expect(report2.jobs.map((row) => row.jobId)).toEqual(
      Array.from({ length: 10 }, (_, i) => `j${i + 1}`),
    );
    expect(report2.jobs.every((row) => row.result.status === 'ok')).toBe(true);
    // No job reported usage → the optional rollups are omitted entirely.
    expect('usage' in report2).toBe(false);
    expect('costUSD' in report2).toBe(false);

    // Run 2's journal is self-contained: 6 dispatches, 10 terminal records
    // (jobs 1-4 re-attested from run 1's evidence after hash verification).
    const events2 = await log.read(report2.runId);
    expect(events2.filter((event) => event.type === 'job-started')).toHaveLength(6);
    expect(jobFinishes(events2)).toHaveLength(10);

    // --- Run 3: a chained resume skips everything (latest-run rule holds) ---
    state.calls = [];
    const report3 = await runPlan(
      plan,
      { concurrency: 1, stopOnError: true, journalDir: dir, resume: true },
      registry,
    );
    expect(state.calls).toEqual([]);
    expect(report3.counts.done).toBe(10);
  });
});
