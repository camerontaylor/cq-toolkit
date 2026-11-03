// runPlan replay resume selection: input-hash re-runs, fresh runs without
// resume, resuming with no prior run, per-plan journal isolation, torn
// tails and the partial-latest-run fold. Split from the pre-split
// test/kernel/runner.test.ts; the describe wrapper (and its tmp-dir hooks)
// is reproduced so every test's full title path stays byte-identical.
import { appendFile, mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { runPlan } from '../../src/kernel/runner.js';
import { openRunLog } from '../../src/kernel/journal.js';

import type { Plan } from '../../src/kernel/types.js';
import {
  chainPlan,
  entry,
  independentPlan,
  jobFinishes,
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

  test('replay re-runs a job whose INPUT changed — hash mismatch beats terminal ok', async () => {
    const { state, op } = makeFake();
    const plan = chainPlan('plan-hash', 3);
    await runPlan(
      plan,
      { concurrency: 1, stopOnError: false, journalDir: dir },
      viewWith(entry('fake', jobInputSchema, op)),
    );

    state.calls = [];
    // j2's input changes (extra key → different hash); j1 and j3 keep theirs.
    const changed: Plan = {
      id: 'plan-hash',
      jobs: [
        { id: 'j1', op: 'fake', input: { jobId: 'j1' } },
        { id: 'j2', op: 'fake', input: { jobId: 'j2', v: 2 }, dependsOn: ['j1'] },
        { id: 'j3', op: 'fake', input: { jobId: 'j3' }, dependsOn: ['j2'] },
      ],
    };
    const report = await runPlan(
      changed,
      { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
      viewWith(entry('fake', jobInputSchema, op)),
    );
    // Per-job rule: only j2 re-runs. j3's own record is terminal-ok with an
    // unchanged hash, so it is attested even though its dependency re-ran.
    expect(state.calls).toEqual(['j2']);
    expect(report.counts.done).toBe(3);
    // The re-run result reflects the fresh dispatch (fake echoes the job id).
    expect(report.jobs[1]?.result).toEqual({ status: 'ok', value: 'j2' });
  });

  test('replay without resume:true starts a fresh run (no skipping)', async () => {
    const { state, op } = makeFake();
    const plan = chainPlan('plan-fresh', 3);
    const report1 = await runPlan(
      plan,
      { concurrency: 1, stopOnError: false, journalDir: dir },
      viewWith(entry('fake', jobInputSchema, op)),
    );

    state.calls = [];
    const report2 = await runPlan(
      plan,
      { concurrency: 1, stopOnError: false, journalDir: dir }, // no resume
      viewWith(entry('fake', jobInputSchema, op)),
    );
    expect(state.calls).toEqual(['j1', 'j2', 'j3']);
    expect(report2.runId).not.toBe(report1.runId);
    const log = openRunLog(dir);
    await expect(log.runs()).resolves.toHaveLength(2);
  });

  test('resume with no prior run for the plan just runs fresh', async () => {
    const { state, op } = makeFake();
    const report = await runPlan(
      chainPlan('plan-noprior', 2),
      { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
      viewWith(entry('fake', jobInputSchema, op)),
    );
    expect(state.calls).toEqual(['j1', 'j2']);
    expect(report.counts.done).toBe(2);
  });

  test('two plans share one journalDir: resuming A skips only A; B stays untouched', async () => {
    const { state, op } = makeFake();
    const registry = viewWith(entry('fake', jobInputSchema, op));
    // Distinct job-id prefixes so a wrong plan match could not silently skip.
    const planA = chainPlan('plan-alpha', 3, 'a');
    const planB = chainPlan('plan-beta', 3, 'b');
    const reportA1 = await runPlan(
      planA,
      { concurrency: 1, stopOnError: false, journalDir: dir },
      registry,
    );
    const reportB1 = await runPlan(
      planB,
      { concurrency: 1, stopOnError: false, journalDir: dir }, // B's run is NEWER
      registry,
    );
    const log = openRunLog(dir);
    const eventsB1 = await log.read(reportB1.runId);
    // Force deterministic mtimes (real resolution can tie); A2's file gets a
    // real (far later) mtime, so it must sort last.
    const at = (ms: number): Date => new Date(ms);
    await utimes(join(dir, `${reportA1.runId}.ndjson`), at(1000), at(1000));
    await utimes(join(dir, `${reportB1.runId}.ndjson`), at(2000), at(2000));
    const runsBefore = await log.runs();
    expect(runsBefore).toEqual([reportA1.runId, reportB1.runId]);

    // Resume A: only A has prior records for jobs a1..a3 — all skip, zero
    // invocations; B's journal file is byte-identical afterwards.
    state.calls = [];
    const reportA2 = await runPlan(
      planA,
      { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
      registry,
    );
    expect(state.calls).toEqual([]);
    expect(reportA2.counts.done).toBe(3);
    await expect(log.runs()).resolves.toEqual([...runsBefore, reportA2.runId]);
    await expect(log.read(reportB1.runId)).resolves.toEqual(eventsB1);
    // A's new run attested all three skips without dispatching.
    const eventsA2 = await log.read(reportA2.runId);
    expect(eventsA2.filter((event) => event.type === 'job-started')).toHaveLength(0);
    expect(jobFinishes(eventsA2)).toHaveLength(3);
    // Sanity: the two fresh runs really were distinct files.
    expect(reportA1.runId).not.toBe(reportB1.runId);
  });

  test('torn tail composes with resume: a crashed run with a torn last line resumes cleanly', async () => {
    const { state, op } = makeFake();
    const registry = viewWith(entry('fake', jobInputSchema, op));
    const plan = chainPlan('plan-torn-resume', 8);
    state.crashOn.add('j5');
    const report1 = await runPlan(
      plan,
      { concurrency: 1, stopOnError: true, journalDir: dir },
      registry,
    );
    // Simulate a crash mid-append on run 1's journal file (torn LAST line).
    await appendFile(join(dir, `${report1.runId}.ndjson`), '{"type":"run-finis', 'utf8');

    state.calls = [];
    state.crashOn.clear();
    const report2 = await runPlan(
      plan,
      { concurrency: 1, stopOnError: true, journalDir: dir, resume: true },
      registry,
    );
    // Torn line ignored; the failed job (j5) plus the unstarted ones (j6-j8)
    // re-ran — exactly 4 invocations; everything ends done.
    expect(state.calls).toEqual(['j5', 'j6', 'j7', 'j8']);
    expect(state.calls.length).toBe(4);
    expect(report2.counts.done).toBe(8);
    expect(report2.counts.failed).toBe(0);
  });

  test("resume keeps older runs' completed jobs when the latest run is partial", async () => {
    const { state, op } = makeFake();
    const registry = viewWith(entry('fake', jobInputSchema, op));
    const plan = independentPlan('plan-partial', 3);
    const report1 = await runPlan(
      plan,
      { concurrency: 3, stopOnError: false, journalDir: dir },
      registry,
    );
    expect(report1.counts.done).toBe(3);

    // Hand-append a PARTIAL run 2 — run-started, a job-started for i1, no
    // finish, no run-finished: a crash mid-run. The hand-built runId follows
    // the `<planId>--<base36>--<hex>` shape so the resume pre-filter passes
    // it, and its run-started `at` is stamped AFTER run 1's real clock so
    // the fold (ordered by `at`, not mtime) treats it as the latest run.
    const log = openRunLog(dir);
    const partialRunId = `${plan.id}--partial--deadbeef`;
    await log.append(partialRunId, {
      type: 'run-started',
      runId: partialRunId,
      at: new Date(Date.now() + 1000).toISOString(), // strictly after run 1 started
      planId: plan.id,
    });
    await log.append(partialRunId, {
      type: 'job-started',
      runId: partialRunId,
      at: '2026-01-01T00:00:01.000Z',
      jobId: 'i1',
      op: 'fake',
      attempt: 1,
    });
    // Force mtime ordering: run 1's file old, the partial run 2 newest — the
    // LATEST run really is the partial one.
    const at = (ms: number): Date => new Date(ms);
    await utimes(join(dir, `${report1.runId}.ndjson`), at(1000), at(1000));
    await utimes(join(dir, `${partialRunId}.ndjson`), at(2000), at(2000));

    // Resume: the partial latest run must not erase run 1's completed jobs —
    // zero re-invocations (old code re-ran all three), all rows reconstructed.
    state.calls = [];
    const report2 = await runPlan(
      plan,
      { concurrency: 3, stopOnError: false, journalDir: dir, resume: true },
      registry,
    );
    expect(state.calls).toEqual([]);
    expect(report2.counts.done).toBe(3);
    expect(report2.jobs.every((row) => row.result.status === 'ok')).toBe(true);
  });
});
