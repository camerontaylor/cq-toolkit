import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createBackfillTransactionEffects } from '../../../src/adapters/crq/backfillTransactionSource.js';
import { inventoryTransaction } from '../../../src/ops/crq/backfillTransaction.js';
import { JsonObject, parseJsonValue } from '../../../src/policy/crq/jsonValue.js';

const obj = (text: string): JsonObject => {
  const value = parseJsonValue(text);
  if (!(value instanceof JsonObject)) throw new Error('expected object');
  return value;
};

describe('backfill transaction file effects', () => {
  it('commits prepared inventory against a fresh real queue and spools before saving', async () => {
    const root = await mkdtemp(join(tmpdir(), 'backfill-transaction-'));
    await writeFile(
      join(root, 'backfill-rollout.json'),
      JSON.stringify({
        operational_ruling: true,
        no_live_run_verification: true,
        owner_branch_ruleset_evidence: true,
        durable_artifact_root: '/artifacts',
        runner_identity: 'crq-runner-app',
        publisher_spool: { ssh_alias: 'runner@example.com', key: '/key' },
      }),
    );
    await writeFile(
      join(root, 'queue.json'),
      '{"items":[],"scheduler":1,"backfill_halted":"error","backfill_halt_operation":"inventory"}',
    );
    const item = obj(
      '{"id":"i","kind":"backfill","family":"f","subject_id":"s","job_id":"j","generation":1,"state":"queued","created_at":"2026-01-01T00:00:00Z"}',
    );
    const effects = createBackfillTransactionEffects({
      stateRoot: root,
      async prepare(queue, enqueue) {
        expect(enqueue).toBe(true);
        await writeFile(
          join(root, 'queue.json'),
          '{"items":[],"scheduler":2,"backfill_halted":"error","backfill_halt_operation":"inventory"}',
        );
        return {
          queue: new JsonObject([
            ...queue.entries.filter(([key]) => key !== 'items'),
            ['items', [item]],
          ]),
          ranked: { candidates: [] },
          report: { ok: true },
          eventItems: ['i'],
        };
      },
    });
    expect(await inventoryTransaction(effects, { reportOnly: false })).toEqual({ ok: true });
    const saved = obj(await readFile(join(root, 'queue.json'), 'utf8'));
    expect(saved.get('scheduler')).toEqual(obj('{"n":2}').get('n'));
    expect(saved.has('backfill_halted')).toBe(false);
    expect(saved.get('items')).toEqual([item]);
    expect(saved.get('backfill_state_events')).toBeInstanceOf(JsonObject);
    expect(await readdir(join(root, 'backfill/publication/pending'))).toHaveLength(1);
    expect(await readFile(join(root, 'backfill/latest-ranked.json'), 'utf8')).toBe(
      '{"candidates":[]}',
    );
    expect(await readFile(join(root, 'backfill/latest-report.json'), 'utf8')).toBe('{"ok":true}');
  });
  it('refuses a changed rollout without persisting the prepared inventory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'backfill-transaction-'));
    const config = {
      operational_ruling: true,
      no_live_run_verification: true,
      owner_branch_ruleset_evidence: true,
      durable_artifact_root: '/artifacts',
      runner_identity: 'crq-runner-app',
      publisher_spool: { ssh_alias: 'runner@example.com', key: '/key' },
      extra: 1,
    };
    await writeFile(join(root, 'backfill-rollout.json'), JSON.stringify(config));
    await writeFile(join(root, 'queue.json'), '{"items":[]}');
    const effects = createBackfillTransactionEffects({
      stateRoot: root,
      async prepare(queue) {
        await writeFile(
          join(root, 'backfill-rollout.json'),
          JSON.stringify({ ...config, extra: 2 }),
        );
        return { queue, ranked: {}, report: {}, eventItems: [] };
      },
    });
    await expect(inventoryTransaction(effects, { reportOnly: false })).rejects.toThrow(
      'snapshot stale',
    );
    expect(await readFile(join(root, 'queue.json'), 'utf8')).toBe('{"items":[]}');
    await expect(readFile(join(root, 'backfill/latest-report.json'))).rejects.toThrow();
  });
  it('evaluates created_at even if publication is disabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'backfill-transaction-'));
    const effects = createBackfillTransactionEffects({
      stateRoot: root,
      prepare: async (queue) => ({ queue, ranked: null, report: null, eventItems: [] }),
    });
    await expect(effects.stateEvent(new JsonObject([]), obj('{"kind":"other"}'))).rejects.toThrow(
      'created_at',
    );
  });
  it('retains and reuses state events after a lost queue save', async () => {
    const root = await mkdtemp(join(tmpdir(), 'backfill-transaction-'));
    await writeFile(
      join(root, 'backfill-rollout.json'),
      JSON.stringify({
        operational_ruling: true,
        no_live_run_verification: true,
        owner_branch_ruleset_evidence: true,
        durable_artifact_root: '/artifacts',
        runner_identity: 'crq-runner-app',
        publisher_spool: { ssh_alias: 'runner@example.com', key: '/key' },
        extra: { a: 1 },
      }),
    );
    const effects = createBackfillTransactionEffects({
      stateRoot: root,
      prepare: async (queue) => ({ queue, ranked: null, report: null, eventItems: [] }),
    });
    const config = await effects.settings();
    expect(config).toBeInstanceOf(JsonObject);
    expect((config as JsonObject).has('extra')).toBe(true);
    const item = obj(
      '{"kind":"backfill","family":"f","subject_id":"s","job_id":"j","generation":1,"state":"queued","created_at":"2026-01-01T00:00:00Z"}',
    );
    const queue = new JsonObject([]);
    const first = await effects.stateEvent(queue, item);
    const second = await effects.stateEvent(queue, item);
    expect(second).toEqual(first);
    expect(await effects.stateEvent(first, item)).toEqual(first);
    const names = await readdir(join(root, 'backfill/publication/pending'));
    expect(names).toHaveLength(1);
    const event = obj(
      await readFile(join(root, 'backfill/publication/pending', names[0]!), 'utf8'),
    );
    expect(event.get('event_type')).toBe('job-state');
    expect((event.get('payload') as JsonObject).get('reason')).toBe('inventory enqueue');
  });
  it('persists canonical artifacts and only clears its own halt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'backfill-transaction-'));
    await mkdir(join(root, 'backfill'));
    const effects = createBackfillTransactionEffects({
      stateRoot: root,
      prepare: async (queue) => ({ queue, ranked: null, report: null, eventItems: [] }),
    });
    expect(await effects.settings()).toBeNull();
    await effects.writeRanked(obj('{"z":1,"a":2}'));
    expect(await readFile(join(root, 'backfill/latest-ranked.json'), 'utf8')).toBe('{"a":2,"z":1}');
    const queue = obj(
      '{"items":[],"backfill_halted":"bad","backfill_halt_operation":"inventory","other":true}',
    );
    const cleared = effects.clearHalt(queue);
    expect(cleared.has('backfill_halted')).toBe(false);
    expect(cleared.get('other')).toBe(true);
    await effects.saveQueue(cleared);
    expect(await effects.loadQueue()).toEqual(cleared);
  });
});
