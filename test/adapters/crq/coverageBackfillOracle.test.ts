import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  bindBindRun,
  bindCancelBeforeVendor,
  bindRank4Gate,
  syncInto,
} from '../../../src/adapters/crq/coverageBackfillSeams.js';
import type { Item, Queue } from '../../../src/queue-runner/coverageUsage.js';

/**
 * Replays the Python 3.14 oracle (apps/crq-python/coverage_backfill_vectors.py):
 * the production `backfill_runtime.rank4_gate`, `backfill_jobs.bind_run` and
 * `cancel_before_vendor`. Result, the queue left behind and the ordered
 * collaborator trace are compared; a raised exception compares by Python class
 * (the `pythonError` of the TS error); message text is the TS port's own and is not
 * compared. Python AttributeError (dict method on a non-dict table) maps to the
 * port's TypeError, the one deliberate class deviation.
 */
interface Refresh {
  success: boolean;
  usage: Record<string, unknown> | null;
}
interface Spec {
  fn: 'rank4' | 'bind' | 'cancel';
  queue: Queue;
  index: number;
  dry?: boolean;
  ordinary?: boolean;
  refresh?: Refresh | null;
  now?: string;
  event_mutates?: boolean;
  run_id?: string;
}
interface Case {
  name: string;
  spec: Spec;
  result: {
    ok?: { admitted?: boolean; queue: unknown };
    raises?: string;
    message?: string;
    trace?: unknown[];
  };
}

const fixture = JSON.parse(
  readFileSync(
    new URL('../../../apps/crq-python/fixtures/crq-coverage-backfill/cases.json', import.meta.url),
    'utf8',
  ),
) as { schema: string; cases: Case[] };

async function replay(spec: Spec) {
  const queue = structuredClone(spec.queue);
  const item = queue.items[spec.index] as Item;
  const trace: unknown[] = [];
  try {
    if (spec.fn === 'bind') bindBindRun(queue, item, spec.run_id as string);
    else if (spec.fn === 'cancel') bindCancelBeforeVendor(queue, item);
    else {
      const refresh = spec.refresh ?? null;
      const gate = bindRank4Gate({
        iso: () => spec.now as string,
        ordinaryEligible: () => spec.ordinary as boolean,
        ...(refresh === null
          ? {}
          : {
              refreshUsage: async (q: Queue) => {
                trace.push(['refresh']);
                if (!refresh.success) return false;
                q.backfill_usage = structuredClone(refresh.usage);
                q.backfill_starts_at_observation = Array.isArray(q.starts) ? q.starts.length : 0;
                return true;
              },
            }),
        stateEvent: async (q, it, at, reason) => {
          trace.push(['state_event', it.id, at, reason, structuredClone(it)]);
          if (spec.event_mutates) {
            const events = (q.backfill_state_events ?? {}) as Record<string, unknown>;
            events.k = 'e1';
            q.backfill_state_events = events;
          }
        },
        saveQueue: async (q) => {
          trace.push(['save', structuredClone(q)]);
        },
      });
      const admitted = await gate(queue, item, spec.dry as boolean);
      return { ok: { admitted, queue }, trace };
    }
    return { ok: { queue }, trace };
  } catch (error) {
    const raises = (error as { pythonError?: string }).pythonError ?? (error as Error).name;
    return { raises, message: (error as Error).message, trace };
  }
}

describe('coverage backfill seams against the Python oracle', () => {
  it('reads the fixture it was written for', () => {
    expect(fixture.schema).toBe('crq-coverage-backfill-oracle/1');
    expect(fixture.cases.length).toBeGreaterThan(80);
  });

  for (const c of fixture.cases) {
    it(c.name, async () => {
      const got = await replay(c.spec);
      if (c.result.raises !== undefined) {
        // The ledger error classes have no AttributeError: Python's `.get`/`.values()`
        // on a non-dict table surfaces as the port's TypeError (both refuse, same point).
        expect(got.raises).toBe(
          c.result.raises === 'AttributeError' ? 'TypeError' : c.result.raises,
        );
      } else {
        expect(got.raises).toBeUndefined();
        expect(JSON.parse(JSON.stringify(got.ok))).toEqual(c.result.ok);
      }
      if (c.spec.fn === 'rank4') expect(got.trace).toEqual(c.result.trace);
    });
  }
});

describe('syncInto', () => {
  it('keeps object and array identity, drops stale keys, grows and shrinks arrays', () => {
    const inner = { a: 1 };
    const target: Record<string, unknown> = { items: [inner, { b: 2 }], stale: true };
    const items = target.items;
    syncInto(target, { items: [{ a: 2 }], fresh: 1 });
    expect(target).toEqual({ items: [{ a: 2 }], fresh: 1 });
    expect(target.items).toBe(items);
    expect((target.items as unknown[])[0]).toBe(inner);
  });
});
