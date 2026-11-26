/**
 * Differential for the bounded closed-PR marker recheck
 * (`repair_tick.closed_marker_due`, the `fix_closed` lane of
 * `reconcile_fix_prs` and the `not_fixed` lane of `reconcile_current_fix`).
 *
 * `apps/crq-python/closed_marker_vectors.py` drives the real Python under a
 * frozen clock and records the due decision, the final record, the counters
 * and the number of forge reads. The same specs run here through
 * `closedMarkerDue`, `runReconcileFixPrs` + `reconcileFixRun` and
 * `reconcileCurrentRepair`.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { makeFixRunAdapter } from '../../../src/ops/crq/internal/reconcileFixRunAdapter.js';
import { reconcileFixRun } from '../../../src/ops/crq/internal/reconcileFixRun.js';
import {
  reconcileCurrentRepair,
  type CurrentRepairEffects,
} from '../../../src/ops/crq/internal/reconcileCurrentRepair.js';
import { fixRunEligible, runReconcileFixPrs } from '../../../src/ops/crq/reconcileFixPrs.js';
import {
  CLOSED_FIX_RECHECK_MICROS,
  closedMarkerDue,
} from '../../../src/policy/crq/closedMarker.js';
import { JsonObject, parseJsonValue, toPlainJson } from '../../../src/policy/crq/jsonValue.js';
import { reviewReceiptBytes, reviewReceiptDigest } from '../../../src/policy/crq/reviewReceipt.js';

type Plain = Record<string, unknown>;
const doc = JSON.parse(
  readFileSync(
    new URL('../../../apps/crq-python/fixtures/crq-closed-marker/cases.json', import.meta.url),
    'utf8',
  ),
) as {
  now: string;
  doc: Plain;
  due: { name: string; marker: unknown; due: boolean }[];
  fix_prs: { spec: FixSpec; result: FixResult }[];
  current: { spec: CurrentSpec; result: CurrentResult }[];
};
interface FixSpec {
  name: string;
  record: Plain;
  forge: Plain[];
  ancestor: boolean;
  passes: number;
}
interface FixResult {
  stats: {
    examined: number;
    projected: number;
    starved: number;
    deferred: number;
    errors: Plain[];
  }[];
  record: Plain;
  forge_calls: unknown[];
}
interface CurrentSpec {
  name: string;
  extra: Plain;
  forge: Plain;
}
interface CurrentResult {
  counts: { starved: number; deferred: number; errors: string[] };
  item: Plain;
  forge_calls: unknown[];
  evidence_merges: string[];
  receipt_id: string;
}

const NOW = new Date(doc.now);
const stamp = (d: Date): string => `${d.toISOString().slice(0, 19)}Z`;
const obj = (value: unknown): JsonObject => {
  const parsed = parseJsonValue(JSON.stringify(value));
  if (!(parsed instanceof JsonObject)) throw new Error('expected object');
  return parsed;
};
class RuntimeError extends Error {
  override readonly name = 'RuntimeError';
}

describe('closedMarkerDue replays the Python oracle', () => {
  test.each(doc.due.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(closedMarkerDue(parseJsonValue(JSON.stringify(c.marker)), NOW)).toBe(c.due);
  });

  test('the window is 24 hours', () => {
    expect(CLOSED_FIX_RECHECK_MICROS).toBe(86_400_000_000n);
  });
});

describe('fix_closed lane replays reconcile_fix_prs', () => {
  test.each(doc.fix_prs.map((c) => [c.spec.name, c] as const))('%s', async (_name, c) => {
    const item = obj({ id: 'item-1', kind: 'other', repair_runs: { run1: c.spec.record } });
    const answers = [...c.spec.forge];
    const calls: unknown[] = [];
    const stats = [];
    let items: readonly JsonObject[] = [item];
    for (let pass = 0; pass < c.spec.passes; pass += 1) {
      // Each tick re-reads the queue the previous tick persisted.
      const adapter = makeFixRunAdapter({
        items,
        now: () => NOW,
        isReceipt: () => false,
        reconcileReceipt: async () => ({}),
        persist: async () => undefined,
        reconcile: (current, run) =>
          reconcileFixRun(current, run, {
            prInfo: async (number) => {
              calls.push(toPlainJson(number));
              const answer = answers.shift() ?? { state: 'CLOSED' };
              if ('raise' in answer) throw new RuntimeError(String(answer.raise));
              return obj(answer);
            },
            defaultTip: async () => 'd'.repeat(40),
            isAncestor: async () => c.spec.ancestor,
            now: () => stamp(NOW),
            proveMerge: () => Promise.reject(new Error('merge proof is out of scope')),
            recheckRevalidation: () => Promise.reject(new Error('out of scope')),
            markFixedOutcome: () => Promise.reject(new Error('out of scope')),
            publishSource: () => Promise.reject(new Error('out of scope')),
          }),
      });
      const s = await runReconcileFixPrs(adapter.effects);
      items = adapter.current() as readonly JsonObject[];
      stats.push({
        examined: s.examined,
        projected: s.projected,
        starved: s.starved,
        deferred: s.deferred,
        errors: s.errors.map((e) => ({ item: e.item, run: e.run, error: e.error })),
      });
    }
    const record = (toPlainJson(items[0] as JsonObject) as { repair_runs: { run1: Plain } })
      .repair_runs.run1;
    expect(stats).toEqual(c.result.stats);
    expect(record).toEqual(c.result.record);
    expect(calls).toEqual(c.result.forge_calls);
  });

  test('eligibility is the traversal rule, not a constant', () => {
    const run = (extra: Plain) => obj({ fix_pr: { number: 1 }, ...extra });
    const old = stamp(new Date(NOW.getTime() - 86_400_000));
    expect(fixRunEligible(run({ fix_closed: old }), NOW)).toBe(true);
    expect(fixRunEligible(run({ fix_closed: stamp(new Date(NOW.getTime() - 1000)) }), NOW)).toBe(
      false,
    );
    expect(fixRunEligible(run({ fix_closed: old, fix_merged: 't' }), NOW)).toBe(false);
  });
});

describe('not_fixed lane replays reconcile_current_fix', () => {
  const sha = (c: string): string => c.repeat(40);
  test.each(doc.current.map((c) => [c.spec.name, c] as const))('%s', async (_name, c) => {
    const { data, receiptId } = reviewReceiptBytes(doc.doc);
    expect(receiptId).toBe(c.result.receipt_id);
    const finding = (doc.doc.findings as Plain[])[0];
    const normalized = { severity: 'major', body: 'fix' };
    const record = {
      state: 'published',
      receipt_id: receiptId,
      jobs: ['j'],
      verdicts: [{ job: 'j', verdict: 'FIXED', finding: normalized }],
      receipt_findings: [reviewReceiptDigest(finding)],
      repair_findings: [reviewReceiptDigest(normalized)],
      fix_pr: { number: 9 },
      publication: { head: sha('b'), target: sha('a') },
      ...c.spec.extra,
    };
    const item = obj({
      kind: 'merged-current',
      state: 'done',
      receipt_id: receiptId,
      subject: doc.doc.source,
      capture: doc.doc.capture,
      remediation_state: 'fixed',
      remediation: { old: true },
      repair_runs: { run: record },
    });
    const calls: unknown[] = [];
    const evidence: string[] = [];
    const effects: CurrentRepairEffects = {
      now: () => NOW,
      readReceipt: async () => data,
      prInfo: async (number) => {
        calls.push(toPlainJson(number));
        if ('raise' in c.spec.forge) throw new RuntimeError(String(c.spec.forge.raise));
        return obj(c.spec.forge);
      },
      targetRef: () => 'origin/main',
      resolveRef: async () => sha('d'),
      isAncestor: async () => true,
      proveMergeTree: async (_record, _head, merge) => {
        evidence.push(merge);
      },
    };
    const result = await reconcileCurrentRepair(item, effects);
    expect(toPlainJson(result.item)).toEqual(c.result.item);
    expect({
      starved: result.starved,
      deferred: result.deferred,
      errors: result.errors,
    }).toEqual(c.result.counts);
    expect(calls).toEqual(c.result.forge_calls);
    expect(evidence).toEqual(c.result.evidence_merges);
  });
});
