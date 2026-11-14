import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { loadInventoryQueue } from '../../../src/adapters/crq/backfillQueueLoad.js';
import { JsonObject } from '../../../src/policy/crq/jsonValue.js';
import { queueBytes } from '../../../src/adapters/crq/queueEffects.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function queueFile(raw: string) {
  const root = await mkdtemp(join(tmpdir(), 'inventory-queue-'));
  roots.push(root);
  const path = join(root, 'queue.json');
  await writeFile(path, raw);
  return path;
}

test('loads compacted history without writing and retires only qualifying open jobs', async () => {
  const row = {
    at: 'today',
    observation: { remaining: 4, ignored: 'data' },
    reservations: { a: { quota_state: 'reserved', payload: 'x'.repeat(1000) } },
  };
  const source = {
    items: [
      { id: 'a', kind: 'open', state: 'pending', cycles: [{}], boost: 1, last_error: 'old' },
      { id: 'b', kind: 'open', state: 'blocked', cycles: [{}], optional_cycle: true, boost: 1 },
      { id: 'c', kind: 'promotion', boost: 1 },
    ],
    backfill_reservations: { a: { quota_state: 'reserved' } },
    backfill_admissions: Array.from({ length: 300 }, () => row),
  };
  const raw = JSON.stringify(source);
  const path = await queueFile(raw);
  const queue = await loadInventoryQueue(path);
  expect(await readFile(path, 'utf8')).toBe(raw);
  const parsed = JSON.parse(queueBytes(queue)) as typeof source & {
    backfill_admission_history_version: number;
  };
  expect(parsed.backfill_admissions).toHaveLength(256);
  expect(parsed.backfill_admission_history_version).toBe(1);
  expect(parsed.backfill_admissions[0]).toEqual({
    at: 'today',
    observation: { remaining: 4 },
    reservation_counts: { reserved: 1 },
  });
  expect(parsed.backfill_reservations).toEqual(source.backfill_reservations);
  expect(parsed.items).toEqual([
    { id: 'a', kind: 'open', state: 'done', cycles: [{}], last_error: null, not_before: null },
    { id: 'b', kind: 'open', state: 'blocked', cycles: [{}], optional_cycle: true },
    { id: 'c', kind: 'promotion', boost: 1 },
  ]);
  await writeFile(path, queueBytes(queue));
  expect(queueBytes(await loadInventoryQueue(path))).toBe(queueBytes(queue));
});

test('validates full input, duplicate keys and versions without changing disk', async () => {
  for (const raw of [
    '{"items":[],}',
    '{"items":[],"backfill_admissions":[{},]}',
    '{"items":[],"x":{"a":1,"a":2}}',
    '{"items":[],"items":[]}',
    '{"items":[{"kind":"open","state":"pending","cycles":"unexpected"}]}',
    '{"items":[]} extra',
    '{"items":[],"backfill_admission_history_version":null}',
    '{"items":[],"backfill_admission_history_version":2}',
  ]) {
    const path = await queueFile(raw);
    await expect(loadInventoryQueue(path)).rejects.toThrow();
    expect(await readFile(path, 'utf8')).toBe(raw);
  }
});

test('retains exact numeric values and handles UTF-8 across stream chunks', async () => {
  const raw = `{"items":[],"padding":"${'x'.repeat(65530)}😀","backfill_admissions":[{"observation":{"remaining":9007199254740993},"reservation_counts":{"x":9007199254740995}}]}`;
  const queue = await loadInventoryQueue(await queueFile(raw));
  const rows = queue.get('backfill_admissions');
  expect(Array.isArray(rows)).toBe(true);
  expect((rows as JsonObject[])[0]).toBeInstanceOf(JsonObject);
  const encoded = queueBytes(queue);
  expect(encoded).toContain('9007199254740993');
  expect(encoded).toContain('9007199254740995');
  expect(queue.get('padding')).toBe(`${'x'.repeat(65530)}😀`);
});
