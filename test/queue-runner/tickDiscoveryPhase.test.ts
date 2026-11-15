import { describe, expect, it } from 'vitest';
import { JsonObject } from '../../src/policy/crq/jsonValue.js';
import type { ForgeBudget } from '../../src/policy/crq/forgeBudget.js';
import {
  runDiscoveryPhase,
  runEnrollmentPhase,
  runReconcilePhase,
  type DiscoveryPhaseEffects,
} from '../../src/queue-runner/tickDiscoveryPhase.js';

const q = (tag: string) => new JsonObject([['tag', tag]]);
const tagOf = (x: JsonObject) => x.get('tag');

/** A deferred queue with one awaiting-pr intent whose search finds no PR: refreshed, no transition. */
const withIntent = () =>
  new JsonObject([
    ['tag', 'start'],
    [
      'queue_client_requests',
      new JsonObject([
        [
          'rid-1',
          new JsonObject([
            [
              'binding',
              new JsonObject([
                ['kind', 'deferred-author'],
                ['repo', 'o/r'],
                ['producer', 'p'],
                ['head', 'h'],
                ['target', 't'],
              ]),
            ],
            ['state', 'awaiting-pr'],
          ]),
        ],
      ]),
    ],
  ]);

function setup(over: Partial<DiscoveryPhaseEffects> = {}) {
  const calls: string[] = [];
  const budgets: ForgeBudget[] = [];
  const saved: unknown[] = [];
  const fx: DiscoveryPhaseEffects = {
    nowIso: () => '2026-11-15T12:00:00Z',
    deferred: (b) => (
      budgets.push(b),
      {
        verify: async () => {
          throw new Error('unused');
        },
        find: async () => (calls.push('find'), []),
      }
    ),
    saveQueue: async (x) => void (calls.push('save'), saved.push(tagOf(x as JsonObject))),
    merged: async (x, b) => (
      calls.push('merged:' + String(tagOf(x))),
      budgets.push(b),
      { queue: q('after-merged'), log: ['M'] }
    ),
    push: async (x) => (
      calls.push('push:' + String(tagOf(x))),
      { queue: q('after-push'), log: ['P'] }
    ),
    ...over,
  };
  return { fx, calls, budgets, saved };
}

describe('runDiscoveryPhase', () => {
  it('does nothing for a dry tick or when only is set', async () => {
    for (const o of [
      { dry: true, only: null },
      { dry: false, only: 'x' },
      { dry: true, only: 'x' },
    ]) {
      const h = setup();
      const input = q('in');
      expect(await runDiscoveryPhase(input, o, h.fx)).toEqual({ queue: input, log: [] });
      expect(h.calls).toEqual([]);
    }
  });

  it('runs deferred refresh, saves it, then merged, then push, threading the queue and logs', async () => {
    const h = setup();
    const r = await runDiscoveryPhase(withIntent(), { dry: false, only: null }, h.fx);
    expect(h.calls).toEqual(['find', 'save', 'merged:start', 'push:after-merged']);
    expect(h.saved).toEqual(['start']);
    expect(tagOf(r.queue)).toBe('after-push');
    expect(r.log).toEqual(['refreshed 1 deferred author intent(s)', 'M', 'P']);
  });

  it('does not save or log an empty refresh, and still discovers', async () => {
    const h = setup();
    const r = await runDiscoveryPhase(q('in'), { dry: false, only: null }, h.fx);
    expect(h.calls).toEqual(['merged:in', 'push:after-merged']);
    expect(r.log).toEqual(['M', 'P']);
  });

  it('gives deferred refresh and merged discovery one shared 24-request budget, fresh each tick', async () => {
    const h = setup();
    await runDiscoveryPhase(withIntent(), { dry: false, only: null }, h.fx);
    const [d, m] = h.budgets;
    expect(d).toBe(m);
    expect(d?.remaining).toBe(24);
    expect(d?.seconds).toBe(30);
    await runDiscoveryPhase(q('in'), { dry: false, only: null }, h.fx);
    expect(h.budgets[2]).not.toBe(d);
  });

  it('stops refreshing intents once the shared budget is spent', async () => {
    const h = setup({
      deferred: (b) => {
        for (let i = 0; i < 24; i += 1) b.take();
        return {
          verify: async () => {
            throw new Error('unused');
          },
          find: async () => {
            throw new Error('must not read');
          },
        };
      },
    });
    const r = await runDiscoveryPhase(withIntent(), { dry: false, only: null }, h.fx);
    expect(r.log[0]).toBe('M');
    expect(h.calls).not.toContain('save');
  });

  it('abandons the tick on a deferred or discovery error', async () => {
    const a = setup({
      deferred: () => ({
        verify: async () => {
          throw new Error('x');
        },
        find: async () => {
          throw new Error('forge down');
        },
      }),
    });
    await expect(runDiscoveryPhase(withIntent(), { dry: false, only: null }, a.fx)).rejects.toThrow(
      'forge down',
    );
    expect(a.calls).not.toContain('merged:start');
    const b = setup({
      merged: async () => {
        throw new Error('disk');
      },
    });
    await expect(runDiscoveryPhase(q('in'), { dry: false, only: null }, b.fx)).rejects.toThrow(
      'disk',
    );
    expect(b.calls).not.toContain('push:in');
  });
});

