import { mkdtempSync, readFileSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { atomicWriteSync } from '../../../src/adapters/crq/atomic.js';
import {
  composeSlot,
  composeTickPhases,
  type ComposeInput,
} from '../../../src/adapters/crq/composeTick.js';
import { JsonObject, parseJsonValue, toPlainJson } from '../../../src/policy/crq/jsonValue.js';
import type { TickPhases } from '../../../src/queue-runner/tickOrchestrator.js';

const doc = (v: unknown): JsonObject => parseJsonValue(JSON.stringify(v)) as JsonObject;
const NOW = Date.parse('2027-01-15T08:00:00Z');
const dir = (): string => mkdtempSync(join(tmpdir(), 'compose-'));

function setup(queue: unknown = { items: [], starts: [], last_tick: '2027-01-15T07:59:00Z' }) {
  const root = dir();
  const home = dir();
  writeFileSync(join(root, 'queue.json'), JSON.stringify(queue, null, 2) + '\n');
  const calls: string[] = [];
  const unbound = (name: string) => async () => {
    throw new Error(`unbound ${name}`);
  };
  const remaining = {
    fetch: unbound('fetch'),
    backfillPublish: unbound('backfillPublish'),
    backfillInventoryMode: unbound('backfillInventoryMode'),
    backfillInventory: unbound('backfillInventory'),
    discovery: unbound('discovery'),
    harvestItems: unbound('harvestItems'),
    reconcileCompleted: unbound('reconcileCompleted'),
    repairBackfill: unbound('repairBackfill'),
    archiveLegacy: unbound('archiveLegacy'),
    reconcile: unbound('reconcile'),
    notifyOwner: unbound('notifyOwner'),
    enrollPrimary: unbound('enrollPrimary'),
    enrollOthers: unbound('enrollOthers'),
    recordCoverage: unbound('recordCoverage'),
    writeStatus: unbound('writeStatus'),
    publishLocalReviewPr: unbound('publishLocalReviewPr'),
    recordClientHealth: unbound('recordClientHealth'),
    readSlotUsage: async () => {
      calls.push('readSlotUsage');
      return { usage: { remaining: 1 }, reserved: [] };
    },
  } as unknown as ComposeInput['remaining'];
  const input: ComposeInput = {
    stateRoot: root,
    config: doc({ schedule_id: 'sched', alerts: { alert_agent_id: 'a' } }),
    watchdogHome: home,
    root: '/r',
    now: () => NOW,
    delivery: {
      gh: () => {
        throw new Error('gh');
      },
      authenticate: () => {
        throw new Error('auth');
      },
      files: { readBytes: () => new Uint8Array() } as never,
      readText: () => '',
      primaryRepo: 'o/r',
      push: {} as never,
    },
    admit: {
      config: { maxStartsPerHour: 5, maxStartsPerTick: 10, maxInflight: 10 },
      nowMicros: () => BigInt(NOW) * 1000n,
      startOne: async (queue) => {
        calls.push('startOne');
        const plain = toPlainJson(queue) as { starts: unknown[] };
        return {
          queue: doc({ ...plain, starts: [...plain.starts, '2027-01-15T08:00:00Z'] }),
          log: ['started'],
          hasCoverage: true,
        };
      },
    },
    remaining,
  };
  return { root, home, input, calls };
}

describe('composeTickPhases', () => {
  it('provides every TickPhases member exactly once', () => {
    const phases = composeTickPhases(setup().input);
    const expected: Array<keyof TickPhases> = [
      'runnerDisabled',
      'loadQueue',
      'fetch',
      'backfillPublish',
      'backfillInventoryMode',
      'backfillInventory',
      'discovery',
      'harvestItems',
      'reconcileCompleted',
      'deliverIssues',
      'deliverPrReviews',
      'deliverCleanReviews',
      'deliverReviewRefreshes',
      'repairBackfill',
      'archiveLegacy',
      'reconcile',
      'parseIso',
      'nowMs',
      'nowIso',
      'event',
      'notifyOwner',
      'enrollPrimary',
      'enrollOthers',
      'readSlotUsage',
      'admit',
      'recordCoverage',
      'saveQueue',
      'refreshSlotDeadline',
      'writeStatus',
      'writeHeartbeat',
      'publishLocalReviewPr',
      'recordClientHealth',
      'mergedDiscoveryEnabled',
    ];
    expect(Object.keys(phases).sort()).toEqual([...expected].sort());
  });

  it('writes the heartbeat once, through the single heartbeat seam', async () => {
    const { home, input } = setup();
    const phases = composeTickPhases(input);
    await phases.writeHeartbeat(doc({ last_tick: '2027-01-15T08:00:00Z' }));
    const beat = JSON.parse(readFileSync(join(home, 'heartbeat.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(beat).toMatchObject({
      last_tick: '2027-01-15T08:00:00Z',
      schedule_id: 'sched',
      root: '/r',
      alert_agent_id: 'a',
    });
  });

  it('refreshes the slot deadline hint and returns the queue unchanged', async () => {
    const { root, input } = setup();
    const phases = composeTickPhases(input);
    const queue = doc({ items: [{ id: 'a', state: 'pending' }], starts: [] });
    const out = await phases.refreshSlotDeadline(queue, { remaining: 2 }, 2, null);
    expect(out).toBe(queue);
    expect(readFileSync(join(root, 'next-review-at'), 'utf8')).toBe('2027-01-15T08:12:00Z\n');
  });

  it('saves the queue through the file seam', async () => {
    const { root, input } = setup();
    await composeTickPhases(input).saveQueue(doc({ items: [], starts: ['x'] }));
    expect(JSON.parse(readFileSync(join(root, 'queue.json'), 'utf8'))).toMatchObject({
      starts: ['x'],
    });
  });
});

describe('composeSlot', () => {
  const run = (s: ReturnType<typeof setup>, collected: string[] = ['collected']) =>
    composeSlot({
      stateRoot: s.root,
      now: () => NOW,
      phases: composeTickPhases(s.input),
      collectFinished: async (queue) => {
        s.calls.push('collect');
        return { queue, log: collected };
      },
    })();

  it('collects, admits, saves and writes the next deadline under tick.lock', async () => {
    const s = setup({ items: [{ id: 'a', state: 'pending' }], starts: [] });
    const log = await run(s);
    expect(s.calls).toEqual(['readSlotUsage', 'collect', 'startOne']);
    expect(log).toEqual(['collected', 'started']);
    const saved = JSON.parse(readFileSync(join(s.root, 'queue.json'), 'utf8')) as {
      starts: unknown[];
    };
    expect(saved.starts).toHaveLength(1);
    expect(existsSync(join(s.root, 'next-review-at'))).toBe(true);
  });

  it('refuses while the runner is disabled', async () => {
    const s = setup();
    writeFileSync(join(s.root, 'runner-disabled'), '');
    expect(await run(s)).toEqual(['runner disabled for host handover']);
    expect(s.calls).toEqual([]);
  });

  it('skips admission when the next-review hint is in the future', async () => {
    const s = setup();
    writeFileSync(join(s.root, 'next-review-at'), '2027-01-15T09:00:00Z\n');
    expect(await run(s)).toEqual([]);
    expect(s.calls).toEqual([]);
  });

  it('discards the observation when the queue changed during the probe', async () => {
    const s = setup();
    const original = s.input.remaining.readSlotUsage;
    s.input = {
      ...s.input,
      remaining: {
        ...s.input.remaining,
        readSlotUsage: async (queue: JsonObject) => {
          writeFileSync(
            join(s.root, 'queue.json'),
            JSON.stringify({ items: [], starts: [], last_tick: 'changed' }),
          );
          return original(queue);
        },
      },
    };
    expect(await run(s)).toEqual(['queue changed during quota probe; retry next slot tick']);
    expect(s.calls).not.toContain('startOne');
  });
});

describe('atomicWriteSync', () => {
  it('replaces the file and leaves no temp behind', () => {
    const d = dir();
    const path = join(d, 'q.json');
    atomicWriteSync(path, 'one');
    atomicWriteSync(path, 'two');
    expect(readFileSync(path, 'utf8')).toBe('two');
    expect(readdirSync(d)).toEqual(['q.json']);
  });
});
