import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { defaultHarnessConfig } from '../../src/harness/config.js';
import {
  buildTools,
  AdvertisedToolInputSchemas,
  BashToolInputSchema,
  GrepToolInputSchema,
  ReadToolInputSchema,
  EditToolInputSchema,
  WriteToolInputSchema,
} from '../../src/harness/tools.js';

async function workspace(body: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'cq-parity-'));
  try {
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('tool argument parity', () => {
  test('read character caps offer a recovery offset without skipping unseen lines', async () => {
    await workspace(async (root) => {
      await writeFile(
        join(root, 'long.txt'),
        Array.from({ length: 30 }, () => 'x'.repeat(100)).join('\n'),
      );
      const tools = buildTools(
        {
          ...defaultHarnessConfig,
          tools: {
            ...defaultHarnessConfig.tools,
            read: { ...defaultHarnessConfig.tools.read, maxOutputChars: 300 },
          },
        },
        root,
      );
      const result = await tools
        .find((tool) => tool.name === 'read')!
        .execute({ file_path: 'long.txt', limit: 20 });
      expect(result).toMatchObject({ ok: true, truncated: true });
      if (result.ok) {
        expect(result.output).toContain('retry offset=1 with a smaller limit');
        expect(result.output).not.toContain('offset=21');
      }
    });
  });
  test('capped grep count rows state their lower-bound semantics', async () => {
    await workspace(async (root) => {
      await writeFile(
        join(root, 'many.txt'),
        Array.from({ length: 120 }, () => 'match').join('\n'),
      );
      const grep = buildTools(defaultHarnessConfig, root, 'read-only').find(
        (tool) => tool.name === 'grep',
      )!;
      const result = await grep.execute({ pattern: 'match', output_mode: 'count' });
      expect(result).toMatchObject({ ok: true, truncated: true });
      if (result.ok) {
        expect(result.output).toContain('many.txt:100+');
        expect(result.output).toContain('lower bounds');
      }
    });
  });
  test('grep glob and include aliases stay identical through the ignore-aware filter (#491)', async () => {
    await workspace(async (root) => {
      await mkdir(join(root, '.git'), { recursive: true });
      await mkdir(join(root, 'ignored'), { recursive: true });
      await writeFile(join(root, '.gitignore'), 'ignored/\n', 'utf8');
      await writeFile(join(root, 'a.ts'), 'needle\n', 'utf8');
      await writeFile(join(root, 'b.js'), 'needle\n', 'utf8');
      await writeFile(join(root, 'ignored', 'c.ts'), 'needle\n', 'utf8');
      const grep = buildTools(defaultHarnessConfig, root, 'read-only').find(
        (tool) => tool.name === 'grep',
      )!;
      const viaInclude = await grep.execute({ pattern: 'needle', include: '*.ts' });
      const viaGlob = await grep.execute({ pattern: 'needle', glob: '*.ts' });
      expect(viaInclude).toMatchObject({ ok: true });
      expect(viaGlob).toMatchObject({ ok: true });
      if (viaInclude.ok && viaGlob.ok) {
        expect(viaInclude.output).toBe(viaGlob.output);
        expect(viaInclude.output).toContain('--- a.ts ---');
        expect(viaInclude.output).not.toContain('c.ts');
        expect(viaInclude.output).not.toContain('b.js');
      }
    });
  });
  test('reviewer schemas keep a bounded canonical surface', () => {
    const surface = buildTools(defaultHarnessConfig, '.', 'read-only').map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      inputSchema: z.toJSONSchema(AdvertisedToolInputSchemas[tool.name]),
    }));
    expect(
      Buffer.byteLength(
        JSON.stringify(surface.filter((tool) => ['read', 'grep', 'glob'].includes(tool.name))),
      ),
    ).toBeLessThanOrEqual(1800);
    expect(Buffer.byteLength(JSON.stringify(surface))).toBeLessThanOrEqual(3500);
    const shapes = {
      read: ['file_path', 'offset', 'limit'],
      grep: ['pattern', 'path', 'glob', 'ignore_case', 'output_mode', 'head_limit'],
      glob: ['pattern', 'path'],
    };
    for (const name of ['read', 'grep', 'glob'] as const) {
      expect(Object.keys(AdvertisedToolInputSchemas[name].shape)).toEqual(shapes[name]);
    }
  });

  test('failures start with actionable shared codes', async () => {
    await workspace(async (root) => {
      await writeFile(join(root, 'a.txt'), 'old old');
      const tools = buildTools(defaultHarnessConfig, root);
      const get = (name: string) => tools.find((tool) => tool.name === name)!;
      const check = async (name: string, input: unknown, code: string) => {
        const result = await get(name).execute(input);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.denial.reason).toMatch(new RegExp(`^${code}: `));
      };
      await check('read', { file_path: 'missing' }, 'FS_NOT_FOUND');
      await check('read', { file_path: '../escape' }, 'PATH_ESCAPE');
      await check('read', { file_path: '.git/config' }, 'PATH_DENIED');
      await check('read', { unexpected: true }, 'INPUT_INVALID');
      await check(
        'edit',
        { file_path: 'a.txt', old_string: 'old', new_string: 'new' },
        'FS_NOT_READ',
      );
      await get('read').execute({ file_path: 'a.txt' });
      await check(
        'edit',
        { file_path: 'a.txt', old_string: 'none', new_string: 'new' },
        'EDIT_NO_MATCH',
      );
      await check(
        'edit',
        { file_path: 'a.txt', old_string: 'old', new_string: 'new' },
        'EDIT_AMBIGUOUS',
      );
      await writeFile(join(root, 'a.txt'), 'changed');
      await check('edit', { file_path: 'a.txt', old_string: 'old', new_string: 'new' }, 'FS_STALE');
      await check('bash', { command: 'pwd', run_in_background: true }, 'UNSUPPORTED');
      await check('bash', { command: 'not-allowed' }, 'CMD_DENIED');
      const grep = buildTools(defaultHarnessConfig, root, 'read-only').find(
        (tool) => tool.name === 'grep',
      )!;
      const invalid = await grep.execute({ pattern: '[' });
      expect(invalid).toMatchObject({
        ok: false,
        denial: { reason: expect.stringMatching(/^SEARCH_INVALID_PATTERN: /) as unknown },
      });
    });
  });

  test('OpenCode reads, edits and writes; matching aliases compose and conflicts fail', async () => {
    await workspace(async (root) => {
      const tools = buildTools(defaultHarnessConfig, root);
      const get = (name: string) => tools.find((tool) => tool.name === name)!;
      await writeFile(join(root, 'a.txt'), 'old old');
      expect(
        await get('read').execute({ filePath: 'a.txt', file_path: 'a.txt', path: 'a.txt' }),
      ).toMatchObject({ ok: true });
      expect(
        await get('edit').execute({
          filePath: 'a.txt',
          oldString: 'old',
          newString: 'new',
          replaceAll: true,
        }),
      ).toMatchObject({ ok: true });
      expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('new new');
      expect(await get('write').execute({ filePath: 'b.txt', content: 'written' })).toMatchObject({
        ok: true,
      });
      expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('written');
    });
    for (const schema of [ReadToolInputSchema, WriteToolInputSchema, EditToolInputSchema]) {
      const extras =
        schema === WriteToolInputSchema
          ? { content: 'x' }
          : schema === EditToolInputSchema
            ? { old_string: 'a', new_string: 'b' }
            : {};
      expect(schema.safeParse({ file_path: 'a', filePath: 'b', ...extras }).success).toBe(false);
      expect(
        schema.safeParse({ file_path: 'a', filePath: 'a', path: 'a', ...extras }).success,
      ).toBe(true);
    }
    expect(
      EditToolInputSchema.safeParse({
        path: 'a',
        oldText: 'x',
        old_string: 'x',
        newText: 'y',
        newString: 'y',
        replace_all: false,
        replaceAll: false,
      }).success,
    ).toBe(true);
    expect(
      EditToolInputSchema.safeParse({ path: 'a', oldText: 'x', old_string: 'z', newText: 'y' })
        .success,
    ).toBe(false);
    expect(
      EditToolInputSchema.safeParse({
        path: 'a',
        oldText: 'x',
        newText: 'y',
        replace_all: false,
        replaceAll: true,
      }).success,
    ).toBe(false);
  });

  test('grep case aliases, inline flag, modes and head_limit change the results', async () => {
    await workspace(async (root) => {
      await writeFile(join(root, 'a.txt'), 'Needle\nNEEDLE\n');
      await writeFile(join(root, 'b.txt'), 'needle\n');
      const grep = buildTools(defaultHarnessConfig, root, 'read-only').find(
        (tool) => tool.name === 'grep',
      )!;
      for (const flag of ['ignore_case', '-i', 'ignoreCase']) {
        expect(
          await grep.execute({ pattern: 'needle', [flag]: true, output_mode: 'count' }),
        ).toMatchObject({ ok: true, output: 'a.txt:2\nb.txt:1' });
      }
      expect(
        await grep.execute({
          pattern: '(?i)needle',
          output_mode: 'files_with_matches',
          head_limit: 1,
        }),
      ).toMatchObject({
        ok: true,
        output:
          'a.txt\n[truncated: head_limit 1]\n[truncated: narrow path or pattern to recover remaining results]',
        truncated: true,
      });
      const content = await grep.execute({ pattern: 'needle', ignore_case: true, head_limit: 1 });
      expect(content).toMatchObject({ ok: true, truncated: true });
      if (content.ok) {
        expect(content.output).toContain('1: Needle');
        expect(content.output).not.toContain('2: NEEDLE');
      }
      expect(
        await grep.execute({
          pattern: 'needle',
          ignore_case: false,
          output_mode: 'count',
          head_limit: 0,
        }),
      ).toMatchObject({ ok: true, output: 'b.txt:1' });
    });
    expect(
      GrepToolInputSchema.safeParse({
        pattern: 'x',
        glob: '*.ts',
        include: '*.ts',
        ignore_case: true,
        '-i': true,
        ignoreCase: true,
      }).success,
    ).toBe(true);
    for (const extras of [
      { glob: '*.ts', include: '*.js' },
      { ignore_case: false, '-i': true },
      { case_insensitive: true },
      { surprise: true },
    ])
      expect(GrepToolInputSchema.safeParse({ pattern: 'x', ...extras }).success).toBe(false);
  });

  test('bash honours contained cwd aliases and timeoutMs, refuses escapes and background', async () => {
    await workspace(async (root) => {
      await mkdir(join(root, 'sub'));
      await symlink(tmpdir(), join(root, 'escape'));
      const config = {
        ...defaultHarnessConfig,
        tools: {
          ...defaultHarnessConfig.tools,
          bash: { enabled: true, commandPatterns: ['pwd', 'printf'], timeoutMs: 1000 },
        },
      };
      const bash = buildTools(config, root).find((tool) => tool.name === 'bash')!;
      for (const key of ['workdir', 'cwd']) {
        const result = await bash.execute({
          command: 'pwd',
          [key]: 'sub',
          description: 'Inspect directory',
          timeoutMs: 500,
          run_in_background: false,
        });
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.output).toContain(join(root, 'sub'));
        expect(await bash.execute({ command: 'pwd', [key]: '..' })).toMatchObject({
          ok: false,
          denial: { reason: expect.stringContaining('path escape:') as unknown },
        });
        expect(await bash.execute({ command: 'pwd', [key]: 'escape' })).toMatchObject({
          ok: false,
          denial: { reason: expect.stringContaining('symlink') as unknown },
        });
      }
      expect(await bash.execute({ command: 'pwd', run_in_background: true })).toMatchObject({
        ok: false,
        denial: { reason: expect.stringContaining('not supported') as unknown },
      });
      expect(await bash.execute({ command: 'not-allowed', workdir: 'sub' })).toMatchObject({
        ok: false,
        denial: { reason: expect.stringContaining('command not allowed') as unknown },
      });
    });
    expect(
      BashToolInputSchema.safeParse({ command: 'pwd', timeout: 10, timeoutMs: 10 }).success,
    ).toBe(true);
    expect(
      BashToolInputSchema.safeParse({ command: 'pwd', timeout: 10, timeoutMs: 20 }).success,
    ).toBe(false);
  });
});
