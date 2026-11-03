// Split provenance: test/harness/search-tools.test.ts was split into
// subject files; this one covers the windowed read tool.
// Siblings: search-tools.helpers.ts (shared fixtures) and the other
// search-tools.*.test.ts files in this directory.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { defaultHarnessConfig } from '../../src/harness/config.js';
import { buildTools } from '../../src/harness/tools.js';
import { withWorkspace, tool, configWithReadPaths } from './search-tools.helpers.js';

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
      expect(result.sourceContents).toEqual([{ text: 'beta', path: 'window.txt' }]);
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
        read.execute({ file_path: 'small.txt', path: 'other.txt' }),
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
