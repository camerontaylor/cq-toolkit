import { describe, expect, it } from 'vitest';
import { JsonObject, parseJsonValue } from '../../src/policy/crq/jsonValue.js';
import { withObjectKeys } from '../../src/policy/crq/queueDoc.js';
import {
  reserveAndSpawnReview,
  recoverReviewOwnership,
  ReviewSpawnError,
  type ReviewLaunchEffects,
  type ReviewLaunchInput,
} from '../../src/queue-runner/reviewLaunch.js';
function obj(v: unknown): JsonObject {
  return parseJsonValue(JSON.stringify(v)) as JsonObject;
}
function queue(kind = 'open'): JsonObject {
  return obj({
    items: [{ id: 'item', kind, state: 'pending', unknown: 1.5 }],
    starts: [],
    unknown: { keep: true },
  });
}
const input: ReviewLaunchInput = {
  itemIndex: 0,
  runId: 'item-20261114T000000Z',
  startedAt: '2026-11-14T00:00:00Z',
  band: 'interactive',
  meta: obj({
    run_id: 'item-20261114T000000Z',
    item_id: 'item',
    kind: 'open',
    started_at: '2026-11-14T00:00:00Z',
    band: 'interactive',
    base: 'base',
    head: 'head',
    label: 'cycle',
  }),
};
function item(q: JsonObject): JsonObject {
  return (q.get('items') as JsonObject[])[0]!;
}
function run(q: JsonObject): JsonObject {
  return item(q).get('run') as JsonObject;
}
function effects(overrides: Partial<ReviewLaunchEffects> = {}): ReviewLaunchEffects {
  return {
    writeMeta: async () => {},
    workStarted: async () => {},
    saveQueue: async () => {},
    spawn: async () => 123,
    event: async () => {},
    nowIso: () => 'later',
    ...overrides,
  };
}
describe('detached review reservation', () => {
  it('persists reservation before spawn and PID before started event', async () => {
    const order: string[] = [];
    const saves: JsonObject[] = [];
    const original = queue();
    const result = await reserveAndSpawnReview(
      original,
      input,
      effects({
        writeMeta: async () => {
          order.push('meta');
        },
        workStarted: async () => {
          order.push('work');
        },
        saveQueue: async (q) => {
          saves.push(q);
          order.push('save');
        },
        spawn: async () => {
          order.push('spawn');
          return 123;
        },
        event: async (event) => {
          order.push(event);
        },
      }),
    );
    expect(order).toEqual(['meta', 'work', 'save', 'spawn', 'save', 'review_started']);
    expect(run(saves[0]!).get('launch_pending')).toBe(true);
    expect(run(saves[0]!).get('pid')).toBeNull();
    expect(run(saves[1]!).get('launch_pending')).toBe(false);
    expect(item(result.queue).get('state')).toBe('reviewing');
    expect(item(original).get('state')).toBe('pending');
    expect(result.queue.get('unknown')).toBe(original.get('unknown'));
    expect(result.queue.get('starts') as unknown[]).toEqual([input.startedAt]);
  });
  it('never spawns after metadata or reservation save failure', async () => {
    for (const fail of ['meta', 'save']) {
      let spawns = 0;
      const e = effects({
        writeMeta: async () => {
          if (fail === 'meta') throw new Error('meta');
        },
        saveQueue: async () => {
          if (fail === 'save') throw new Error('save');
        },
        spawn: async () => {
          spawns++;
          return 123;
        },
      });
      await expect(reserveAndSpawnReview(queue(), input, e)).rejects.toThrow(fail);
      expect(spawns).toBe(0);
    }
  });
  it('rejects inconsistent metadata before writing or reserving', async () => {
    let writes = 0;
    await expect(
      reserveAndSpawnReview(
        queue('author'),
        input,
        effects({
          writeMeta: async () => {
            writes++;
          },
        }),
      ),
    ).rejects.toThrow('invalid launch metadata');
    expect(writes).toBe(0);
  });
  it('retains reservation on crash after spawn before PID save, never redispatches', async () => {
    let durable = queue();
    let saves = 0,
      spawns = 0;
    const e = effects({
      saveQueue: async (q) => {
        if (++saves === 2) throw new Error('crash');
        durable = q;
      },
      spawn: async () => {
        spawns++;
        return 123;
      },
    });
    await expect(reserveAndSpawnReview(durable, input, e)).rejects.toThrow('crash');
    expect(run(durable).get('launch_pending')).toBe(true);
    await expect(reserveAndSpawnReview(durable, input, e)).rejects.toThrow('not launchable');
    expect(spawns).toBe(1);
    const probes = {
      hasExit: false,
      runnerAlive: false,
      cliAlive: false,
      runnerGroupAlive: false,
      wrapperGroupAlive: null,
    };
    expect(recoverReviewOwnership(input.runId, null, null, probes)).toBe('ambiguous');
    const pidfile = {
      run_id: input.runId,
      pid: 123,
      pgid: 123,
      sid: 123,
      group_owner: 'foreground-v1',
    };
    expect(
      recoverReviewOwnership(input.runId, null, pidfile, { ...probes, runnerGroupAlive: true }),
    ).toBe('alive');
    expect(recoverReviewOwnership(input.runId, null, pidfile, { ...probes, hasExit: true })).toBe(
      'harvest',
    );
  });
  it('consumes failed author and local-review starts but preserves other reservations', async () => {
    for (const kind of ['author', 'local-review', 'open']) {
      let durable = queue(kind);
      const order: string[] = [];
      const e = effects({
        saveQueue: async (q) => {
          durable = q;
          order.push('save');
        },
        spawn: async () => {
          throw new ReviewSpawnError('unavailable');
        },
        event: async (name) => {
          order.push(name);
        },
      });
      const matchingInput = { ...input, meta: withObjectKeys(input.meta, [['kind', kind]]) };
      if (kind === 'open')
        await expect(reserveAndSpawnReview(durable, matchingInput, e)).rejects.toThrow(
          'unavailable',
        );
      else await reserveAndSpawnReview(durable, matchingInput, e);
      expect(item(durable).get('state')).toBe(
        kind === 'author' ? 'author_failed' : kind === 'local-review' ? 'failed' : 'reviewing',
      );
      expect(durable.get('starts') as unknown[]).toHaveLength(1);
      expect(run(durable).get('launch_pending')).toBe(kind === 'open');
      expect(order).toEqual(kind === 'open' ? ['save'] : ['save', 'spawn_failed', 'save']);
    }
  });
  it('preserves reservation on unexpected spawn error and ignores telemetry failure', async () => {
    let durable = queue();
    await expect(
      reserveAndSpawnReview(
        durable,
        input,
        effects({
          workStarted: async () => {
            throw new Error('telemetry');
          },
          saveQueue: async (q) => {
            durable = q;
          },
          spawn: async () => {
            throw new Error('unknown');
          },
        }),
      ),
    ).rejects.toThrow('unknown');
    expect(run(durable).get('launch_pending')).toBe(true);
  });
});
