// runPlan plan validation and pre-run asserts: dependency cycles, resume
// without journalDir, duplicate job ids and the runId filename-safety
// assert. Split from the pre-split test/kernel/runner.test.ts; the describe
// wrapper (and its tmp-dir hooks) is reproduced so every test's full title
// path stays byte-identical.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { runPlan } from '../../src/kernel/runner.js';
import { openRunLog } from '../../src/kernel/journal.js';

import type { Plan } from '../../src/kernel/types.js';
import {
  chainPlan,
  DEFAULT_VIEW,
  entry,
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

  test('dependency cycle throws (plan corruption fails loudly, nothing journaled)', async () => {
    const plan: Plan = {
      id: 'plan-cycle',
      jobs: [
        { id: 'a', op: 'fake', input: { jobId: 'a' }, dependsOn: ['b'] },
        { id: 'b', op: 'fake', input: { jobId: 'b' }, dependsOn: ['a'] },
      ],
    };
    await expect(
      runPlan(plan, { concurrency: 1, stopOnError: false }, DEFAULT_VIEW()),
    ).rejects.toThrow(/cycle/);
  });

  test('resume:true without journalDir throws before anything is generated or journaled', async () => {
    const { state, op } = makeFake();
    await expect(
      runPlan(
        chainPlan('plan-nojournaldir', 2),
        { concurrency: 1, stopOnError: false, resume: true }, // no journalDir
        viewWith(entry('fake', jobInputSchema, op)),
      ),
    ).rejects.toThrow(/resume: true requires journalDir/);
    expect(state.calls).toEqual([]); // no op ever ran
  });

  test('duplicate plan job ids throw before anything runs or is journaled', async () => {
    const { state, op } = makeFake();
    const plan: Plan = {
      id: 'plan-dup',
      jobs: [
        { id: 'a', op: 'fake', input: { jobId: 'a' } },
        { id: 'a', op: 'fake', input: { jobId: 'a-again' } }, // duplicate
        { id: 'b', op: 'fake', input: { jobId: 'b' }, dependsOn: ['a'] },
      ],
    };
    await expect(
      runPlan(
        plan,
        { concurrency: 1, stopOnError: false, journalDir: dir },
        viewWith(entry('fake', jobInputSchema, op)),
      ),
    ).rejects.toThrow(/duplicate job id 'a'/);
    expect(state.calls).toEqual([]); // zero invocations
    // Nothing journaled: the rejection happened before the run existed.
    await expect(openRunLog(dir).runs()).resolves.toEqual([]);
  });

  test('journal-less runs accept any schema-valid plan id (filename assert only when journaling)', async () => {
    // PlanSchema.id is any string; without a journalDir there is no file name
    // and no resume key, so the filesystem-safety assert must not fire.
    const { state, op } = makeFake();
    const plan: Plan = {
      id: 'plan in-mem ω',
      jobs: [{ id: 'a', op: 'fake', input: { jobId: 'a' } }],
    };
    const report = await runPlan(
      plan,
      { concurrency: 1, stopOnError: false },
      viewWith(entry('fake', jobInputSchema, op)),
    );
    expect(report.runId.startsWith('plan in-mem ω--')).toBe(true);
    expect(state.calls).toEqual(['a']); // jobs execute
  });

  test('journaled runs still reject a non-filesystem-safe plan id before any op runs', async () => {
    // Journaled runIds become file names and resume keys, so they stay
    // asserted — loudly, before the run exists.
    const { state, op } = makeFake();
    const plan: Plan = {
      id: 'plan in-mem ω',
      jobs: [{ id: 'a', op: 'fake', input: { jobId: 'a' } }],
    };
    await expect(
      runPlan(
        plan,
        { concurrency: 1, stopOnError: false, journalDir: dir },
        viewWith(entry('fake', jobInputSchema, op)),
      ),
    ).rejects.toThrow(/runId must match/);
    expect(state.calls).toEqual([]); // no op ever ran
    // Nothing journaled: the rejection happened before the run existed.
    await expect(openRunLog(dir).runs()).resolves.toEqual([]);
  });
});
