// Split provenance: test/harness/tools.test.ts was split by subject into the
// tools.*.test.ts siblings in this directory (shared fixtures live in
// tools.helpers.ts). This file keeps the "read/edit never touch .git"
// composition-review invariant.
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { buildTools } from '../../src/harness/tools.js';
import { isHarnessDenial } from '../../src/harness/surface.js';
import { reviewFixHarness } from '../../src/ops/review/fixReviewItem.js';
import { withScratch } from './tools.helpers.js';

describe('toolkit invariant: read/edit never touch .git (W1.4 composition review F1)', () => {
  test('with the shipped reviewFixHarness, every .git path denies — gitfile, config, case/alias variants, symlinks', async () => {
    await withScratch(async (scratchDir) => {
      const workspace = join(scratchDir, 'wt');
      await mkdir(join(workspace, '.git', 'hooks'), { recursive: true });
      // A linked worktree's gitfile lives at the ROOT as `.git`; model a
      // nested checkout's gitfile too (sub/.git) — both must be off-limits.
      await mkdir(join(workspace, 'sub'), { recursive: true });
      await writeFile(join(workspace, 'sub', '.git'), 'gitdir: /repo/.git/worktrees/sub\n');
      await writeFile(join(workspace, '.git', 'config'), '[core]\n\tbare = false\n');
      await writeFile(join(workspace, '.git', 'HEAD'), 'ref: refs/heads/main\n');
      await writeFile(join(workspace, '.gitignore'), 'node_modules\n');
      await writeFile(join(workspace, 'src.ts'), 'export const a = 1;\n');
      await symlink(join(workspace, '.git'), join(workspace, 'innocent'));
      const tools = buildTools(reviewFixHarness, workspace);
      const edit = tools.find((t) => t.name === 'edit');
      const read = tools.find((t) => t.name === 'read');
      const attempts = [
        { path: '.git/config', oldText: 'bare = false', newText: 'fsmonitor = sh -c evil' },
        { path: 'sub/.git', oldText: 'gitdir: /repo', newText: 'gitdir: /elsewhere' },
        { path: '.GIT/config', oldText: 'bare = false', newText: 'x' },
        { path: './src/../.git/config', oldText: 'bare = false', newText: 'x' },
        { path: 'innocent/config', oldText: 'bare = false', newText: 'x' }, // symlink → .git
      ];
      for (const input of attempts) {
        const result = await edit?.execute(input);
        expect(result?.ok, input.path).toBe(false);
        if (result?.ok !== false) continue;
        expect(result.denial.tool).toBe('edit');
        expect(result.denial.reason, input.path).toMatch(
          /^PATH_DENIED: path not allowed: .*\.git directory/,
        );
        expect(isHarnessDenial(result.denial.reason)).toBe(true);
      }
      const readGit = await read?.execute({ path: '.git/HEAD' });
      expect(readGit).toMatchObject({ ok: false, denial: { tool: 'read' } });
      // Nothing under .git changed…
      expect(await readFile(join(workspace, '.git', 'config'), 'utf8')).toBe(
        '[core]\n\tbare = false\n',
      );
      expect(await readFile(join(workspace, 'sub', '.git'), 'utf8')).toContain('/repo/');
      // …while ordinary files — and dot-files that merely START with .git — stay editable.
      await expect(read?.execute({ path: '.gitignore' })).resolves.toMatchObject({ ok: true });
      expect(
        await edit?.execute({ path: '.gitignore', oldText: 'node_modules', newText: 'dist' }),
      ).toMatchObject({ ok: true });
      await expect(read?.execute({ path: 'src.ts' })).resolves.toMatchObject({ ok: true });
      expect(
        await edit?.execute({ path: 'src.ts', oldText: 'a = 1', newText: 'a = 2' }),
      ).toMatchObject({ ok: true });
    });
  });
});
