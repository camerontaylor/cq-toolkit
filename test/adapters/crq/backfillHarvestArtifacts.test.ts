import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { backfillArtifactReader } from '../../../src/adapters/crq/backfillHarvestArtifacts.js';
import { harvestBackfillFailure } from '../../../src/ops/crq/internal/backfillHarvest.js';
import { JsonObject, parseJsonValue } from '../../../src/policy/crq/jsonValue.js';

describe('backfill artifact reader', () => {
  it('harvests a verified failure from disposable run files', async () => {
    const root = await mkdtemp(
      join(process.env.JCODE_SCRATCH_DIR ?? tmpdir(), 'backfill-harvest-'),
    );
    try {
      const dir = join(root, 'runs', 'r');
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, 'meta.json'),
        '{"run_id":"r","item_id":"j","backfill":{"attempt_id":"a"}}',
      );
      await writeFile(join(dir, 'exit.json'), '{"exit":1,"ended_at":"2026-10-30T01:00:00Z"}');
      await writeFile(join(dir, 'review.ndjson'), '');
      const q = parseJsonValue(
        '{"items":[{"id":"j","kind":"backfill","state":"reviewing","vendor_state":"live","family":"f","scope":[],"attempt_id":"a","run":{"run_id":"r"}}],"backfill_reservations":{"a":{"item":"j","vendor_run_id":"r"}}}',
      );
      if (!(q instanceof JsonObject)) throw new Error('fixture');
      const calls: string[] = [];
      const result = await harvestBackfillFailure(
        q,
        0,
        { runId: 'r', exitCode: 1, terminalVerified: true },
        {
          readArtifacts: backfillArtifactReader(root),
          retain: async () => {
            calls.push('retain');
          },
          stateEvent: async (queue) => {
            calls.push('event');
            return queue;
          },
          saveQueue: async () => {
            calls.push('save');
          },
          cleanup: async () => {
            calls.push('cleanup');
          },
        },
      );
      expect(result.status).toBe('handled');
      expect(calls).toEqual(['retain', 'retain', 'event', 'save', 'cleanup']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('reads exact bytes and rejects traversal and escaped artifact symlinks', async () => {
    const root = await mkdtemp(
      join(process.env.JCODE_SCRATCH_DIR ?? tmpdir(), 'backfill-artifacts-'),
    );
    try {
      const dir = join(root, 'runs', 'r');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'meta.json'), '{}');
      await writeFile(join(dir, 'exit.json'), '{}');
      await writeFile(join(dir, 'review.ndjson'), new Uint8Array([0, 255, 10]));
      const read = backfillArtifactReader(root);
      expect([...(await read('r')).review]).toEqual([0, 255, 10]);
      await expect(read('../outside')).rejects.toThrow('invalid run id');
      await writeFile(join(root, 'outside'), 'secret');
      await mkdir(join(root, 'runs', 's'));
      await symlink(join(root, 'outside'), join(root, 'runs', 's', 'meta.json'));
      await expect(read('s')).rejects.toThrow('escapes');
      await symlink(root, join(root, 'runs', 'escape'));
      await expect(read('escape')).rejects.toThrow('escapes');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
