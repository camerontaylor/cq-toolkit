// Governor tests (split from test/kernel/governor.test.ts — pure move): the governed dispatch folds a returned WorkerResult through observeResult (#14-1/#14-2), observeCost invalid-USD rejection (#15-1).

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { openRunLog } from '../../src/kernel/journal.js';
import { BudgetGovernor, currentJobContext, governorConfig } from '../../src/kernel/governor.js';
import { runPlan } from '../../src/kernel/runner.js';
import { entry, independentPlan, viewWith } from './governor.helpers.js';
import type { OpResult, Plan } from '../../src/kernel/types.js';

// ---------------------------------------------------------------------------
// 2c. RD-B review debt — the production observeResult wiring (#14-1/#14-2),
// now the GOVERNED RUNNER's completion-time evidence fold (W2.2 slice C)
// ---------------------------------------------------------------------------

describe('the governed dispatch folds a returned WorkerResult through observeResult (#14-1/#14-2)', () => {
  const WORKER_USAGE = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 };
  const workerValue = (extra?: {
    costUSD?: number;
    costBasis?: 'modeled' | 'billed';
  }): unknown => ({
    usage: WORKER_USAGE,
    denials: [],
    stopReason: 'complete',
    ...extra,
  });

  test('THE production path: a returned priced WorkerResult moves the budget', async () => {
    const governor = new BudgetGovernor(
      governorConfig({ concurrency: 1, stopOnError: false, maxUsd: 5 }, {}),
    );
    const workerOp = async (): Promise<OpResult<unknown>> => ({
      status: 'ok',
      value: workerValue({ costUSD: 0.02, costBasis: 'modeled' }),
    });
    const plan = independentPlan('plan-worker-priced', 1, 'worker');
    const report = await runPlan(
      plan,
      { concurrency: 1, stopOnError: false },
      viewWith(entry('worker', workerOp)),
      { governor, allowAdvisory: true },
    );
    // The op never called reportUsage/reportCost — the RETURNED value is the
    // budget evidence, folded through the governed completed branch.
    expect(governor.usage).toEqual(WORKER_USAGE);
    expect(governor.usdSpent).toBe(0.02);
    expect(governor.tripped).toBe(false);
    expect(report.jobs[0]?.result).toEqual({
      status: 'ok',
      value: workerValue({ costUSD: 0.02, costBasis: 'modeled' }),
    });
  });

  test('returned UNPRICED usage under maxUsd trips the budget through the production path', async () => {
    const governor = new BudgetGovernor(
      governorConfig({ concurrency: 1, stopOnError: false, maxUsd: 5 }, {}),
    );
    const unpricedWorkerOp = async (): Promise<OpResult<unknown>> => ({
      status: 'ok',
      value: workerValue(), // real usage, no costUSD — the unpriced-model shape
    });
    const plan = independentPlan('plan-worker-unpriced', 1, 'unpriced');
    await runPlan(
      plan,
      { concurrency: 1, stopOnError: false },
      viewWith(entry('unpriced', unpricedWorkerOp)),
      { governor, allowAdvisory: true },
    );
    expect(governor.usage).toEqual(WORKER_USAGE);
    expect(governor.usdSpent).toBe(0);
    expect(governor.tripped).toBe(true); // fail loud, never fail open (DD-9)
    expect(governor.tripReason).toMatch(/unpriced usage under a USD cap/);
  });

  test('once-only: usage streamed through the job context is NOT double-counted by the returned WorkerResult', async () => {
    const governor = new BudgetGovernor(
      governorConfig({ concurrency: 1, stopOnError: false, maxUsd: 5 }, {}),
    );
    const doubleEvidenceOp = async (): Promise<OpResult<unknown>> => {
      const ctx = currentJobContext();
      if (ctx !== undefined) {
        // reportResult is the ONE streaming channel: the op streams the
        // FULL fold (usage + cost) — streaming usage alone would be the
        // unpriced fail-loud shape (DD-9).
        ctx.reportResult({ usage: WORKER_USAGE, costUSD: 0.02 });
      }
      // …AND the same evidence returned in the WorkerResult: the rollup must
      // count it ONCE, not twice.
      return { status: 'ok', value: workerValue({ costUSD: 0.02, costBasis: 'modeled' }) };
    };
    const plan = independentPlan('plan-worker-once', 1, 'double');
    await runPlan(
      plan,
      { concurrency: 1, stopOnError: false },
      viewWith(entry('double', doubleEvidenceOp)),
      { governor, allowAdvisory: true },
    );
    expect(governor.usage).toEqual(WORKER_USAGE); // once — not {input: 200, output: 100, …}
    expect(governor.usdSpent).toBe(0.02); // the cost folded (once)
  });

  test("reportResult streams a value-mapping op's driver evidence through the job context (#185)", async () => {
    const governor = new BudgetGovernor(
      governorConfig({ concurrency: 1, stopOnError: false, maxUsd: 5 }, {}),
    );
    // The op maps the WorkerResult into its OWN value shape (review.fixItem /
    // resolveConflict), so the completion-time WorkerResult fold cannot see
    // it — it reports usage+cost in ONE fold through the job context.
    const mappedOp = async (): Promise<OpResult<unknown>> => {
      currentJobContext()?.reportResult({ usage: WORKER_USAGE, costUSD: 0.03 });
      return {
        status: 'ok',
        value: { changed: true, summary: 'fixed', commits: ['a'.repeat(40)] },
      };
    };
    const plan = independentPlan('plan-mapped-cost', 1, 'mapped');
    await runPlan(
      plan,
      { concurrency: 1, stopOnError: false },
      viewWith(entry('mapped', mappedOp)),
      { governor, allowAdvisory: true },
    );
    expect(governor.usage).toEqual(WORKER_USAGE);
    expect(governor.usdSpent).toBe(0.03);
    expect(governor.tripped).toBe(false);
  });

  test('reportResult with UNPRICED usage under maxUsd still trips LOUD — DD-9 is not bypassed (#185)', async () => {
    const governor = new BudgetGovernor(
      governorConfig({ concurrency: 1, stopOnError: false, maxUsd: 5 }, {}),
    );
    const mappedUnpricedOp = async (): Promise<OpResult<unknown>> => {
      currentJobContext()?.reportResult({ usage: WORKER_USAGE }); // no costUSD
      return { status: 'ok', value: { changed: false, summary: 'nothing' } };
    };
    const plan = independentPlan('plan-mapped-unpriced', 1, 'mapped-unpriced');
    await runPlan(
      plan,
      { concurrency: 1, stopOnError: false },
      viewWith(entry('mapped-unpriced', mappedUnpricedOp)),
      { governor, allowAdvisory: true },
    );
    expect(governor.usage).toEqual(WORKER_USAGE);
    expect(governor.usdSpent).toBe(0);
    expect(governor.tripped).toBe(true);
    expect(governor.tripReason).toMatch(/unpriced usage under a USD cap/);
  });

  test('a LYING reportResult measurement folds as ZERO evidence, never throws past the op (#185 review r1)', async () => {
    const governor = new BudgetGovernor(
      governorConfig({ concurrency: 1, stopOnError: false, maxUsd: 5 }, {}),
    );
    const lyingOp = async (): Promise<OpResult<unknown>> => {
      // NaN/negative measurements an op streamed through the job context
      // never passed the workerResultOfValue guard; observeResult sanitizes
      // them instead of letting assertValid* throw out of the op.
      currentJobContext()?.reportResult({
        usage: { input: Number.NaN, output: -1, cacheRead: 0, cacheWrite: 0 },
        costUSD: -3,
      });
      return { status: 'ok', value: { changed: false, summary: 'nothing' } };
    };
    const plan = independentPlan('plan-lying-report', 1, 'lying-report');
    await runPlan(
      plan,
      { concurrency: 1, stopOnError: false },
      viewWith(entry('lying-report', lyingOp)),
      { governor, allowAdvisory: true },
    );
    expect(governor.usage).toBeUndefined();
    expect(governor.usdSpent).toBe(0);
    expect(governor.tripped).toBe(false);
  });

  test('measurements the journal mirror would reject fold as ZERO evidence on BOTH channels (fractional/extra-keyed usage)', async () => {
    // journalDir ON: usage that passes a loose defensive predicate but not
    // the strict UsageSchema used to surface as a post-record job-finished
    // append throw — after the op had already completed. Both spend channels
    // must validate the PERSISTED shape (integer cardinalities, strict
    // keys): the STREAMED reportResult channel and the RETURNED WorkerResult
    // an unschemable measurement is zero evidence, never a late throw.
    const dir = await mkdtemp(join(tmpdir(), 'cq-governor-usage-mirror-'));
    try {
      const governor = new BudgetGovernor(
        governorConfig({ concurrency: 1, stopOnError: false, maxUsd: 5, journalDir: dir }, {}),
      );
      const mirrorLyingOp = async (raw: unknown): Promise<OpResult<unknown>> => {
        const jobId = (raw as { jobId: string }).jobId;
        if (jobId === 'j3') {
          // Returned-WorkerResult channel: workerResultOfValue passes a
          // fractional count (finite, non-negative) — the fold must still
          // not persist it raw.
          return {
            status: 'ok',
            value: {
              stopReason: 'complete',
              usage: { input: 2.5, output: 1, cacheRead: 0, cacheWrite: 0 },
              denials: [],
            },
          };
        }
        const usage =
          jobId === 'j1'
            ? { input: 1.5, output: 2, cacheRead: 0, cacheWrite: 0 } // fractional
            : { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, vendorPromptTokens: 9 }; // extra key
        currentJobContext()?.reportResult({ usage });
        return { status: 'ok', value: jobId };
      };
      const plan: Plan = {
        id: 'plan-usage-mirror',
        jobs: [
          { id: 'j1', op: 'mirror-lying', input: { jobId: 'j1' } },
          { id: 'j2', op: 'mirror-lying', input: { jobId: 'j2' } },
          { id: 'j3', op: 'mirror-lying', input: { jobId: 'j3' } },
        ],
      };
      const report = await runPlan(
        plan,
        { concurrency: 1, stopOnError: false, journalDir: dir },
        viewWith(entry('mirror-lying', mirrorLyingOp)),
        { governor, allowAdvisory: true },
      );
      expect(governor.usage).toBeUndefined(); // every measurement dropped
      expect(governor.usdSpent).toBe(0); // no cost folds off unschemable usage
      expect(report.jobs[0]?.usage).toBeUndefined();
      expect(report.jobs[1]?.usage).toBeUndefined();
      expect(report.jobs[2]?.usage).toBeUndefined();
      // The journal stays schema-clean: no job-finished line carries usage.
      const runLog = openRunLog(dir);
      const events = await runLog.read((await runLog.runs())[0]!);
      expect(
        events.every((event) => event.type !== 'job-finished' || event.usage === undefined),
      ).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('observeCost rejects invalid USD before mutating the rollup (#15-1)', () => {
  test.each([NaN, Infinity, -0.01])('usd %p throws and leaves the rollup untouched', (bad) => {
    const governor = new BudgetGovernor({ maxUsd: 1 });
    governor.observeCost('j1', 0.25); // a valid fold first
    expect(() => governor.observeCost('j1', bad)).toThrowError(
      /observed cost must be a finite number >= 0/,
    );
    expect(governor.usdSpent).toBe(0.25); // not poisoned by the bad fold
  });
});
