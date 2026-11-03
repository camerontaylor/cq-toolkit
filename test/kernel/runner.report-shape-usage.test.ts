// runPlan report shape (JSON round-trip, the six frozen states), journal
// fold-readiness, usage/reasoning reconstruction and rollup and
// journal-less parity. Split from the pre-split test/kernel/runner.test.ts;
// the describe wrapper (and its tmp-dir hooks) is reproduced so every
// test's full title path stays byte-identical.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { deriveJobStatuses, openRunLog } from '../../src/kernel/journal.js';
import { makeManifest } from '../../src/kernel/manifest.js';
import { createGovernor, currentJobContext, governorConfig } from '../../src/kernel/governor.js';
import { runPlan } from '../../src/kernel/runner.js';
import type { OpResult, Plan, RunReport } from '../../src/kernel/types.js';
import {
  chainPlan,
  entry,
  jobFinishes,
  jobInputSchema,
  makeFake,
  SIX_STATES,
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

  test('report is JSON-serializable, counts carry all six states, honest-stop untouched', async () => {
    const { op } = makeFake();
    const report = await runPlan(
      chainPlan('plan-shape', 3),
      { concurrency: 2, stopOnError: false, journalDir: dir },
      viewWith(entry('fake', jobInputSchema, op)),
    );
    const roundTripped = JSON.parse(JSON.stringify(report)) as RunReport;
    expect(roundTripped).toEqual(report);
    expect(Object.keys(report.counts).sort()).toEqual(SIX_STATES);
    expect(report.stoppedEarly).toBe(false);
    expect('earlyStopReason' in report).toBe(false);
    expect(report.runId).toMatch(/^plan-shape--/);
  });

  test('journaled events are fold-ready: attempt 1, opId+inputsHash match the manifest', async () => {
    const { op } = makeFake();
    const plan = chainPlan('plan-fold', 2);
    const report = await runPlan(
      plan,
      { concurrency: 1, stopOnError: false, journalDir: dir },
      viewWith(entry('fake', jobInputSchema, op)),
    );
    const events = await openRunLog(dir).read(report.runId);
    const manifest = makeManifest(plan);
    const starts = events.filter((event) => event.type === 'job-started');
    expect(starts).toHaveLength(2);
    for (const start of starts) {
      expect(start).toMatchObject({ attempt: 1, runId: report.runId, op: 'fake' });
    }
    const finishes = jobFinishes(events);
    for (const finish of finishes) {
      const job = manifest.jobs.find((candidate) => candidate.id === finish.jobId);
      expect(finish.opId).toBe('fake');
      expect(finish.inputsHash).toBe(job?.inputsHash);
    }
    // The shared fold derives done for every executed job.
    expect(deriveJobStatuses(events)).toEqual([
      { jobId: 'j1', state: 'done' },
      { jobId: 'j2', state: 'done' },
    ]);
  });

  test('replayed outcomes reconstruct usage and roll it up (usage only ever comes from the journal)', async () => {
    const { state, op } = makeFake();
    const plan: Plan = {
      id: 'plan-usage',
      jobs: [{ id: 'j1', op: 'fake', input: { jobId: 'j1' } }],
    };
    const manifest = makeManifest(plan);
    const log = openRunLog(dir);
    const priorRunId = 'plan-usage--prior--beef';
    await log.append(priorRunId, {
      type: 'run-started',
      runId: priorRunId,
      at: '2026-01-01T00:00:00.000Z',
      planId: 'plan-usage',
    });
    await log.append(priorRunId, {
      type: 'job-finished',
      runId: priorRunId,
      at: '2026-01-01T00:00:01.000Z',
      jobId: 'j1',
      opId: 'fake',
      inputsHash: manifest.jobs[0]?.inputsHash ?? '',
      result: { status: 'ok', value: { jobId: 'j1' } },
      usage: { input: 3, output: 4, cacheRead: 1, cacheWrite: 2 },
    });
    await log.append(priorRunId, {
      type: 'run-finished',
      runId: priorRunId,
      at: '2026-01-01T00:00:02.000Z',
      stoppedEarly: false,
    });

    const report = await runPlan(
      plan,
      { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
      viewWith(entry('fake', jobInputSchema, op)),
    );
    expect(state.calls).toEqual([]); // zero op invocation
    expect(report.jobs[0]?.usage).toEqual({ input: 3, output: 4, cacheRead: 1, cacheWrite: 2 });
    expect(report.usage).toEqual({ input: 3, output: 4, cacheRead: 1, cacheWrite: 2 });
    expect('costUSD' in report).toBe(false); // no job reported cost → omitted
    expect('reasoning' in (report.usage as { reasoning?: number })).toBe(false);
  });

  test('T-usage reasoning once: an EXECUTED job rolls additive reasoning once through the evidence gates', async () => {
    // An executed job (never a replay): the op meters a reasoning-only
    // dispatch through reportResult, then a mixed one. The usageTokens > 0
    // evidence gates (the once-only flags, onResult and the completion
    // fold) must keep BOTH measurements; reasoning counts exactly once.
    const reasoningOnceOp = async (raw: unknown): Promise<OpResult<unknown>> => {
      currentJobContext()?.reportResult({
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 9 },
      });
      currentJobContext()?.reportResult({
        usage: { input: 3, output: 4, cacheRead: 1, cacheWrite: 2, reasoning: 7 },
      });
      return { status: 'ok', value: (raw as { jobId: string }).jobId };
    };
    const plan: Plan = {
      id: 'plan-reasoning-exec',
      jobs: [{ id: 'j1', op: 'fake', input: { jobId: 'j1' } }],
    };
    const report = await runPlan(
      plan,
      { concurrency: 1, stopOnError: false },
      viewWith(entry('fake', jobInputSchema, reasoningOnceOp)),
      {
        governor: createGovernor(governorConfig({ concurrency: 1, stopOnError: false }, {})),
        allowAdvisory: true,
      },
    );
    expect(report.jobs[0]?.usage).toEqual({
      input: 3,
      output: 4,
      cacheRead: 1,
      cacheWrite: 2,
      reasoning: 16,
    });
    expect(report.usage).toEqual({
      input: 3,
      output: 4,
      cacheRead: 1,
      cacheWrite: 2,
      reasoning: 16,
    });
  });

  test('T-usage reasoning-only: an executed reasoning-only measurement survives the evidence fold', async () => {
    // The old fold (which excluded reasoning) computed 0 tokens for this
    // usage and dropped the measurement at the usageTokens > 0 gates. The
    // reasoning-inclusive fold keeps it: the job row, the run rollup and
    // the persisted report all retain it (no replay involved).
    const reasoningOnlyOp = async (raw: unknown): Promise<OpResult<unknown>> => {
      currentJobContext()?.reportResult({
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 9 },
      });
      return { status: 'ok', value: (raw as { jobId: string }).jobId };
    };
    const plan: Plan = {
      id: 'plan-reasoning-only-exec',
      jobs: [{ id: 'j1', op: 'fake', input: { jobId: 'j1' } }],
    };
    const report = await runPlan(
      plan,
      { concurrency: 1, stopOnError: false },
      viewWith(entry('fake', jobInputSchema, reasoningOnlyOp)),
      {
        governor: createGovernor(governorConfig({ concurrency: 1, stopOnError: false }, {})),
        allowAdvisory: true,
      },
    );
    expect(report.jobs[0]?.usage).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 9,
    });
    expect(report.usage).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 9,
    });
  });

  test('journal-less runs (no journalDir) produce the same report semantics', async () => {
    const { state, op } = makeFake();
    const plan = chainPlan('plan-mem', 3);
    const memory = await runPlan(
      plan,
      { concurrency: 2, stopOnError: false },
      viewWith(entry('fake', jobInputSchema, op)),
    );
    const { state: state2, op: op2 } = makeFake();
    const journaled = await runPlan(
      plan,
      { concurrency: 2, stopOnError: false, journalDir: dir },
      viewWith(entry('fake', jobInputSchema, op2)),
    );
    expect(memory.runId).toMatch(/^plan-mem--/);
    expect(memory.counts).toEqual(journaled.counts);
    expect(memory.jobs.map((row) => [row.jobId, row.result])).toEqual(
      journaled.jobs.map((row) => [row.jobId, row.result]),
    );
    expect(state.calls).toEqual(state2.calls);
  });
});
