// Split provenance: test/harness/tools.test.ts was split by subject into the
// tools.*.test.ts siblings in this directory (shared fixtures live in
// tools.helpers.ts). This file keeps the F1 write-tool cases.
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { buildTools } from '../../src/harness/tools.js';
import { defaultHarnessConfig } from '../../src/harness/config.js';
import { defaultTools, withScratch } from './tools.helpers.js';

describe('F1 write tool', () => {
  test('creates a new file without a prior read; overwrite needs a read and preserves style', async () => {
    await withScratch(async (scratchDir) => {
      const tools = defaultTools(scratchDir);
      const created = await tools.write.execute({
        file_path: 'new.txt',
        content: 'created\n',
      });
      expect(created).toMatchObject({ ok: true });
      await expect(readFile(join(scratchDir, 'new.txt'), 'utf8')).resolves.toBe('created\n');

      // A file this tools instance created is already known; one created
      // outside it must be read before it can be overwritten.
      await writeFile(join(scratchDir, 'external.txt'), 'outside\n', 'utf8');
      const unread = await tools.write.execute({
        file_path: 'external.txt',
        content: 'overwrite\n',
      });
      expect(unread.ok).toBe(false);
      if (!unread.ok) expect(unread.denial.reason).toContain('must be read before');

      // Style preservation on overwrite: BOM + CRLF stay.
      await writeFile(join(scratchDir, 'styled.txt'), '\uFEFFa\r\nb\r\n', 'utf8');
      await tools.read.execute({ path: 'styled.txt' });
      const overwritten = await tools.write.execute({
        file_path: 'styled.txt',
        content: 'x\ny\n',
      });
      expect(overwritten).toMatchObject({ ok: true });
      await expect(readFile(join(scratchDir, 'styled.txt'), 'utf8')).resolves.toBe(
        '\uFEFFx\r\ny\r\n',
      );
    });
  });

  test('a new file cannot escape through a symlinked parent or a dangling symlink', async () => {
    await withScratch(async (scratchDir) => {
      const workspace = join(scratchDir, 'ws');
      const outside = join(scratchDir, 'outside');
      await mkdir(workspace, { recursive: true });
      await mkdir(outside, { recursive: true });
      const write = buildTools(defaultHarnessConfig, workspace).find(
        (candidate) => candidate.name === 'write',
      );
      if (write === undefined) throw new Error('missing write');

      // A symlinked PARENT directory must not create outside the workspace.
      await symlink(outside, join(workspace, 'link'));
      const viaParent = await write.execute({ file_path: 'link/new.txt', content: 'escape\n' });
      expect(viaParent.ok).toBe(false);
      if (!viaParent.ok) expect(viaParent.denial.reason).toContain('path escape');
      await expect(readFile(join(outside, 'new.txt'), 'utf8')).rejects.toThrow();

      // A dangling symlink must not be followed to create its target.
      await symlink(join(outside, 'missing.txt'), join(workspace, 'dangling'));
      const viaDangling = await write.execute({ file_path: 'dangling', content: 'escape\n' });
      expect(viaDangling.ok).toBe(false);
      if (!viaDangling.ok) expect(viaDangling.denial.reason).toContain('does not resolve');
      await expect(readFile(join(outside, 'missing.txt'), 'utf8')).rejects.toThrow();

      // A symlinked parent INSIDE the workspace still works.
      await mkdir(join(workspace, 'real'));
      await symlink(join(workspace, 'real'), join(workspace, 'alias'));
      const inside = await write.execute({
        file_path: 'alias/inside.txt',
        content: 'inside\n',
      });
      expect(inside).toMatchObject({ ok: true });
      await expect(readFile(join(workspace, 'real', 'inside.txt'), 'utf8')).resolves.toBe(
        'inside\n',
      );
    });
  });
});
