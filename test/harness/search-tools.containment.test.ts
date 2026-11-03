// Split provenance: test/harness/search-tools.test.ts was split into
// subject files; this one covers .git exclusion, forbidden descendants and
// symlink/.git path denials.
// Siblings: search-tools.helpers.ts (shared fixtures) and the other
// search-tools.*.test.ts files in this directory.
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { defaultHarnessConfig } from '../../src/harness/config.js';
import { buildTools } from '../../src/harness/tools.js';
import { withWorkspace, tool, configWithReadPaths } from './search-tools.helpers.js';

describe('contained grep and glob tools', () => {
  test('excludes .git before the candidate cap can crowd out workspace files', async () => {
    await withWorkspace(async (workspace) => {
      const gitDir = join(workspace, '.git');
      await mkdir(gitDir);
      await Promise.all(
        Array.from({ length: 1_001 }, (_, index) =>
          writeFile(join(gitDir, `${String(index).padStart(4, '0')}.txt`), 'needle', 'utf8'),
        ),
      );
      await writeFile(join(workspace, 'visible.txt'), 'needle', 'utf8');
      const grep = tool(buildTools(defaultHarnessConfig, workspace, 'read-only'), 'grep');
      const result = await grep.execute({ pattern: 'needle' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('visible.txt');
        expect(result.output).not.toContain('.git/');
      }
    });
  });

  test('filters forbidden descendants before grep and glob can read or return them', async () => {
    await withWorkspace(async (workspace) => {
      await mkdir(join(workspace, 'src'), { recursive: true });
      await mkdir(join(workspace, 'private'), { recursive: true });
      await writeFile(join(workspace, 'src', 'allowed.ts'), 'needle-safe\n', 'utf8');
      await writeFile(join(workspace, 'private', 'secret.ts'), 'needle-secret\n', 'utf8');
      const tools = buildTools(configWithReadPaths(['src/**']), workspace, 'read-only');
      const grep = tool(tools, 'grep');
      const search = await grep.execute({ pattern: 'needle-' });
      expect(search.ok).toBe(true);
      if (search.ok) {
        expect(search.output).toContain('needle-safe');
        expect(search.output).not.toContain('needle-secret');
      }
      const glob = tool(tools, 'glob');
      const listed = await glob.execute({ pattern: '**/*.ts' });
      expect(listed.ok).toBe(true);
      if (listed.ok) {
        expect(listed.output).toContain('src/allowed.ts');
        expect(listed.output).not.toContain('private/secret.ts');
      }
    });
  });

  test('denies outside-workspace symlinks, symlinks into .git, and .git files', async () => {
    await withWorkspace(async (scratch) => {
      const workspace = join(scratch, 'workspace');
      const outside = join(scratch, 'outside');
      await mkdir(join(workspace, '.git'), { recursive: true });
      await mkdir(join(workspace, 'nested'), { recursive: true });
      await mkdir(outside, { recursive: true });
      await writeFile(join(workspace, '.git', 'config'), 'secret-config', 'utf8');
      await writeFile(join(workspace, 'nested', '.git'), 'gitdir: elsewhere', 'utf8');
      await writeFile(join(outside, 'secret.txt'), 'external-secret', 'utf8');
      await symlink(join(outside, 'secret.txt'), join(workspace, 'outside-link'));
      await symlink(join(workspace, '.git'), join(workspace, 'git-link'));
      await symlink(join(outside, 'secret.txt'), join(workspace, 'nested', 'outside-link'));
      const tools = buildTools(defaultHarnessConfig, workspace, 'read-only');
      const grep = tool(tools, 'grep');
      const outsideLink = await grep.execute({ pattern: 'secret', path: 'outside-link' });
      expect(outsideLink.ok).toBe(false);
      if (!outsideLink.ok) expect(outsideLink.denial.reason).toContain('path escape');
      const gitLink = await grep.execute({ pattern: 'config', path: 'git-link' });
      expect(gitLink.ok).toBe(false);
      if (!gitLink.ok) expect(gitLink.denial.reason).toContain('.git');
      const gitFile = await grep.execute({ pattern: 'gitdir', path: 'nested/.git' });
      expect(gitFile.ok).toBe(false);
      if (!gitFile.ok) expect(gitFile.denial.reason).toContain('.git');
      const glob = tool(tools, 'glob');
      for (const path of ['outside-link', 'git-link', 'nested/.git']) {
        const denied = await glob.execute({ pattern: '**/*', path });
        expect(denied.ok).toBe(false);
        if (!denied.ok) expect(denied.denial.reason).toMatch(/^(PATH_ESCAPE|PATH_DENIED): /);
      }
      const broadSearch = await grep.execute({ pattern: 'external-secret' });
      expect(broadSearch).toMatchObject({ ok: true, output: 'No matches' });
    });
  });
});
