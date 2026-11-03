// Split provenance: test/harness/search-tools.test.ts was split into
// subject files; this one covers brace expansion in grep includes (streaming,
// nesting, escapes).
// Siblings: search-tools.helpers.ts (shared fixtures) and the other
// search-tools.*.test.ts files in this directory.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { defaultHarnessConfig } from '../../src/harness/config.js';
import { buildTools } from '../../src/harness/tools.js';
import { withWorkspace, tool } from './search-tools.helpers.js';

describe('contained grep and glob tools', () => {
  test('brace include finds matches past a huge unrelated enumeration (streaming, CR MAJOR 1+2)', async () => {
    await withWorkspace(async (workspace) => {
      await mkdir(join(workspace, '.git'), { recursive: true });
      await mkdir(join(workspace, 'bulk'), { recursive: true });
      // Over 4 MiB of rg --files ENUMERATION OUTPUT from unrelated
      // filenames (the old whole-output cap): ~21k long names, only two
      // matching files. At 5ef68b24 this request denies with SEARCH_LIMIT
      // before the include filter ever runs; the streaming path finds both.
      // Bound simultaneous file opens: macOS can exhaust descriptors if all
      // 21,000 writes start together, before the grep behavior is exercised.
      for (let start = 0; start < 21_000; start += 64) {
        await Promise.all(
          Array.from({ length: Math.min(64, 21_000 - start) }, (_, offset) =>
            writeFile(
              join(
                workspace,
                'bulk',
                `${'u'.repeat(200)}-${String(start + offset).padStart(6, '0')}.dat`,
              ),
              'unrelated\n',
              'utf8',
            ),
          ),
        );
      }
      await writeFile(join(workspace, 'hit-a.ts'), 'brace-needle\n', 'utf8');
      await writeFile(join(workspace, 'hit-b.tsx'), 'brace-needle\n', 'utf8');
      await writeFile(join(workspace, 'miss.md'), 'brace-needle\n', 'utf8');
      const grep = tool(buildTools(defaultHarnessConfig, workspace, 'read-only'), 'grep');
      const result = await grep.execute({ pattern: 'brace-needle', include: '*.{ts,tsx}' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('--- hit-a.ts ---');
        expect(result.output).toContain('--- hit-b.tsx ---');
        expect(result.output).not.toContain('miss.md');
        expect(result.output).not.toContain('SEARCH_LIMIT');
        expect(result.truncated).toBe(false);
      }
    });
  });

  test('nested braces expand and rootless brace alternatives stay basename filters', async () => {
    await withWorkspace(async (workspace) => {
      await mkdir(join(workspace, '.git'), { recursive: true });
      await mkdir(join(workspace, 'src'), { recursive: true });
      await writeFile(join(workspace, 'src', 'a.ts'), 'nested-needle\n', 'utf8');
      await writeFile(join(workspace, 'src', 'b.js'), 'nested-needle\n', 'utf8');
      await writeFile(join(workspace, 'c.rs'), 'nested-needle\n', 'utf8');
      const grep = tool(buildTools(defaultHarnessConfig, workspace, 'read-only'), 'grep');
      const result = await grep.execute({
        pattern: 'nested-needle',
        include: '{src/*.{ts,js},*.rs}',
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('--- src/a.ts ---');
        expect(result.output).toContain('--- src/b.js ---');
        expect(result.output).toContain('--- c.rs ---');
      }
    });
  });

  test('escaped brace delimiters and commas follow rg glob expansion (#604)', async () => {
    await withWorkspace(async (workspace) => {
      await mkdir(join(workspace, '.git'), { recursive: true });
      for (const name of [
        '{a,b}.ts',
        'a.ts',
        'b.ts',
        'a,b.ts',
        'c.ts',
        'a}.ts',
        '{b.ts',
        '\\a.ts',
        '\\b.ts',
      ]) {
        await writeFile(join(workspace, name), 'needle\n', 'utf8');
      }
      const grep = tool(buildTools(defaultHarnessConfig, workspace, 'read-only'), 'grep');
      // Verified against rg --files --hidden --no-ignore --glob on this fixture:
      // one slash escapes a brace/comma; two slashes escape each other.
      const cases = [
        {
          include: '\\{a,b\\}.ts',
          expected: ['{a,b}.ts'],
          excluded: ['a.ts', 'b.ts'],
        },
        {
          include: '{a\\,b,c}.ts',
          expected: ['a,b.ts', 'c.ts'],
          excluded: ['{a,b}.ts'],
        },
        {
          include: '\\\\{a,b}.ts',
          expected: ['\\a.ts', '\\b.ts'],
          excluded: ['a.ts', 'b.ts'],
        },
        {
          include: '{a\\},b}.ts',
          expected: ['a}.ts', 'b.ts'],
          excluded: ['a.ts'],
        },
        {
          include: '{a,\\{b}.ts',
          expected: ['a.ts', '{b.ts'],
          excluded: ['b.ts'],
        },
        {
          include: '{a}.ts',
          expected: ['a.ts'],
          excluded: ['{a,b}.ts'],
        },
      ];
      for (const { include, expected, excluded } of cases) {
        const result = await grep.execute({ pattern: 'needle', include });
        expect(result.ok).toBe(true);
        if (result.ok) {
          for (const name of expected) expect(result.output).toContain(`--- ${name} ---`);
          for (const name of excluded) expect(result.output).not.toContain(`--- ${name} ---`);
        }
      }
    });
  });
});
