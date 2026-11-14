import { describe, expect, it } from 'vitest';
import {
  COVERAGE_PENDING,
  MISSING_EVIDENCE,
  reconcileBackfillSelection,
  type BackfillSelectionEffects,
} from '../../../src/ops/crq/internal/backfillSelection.js';
import { JsonObject, parseJsonValue } from '../../../src/policy/crq/jsonValue.js';
import { enqueue } from '../../../src/policy/crq/backfillJobs.js';
import { withObjectKeys } from '../../../src/policy/crq/queueDoc.js';

const object = (s: string): JsonObject => {
  const result = parseJsonValue(s);
  if (!(result instanceof JsonObject)) throw new Error('not object');
  return result;
};
const queue = () =>
  object(
    JSON.stringify({
      items: [
        {
          id: 'one',
          kind: 'backfill',
          state: 'pending',
          family: 'f',
          target: 't1',
          tier_importance: 'T1',
          subject_kind: 'A',
          row: 1,
          subject_id: 'one',
          scope: [{ path: 'a', blob: 'b', intervals: [[1, 2]] }],
        },
        {
          id: 'two',
          kind: 'backfill',
          state: 'pending',
          family: 'f',
          target: 't2',
          tier_importance: 'T2',
          subject_kind: 'A',
          row: 2,
          subject_id: 'two',
          scope: [{ path: 'b', blob: 'c', intervals: [[1, 2]] }],
        },
      ],
      other: 1.25,
    }),
  );
const getItem = (q: JsonObject, i: number): JsonObject => {
  const items = q.get('items');
  if (!Array.isArray(items) || !(items[i] instanceof JsonObject)) throw new Error('bad item');
  return items[i];
};
const options = { halted: false, dispatchEnabled: true, dry: false };
const effects = (overrides: Partial<BackfillSelectionEffects> = {}): BackfillSelectionEffects => ({
  now: () => '2026-10-30T00:10:00Z',
  probeGate: async (q) => ({ queue: q, admitted: true }),
  fetchLedger: async () => ({ head: 'head', events: [] }),
  loadCoverage: async () => ({ covered: new Map(), gaps: [] }),
  requestCoverage: async () => {},
  ...overrides,
});

