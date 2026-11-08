// Split provenance: test/harness/search-tools.test.ts was split into
// subject files; this one covers match, output, per-line, byte and candidate
// cap markers.
// Siblings: search-tools.helpers.ts (shared fixtures) and the other
// search-tools.*.test.ts files in this directory.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { defaultHarnessConfig } from '../../src/harness/config.js';
import { buildTools } from '../../src/harness/tools.js';
import { withWorkspace, tool } from './search-tools.helpers.js';

describe('contained grep and glob tools', () => {
  test('files_with_matches charges one row per file, not per match line', async () => {
    await withWorkspace(async (workspace) => {
      await writeFile(
        join(workspace, 'a-busy.txt'),
        `${Array.from({ length: 150 }, () => 'token').join('\n')}\n`,
        'utf8',
      );
      await writeFile(join(workspace, 'b-other.txt'), 'token\n', 'utf8');
      const grep = tool(buildTools(defaultHarnessConfig, workspace, 'read-only'), 'grep');
      const result = await grep.execute({ pattern: 'token', output_mode: 'files_with_matches' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('a-busy.txt');
        expect(result.output).toContain('b-other.txt');
      }
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

  test('an oversized early candidate is skipped and later files still search (#493)', async () => {
    await withWorkspace(async (workspace) => {
      await mkdir(join(workspace, '.git'), { recursive: true });
      await writeFile(join(workspace, 'aaa-big.bin'), Buffer.alloc(20 * 1_024 * 1_024 + 1, 0x78));
      await writeFile(join(workspace, 'zzz-small.txt'), 'needle\n', 'utf8');
      const grep = tool(buildTools(defaultHarnessConfig, workspace, 'read-only'), 'grep');
      const result = await grep.execute({ pattern: 'needle' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('--- zzz-small.txt ---');
        expect(result.output).toContain('1: needle');
        expect(result.output).toContain(`[truncated: searched bytes cap ${20 * 1_024 * 1_024}]`);
        expect(result.output).toContain('[truncated: skipped oversized candidate aaa-big.bin');
        expect(result.truncated).toBe(true);
      }
    });
  });

  test('glob discovery reports oversized files without a byte-budget stop (#494)', async () => {
    await withWorkspace(async (workspace) => {
      await mkdir(join(workspace, '.git'), { recursive: true });
      await writeFile(join(workspace, 'aaa-big.bin'), Buffer.alloc(20 * 1_024 * 1_024 + 1, 0x78));
      await writeFile(join(workspace, 'zzz-small.txt'), 'needle\n', 'utf8');
      const glob = tool(buildTools(defaultHarnessConfig, workspace, 'read-only'), 'glob');
      const result = await glob.execute({ pattern: '*' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('aaa-big.bin');
        expect(result.output).toContain('zzz-small.txt');
        expect(result.output).not.toContain('searched bytes cap');
        expect(result.truncated).toBe(false);
      }
    });
  });
});
