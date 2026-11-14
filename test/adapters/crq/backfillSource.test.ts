import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  fileBackfillInventoryEffects,
  runBackfillUnit,
} from '../../../src/adapters/crq/backfillSource.js';

describe('backfill adapter', () => {
  test('an unimplemented subcommand is refused, never silently replayed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cq-backfill-adapter-'));
    try {
      const result = await runBackfillUnit(['publish'], { stateRoot: root });
      expect(result.exitCode).toBe(3);
      expect(result.artifact).toEqual({
        status: 'failed',
        error: 'backfill subcommand is not implemented in this runtime: publish',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('a missing rollout configuration reads as absent, not as unreadable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cq-backfill-adapter-'));
    try {
      const effects = fileBackfillInventoryEffects(root);
      await expect(effects.readRollout()).resolves.toBeNull();
      await expect(effects.readBaseline()).resolves.toBeNull();
      // An absent queue file is an error: the runner always writes one, so a
      // missing file means this is not the state root.
      await expect(effects.readQueue()).rejects.toThrow();
      await expect(effects.readTriage()).resolves.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('a malformed rollout file rejects the route without writing artifacts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cq-backfill-adapter-'));
    try {
      await writeFile(join(root, 'backfill-rollout.json'), '{not json');
      await writeFile(join(root, 'queue.json'), '{}');
      const result = await runBackfillUnit(['inventory', '--report-only'], { stateRoot: root });
      expect(result.exitCode).toBe(3);
      const error = result.artifact.status === 'failed' ? result.artifact.error : '';
      expect(error).toContain('not valid JSON');
      await expect(
        readFile(join(root, 'backfill', 'latest-report.json'), 'utf8'),
      ).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
