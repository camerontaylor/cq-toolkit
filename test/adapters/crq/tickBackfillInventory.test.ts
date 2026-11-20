import { mkdtemp, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tickBackfillInventory } from '../../../src/adapters/crq/tickBackfillInventory.js';
import type { PreparedInventory } from '../../../src/ops/crq/internal/backfillTransaction.js';
import { JsonObject, parseJsonValue } from '../../../src/policy/crq/jsonValue.js';

const obj = (text: string): JsonObject => {
  const value = parseJsonValue(text);
  if (!(value instanceof JsonObject)) throw new Error('expected object');
  return value;
};

const rollout = {
  operational_ruling: true,
  no_live_run_verification: true,
  owner_branch_ruleset_evidence: true,
  durable_artifact_root: '/artifacts',
  runner_identity: 'crq-runner-app',
  publisher_spool: { ssh_alias: 'runner@example.com', key: '/key' },
  enabled: true,
  inventory_mode: 'integrated',
};

async function stateRoot(config: unknown = rollout): Promise<string> {
  // `null` means no rollout file: `undefined` would select the default.
  const root = await mkdtemp(join(tmpdir(), 'tick-inventory-'));
  if (config !== null) await writeFile(join(root, 'backfill-rollout.json'), JSON.stringify(config));
  return root;
}

const job = (id: string, state: string, created = '2026-01-01T00:00:00Z'): string =>
  `{"id":"${id}","kind":"backfill","family":"f","subject_id":"s-${id}","job_id":"${id}:0","generation":0,"state":"${state}","created_at":"${created}"}`;

describe('tick inventory binding', () => {
  it('reports the rollout inventory mode', async () => {
    const tick = tickBackfillInventory({ stateRoot: await stateRoot(), cloneRoot: '/clone' });
    expect(await tick.inventoryMode()).toBe('integrated');
    const none = tickBackfillInventory({ stateRoot: await stateRoot(null), cloneRoot: '/c' });
    expect(await none.inventoryMode()).toBeNull();
  });
  it('requests retirement and the 32-job cap from the preparation', async () => {
    const root = await stateRoot();
    let seen: unknown;
    const queue = obj('{"items":[]}');
    const tick = tickBackfillInventory({
      stateRoot: root,
      cloneRoot: '/clone',
      async prepare(q, enqueue, options) {
        seen = { enqueue, options };
        return { queue: q, ranked: {}, report: {}, eventItems: [] };
      },
    });
    await tick.inventory(queue);
    expect(seen).toEqual({ enqueue: true, options: { retire: true, enqueueLimit: 32 } });
  });
  it('spools retire events before enqueue events, writes artifacts, clears the halt, saves', async () => {
    const root = await stateRoot();
    const live = obj(
      `{"items":[${job('old', 'skipped')},${job('new', 'pending', '2026-01-02T00:00:00Z')}],"scheduler":1,"backfill_halted":"boom","backfill_halt_operation":"inventory"}`,
    );
    const prepared: PreparedInventory = {
      queue: live,
      ranked: { ranked: 1 },
      report: { report: 1 },
      eventItems: ['new'],
      retired: [{ id: 'old', at: '2026-01-03T00:00:00Z' }],
    };
    const tick = tickBackfillInventory({
      stateRoot: root,
      cloneRoot: '/clone',
      prepare: async () => prepared,
    });
    const out = await tick.inventory(live);
    expect(out.has('backfill_halted')).toBe(false);
    expect(out.has('backfill_halt_operation')).toBe(false);
    expect(out.get('scheduler')).toEqual(live.get('scheduler'));
    const events = out.get('backfill_state_events') as JsonObject;
    expect(events.entries.map(([key]) => key.split(':').slice(0, 3).join(':'))).toEqual([
      'job:old:0',
      'job:new:0',
    ]);
    const reasons: string[] = [];
    for (const [, id] of events.entries) {
      const event = obj(
        await readFile(join(root, 'backfill/publication/pending', `${String(id)}.json`), 'utf8'),
      );
      reasons.push(String((event.get('payload') as JsonObject).get('reason')));
    }
    expect(reasons).toEqual(['superseded by inventory', 'inventory enqueue']);
    expect(await readFile(join(root, 'backfill/latest-ranked.json'), 'utf8')).toBe('{"ranked":1}');
    expect(await readFile(join(root, 'backfill/latest-report.json'), 'utf8')).toBe('{"report":1}');
    expect(obj(await readFile(join(root, 'queue.json'), 'utf8')).has('backfill_halted')).toBe(
      false,
    );
    // Taking tick.lock here would deadlock a real tick: no lock file may be created.
    expect(await readdir(root)).not.toContain('tick.lock');
  });
  it('keeps a halt that belongs to another operation', async () => {
    const root = await stateRoot();
    const live = obj('{"items":[],"backfill_halted":"x","backfill_halt_operation":"harvest"}');
    const tick = tickBackfillInventory({
      stateRoot: root,
      cloneRoot: '/clone',
      prepare: async (q) => ({ queue: q, ranked: {}, report: {}, eventItems: [] }),
    });
    const out = await tick.inventory(live);
    expect(out.get('backfill_halt_operation')).toBe('harvest');
  });
  it('refuses an absent or disabled rollout before preparing anything', async () => {
    for (const [config, message] of [
      [null, 'operator rollout configuration required for inventory publication'],
      [{ ...rollout, enabled: false }, 'operator rollout must be enabled before inventory enqueue'],
    ] as const) {
      let prepared = false;
      const tick = tickBackfillInventory({
        stateRoot: await stateRoot(config),
        cloneRoot: '/clone',
        async prepare(q) {
          prepared = true;
          return { queue: q, ranked: {}, report: {}, eventItems: [] };
        },
      });
      await expect(tick.inventory(obj('{"items":[]}'))).rejects.toThrow(message);
      expect(prepared).toBe(false);
    }
  });
  it('aborts before publishing when the rollout disappears mid-run', async () => {
    const root = await stateRoot();
    const live = obj(
      `{"items":[${job('old', 'skipped')},${job('new', 'pending', '2026-01-02T00:00:00Z')}],"scheduler":1}`,
    );
    const prepared: PreparedInventory = {
      queue: live,
      ranked: { ranked: 1 },
      report: { report: 1 },
      eventItems: ['new'],
      retired: [{ id: 'old', at: '2026-01-03T00:00:00Z' }],
    };
    const tick = tickBackfillInventory({
      stateRoot: root,
      cloneRoot: '/clone',
      prepare: async () => {
        await unlink(join(root, 'backfill-rollout.json'));
        return prepared;
      },
    });
    // The writer spools nothing without the rollout, so the run must refuse
    // rather than save retired or enqueued jobs without their events.
    await expect(tick.inventory(live)).rejects.toThrow(
      'operator rollout removed during inventory; queue not saved',
    );
    await expect(readFile(join(root, 'queue.json'), 'utf8')).rejects.toThrow();
    await expect(readFile(join(root, 'backfill/latest-ranked.json'), 'utf8')).rejects.toThrow();
    await expect(readFile(join(root, 'backfill/latest-report.json'), 'utf8')).rejects.toThrow();
  });
});
