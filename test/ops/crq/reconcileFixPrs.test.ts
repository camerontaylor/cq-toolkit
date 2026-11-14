/**
 * The reconcile per-run report and traversal (`repair_tick.reconcile_fix_prs`).
 *
 * Effects are injected counters, so the regressions are about the REPORT: a
 * quiet pass, a starved pass and a real-error pass must be distinguishable,
 * counts must come from the traversal, and the error cap must hold. No forge,
 * repair or provider participates.
 */
import { describe, expect, test } from 'vitest';
import { JsonObject, toPlainJson } from '../../../src/policy/crq/jsonValue.js';
import { fromPlainJson } from '../../../src/policy/crq/queueDoc.js';
import { RefreshExhausted } from '../../../src/policy/crq/forgeBudget.js';
import {
  countExamined,
  countProjected,
  newReconcileStats,
  reconcileIncompleteEvent,
  reconcileLogLine,
  reconcileStatsObject,
  reconcileTickReport,
} from '../../../src/policy/crq/reconcileReport.js';
import {
  fixRunEligible,
  repairRunEntries,
  runReconcileFixPrs,
  type ReconcileFixPrEffects,
} from '../../../src/ops/crq/reconcileFixPrs.js';
import type { JsonRecordLike } from '../../../src/policy/crq/queueDoc.js';

function item(value: unknown): JsonRecordLike {
  const converted = fromPlainJson(value);
  if (!(converted instanceof JsonObject)) throw new Error('expected an item object');
  return converted;
}

describe('reconcile report projections', () => {
  test('a quiet pass has no log line and no event', () => {
    const stats = newReconcileStats();
    expect(reconcileLogLine(stats)).toBeNull();
    expect(reconcileIncompleteEvent(stats)).toBeNull();
    expect(reconcileTickReport(stats, '2026-11-14T00:00:00Z')).toEqual({
      line: null,
      event: null,
    });
  });

  test('a failing pass logs the real counts and writes the incomplete event', () => {
    const stats = newReconcileStats();
    stats.examined = 12;
    stats.projected = 3;
    stats.starved = 7;
    stats.deferred = 2;
    stats.errors.push({ item: 'a', run: 'r1', error: 'RefreshExhausted: debt' });
    expect(reconcileLogLine(stats)).toBe('reconcile: 12 examined, 3 projected, 7 starved, 2 deferred');
    const report = reconcileTickReport(stats, '2026-11-14T00:00:00Z');
    const event = report.event as JsonObject;
    expect(event.get('at')).toBe('2026-11-14T00:00:00Z');
    expect(event.get('event')).toBe('reconcile_incomplete');
    expect(toPlainJson(event)).toEqual({
      at: '2026-11-14T00:00:00Z',
      event: 'reconcile_incomplete',
      examined: 12,
      projected: 3,
      starved: 7,
      deferred: 2,
      errors: [{ item: 'a', run: 'r1', error: 'RefreshExhausted: debt' }],
    });
  });

  test('counts materialise as a lossless report object', () => {
    const stats = newReconcileStats();
    countExamined(stats);
    countProjected(stats);
    const report = reconcileStatsObject(stats);
    expect(report.get('examined')).toBeDefined();
    expect(report.get('errors')).toEqual([]);
  });
});

describe('fix-run eligibility', () => {
  test('only an unmerged, open fix PR is eligible', () => {
    expect(fixRunEligible(item({ fix_pr: { number: 1 } }))).toBe(true);
    expect(fixRunEligible(item({ fix_pr: { number: 1 }, fix_merged: 'yes' }))).toBe(false);
    expect(fixRunEligible(item({ fix_pr: { number: 1 }, fix_closed: 'yes' }))).toBe(false);
    expect(fixRunEligible(item({}))).toBe(false);
    expect(fixRunEligible(item({ fix_pr: null }))).toBe(false);
    expect(fixRunEligible(item({ fix_pr: {} }))).toBe(false);
  });

  test('repair-run entries preserve queue order and skip non-objects', () => {
    const entries = repairRunEntries(
      item({ repair_runs: { first: { fix_pr: { number: 1 } }, bad: 3, second: {} } }),
    );
    expect(entries.map((entry) => entry.run)).toEqual(['first', 'second']);
  });
});

