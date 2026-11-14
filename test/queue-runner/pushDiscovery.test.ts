import { describe, expect, it } from 'vitest';
import { JsonObject, parseJsonValue } from '../../src/policy/crq/jsonValue.js';
import {
  discoverPush,
  runPushDiscovery,
  type PushDiscoveryEffects,
  type PushDiscoveryRepo,
} from '../../src/queue-runner/pushDiscovery.js';

const base = 'a'.repeat(40);
const tip = 'b'.repeat(40);
const cfg: PushDiscoveryRepo = {
  repo: 'o/r',
  name: 'r',
  floor: null,
  quietMinutes: 10,
  enabled: true,
};
function obj(value: unknown): JsonObject {
  return parseJsonValue(JSON.stringify(value)) as JsonObject;
}
function queue(items: unknown[] = []): JsonObject {
  return obj({
    items,
    push_discovery: { 'o/r': { reviewed_tip: base, unknown: 1.5 } },
    unknown: { key: 'kept' },
  });
}
function effects(overrides: Partial<PushDiscoveryEffects> = {}): PushDiscoveryEffects {
  return {
    fetchTip: async () => tip,
    floorBase: async () => null,
    isAncestor: async () => true,
    commitTime: async () => 0,
    nowSeconds: () => 3600,
    nowIso: () => 'now',
    event: async () => {},
    ...overrides,
  };
}
function items(q: JsonObject): JsonObject[] {
  return q.get('items') as JsonObject[];
}
function record(q: JsonObject): JsonObject {
  return (q.get('push_discovery') as JsonObject).get('o/r') as JsonObject;
}

describe('push discovery', () => {
  it('initializes floor without enrolling and persists even an empty pass', async () => {
    let saved: JsonObject | undefined;
    const original = obj({ items: [], extra: 1 });
    const result = await runPushDiscovery([{ ...cfg, floor: '2025-01-01' }], false, 'main/repo', {
      ...effects({ floorBase: async () => base }),
      loadQueue: async () => original,
      saveQueue: async (q) => {
        saved = q;
      },
    });
    expect(record(result.queue).get('reviewed_tip')).toBe(base);
    expect(items(result.queue)).toHaveLength(0);
    expect(saved).toBe(result.queue);
    expect(original.get('push_discovery')).toBeUndefined();
  });
  it('coalesces only unpinned whole ranges and retains unknown data', async () => {
    const original = queue([
      {
        id: 'old',
        repo: 'o/r',
        kind: 'push-current',
        state: 'pending',
        subject: {},
        notes: [],
        order: 3,
        custom: 'retain',
      },
      {
        id: 'part',
        repo: 'o/r',
        kind: 'push-current',
        state: 'pending',
        subject: { paths_filter: ['x'] },
        depends_on: 'parent',
        order: 4,
      },
    ]);
    const events: string[] = [];
    const result = await discoverPush(
      original,
      [cfg],
      false,
      'main/repo',
      effects({
        event: async (kind) => {
          events.push(kind);
        },
      }),
    );
    expect(items(result.queue).map((i) => i.get('state'))).toEqual([
      'skipped',
      'pending',
      'pending',
    ]);
    expect(items(result.queue)[0]?.get('custom')).toBe('retain');
    expect(items(original)[0]?.get('state')).toBe('pending');
    expect(items(result.queue)[2]?.get('id')).toBe(
      `push-r-${base.slice(0, 10)}-${tip.slice(0, 10)}`,
    );
    expect(record(result.queue).get('reviewed_tip')).toBe(base);
    expect(result.queue.get('unknown')).toBe(original.get('unknown'));
    expect(events).toEqual(['enrolled']);
  });
  it('retains captured lane, honors quiet window and does not coalesce same pending range', async () => {
    const id = `push-r-${base.slice(0, 10)}-${tip.slice(0, 10)}`;
    for (const item of [
      {
        id: 'captured',
        repo: 'o/r',
        kind: 'push-current',
        state: 'blocked',
        capture: { run: 'x' },
      },
      { id, repo: 'o/r', kind: 'push-current', state: 'pending', subject: {} },
    ]) {
      const result = await discoverPush(queue([item]), [cfg], false, 'main/repo', effects());
      expect(items(result.queue)).toHaveLength(1);
      expect(items(result.queue)[0]?.get('state')).toBe(item.state);
    }
    const quiet = await discoverPush(
      queue(),
      [cfg],
      false,
      'main/repo',
      effects({ commitTime: async () => 3599 }),
    );
    expect(items(quiet.queue)).toHaveLength(0);
  });
  it('resets divergence without enrollment and dry runs never mutate', async () => {
    const original = queue();
    const events: string[] = [];
    const result = await discoverPush(
      original,
      [cfg],
      false,
      'main/repo',
      effects({
        isAncestor: async () => false,
        event: async (kind) => {
          events.push(kind);
        },
      }),
    );
    expect(record(result.queue).get('reviewed_tip')).toBe(tip);
    expect(items(result.queue)).toHaveLength(0);
    expect(events).toEqual(['push_divergence']);
    const dry = await discoverPush(original, [cfg], true, 'main/repo', effects());
    expect(dry.queue).toBe(original);
    expect(dry.log[0]).toContain('DRY-RUN');
  });
  it('isolates a repo error, retains event-ordered changes, and propagates save failure', async () => {
    const result = await discoverPush(
      queue(),
      [cfg, { ...cfg, repo: 'other/repo', name: 'other' }],
      false,
      'main/repo',
      effects({
        fetchTip: async (repo) => {
          if (repo.repo === 'o/r') throw new Error('offline');
          return tip;
        },
      }),
    );
    expect(result.log[0]).toContain('skipped o/r');
    expect(
      ((result.queue.get('push_discovery') as JsonObject).get('other/repo') as JsonObject).get(
        'reviewed_tip',
      ),
    ).toBe(tip);
    const eventFailure = await discoverPush(
      queue(),
      [cfg],
      false,
      'main/repo',
      effects({
        event: async () => {
          throw new Error('disk');
        },
      }),
    );
    expect(items(eventFailure.queue)).toHaveLength(1);
    await expect(
      runPushDiscovery([], false, 'main/repo', {
        ...effects(),
        loadQueue: async () => queue(),
        saveQueue: async () => {
          throw new Error('save');
        },
      }),
    ).rejects.toThrow('save');
  });
});
