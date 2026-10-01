import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { boundWorkspacePath, resumedRecordOrThrow } from '../../src/driver/common/workspace.js';
import { SessionStore } from '../../src/harness/session.js';

const LANES = ['acp driver', 'ai-sdk driver', 'claude-agent driver', 'subprocess driver'];

describe('shared driver workspace binding', () => {
  test.each(LANES)('%s resumes a legacy record through a directory alias', async (lane) => {
    const scratch = await mkdtemp(join(tmpdir(), 'cq-workspace-alias-'));
    try {
      const workspace = join(scratch, 'workspace');
      const alias = join(scratch, 'alias');
      await mkdir(workspace);
      await symlink(workspace, alias, 'dir');
      const store = new SessionStore(join(scratch, 'sessions'));
      const record = await store.create(alias);
      const bound = boundWorkspacePath({ path: alias }, lane);
      expect(bound).toBe(realpathSync(workspace));
      expect(await resumedRecordOrThrow(store, record.sessionId, bound, lane)).toEqual(record);
      // The stored identity remains intact; normalization happens at comparison.
      expect((await store.load(record.sessionId))?.workspace).toBe(alias);
      await expect(
        resumedRecordOrThrow(store, record.sessionId, realpathSync(scratch), lane),
      ).rejects.toMatchObject({ dispatchClass: 'config' });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test('a removed legacy workspace retains its recorded identity', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'cq-workspace-removed-'));
    try {
      const removed = join(scratch, 'removed');
      const store = new SessionStore(join(scratch, 'sessions'));
      const record = await store.create(removed);
      expect(await resumedRecordOrThrow(store, record.sessionId, removed, 'ai-sdk driver')).toEqual(
        record,
      );
      expect(
        await resumedRecordOrThrow(store, record.sessionId, undefined, 'ai-sdk driver'),
      ).toEqual(record);
      await expect(
        resumedRecordOrThrow(store, 'unknown', undefined, 'ai-sdk driver'),
      ).rejects.toThrow('ai-sdk driver: unknown sessionRef');
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test('rejects relative, missing and non-directory bindings with the lane label', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'cq-workspace-invalid-'));
    try {
      const file = join(scratch, 'file');
      await writeFile(file, 'not a directory');
      for (const path of ['relative', join(scratch, 'missing'), file]) {
        expect(() => boundWorkspacePath({ path }, 'acp driver')).toThrow(
          'acp driver: workspace.path',
        );
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
