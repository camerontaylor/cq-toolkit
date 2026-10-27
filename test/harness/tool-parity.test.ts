import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
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
  test('reviewer schemas keep a bounded canonical surface', () => {
    const shapes = {
      read: ['file_path', 'offset', 'limit'],
      grep: ['pattern', 'path', 'glob', 'ignore_case', 'output_mode', 'head_limit'],
      glob: ['pattern', 'path'],
    };
    for (const name of ['read', 'grep', 'glob'] as const) {
      expect(Object.keys(AdvertisedToolInputSchemas[name].shape)).toEqual(shapes[name]);
    }
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
