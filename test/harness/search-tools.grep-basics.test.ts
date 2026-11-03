// Split provenance: test/harness/search-tools.test.ts was split into
// subject files; this one covers read-only tool selection, grep matching, dash
// patterns and ignore semantics.
// Siblings: search-tools.helpers.ts (shared fixtures) and the other
// search-tools.*.test.ts files in this directory.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { defaultHarnessConfig } from '../../src/harness/config.js';
import { buildTools } from '../../src/harness/tools.js';
import { withWorkspace, tool } from './search-tools.helpers.js';

describe('contained grep and glob tools', () => {
  test('exist only in read-only builds and honor the per-op tool selection names', async () => {
    await withWorkspace(async (workspace) => {
      const writable = buildTools(defaultHarnessConfig, workspace, 'workspace-write');
      expect(writable.some(({ name }) => name === 'grep' || name === 'glob')).toBe(false);
      const readOnly = buildTools(defaultHarnessConfig, workspace, 'read-only');
      expect(readOnly.map(({ name }) => name)).toContain('grep');
      expect(readOnly.map(({ name }) => name)).toContain('glob');
    });
  });

  test('grep supports regex, include alias, line numbers, grouped source provenance, and no matches', async () => {
    await withWorkspace(async (workspace) => {
      await mkdir(join(workspace, 'src'), { recursive: true });
      await writeFile(join(workspace, 'src', 'match.ts'), 'first\nneedle-value\nlast\n', 'utf8');
      await writeFile(join(workspace, 'src', 'other.js'), 'needle-value\n', 'utf8');
      const tools = buildTools(defaultHarnessConfig, workspace, 'read-only');
      const grep = tool(tools, 'grep');
      const result = await grep.execute({ pattern: 'needle-[a-z]+', path: 'src', include: '*.ts' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.output).toContain('--- src/match.ts ---');
      expect(result.output).toContain('2: needle-value');
      expect(result.output).not.toContain('other.js');
      expect(result.sourceContents).toEqual([{ path: 'src/match.ts', text: 'needle-value' }]);
      const empty = await grep.execute({ pattern: 'no-such-token' });
      expect(empty).toMatchObject({ ok: true, output: 'No matches', truncated: false });
    });
  });

  test('patterns beginning with a dash are passed as data, not options', async () => {
    await withWorkspace(async (workspace) => {
      await writeFile(join(workspace, 'dash.txt'), '-needle\n', 'utf8');
      const grep = tool(buildTools(defaultHarnessConfig, workspace, 'read-only'), 'grep');
      const result = await grep.execute({ pattern: '-needle' });
      expect(result).toMatchObject({ ok: true });
      if (result.ok) expect(result.output).toContain('1: -needle');
    });
  });

  test('glob includes ignored and hidden files while grep respects .gitignore', async () => {
    await withWorkspace(async (workspace) => {
      await mkdir(join(workspace, '.git'), { recursive: true });
      await mkdir(join(workspace, 'ignored'), { recursive: true });
      await writeFile(join(workspace, '.gitignore'), 'ignored/\n', 'utf8');
      await writeFile(join(workspace, 'ignored', 'secret.ts'), 'ignored-needle\n', 'utf8');
      await writeFile(join(workspace, '.hidden.ts'), 'visible-needle\n', 'utf8');
      for (const vcs of ['.git', '.hg', '.svn']) {
        await mkdir(join(workspace, vcs), { recursive: true });
        await writeFile(join(workspace, vcs, 'internal.ts'), 'vcs-needle\n', 'utf8');
      }
      const tools = buildTools(defaultHarnessConfig, workspace, 'read-only');
      await expect(
        tool(tools, 'grep').execute({ pattern: 'ignored-needle' }),
      ).resolves.toMatchObject({
        ok: true,
        output: 'No matches',
      });
      const listed = await tool(tools, 'glob').execute({ pattern: '**/*.ts' });
      expect(listed.ok).toBe(true);
      if (listed.ok) {
        expect(listed.output).toContain('ignored/secret.ts');
        expect(listed.output).toContain('.hidden.ts');
        expect(listed.output).not.toContain('internal.ts');
      }
      await expect(
        tool(tools, 'grep').execute({ pattern: 'visible-needle' }),
      ).resolves.toMatchObject({
        ok: true,
        output: expect.stringContaining('.hidden.ts') as unknown,
      });
    });
  });
});
