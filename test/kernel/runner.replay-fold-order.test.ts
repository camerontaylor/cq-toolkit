// runPlan replay evidence fold: last-finish-wins across runs, by-`at`
// ordering over mtime, case-insensitive runId tails and the sibling-plan
// prefix guard. Split from the pre-split test/kernel/runner.test.ts; the
// describe wrapper (and its tmp-dir hooks) is reproduced so every test's
// full title path stays byte-identical.
import { appendFile, mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { runPlan } from '../../src/kernel/runner.js';
import { openRunLog } from '../../src/kernel/journal.js';
import { makeManifest } from '../../src/kernel/manifest.js';

import type { Plan } from '../../src/kernel/types.js';
import {
  chainPlan,
  entry,
  independentPlan,
  jobInputSchema,
  makeFake,
  viewWith,
} from './runner.helpers.js';
describe('runPlan — report shape and replay details', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cq-runner-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('last finish wins across runs: a failed re-attempt in a later run re-runs despite an older ok', async () => {
    const { state, op } = makeFake();
    const registry = viewWith(entry('fake', jobInputSchema, op));
    const plan = independentPlan('plan-lastwin', 3);
    const report1 = await runPlan(
      plan,
      { concurrency: 3, stopOnError: false, journalDir: dir },
      registry,
    );
    expect(report1.counts.done).toBe(3);

    // A later run re-attempted i2 and it FAILED there; i1/i3 were untouched.
    const log = openRunLog(dir);
    const laterRunId = `${plan.id}--reattempt--beefdead`;
    const manifest = makeManifest(plan);
    const i2Hash = manifest.jobs.find((job) => job.id === 'i2')?.inputsHash ?? '';
    await log.append(laterRunId, {
      type: 'run-started',
      runId: laterRunId,
      at: new Date(Date.now() + 1000).toISOString(), // strictly after run 1 started
      planId: plan.id,
    });
    await log.append(laterRunId, {
      type: 'job-finished',
      runId: laterRunId,
      at: '2026-01-01T00:00:01.000Z',
      jobId: 'i2',
      opId: 'fake',
      inputsHash: i2Hash,
      result: { status: 'failed', error: 're-attempt blew up' },
    });
    await log.append(laterRunId, {
      type: 'run-finished',
      runId: laterRunId,
      at: '2026-01-01T00:00:02.000Z',
      stoppedEarly: false,
    });
    const at = (ms: number): Date => new Date(ms);
    await utimes(join(dir, `${report1.runId}.ndjson`), at(1000), at(1000));
    await utimes(join(dir, `${laterRunId}.ndjson`), at(2000), at(2000));

    // Resume: the later FAILED finish overrides run 1's ok for i2 (it
    // re-runs); i1/i3 keep their older oks and skip. All end done.
    state.calls = [];
    const report2 = await runPlan(
      plan,
      { concurrency: 3, stopOnError: false, journalDir: dir, resume: true },
      registry,
    );
    expect(state.calls).toEqual(['i2']);
    expect(report2.counts.done).toBe(3);
    expect(report2.counts.failed).toBe(0);
  });

  test('the fold is ordered by run-started `at`, not mtime (concurrent-run safety)', async () => {
    // Two hand-built runs of one plan with DELIBERATELY contradictory
    // orderings: mtime says r2 (failed j1) is newest, but r1 (ok j1) started
    // LATER by its own `at`. The fold must follow `at` — r1's ok wins, so
    // the resume skips j1; mtime order would have re-run it.
    const { state, op } = makeFake();
    const registry = viewWith(entry('fake', jobInputSchema, op));
    const plan: Plan = {
      id: 'plan-atorder',
      jobs: [{ id: 'j1', op: 'fake', input: { jobId: 'j1' } }],
    };
    const hash = makeManifest(plan).jobs[0]?.inputsHash ?? '';
    const log = openRunLog(dir);
    const run1 = `${plan.id}--r1--aaaa`; // started LATER (at 2026-01-02), finished ok
    const run2 = `${plan.id}--r2--bbbb`; // started EARLIER (at 2026-01-01), failed j1
    await log.append(run1, {
      type: 'run-started',
      runId: run1,
      at: '2026-01-02T00:00:00.000Z',
      planId: plan.id,
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
    await log.append(run2, {
      type: 'run-started',
      runId: run2,
      at: '2026-01-01T00:00:00.000Z',
      planId: plan.id,
    });
    await log.append(run2, {
      type: 'job-finished',
      runId: run2,
      at: '2026-01-01T00:00:01.000Z',
      jobId: 'j1',
      opId: 'fake',
      inputsHash: hash,
      result: { status: 'failed', error: 'older attempt blew up' },
    });
    // mtime: run2 NEWEST (2000) — the trap mtime-based folding would fall into.
    const at = (ms: number): Date => new Date(ms);
    await utimes(join(dir, `${run1}.ndjson`), at(1000), at(1000));
    await utimes(join(dir, `${run2}.ndjson`), at(2000), at(2000));

    state.calls = [];
    const report = await runPlan(
      plan,
      { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
      registry,
    );
    expect(state.calls).toEqual([]); // the by-`at` winner (ok) is honored
    expect(report.counts.done).toBe(1);
  });

  test('case-insensitive runId tails still count as this-plan evidence', async () => {
    // An operator-copied journal with an uppercase hex tail ('A3F2') is
    // well-formed evidence for the plan: the candidate filter is
    // case-insensitive, so it is parsed, its planId matched, and its
    // terminal-ok finish honored (zero re-invocations on resume).
    const { state, op } = makeFake();
    const registry = viewWith(entry('fake', jobInputSchema, op));
    const plan: Plan = {
      id: 'plan-tail',
      jobs: [{ id: 'j1', op: 'fake', input: { jobId: 'j1' } }],
    };
    const hash = makeManifest(plan).jobs[0]?.inputsHash ?? '';
    const log = openRunLog(dir);
    const copiedRunId = 'plan-tail--r7--A3F2';
    await log.append(copiedRunId, {
      type: 'run-started',
      runId: copiedRunId,
      at: '2026-01-01T00:00:00.000Z',
      planId: plan.id,
    });
    await log.append(copiedRunId, {
      type: 'job-finished',
      runId: copiedRunId,
      at: '2026-01-01T00:00:01.000Z',
      jobId: 'j1',
      opId: 'fake',
      inputsHash: hash,
      result: { status: 'ok', value: 'j1' },
    });

    state.calls = [];
    const report = await runPlan(
      plan,
      { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
      registry,
    );
    expect(state.calls).toEqual([]);
    expect(report.counts.done).toBe(1);
  });

  test("a sibling plan whose id extends this one ('a' vs 'a--b') cannot block the resume", async () => {
    const { state, op } = makeFake();
    const registry = viewWith(entry('fake', jobInputSchema, op));
    const planA = chainPlan('a', 2);
    const reportA1 = await runPlan(
      planA,
      { concurrency: 1, stopOnError: false, journalDir: dir },
      registry,
    );

    // Hand-write plan 'a--b''s journal: valid first/last lines around a
    // corrupt MIDDLE line. A prefix-only candidate filter would parse this
    // file when resuming plan 'a' and die on the corruption.
    const bogusId = 'a--b--k3y--c0ffee';
    await appendFile(
      join(dir, `${bogusId}.ndjson`),
      `${JSON.stringify({
        type: 'run-started',
        runId: bogusId,
        at: '2026-01-01T00:00:00.000Z',
        planId: 'a--b',
      })}\n{"type":"job-started","runI\n${JSON.stringify({
        type: 'run-finished',
        runId: bogusId,
        at: '2026-01-01T00:00:02.000Z',
        stoppedEarly: false,
      })}\n`,
      'utf8',
    );
    // Plan a's file is oldest so candidate iteration is deterministic.
    const at = (ms: number): Date => new Date(ms);
    await utimes(join(dir, `${reportA1.runId}.ndjson`), at(1000), at(1000));
    await utimes(join(dir, `${bogusId}.ndjson`), at(2000), at(2000));

    // Resume plan 'a': the 'a--b' file fails the two-segment tail check
    // ('b--k3y--c0ffee' is not `<base36>--<hex>`) and is never parsed —
    // old code rejected with /corrupt line/. Jobs all skip.
    state.calls = [];
    const reportA2 = await runPlan(
      planA,
      { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
      registry,
    );
    expect(state.calls).toEqual([]);
    expect(reportA2.counts.done).toBe(2);

    // Plan 'a--b''s OWN corrupt journal is loud (its runId legitimately
    // passes the pre-filter, so read() throws on the corrupt middle line).
    const planB: Plan = {
      id: 'a--b',
      jobs: [{ id: 'b1', op: 'fake', input: { jobId: 'b1' } }],
    };
    await expect(
      runPlan(
        planB,
        { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
        registry,
      ),
    ).rejects.toThrow(/corrupt line/);
  });
});
