import { describe, expect, it } from 'vitest';
import { JsonObject, parseJsonValue } from '../../src/policy/crq/jsonValue.js';
import { withObjectKeys } from '../../src/policy/crq/queueDoc.js';
import {
  discoverOpenPrs,
  type OpenPr,
  type PrDiscoveryEffects,
  type PrDiscoveryRepo,
} from '../../src/queue-runner/openPrDiscovery.js';
const head = 'a'.repeat(40),
  base = 'b'.repeat(40),
  old = 'c'.repeat(40);
const primary: PrDiscoveryRepo = {
  repo: 'O/R',
  name: 'main',
  primary: true,
  enabled: true,
  defaultBranch: 'main',
  branches: ['main'],
};
const foreign: PrDiscoveryRepo = {
  repo: 'x/y',
  name: 'other',
  primary: false,
  enabled: true,
  defaultBranch: 'trunk',
  branches: ['trunk'],
};
const pr: OpenPr = { number: 7, draft: false, base: 'main', headRef: 'feature', head };
function obj(value: unknown): JsonObject {
  return parseJsonValue(JSON.stringify(value)) as JsonObject;
}
function queue(items: unknown[] = []): JsonObject {
  return obj({ items, unknown: 1.5 });
}
function items(q: JsonObject): JsonObject[] {
  return q.get('items') as JsonObject[];
}
function effects(overrides: Partial<PrDiscoveryEffects> = {}): PrDiscoveryEffects {
  return {
    list: async () => [pr],
    fetchDefault: async () => {},
    rangeBase: async () => base,
    associate: async (q) => ({ queue: q, associated: false }),
    ownRange: async () => false,
    event: async () => {},
    nowIso: () => 'now',
    ...overrides,
  };
}
describe('open PR discovery', () => {
  it('emits one enrollment event and none for associated or equivalent work', async () => {
    const events: string[][] = [];
    const emit = async (id: string, reason: string) => {
      events.push([id, reason]);
    };
    await discoverOpenPrs(queue(), [primary], false, 'o/r', effects({ event: emit }));
    expect(events).toEqual([['pr7', 'now auto-enrolled: open PR not yet enrolled']]);
    events.length = 0;
    await discoverOpenPrs(
      queue(),
      [primary],
      false,
      'o/r',
      effects({ event: emit, associate: async (q) => ({ queue: q, associated: true }) }),
    );
    const cycle = {
      base,
      head,
      range_policy: 'full-range-once-v1',
      run_id: 'run',
      completed_at: '2025',
    };
    await discoverOpenPrs(
      queue([{ id: 'pr7', pr: 7, kind: 'open', state: 'done', cycles: [cycle] }]),
      [primary],
      false,
      'o/r',
      effects({ event: emit }),
    );
    expect(events).toEqual([]);
  });
  it('retains owed delta when repair proof throws and handles optional pending cycles', async () => {
    const previous = {
      id: 'pr7',
      pr: 7,
      kind: 'open',
      state: 'pending',
      cycles: [
        {
          base,
          head: old,
          range_policy: 'full-range-once-v1',
          run_id: 'run',
          completed_at: '2025',
        },
      ],
    };
    const result = await discoverOpenPrs(
      queue([previous]),
      [primary],
      false,
      'o/r',
      effects({
        ownRange: async () => {
          throw new Error('unavailable');
        },
      }),
    );
    expect(items(result.queue)[1]?.get('kind')).toBe('delta');
  });
  it('fetches foreign default and never applies primary repair proof to it', async () => {
    const calls: string[] = [];
    const previous = {
      id: 'other-pr7',
      repo: 'x/y',
      pr: 7,
      kind: 'open',
      state: 'done',
      cycles: [{ base, head: old, run_id: 'run', completed_at: '2025' }],
    };
    const result = await discoverOpenPrs(
      queue([previous]),
      [foreign],
      false,
      'o/r',
      effects({
        list: async () => [{ ...pr, base: 'trunk' }],
        fetchDefault: async () => {
          calls.push('fetch');
        },
        ownRange: async () => {
          calls.push('ownRange');
          return true;
        },
      }),
    );
    expect(calls).toEqual(['fetch']);
    expect(items(result.queue)[1]?.get('kind')).toBe('delta');
  });
  it('skips non-default foreign bases and distinguishes list from fetch failure', async () => {
    const configured = { ...foreign, branches: ['trunk', 'other'] };
    const skipped = await discoverOpenPrs(
      queue(),
      [configured],
      false,
      'o/r',
      effects({ list: async () => [{ ...pr, base: 'other' }] }),
    );
    expect(items(skipped.queue)).toHaveLength(0);
    expect(skipped.log[0]).toContain('targets other, not trunk');
    const noList = await discoverOpenPrs(
      queue(),
      [foreign],
      false,
      'o/r',
      effects({
        list: async () => {
          throw new Error('secret');
        },
      }),
    );
    const noFetch = await discoverOpenPrs(
      queue(),
      [foreign],
      false,
      'o/r',
      effects({
        fetchDefault: async () => {
          throw new Error('secret');
        },
      }),
    );
    expect(noList.log[0]).toContain('forge listing unavailable');
    expect(noFetch.log[0]).toContain('default branch fetch failed');
    expect([...noList.log, ...noFetch.log].join()).not.toContain('secret');
  });
  it('enrolls primary including stacked PR and filters drafts and unconnected chains', async () => {
    const parent = { ...pr, number: 3, headRef: 'parent' };
    const stacked = { ...pr, number: 4, base: 'parent', headRef: 'child' };
    const result = await discoverOpenPrs(
      queue(),
      [primary],
      false,
      'o/r',
      effects({
        list: async () => [
          stacked,
          { ...pr, number: 5, draft: true },
          { ...pr, number: 6, base: 'unknown' },
          parent,
        ],
      }),
    );
    expect(items(result.queue).map((i) => i.get('id'))).toEqual(['pr3', 'pr4']);
    expect(result.queue.get('unknown')).toBeInstanceOf(Object);
  });
  it('allows primary initial fallback, but foreign requires range and default branch', async () => {
    const e = effects({
      list: async (r) => [{ ...pr, base: r.primary ? 'main' : 'trunk' }],
      rangeBase: async () => null,
    });
    const result = await discoverOpenPrs(queue(), [primary, foreign], false, 'o/r', e);
    expect(items(result.queue).map((i) => i.get('id'))).toEqual(['pr7']);
    expect(result.log.some((line) => line.includes('range unavailable'))).toBe(true);
  });
  it('preserves returned association queue and suppresses enrollment when associated', async () => {
    const result = await discoverOpenPrs(
      queue(),
      [primary],
      false,
      'o/r',
      effects({
        associate: async (q) => ({
          queue: withObjectKeys(q, [['linked', true]]),
          associated: true,
        }),
      }),
    );
    expect(result.queue.get('linked')).toBe(true);
    expect(items(result.queue)).toHaveLength(0);
  });
  it('uses repo-scoped evidence, suppresses equivalent ranges and enrolls owed delta', async () => {
    const item = {
      id: 'pr7',
      pr: 7,
      repo: 'o/r',
      kind: 'open',
      state: 'done',
      cycles: [
        { base, head, range_policy: 'full-range-once-v1', run_id: 'run', completed_at: '2025' },
      ],
    };
    const matched = await discoverOpenPrs(queue([item]), [primary], false, 'o/r', effects());
    expect(items(matched.queue)).toHaveLength(1);
    const changed = await discoverOpenPrs(
      queue([{ ...item, cycles: [{ ...item.cycles[0], head: old }] }]),
      [primary],
      false,
      'o/r',
      effects(),
    );
    expect(items(changed.queue)[1]?.get('id')).toBe(
      `pr7-range-${base.slice(0, 10)}-${head.slice(0, 10)}`,
    );
    const owned = await discoverOpenPrs(
      queue([{ ...item, cycles: [{ ...item.cycles[0], head: old }] }]),
      [primary],
      false,
      'o/r',
      effects({ ownRange: async () => true }),
    );
    expect(items(owned.queue)).toHaveLength(1);
  });
  it('skips active nonoptional work, isolates repo reads, and respects dry event semantics', async () => {
    const active = queue([{ id: 'pr7', pr: 7, kind: 'open', state: 'reviewing', cycles: [] }]);
    expect(
      items((await discoverOpenPrs(active, [primary], false, 'o/r', effects())).queue),
    ).toHaveLength(1);
    let events = 0;
    const result = await discoverOpenPrs(
      queue(),
      [primary, foreign],
      true,
      'o/r',
      effects({
        list: async (r) => {
          if (r.primary) throw new Error('unavailable');
          return [{ ...pr, base: 'trunk' }];
        },
        event: async () => {
          events++;
        },
      }),
    );
    expect(items(result.queue)[0]?.get('id')).toBe('other-pr7');
    expect(events).toBe(0);
  });
});
