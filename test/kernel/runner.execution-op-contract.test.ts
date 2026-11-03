// runPlan op-contract failure recording: unknown op, input-schema
// violation, a throwing op and a non-OpResult return. Split from the
// pre-split test/kernel/runner.test.ts; the describe wrapper (and its
// tmp-dir hooks) is reproduced so every test's full title path stays
// byte-identical.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { runPlan } from '../../src/kernel/runner.js';
import { z } from 'zod';
import { match } from '../helpers/matchers.js';

import type { OpResult, Plan } from '../../src/kernel/types.js';
import { DEFAULT_VIEW, entry, jobInputSchema, viewWith } from './runner.helpers.js';
describe('runPlan — execution semantics', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cq-runner-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('unknown op name fails that job at execution time with a clear error', async () => {
    const plan: Plan = {
      id: 'plan-ghost-op',
      jobs: [{ id: 'a', op: 'ghost', input: { jobId: 'a' } }],
    };
    const report = await runPlan(plan, { concurrency: 1, stopOnError: false }, DEFAULT_VIEW());
    expect(report.counts.failed).toBe(1);
    expect(report.jobs[0]?.result).toEqual({
      status: 'failed',
      error: "unknown op 'ghost'",
    });
  });

  test('inputSchema violation records failed with the zod message', async () => {
    const plan: Plan = {
      id: 'plan-bad-input',
      jobs: [{ id: 'a', op: 'numbered', input: { n: 'not-a-number' } }],
    };
    const registry = viewWith(
      entry('numbered', z.object({ n: z.number() }).strict(), async () => {
        throw new Error('op must never run');
      }),
    );
    const report = await runPlan(plan, { concurrency: 1, stopOnError: false }, registry);
    expect(report.counts.failed).toBe(1);
    expect(report.jobs[0]?.result.status).toBe('failed');
    expect(report.jobs[0]?.result).toMatchObject({ error: match.stringMatching(/number/i) });
  });

  test('a throwing op records failed with the throw message (contract violation, run survives)', async () => {
    const plan: Plan = {
      id: 'plan-boom',
      jobs: [{ id: 'a', op: 'fake', input: { jobId: 'a' } }],
    };
    const registry = viewWith(
      entry('fake', jobInputSchema, async () => {
        throw new Error('kaboom');
      }),
    );
    const report = await runPlan(plan, { concurrency: 1, stopOnError: false }, registry);
    expect(report.jobs[0]?.result).toEqual({ status: 'failed', error: 'kaboom' });
    expect(report.counts.failed).toBe(1);
  });

  test('an op returning a non-OpResult is a contract violation, recorded as failed', async () => {
    const plan: Plan = {
      id: 'plan-garbage',
      jobs: [{ id: 'a', op: 'fake', input: { jobId: 'a' } }],
    };
    const registry = viewWith(
      entry('fake', jobInputSchema, async () => 42 as unknown as OpResult<unknown>),
    );
    const report = await runPlan(plan, { concurrency: 1, stopOnError: false }, registry);
    expect(report.jobs[0]?.result).toMatchObject({
      status: 'failed',
      error: match.stringMatching(/violated the op contract/),
    });
  });
});
