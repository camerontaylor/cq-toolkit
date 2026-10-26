import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { defaultHarnessConfig } from '../../src/harness/config.js';
import type { HarnessConfig } from '../../src/harness/config.js';
import { buildTools } from '../../src/harness/tools.js';
import type { ToolkitTool } from '../../src/harness/tools.js';

async function withWorkspace(body: (workspace: string) => Promise<void>): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), 'cq-search-tools-'));
  try {
    await body(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

function tool(tools: ToolkitTool[], name: string): ToolkitTool {
  const found = tools.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`missing ${name} tool`);
  return found;
}

function configWithReadPaths(pathPatterns: string[], maxOutputChars?: number): HarnessConfig {
  return {
    ...defaultHarnessConfig,
    tools: {
      ...defaultHarnessConfig.tools,
      read: {
        ...defaultHarnessConfig.tools.read,
        pathPatterns,
        ...(maxOutputChars === undefined ? {} : { maxOutputChars }),
      },
    },
  };
}

describe('windowed read tool', () => {
  test('uses 1-based windows, line numbers, the path alias, and a continuation hint', async () => {
    await withWorkspace(async (workspace) => {
      await writeFile(join(workspace, 'window.txt'), 'alpha\nbeta\ngamma\n', 'utf8');
      const read = tool(buildTools(defaultHarnessConfig, workspace), 'read');
      const result = await read.execute({ path: 'window.txt', offset: 2, limit: 1 });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.output).toContain('--- window.txt ---');
      expect(result.output).toContain('     2: beta');
      expect(result.output).toContain('offset=3 to continue');
      expect(result.output).not.toContain('alpha');
      expect(result.sourceContents).toEqual([{ text: result.output, path: 'window.txt' }]);
      expect(result.truncated).toBe(true);
    });
  });

  test('defaults to 2000 lines and caps long lines with a visible marker', async () => {
    await withWorkspace(async (workspace) => {
      const lines = Array.from({ length: 2_003 }, (_, index) => `line-${index + 1}`);
      lines[0] = `long-${'x'.repeat(2_100)}`;
      await writeFile(join(workspace, 'many.txt'), lines.join('\n'), 'utf8');
      const read = tool(buildTools(defaultHarnessConfig, workspace), 'read');
      const result = await read.execute({ file_path: 'many.txt' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.output).toContain('line truncated at 2000 chars');
      expect(result.output).toContain('  2000: line-2000');
      expect(result.output).toContain('offset=2001 to continue');
      expect(result.output).not.toContain('line-2001');
      expect(result.truncated).toBe(true);
    });
  });

  test('keeps the full-file F1 staleness ledger after returning a partial window', async () => {
    await withWorkspace(async (workspace) => {
      await writeFile(join(workspace, 'ledger.txt'), 'visible\nhidden target\n', 'utf8');
      const tools = buildTools(defaultHarnessConfig, workspace);
      const read = tool(tools, 'read');
      const edit = tool(tools, 'edit');
      const readResult = await read.execute({ file_path: 'ledger.txt', offset: 1, limit: 1 });
      expect(readResult.ok).toBe(true);
      if (!readResult.ok) return;
      expect(readResult.output).not.toContain('hidden target');
      const editResult = await edit.execute({
        file_path: 'ledger.txt',
        old_string: 'hidden target',
        new_string: 'updated target',
      });
      expect(editResult.ok).toBe(true);
      expect(await readFile(join(workspace, 'ledger.txt'), 'utf8')).toBe(
        'visible\nupdated target\n',
      );
    });
  });

  test('refuses NUL-containing and invalid UTF-8 files', async () => {
    await withWorkspace(async (workspace) => {
      await writeFile(join(workspace, 'binary.dat'), Buffer.from([0x61, 0x00, 0x62]));
      await writeFile(join(workspace, 'invalid.txt'), Buffer.from([0xc3, 0x28]));
      const read = tool(buildTools(defaultHarnessConfig, workspace), 'read');
      const binary = await read.execute({ file_path: 'binary.dat' });
      expect(binary.ok).toBe(false);
      if (!binary.ok) expect(binary.denial.reason).toContain('binary file');
      const invalid = await read.execute({ file_path: 'invalid.txt' });
      expect(invalid.ok).toBe(false);
      if (!invalid.ok) expect(invalid.denial.reason).toContain('not valid UTF-8');
    });
  });

  test('denies invalid alias combinations and shows output-cap truncation', async () => {
    await withWorkspace(async (workspace) => {
      await writeFile(join(workspace, 'small.txt'), 'one\ntwo\nthree', 'utf8');
      const read = tool(buildTools(configWithReadPaths(['**/*'], 40), workspace), 'read');
      await expect(
        read.execute({ file_path: 'small.txt', path: 'small.txt' }),
      ).resolves.toMatchObject({
        ok: false,
      });
      const result = await read.execute({ file_path: 'small.txt' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('[truncated: output chars cap 40]');
        expect(result.truncated).toBe(true);
      }
    });
  });
});

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
      expect(result.sourceContents).toEqual([{ path: 'src/match.ts', text: '2: needle-value' }]);
      const empty = await grep.execute({ pattern: 'no-such-token' });
      expect(empty).toMatchObject({ ok: true, output: 'No matches', truncated: false });
    });
  });

  test('honors .gitignore while still enumerating hidden workspace files', async () => {
    await withWorkspace(async (workspace) => {
      await mkdir(join(workspace, '.git'), { recursive: true });
      await mkdir(join(workspace, 'ignored'), { recursive: true });
      await writeFile(join(workspace, '.gitignore'), 'ignored/\n', 'utf8');
      await writeFile(join(workspace, 'ignored', 'secret.ts'), 'ignored-needle\n', 'utf8');
      const tools = buildTools(defaultHarnessConfig, workspace, 'read-only');
      await expect(
        tool(tools, 'grep').execute({ pattern: 'ignored-needle' }),
      ).resolves.toMatchObject({
        ok: true,
        output: 'No matches',
      });
      const listed = await tool(tools, 'glob').execute({ pattern: '**/*.ts' });
      expect(listed.ok).toBe(true);
      if (listed.ok) expect(listed.output).not.toContain('ignored/secret.ts');
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
      const broadSearch = await grep.execute({ pattern: 'external-secret' });
      expect(broadSearch).toMatchObject({ ok: true, output: 'No matches' });
    });
  });

  test('shows explicit match, output, per-line, and byte-cap markers', async () => {
    await withWorkspace(async (workspace) => {
      const longLine = `${'x'.repeat(2_100)} token`;
      await writeFile(
        join(workspace, 'long.txt'),
        `${Array.from({ length: 105 }, () => longLine).join('\n')}\n`,
        'utf8',
      );
      const grep = tool(buildTools(defaultHarnessConfig, workspace, 'read-only'), 'grep');
      const result = await grep.execute({ pattern: 'token' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('[truncated: matches cap 100]');
        expect(result.output).toContain('[truncated: per-line chars cap 2000]');
        expect(result.truncated).toBe(true);
      }
      await writeFile(join(workspace, 'oversize.txt'), Buffer.alloc(20 * 1_024 * 1_024 + 1, 0x78));
      const byteLimited = await grep.execute({ pattern: 'never-present' });
      expect(byteLimited.ok).toBe(true);
      if (byteLimited.ok) {
        expect(byteLimited.output).toContain(
          `[truncated: searched bytes cap ${20 * 1_024 * 1_024}]`,
        );
        expect(byteLimited.truncated).toBe(true);
      }
    });
  });

  test('candidate and output caps are named in the response', async () => {
    await withWorkspace(async (workspace) => {
      await Promise.all(
        Array.from({ length: 1_005 }, (_, index) =>
          writeFile(
            join(workspace, `file-${String(index).padStart(4, '0')}-${'x'.repeat(60)}.txt`),
            'x',
            'utf8',
          ),
        ),
      );
      const glob = tool(buildTools(defaultHarnessConfig, workspace, 'read-only'), 'glob');
      const result = await glob.execute({ pattern: '*.txt' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('[truncated: candidate files cap 1000]');
        expect(result.output).toContain('[truncated: output chars cap 50000]');
        expect(result.truncated).toBe(true);
      }
    });
  });

  test('returns a denial when an in-flight rg operation is aborted', async () => {
    await withWorkspace(async (workspace) => {
      await Promise.all(
        Array.from({ length: 1_500 }, (_, index) =>
          writeFile(join(workspace, `abort-${index}.txt`), 'needle\n', 'utf8'),
        ),
      );
      const grep = tool(buildTools(defaultHarnessConfig, workspace, 'read-only'), 'grep');
      const controller = new AbortController();
      const pending = grep.execute({ pattern: 'needle' }, { signal: controller.signal });
      setTimeout(() => controller.abort(), 5);
      const aborted = await pending;
      expect(aborted.ok).toBe(false);
      if (!aborted.ok) expect(aborted.denial.reason).toContain('cancelled:');
    });
  });
});