describe('runReconcileFixPrs', () => {
  interface Outcome {
    readonly kind: 'projected' | 'skipped' | 'starved' | 'deferred';
    readonly message?: string;
  }

  function effects(options: {
    readonly items: readonly JsonRecordLike[];
    readonly outcomes?: Readonly<Record<string, Outcome>>;
    readonly receipts?: Readonly<Record<string, unknown>>;
  }): ReconcileFixPrEffects {
    return {
      items: () => options.items,
      isReceipt: (entry) => (entry as JsonObject).get('kind') === 'review-receipt',
      reconcileReceipt: (entry) => {
        const key = String((entry as JsonObject).get('id'));
        const outcome = options.outcomes?.[key];
        if (outcome?.kind === 'starved') {
          return Promise.reject(new RefreshExhausted(outcome.message ?? 'debt'));
        }
        if (outcome?.kind === 'deferred') {
          return Promise.reject(new Error(outcome.message ?? 'boom'));
        }
        return Promise.resolve(options.receipts?.[key] ?? {});
      },
      repairRuns: (entry) => repairRunEntries(entry),
      advanceFixRun: (_entry, run) => {
        const outcome = options.outcomes?.[run.run];
        if (outcome?.kind === 'starved') {
          return Promise.reject(new RefreshExhausted(outcome.message ?? 'debt'));
        }
        if (outcome?.kind === 'deferred') {
          return Promise.reject(new Error(outcome.message ?? 'boom'));
        }
        return Promise.resolve(outcome?.kind === 'projected' ? 'projected' : 'skipped');
      },
    };
  }

  test('a quiet queue examines nothing', async () => {
    const stats = await runReconcileFixPrs(effects({ items: [] }));
    expect(stats).toEqual({ examined: 0, projected: 0, starved: 0, deferred: 0, errors: [] });
  });

  test('receipt items are examined and their lane skips are counted', async () => {
    const queue = [item({ id: 'receipt-1', kind: 'review-receipt' })];
    const stats = await runReconcileFixPrs(
      effects({
        items: queue,
        receipts: { 'receipt-1': { starved: 2, deferred: 1, errors: ['one', 'two', 'three'] } },
      }),
    );
    expect(stats.examined).toBe(1);
    expect(stats.starved).toBe(2);
    expect(stats.deferred).toBe(1);
    expect(stats.errors.map((entry) => entry.error)).toEqual(['one', 'two']);
  });

  test('budget starvation and real errors are classified separately', async () => {
    const queue = [
      item({ id: 'receipt-1', kind: 'review-receipt' }),
      item({ id: 'receipt-2', kind: 'review-receipt' }),
    ];
    const stats = await runReconcileFixPrs(
      effects({
        items: queue,
        outcomes: {
          'receipt-1': { kind: 'starved', message: 'debt retained' },
          'receipt-2': { kind: 'deferred', message: 'bad state' },
        },
      }),
    );
    expect(stats.examined).toBe(2);
    expect(stats.starved).toBe(1);
    expect(stats.deferred).toBe(1);
    expect(stats.errors).toEqual([
      { item: 'receipt-1', run: '', error: 'RefreshExhausted: debt retained' },
      { item: 'receipt-2', run: '', error: 'Error: bad state' },
    ]);
  });

  test('eligible repair runs count and only advanced runs project', async () => {
    const queue = [
      item({
        id: 'item-1',
        repair_runs: {
          r1: { fix_pr: { number: 1 } },
          r2: { fix_pr: { number: 2 } },
          done: { fix_pr: { number: 3 }, fix_merged: 'yes' },
          closed: { fix_pr: { number: 4 }, fix_closed: 'yes' },
          'no-pr': {},
        },
      }),
    ];
    const stats = await runReconcileFixPrs(
      effects({ items: queue, outcomes: { r1: { kind: 'projected' }, r2: { kind: 'skipped' } } }),
    );
    expect(stats.examined).toBe(2);
    expect(stats.projected).toBe(1);
    expect(stats.starved).toBe(0);
    expect(stats.deferred).toBe(0);
  });

  test('the first five errors survive and a pass of only errors is not quiet', async () => {
    const runs = Array.from({ length: 8 }, (_, index) => `r${String(index)}`).map((run, index) => [
      run,
      { fix_pr: { number: index + 1 } },
    ]);
    const queue = [item({ id: 'item-1', repair_runs: Object.fromEntries(runs) })];
    const stats = await runReconcileFixPrs(
      effects({
        items: queue,
        outcomes: Object.fromEntries(
          runs.map(([run]) => [run as string, { kind: 'deferred' as const, message: 'boom' }]),
        ),
      }),
    );
    expect(stats.examined).toBe(8);
    expect(stats.deferred).toBe(8);
    expect(stats.errors).toHaveLength(5);
    expect(reconcileLogLine(stats)).toBe('reconcile: 8 examined, 0 projected, 0 starved, 8 deferred');
    expect(reconcileIncompleteEvent(stats)?.get('errors')).toHaveLength(5);
  });
});