describe('non-launching backfill selection', () => {
  it('selects real enqueued partitions with canonical string tiers', async () => {
    const first = object(
      '{"job_id":"j1","subject_id":"one","generation":0,"kind":"A","tier":"T2","row":1,"target":"t1","scope_digest":"d1","family":"f","scope":[{"path":"a","blob":"b","intervals":[[1,2]]}]}',
    );
    const second = object(
      '{"job_id":"j2","subject_id":"two","generation":0,"kind":"A","tier":"T1","row":2,"target":"t2","scope_digest":"d2","family":"f","scope":[{"path":"b","blob":"c","intervals":[[1,2]]}]}',
    );
    const firstResult = enqueue(object('{}'), first, '2026-10-30T00:00:00Z');
    const secondResult = enqueue(firstResult.queue, second, '2026-10-30T00:00:00Z');
    const result = await reconcileBackfillSelection(secondResult.queue, options, effects());
    expect(result.candidate).toBe(1);
    expect(getItem(result.queue, 1).get('tier_importance')).toBe('T1');
  });
  it('continues after a real gate refusal and reconciles later jobs', async () => {
    let calls = 0;
    const result = await reconcileBackfillSelection(
      queue(),
      options,
      effects({
        admitGate: async (q, i) => {
          calls++;
          const items = q.get('items');
          if (!Array.isArray(items)) throw new Error('bad items');
          return {
            queue: withObjectKeys(q, [
              [
                'items',
                items.map((v, n) =>
                  n === i ? withObjectKeys(getItem(q, i), [['wait_reason', 'quota']]) : v,
                ),
              ],
              ['gate_marker', 'preserved'],
            ]),
            admitted: false,
          };
        },
      }),
    );
    expect(calls).toBe(1);
    expect(result.candidate).toBeNull();
    expect(result.reserved).toBe(false);
    expect(getItem(result.queue, 0).get('wait_reason')).toBe('quota');
    expect(getItem(result.queue, 1).get('wait_reason')).toBe('quota');
    expect(result.queue.get('gate_marker')).toBe('preserved');
    expect(result.queue.has('backfill_coverage_reconciled')).toBe(true);
  });
  it('reports a persisted gate reservation and does not call the real gate in dry mode', async () => {
    let calls = 0;
    const fx = effects({
      admitGate: async (q) => {
        calls++;
        return { queue: withObjectKeys(q, [['durable', 'yes']]), admitted: true };
      },
    });
    const dry = await reconcileBackfillSelection(queue(), { ...options, dry: true }, fx);
    expect(dry.reserved).toBe(false);
    expect(calls).toBe(0);
    const result = await reconcileBackfillSelection(queue(), options, fx);
    expect(calls).toBe(1);
    expect(result.reserved).toBe(true);
    expect(result.queue.get('durable')).toBe('yes');
  });
  it('does not reserve when a stale-target refresh hint fails', async () => {
    let gates = 0;
    const fx = effects({
      loadCoverage: async (target) => (target === 't1' ? null : { covered: new Map(), gaps: [] }),
      requestCoverage: async () => {
        throw new Error('hint failed');
      },
      admitGate: async (q) => {
        gates++;
        return { queue: q, admitted: true };
      },
    });
    await expect(reconcileBackfillSelection(queue(), options, fx)).rejects.toThrow('hint failed');
    expect(gates).toBe(0);
  });
  it('requests stale and gap snapshots, and never selects either', async () => {
    const requests: string[][] = [];
    const result = await reconcileBackfillSelection(
      queue(),
      options,
      effects({
        loadCoverage: async (target) =>
          target === 't1' ? null : { covered: new Map(), gaps: ['gap'] },
        requestCoverage: async (_head, targets) => {
          requests.push([...targets]);
        },
      }),
    );
    expect(result.candidate).toBeNull();
    expect(result.available).toBe(false);
    expect(getItem(result.queue, 0).get('wait_reason')).toBe(COVERAGE_PENDING);
    expect(getItem(result.queue, 1).get('wait_reason')).toBe(MISSING_EVIDENCE);
    expect(requests).toEqual([['t1', 't2']]);
    expect(result.queue.has('backfill_coverage_reconciled')).toBe(false);
  });
  it('marks covered jobs done and returns next uncovered candidate without reserving', async () => {
    const result = await reconcileBackfillSelection(
      queue(),
      options,
      effects({
        loadCoverage: async (target) => ({
          covered: target === 't1' ? new Map([['a', new Set([1, 2])]]) : new Map(),
          gaps: [],
        }),
      }),
    );
    expect(getItem(result.queue, 0).get('state')).toBe('done');
    expect(getItem(result.queue, 0).get('coverage_satisfied_by')).toBe('head');
    expect(result.candidate).toBe(1);
    expect(result.available).toBe(true);
    expect(result.queue.has('backfill_reservations')).toBe(false);
  });
  it('records refusal reconciliation and skips repeat reads', async () => {
    let reads = 0;
    const fx = effects({
      probeGate: async (q, i) => {
        const items = q.get('items');
        if (!Array.isArray(items)) throw new Error('bad items');
        return {
          queue: withObjectKeys(q, [
            [
              'items',
              items.map((v, n) =>
                n === i ? withObjectKeys(getItem(q, i), [['wait_reason', 'quota']]) : v,
              ),
            ],
          ]),
          admitted: false,
        };
      },
      loadCoverage: async () => {
        reads++;
        return { covered: new Map(), gaps: [] };
      },
    });
    const first = await reconcileBackfillSelection(queue(), options, fx);
    expect(first.candidate).toBeNull();
    expect(first.available).toBe(true);
    expect(getItem(first.queue, 0).get('wait_reason')).toBe('quota');
    const second = await reconcileBackfillSelection(first.queue, options, fx);
    expect(reads).toBe(2);
    expect(second.available).toBe(true);
  });
  it('reorders by the least important remaining uncovered path', async () => {
    const q = queue();
    const items = q.get('items');
    if (!Array.isArray(items)) throw new Error('bad items');
    const first = withObjectKeys(getItem(q, 0), [
      [
        'scope',
        object(
          '{"scope":[{"path":"a","blob":"b","intervals":[[1,2]]},{"path":"z","blob":"c","intervals":[[1,1]]}]}',
        ).get('scope')!,
      ],
      ['path_tiers', object('{"a":"T1","z":"T4"}')],
    ]);
    const result = await reconcileBackfillSelection(
      withObjectKeys(q, [['items', [first, items[1]!]]]),
      options,
      effects({
        loadCoverage: async (target) => ({
          covered: target === 't1' ? new Map([['a', new Set([1, 2])]]) : new Map(),
          gaps: [],
        }),
      }),
    );
    expect(result.candidate).toBe(1);
    expect(getItem(result.queue, 0).get('dispatch_tier_importance')).toBe('T4');
  });
  it('does not request refresh in dry mode and fails closed on pending event', async () => {
    let requests = 0;
    const fx = effects({
      loadCoverage: async () => null,
      requestCoverage: async () => {
        requests++;
      },
    });
    await reconcileBackfillSelection(queue(), { ...options, dry: true }, fx);
    expect(requests).toBe(0);
    const q = queue();
    const items = q.get('items');
    if (!Array.isArray(items)) throw new Error('bad items');
    const changed = withObjectKeys(q, [
      [
        'items',
        [
          withObjectKeys(getItem(q, 0), [['refusal_state_event', object('{"reason":"x"}')]]),
          items[1]!,
        ],
      ],
    ]);
    await expect(reconcileBackfillSelection(changed, options, fx)).rejects.toThrow(
      'pending refusal state events',
    );
  });
});
