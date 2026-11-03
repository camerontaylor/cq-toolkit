// runPlan stopOnError / dependency-graph stop semantics: fleet collection
// when stopping is off, the never-started counts policy, stop-sweep
// precedence and missing dependencies. Split from the pre-split
// test/kernel/runner.test.ts; the describe wrapper (and its tmp-dir hooks)
// is reproduced so every test's full title path stays byte-identical.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { runPlan } from '../../src/kernel/runner.js';
import { match } from '../helpers/matchers.js';

import type { Plan } from '../../src/kernel/types.js';
import { chainPlan, entry, jobInputSchema, makeFake, viewWith } from './runner.helpers.js';
describe('runPlan — execution semantics', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cq-runner-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('stopOnError:false collects everything — downstream of a failure is blocked, all 10 outcomes present', async () => {
    const { state, op } = makeFake();
    state.failOn.add('j3');
    const report = await runPlan(
      chainPlan('plan-fleet', 10),
      { concurrency: 4, stopOnError: false, journalDir: dir },
      viewWith(entry('fake', jobInputSchema, op)),
    );
    expect(state.calls).toEqual(['j1', 'j2', 'j3']); // j4+ blocked, never invoked
    expect(report.jobs).toHaveLength(10);
    expect(report.counts).toEqual({
      queued: 0,
      running: 0,
      blocked: 7,
      done: 2,
      failed: 1,
      'budget-exhausted': 0,
    });
    const j4 = report.jobs.find((row) => row.jobId === 'j4');
    expect(j4?.result).toMatchObject({
      status: 'failed',
      error: match.stringMatching(/blocked: dependency 'j3'/),
    });
  });

  test('never-started jobs: queued when deps are fine, blocked when a dependency failed (counts policy)', async () => {
    // Two independent chains; a1 fails with concurrency 2 so b1 (same wave,
    // in flight) still completes. Wave 2 never dispatches: a2 is downstream
    // of the failure (blocked), b2's dependency finished ok (queued).
    const { state, op } = makeFake();
    state.failOn.add('a1');
    const plan: Plan = {
      id: 'plan-stop',
      jobs: [
        { id: 'a1', op: 'fake', input: { jobId: 'a1' } },
        { id: 'a2', op: 'fake', input: { jobId: 'a2' }, dependsOn: ['a1'] },
        { id: 'b1', op: 'fake', input: { jobId: 'b1' } },
        { id: 'b2', op: 'fake', input: { jobId: 'b2' }, dependsOn: ['b1'] },
      ],
    };
    const report = await runPlan(
      plan,
      { concurrency: 2, stopOnError: true, journalDir: dir },
      viewWith(entry('fake', jobInputSchema, op)),
    );
    expect(state.calls.sort()).toEqual(['a1', 'b1']);
    expect(report.counts).toEqual({
      queued: 1, // b2: deps fine, dispatch never happened
      running: 0,
      blocked: 1, // a2: dependency a1 failed
      done: 1, // b1
      failed: 1, // a1
      'budget-exhausted': 0,
    });
    const a2 = report.jobs.find((row) => row.jobId === 'a2');
    const b2 = report.jobs.find((row) => row.jobId === 'b2');
    expect(a2?.result).toMatchObject({
      status: 'failed',
      error: match.stringMatching(/blocked: dependency 'a1'/),
    });
    expect(b2?.result).toMatchObject({
      status: 'indeterminate',
      detail: match.stringMatching(/queued: run stopped before dispatch/),
    });
  });

  test('stop sweep precedence: a failed dep beats a queued dep (blocked, not queued)', async () => {
    // c depends on [a1, b2]: a1 definitively failed, b2 is merely queued. The
    // failed dep means c can NEVER run → blocked (old code classified c
    // queued via anyQueued, and the error could name the queued sibling b2).
    const { state, op } = makeFake();
    state.failOn.add('a1');
    const plan: Plan = {
      id: 'plan-sweep-precedence',
      jobs: [
        { id: 'a1', op: 'fake', input: { jobId: 'a1' } },
        { id: 'b1', op: 'fake', input: { jobId: 'b1' } },
        { id: 'b2', op: 'fake', input: { jobId: 'b2' }, dependsOn: ['b1'] },
        { id: 'c', op: 'fake', input: { jobId: 'c' }, dependsOn: ['a1', 'b2'] },
      ],
    };
    const report = await runPlan(
      plan,
      { concurrency: 2, stopOnError: true, journalDir: dir },
      viewWith(entry('fake', jobInputSchema, op)),
    );
    // Wave 1 runs a1 (fails → stop) and b1 (ok, in flight); waves 2-3 never
    // dispatch, so b2 stays queued and c is classified in the sweep.
    expect(state.calls.sort()).toEqual(['a1', 'b1']);
    expect(report.counts).toEqual({
      queued: 1, // b2: all-done deps, dispatch never happened
      running: 0,
      blocked: 1, // c: a1 definitively failed
      done: 1, // b1
      failed: 1, // a1
      'budget-exhausted': 0,
    });
    // The error names the FAILED dep, not the queued sibling.
    expect(report.jobs.find((row) => row.jobId === 'c')?.result).toMatchObject({
      status: 'failed',
      error: match.stringMatching(/blocked: dependency 'a1' did not succeed/),
    });
  });

  test('dependency on a job missing from the plan is blocked, not a crash (transitive)', async () => {
    const { state, op } = makeFake();
    const plan: Plan = {
      id: 'plan-missing-dep',
      jobs: [
        { id: 'a', op: 'fake', input: { jobId: 'a' } },
        { id: 'b', op: 'fake', input: { jobId: 'b' }, dependsOn: ['ghost'] },
        { id: 'c', op: 'fake', input: { jobId: 'c' }, dependsOn: ['b'] },
      ],
    };
    const report = await runPlan(
      plan,
      { concurrency: 2, stopOnError: false },
      viewWith(entry('fake', jobInputSchema, op)),
    );
    expect(state.calls).toEqual(['a']);
    expect(report.counts).toEqual({
      queued: 0,
      running: 0,
      blocked: 2,
      done: 1,
      failed: 0,
      'budget-exhausted': 0,
    });
    expect(report.jobs.find((row) => row.jobId === 'b')?.result).toMatchObject({
      status: 'failed',
      error: match.stringMatching(/dependency 'ghost' missing from plan/),
    });
    expect(report.jobs.find((row) => row.jobId === 'c')?.result).toMatchObject({
      status: 'failed',
      error: match.stringMatching(/blocked/),
    });
  });
});
