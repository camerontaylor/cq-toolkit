import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  assertSessionsDirOutsideWorkspace,
  boundWorkspacePath,
  resumedRecordOrThrow,
} from '../../src/driver/common/workspace.js';
import { DispatchError, errorClassOf } from '../../src/driver/errors.js';
import { SessionStore } from '../../src/harness/session.js';

const LANES = ['acp driver', 'ai-sdk driver', 'claude-code driver'];

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

  test('assertSessionsDirOutsideWorkspace refuses equal/nested/missing-inside dirs and accepts outside + symlink-outside', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'cq-sessions-contain-'));
    try {
      const workspace = realpathSync(scratch);
      const nested = join(workspace, 'nested');
      await mkdir(nested);
      const outside = join(scratch, '..', 'cq-sessions-outside-');
      const outsideDir = await mkdtemp(outside);
      try {
        // Equal, nested, and not-yet-existing nested dirs are refused.
        for (const dir of [workspace, nested, join(workspace, '.s', 'deep')]) {
          expect(() => assertSessionsDirOutsideWorkspace(dir, workspace, 'test lane')).toThrow(
            DispatchError,
          );
          expect(() => assertSessionsDirOutsideWorkspace(dir, workspace, 'test lane')).toThrow(
            'test lane: sessionsDir',
          );
        }
        // Outside passes — including the issue's acceptance case, a
        // `<workspace>/link -> <outside>` alias that resolves outside.
        assertSessionsDirOutsideWorkspace(outsideDir, workspace, 'test lane');
        const link = join(workspace, 'link');
        await symlink(outsideDir, link, 'dir');
        assertSessionsDirOutsideWorkspace(link, workspace, 'test lane');
        // A symlink INTO the workspace (from an outside path) is refused.
        const inward = join(scratch, 'inward');
        await symlink(workspace, inward, 'dir');
        expect(() => assertSessionsDirOutsideWorkspace(inward, workspace, 'test lane')).toThrow(
          DispatchError,
        );
        // A sibling-prefix dir (`…-contain2`) is not "inside" the workspace.
        const sibling = await mkdtemp(join(tmpdir(), 'cq-sessions-contain2-'));
        try {
          assertSessionsDirOutsideWorkspace(sibling, workspace, 'test lane');
        } finally {
          await rm(sibling, { recursive: true, force: true });
        }
        // The throw carries the structured 'config' class, like the other
        // pre-dispatch validation rows.
        try {
          assertSessionsDirOutsideWorkspace(workspace, workspace, 'test lane');
          expect.unreachable();
        } catch (err) {
          expect(err).toBeInstanceOf(DispatchError);
          expect(errorClassOf(err)).toBe('config');
        }
      } finally {
        await rm(outsideDir, { recursive: true, force: true });
      }
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
      // An unknown sessionRef is a caller misconfiguration like the other
      // pre-dispatch rows: the throw carries the structured 'config' class.
      await expect(
        resumedRecordOrThrow(store, 'unknown', undefined, 'ai-sdk driver'),
      ).rejects.toMatchObject({ dispatchClass: 'config' });
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
