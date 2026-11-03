// runPlan registry lookup failures, the concurrency pool high-water, the
// frozen counts taxonomy and the empty plan. Split from the pre-split
// test/kernel/runner.test.ts; the describe wrapper (and its tmp-dir hooks)
// is reproduced so every test's full title path stays byte-identical.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { runPlan, type OpRegistryView } from '../../src/kernel/runner.js';
import { match } from '../helpers/matchers.js';
import type { Plan } from '../../src/kernel/types.js';
import {
  DEFAULT_VIEW,
  entry,
  independentPlan,
  jobInputSchema,
  makeFake,
  viewWith,
} from './runner.helpers.js';
describe('runPlan — execution semantics', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cq-runner-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('a throwing registry lookup records failed with the throw message (run survives)', async () => {
    // A registry backend that throws on read must fail THIS job, not reject
    // the whole runPlan call ('this function never throws' holds).
    const cursedView: OpRegistryView = {
      get(name: string) {
        if (name === 'cursed') throw new Error('registry backend offline');
        return undefined; // other names stay plain unknown ops
      },
    };
    const plan: Plan = {
      id: 'plan-cursed-registry',
      jobs: [
        { id: 'j1', op: 'cursed', input: { jobId: 'j1' } },
        { id: 'j2', op: 'ghost', input: { jobId: 'j2' } },
      ],
    };
    const report = await runPlan(plan, { concurrency: 2, stopOnError: false }, cursedView);
    expect(report.jobs.find((row) => row.jobId === 'j1')?.result).toMatchObject({
      status: 'failed',
      error: match.stringMatching(
        /registry lookup for op 'cursed' failed: registry backend offline/,
      ),
    });
    expect(report.jobs.find((row) => row.jobId === 'j2')?.result).toEqual({
      status: 'failed',
      error: "unknown op 'ghost'",
    });
    expect(report.counts.failed).toBe(2);
  });

  test('concurrency is the one knob: in-flight high-water equals it under load', async () => {
    const { state, op } = makeFake();
    await runPlan(
      independentPlan('plan-pool', 9),
      { concurrency: 3, stopOnError: false },
      viewWith(entry('fake', jobInputSchema, op)),
    );
    expect(state.highWater).toBe(3);
    expect(state.calls).toHaveLength(9);

    const single = makeFake();
    await runPlan(
      independentPlan('plan-pool-1', 6),
      { concurrency: 1, stopOnError: false },
      viewWith(entry('fake', jobInputSchema, single.op)),
    );
    expect(single.state.highWater).toBe(1);
  });

  test('counts mapping for needs-human/indeterminate results (documented freeze workaround)', async () => {
    const plan: Plan = {
      id: 'plan-taxonomy',
      jobs: [
        { id: 'a', op: 'nh', input: { jobId: 'a' } },
        { id: 'b', op: 'ind', input: { jobId: 'b' } },
      ],
    };
    const registry = viewWith(
      entry('nh', jobInputSchema, async () => ({ status: 'needs-human', reason: 'human please' })),
      entry('ind', jobInputSchema, async () => ({ status: 'indeterminate', detail: 'lost' })),
    );
    const report = await runPlan(plan, { concurrency: 2, stopOnError: false }, registry);
    // needs-human → blocked (waiting on a human); indeterminate → failed.
    // The ROWS keep the true taxonomy statuses.
    expect(report.counts).toEqual({
      queued: 0,
      running: 0,
      blocked: 1,
      done: 0,
      failed: 1,
      'budget-exhausted': 0,
    });
    expect(report.jobs[0]?.result.status).toBe('needs-human');
    expect(report.jobs[1]?.result.status).toBe('indeterminate');
  });

  test('an empty plan runs to an empty, honest report', async () => {
    const report = await runPlan(
      { id: 'plan-empty', jobs: [] },
      { concurrency: 1, stopOnError: false },
      DEFAULT_VIEW(),
    );
    expect(report.jobs).toEqual([]);
    expect(report.counts).toEqual({
      queued: 0,
      running: 0,
      blocked: 0,
      done: 0,
      failed: 0,
      'budget-exhausted': 0,
    });
  });
});