describe('runEnrollmentPhase', () => {
  it('enrolls the primary repo before the others, threading the queue', async () => {
    const calls: string[] = [];
    const r = await runEnrollmentPhase(q('in'), false, {
      primary: async (x, dry) => (
        calls.push(`primary:${String(tagOf(x))}:${String(dry)}`),
        { queue: q('p'), log: ['A'] }
      ),
      others: async (x, dry) => (
        calls.push(`others:${String(tagOf(x))}:${String(dry)}`),
        { queue: q('o'), log: ['B'] }
      ),
    });
    expect(calls).toEqual(['primary:in:false', 'others:p:false']);
    expect(tagOf(r.queue)).toBe('o');
    expect(r.log).toEqual(['A', 'B']);
  });

  it('passes dry through and skips the others when primary throws', async () => {
    const calls: string[] = [];
    await expect(
      runEnrollmentPhase(q('in'), true, {
        primary: async (_x, dry) => {
          calls.push(String(dry));
          throw new Error('boom');
        },
        others: async () => (calls.push('others'), { queue: q('o'), log: [] }),
      }),
    ).rejects.toThrow('boom');
    expect(calls).toEqual(['true']);
  });
});

describe('runReconcilePhase', () => {
  function rec(result: unknown) {
    const events: Array<[string, Record<string, unknown>]> = [];
    const budgets: ForgeBudget[] = [];
    const fx = {
      reconcile: async (_q: JsonObject, b: ForgeBudget) => (budgets.push(b), result),
      event: async (k: 'reconcile_incomplete', d: Record<string, unknown>) =>
        void events.push([k, d]),
    };
    return { fx, events, budgets };
  }

  it('uses its own 80-request / 60 s budget', async () => {
    const h = rec({});
    await runReconcilePhase(q('in'), h.fx);
    expect(h.budgets[0]?.remaining).toBe(80);
    expect(h.budgets[0]?.seconds).toBe(60);
  });

  it('logs an examined pass, defaulting missing counts to 0, with no event when nothing starved', async () => {
    const h = rec({ examined: 12, projected: 12 });
    expect(await runReconcilePhase(q('in'), h.fx)).toEqual([
      'reconcile: 12 examined, 12 projected, 0 starved, 0 deferred',
    ]);
    expect(h.events).toEqual([]);
  });

  it('records reconcile_incomplete when starved or deferred, even if nothing was examined', async () => {
    const a = rec({ examined: 12, projected: 5, starved: 7, deferred: 0, errors: ['e'] });
    expect(await runReconcilePhase(q('in'), a.fx)).toEqual([
      'reconcile: 12 examined, 5 projected, 7 starved, 0 deferred',
    ]);
    expect(a.events).toEqual([
      [
        'reconcile_incomplete',
        { examined: 12, projected: 5, starved: 7, deferred: 0, errors: ['e'] },
      ],
    ]);
    const b = rec({ deferred: 2 });
    expect(await runReconcilePhase(q('in'), b.fx)).toEqual([]);
    expect(b.events).toEqual([
      ['reconcile_incomplete', { examined: 0, projected: 0, starved: 0, deferred: 2, errors: [] }],
    ]);
  });

  it('treats a non-object result as reporting nothing', async () => {
    for (const bad of [null, undefined, 5, 'x', [1], [{ examined: 3, starved: 1 }]]) {
      const h = rec(bad);
      expect(await runReconcilePhase(q('in'), h.fx)).toEqual([]);
      expect(h.events).toEqual([]);
    }
  });

  it('does not swallow a reconcile error', async () => {
    const fx = {
      reconcile: async () => {
        throw new Error('gh');
      },
      event: async () => undefined,
    };
    await expect(runReconcilePhase(q('in'), fx)).rejects.toThrow('gh');
  });
});
