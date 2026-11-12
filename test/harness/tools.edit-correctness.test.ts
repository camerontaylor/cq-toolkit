// Split provenance: test/harness/tools.test.ts was split by subject into the
// tools.*.test.ts siblings in this directory (shared fixtures live in
// tools.helpers.ts). This file keeps the F1 edit-correctness cases; the
// concurrent-edit and admission-ordering cases live in
// tools.edit-concurrency.test.ts.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { buildTools } from '../../src/harness/tools.js';
import { defaultHarnessConfig } from '../../src/harness/config.js';
import { defaultTools, withScratch } from './tools.helpers.js';

// ---------------------------------------------------------------------------
// F1 — canonical edit/write/bash correctness
// ---------------------------------------------------------------------------

describe('F1 edit correctness', () => {
  test('an ambiguous target is refused unless replace_all is true', async () => {
    await withScratch(async (scratchDir) => {
      const tools = defaultTools(scratchDir);
      await writeFile(join(scratchDir, 'dup.txt'), 'x\nx\n', 'utf8');
      await tools.read.execute({ path: 'dup.txt' });

      const refused = await tools.edit.execute({
        file_path: 'dup.txt',
        old_string: 'x',
        new_string: 'y',
      });
      expect(refused.ok).toBe(false);
      if (!refused.ok) {
        expect(refused.denial.reason).toContain('not unique');
        expect(refused.denial.reason).toContain('replace_all');
      }
      await expect(readFile(join(scratchDir, 'dup.txt'), 'utf8')).resolves.toBe('x\nx\n');

      const replaced = await tools.edit.execute({
        file_path: 'dup.txt',
        old_string: 'x',
        new_string: 'y',
        replace_all: true,
      });
      expect(replaced).toMatchObject({ ok: true });
      if (replaced.ok) expect(replaced.output).toContain('replaced 2 occurrences');
      await expect(readFile(join(scratchDir, 'dup.txt'), 'utf8')).resolves.toBe('y\ny\n');
    });
  });

  test('overlapping matches count as ambiguous; replace_all uses non-overlapping spans', async () => {
    await withScratch(async (scratchDir) => {
      const tools = defaultTools(scratchDir);
      await writeFile(join(scratchDir, 'overlap.txt'), 'aaa\n', 'utf8');
      await tools.read.execute({ path: 'overlap.txt' });

      // `aa` starts at 0 AND 1: unique-match refusal must see both.
      const refused = await tools.edit.execute({
        file_path: 'overlap.txt',
        old_string: 'aa',
        new_string: 'b',
      });
      expect(refused.ok).toBe(false);
      if (!refused.ok) {
        expect(refused.denial.reason).toContain('multiple possible matches');
      }
      await expect(readFile(join(scratchDir, 'overlap.txt'), 'utf8')).resolves.toBe('aaa\n');

      // replace_all keeps standard non-overlapping semantics: one span.
      const replaced = await tools.edit.execute({
        file_path: 'overlap.txt',
        old_string: 'aa',
        new_string: 'b',
        replace_all: true,
      });
      expect(replaced).toMatchObject({ ok: true });
      if (replaced.ok) expect(replaced.output).toContain('replaced 1 occurrence');
      await expect(readFile(join(scratchDir, 'overlap.txt'), 'utf8')).resolves.toBe('ba\n');
    });
  });

  test('mixed line endings keep their untouched bytes', async () => {
    await withScratch(async (scratchDir) => {
      const tools = defaultTools(scratchDir);
      await writeFile(join(scratchDir, 'mixed.txt'), 'a\r\nb\nc\r\n', 'utf8');
      await tools.read.execute({ path: 'mixed.txt' });
      const result = await tools.edit.execute({
        file_path: 'mixed.txt',
        old_string: 'b',
        new_string: 'B',
      });
      expect(result).toMatchObject({ ok: true });
      // The lone LF between b and c is NOT rewritten to CRLF.
      await expect(readFile(join(scratchDir, 'mixed.txt'), 'utf8')).resolves.toBe('a\r\nB\nc\r\n');
    });
  });

  test('a needle beginning with LF matches a CRLF pair once, not twice', async () => {
    await withScratch(async (scratchDir) => {
      const tools = defaultTools(scratchDir);
      await writeFile(join(scratchDir, 'lfstart.txt'), 'a\r\nb\r\n', 'utf8');
      await tools.read.execute({ path: 'lfstart.txt' });
      // `\nb` has two raw starts in `\r\n` (the CR and the LF); they are one
      // logical occurrence, so the unique-match gate must not see ambiguity.
      const result = await tools.edit.execute({
        file_path: 'lfstart.txt',
        old_string: '\nb',
        new_string: '\nB',
      });
      expect(result).toMatchObject({ ok: true });
      await expect(readFile(join(scratchDir, 'lfstart.txt'), 'utf8')).resolves.toBe('a\r\nB\r\n');
    });
  });

  test('the pre-F1 path/oldText/newText arguments are still accepted', async () => {
    await withScratch(async (scratchDir) => {
      const tools = defaultTools(scratchDir);
      await writeFile(join(scratchDir, 'legacy.txt'), 'hello world\n', 'utf8');
      await tools.read.execute({ path: 'legacy.txt' });
      const result = await tools.edit.execute({
        path: 'legacy.txt',
        oldText: 'world',
        newText: 'there',
      });
      expect(result).toMatchObject({ ok: true });
      await expect(readFile(join(scratchDir, 'legacy.txt'), 'utf8')).resolves.toBe('hello there\n');
    });
  });

  test('a CRLF file with a BOM keeps both after an LF-space edit', async () => {
    await withScratch(async (scratchDir) => {
      const tools = defaultTools(scratchDir);
      const original = '\uFEFFalpha\r\nbeta\r\n';
      await writeFile(join(scratchDir, 'crlf.txt'), original, 'utf8');
      await tools.read.execute({ path: 'crlf.txt' });
      const result = await tools.edit.execute({
        file_path: 'crlf.txt',
        old_string: 'alpha\nbeta',
        new_string: 'alpha\nBETA',
      });
      expect(result).toMatchObject({ ok: true });
      await expect(readFile(join(scratchDir, 'crlf.txt'), 'utf8')).resolves.toBe(
        '\uFEFFalpha\r\nBETA\r\n',
      );
    });
  });

  test('edit requires a prior read and refuses a file that changed since it', async () => {
    await withScratch(async (scratchDir) => {
      const tools = defaultTools(scratchDir);
      await writeFile(join(scratchDir, 'stale.txt'), 'one\n', 'utf8');

      const unread = await tools.edit.execute({
        file_path: 'stale.txt',
        old_string: 'one',
        new_string: 'two',
      });
      expect(unread.ok).toBe(false);
      if (!unread.ok) expect(unread.denial.reason).toContain('must be read before');

      await tools.read.execute({ path: 'stale.txt' });
      await writeFile(join(scratchDir, 'stale.txt'), 'changed\n', 'utf8');
      const stale = await tools.edit.execute({
        file_path: 'stale.txt',
        old_string: 'one',
        new_string: 'two',
      });
      expect(stale.ok).toBe(false);
      if (!stale.ok) expect(stale.denial.reason).toContain('changed since it was read');

      await tools.read.execute({ path: 'stale.txt' });
      const fresh = await tools.edit.execute({
        file_path: 'stale.txt',
        old_string: 'changed',
        new_string: 'two',
      });
      expect(fresh).toMatchObject({ ok: true });
    });
  });

  test('binary and invalid-UTF-8 files are refused, never rewritten', async () => {
    await withScratch(async (scratchDir) => {
      const tools = defaultTools(scratchDir);
      await writeFile(join(scratchDir, 'bin.dat'), Buffer.from([0x61, 0x00, 0x62]));
      await writeFile(join(scratchDir, 'bad.txt'), Buffer.from([0xff, 0xfe, 0x61]));
      await tools.read.execute({ path: 'bin.dat' });
      await tools.read.execute({ path: 'bad.txt' });

      const binary = await tools.edit.execute({
        file_path: 'bin.dat',
        old_string: 'a',
        new_string: 'z',
      });
      expect(binary.ok).toBe(false);
      if (!binary.ok) expect(binary.denial.reason).toContain('binary file');

      const invalid = await tools.edit.execute({
        file_path: 'bad.txt',
        old_string: 'a',
        new_string: 'z',
      });
      expect(invalid.ok).toBe(false);
      if (!invalid.ok) expect(invalid.denial.reason).toContain('not valid UTF-8');
    });
  });

  test('concurrent edits of one file serialize: the second sees the first result', async () => {
    await withScratch(async (scratchDir) => {
      const tools = defaultTools(scratchDir);
      await writeFile(join(scratchDir, 'serial.txt'), 'a\n', 'utf8');
      await tools.read.execute({ path: 'serial.txt' });
      const [first, second] = await Promise.all([
        tools.edit.execute({ file_path: 'serial.txt', old_string: 'a', new_string: 'b' }),
        tools.edit.execute({ file_path: 'serial.txt', old_string: 'b', new_string: 'c' }),
      ]);
      expect(first.ok, first.ok ? '' : first.denial.reason).toBe(true);
      expect(second.ok, second.ok ? '' : second.denial.reason).toBe(true);
      await expect(readFile(join(scratchDir, 'serial.txt'), 'utf8')).resolves.toBe('c\n');
    });
  });

  test('a preflight denial leaves no poisoned queue: the next SAME-path call runs normally', async () => {
    await withScratch(async (scratchDir) => {
      const file = join(scratchDir, 'guard.txt');
      await writeFile(file, 'keep\n', 'utf8');
      // SAME lexical path for both calls; edit.pathPatterns DENY it, so the
      // edit's preflight denies (path not allowed) while read allows — the
      // exact 586-poisoning shape: edit admitted, denied, released; a later
      // read on the SAME path must run normally.
      const denyEditConfig = {
        ...defaultHarnessConfig,
        tools: {
          ...defaultHarnessConfig.tools,
          edit: {
            ...defaultHarnessConfig.tools.edit,
            pathPatterns: ['elsewhere/**'],
          },
        },
      };
      const tools = buildTools(denyEditConfig, scratchDir);
      const read = tools.find((c) => c.name === 'read');
      const edit = tools.find((c) => c.name === 'edit');
      if (read === undefined || edit === undefined) throw new Error('missing tools');

      const denied = await edit.execute({
        file_path: 'guard.txt',
        old_string: 'keep',
        new_string: 'x',
      });
      expect(denied.ok, denied.ok ? '' : denied.denial.reason).toBe(false);
      if (!denied.ok) expect(denied.denial.reason).toContain('path not allowed');

      // NO poisoned queue: a later read on the SAME path runs normally.
      const fine = await read.execute({ path: 'guard.txt' });
      expect(fine.ok, fine.ok ? '' : fine.denial.reason).toBe(true);
    });
  });

  // #1194 follow-up: the edit allowlist invoke() builds from a finding path
  // compiles through compilePathPatterns, whose literalChar escapes brackets
  // — so a bracketed route name authorizes exactly that file — while `*` and
  // `?` are wildcards, which is why safeFile must refuse them.
  test('a bracketed edit pattern authorizes only the literal file', async () => {
    await withScratch(async (scratchDir) => {
      await mkdir(join(scratchDir, 'pages'), { recursive: true });
      await mkdir(join(scratchDir, 'src'), { recursive: true });
      for (const name of ['[id].tsx', 'i.tsx', 'd.tsx'])
        await writeFile(join(scratchDir, 'pages', name), 'seed\n', 'utf8');
      await writeFile(join(scratchDir, 'src/ab.ts'), 'seed\n', 'utf8');
      const toolsWithPatterns = (pattern: string) =>
        buildTools(
          {
            ...defaultHarnessConfig,
            tools: {
              ...defaultHarnessConfig.tools,
              edit: { ...defaultHarnessConfig.tools.edit, pathPatterns: [pattern] },
            },
          },
          scratchDir,
        );
      const editFile = async (pattern: string, file: string, dir: string) => {
        const tools = toolsWithPatterns(pattern);
        const read = tools.find((c) => c.name === 'read');
        const edit = tools.find((c) => c.name === 'edit');
        if (read === undefined || edit === undefined) throw new Error('missing tools');
        // edit refuses FS_NOT_READ without a prior read on the same instance.
        const seen = await read.execute({ path: `${dir}/${file}` });
        if (!seen.ok) return seen.denial.reason;
        const result = await edit.execute({
          file_path: `${dir}/${file}`,
          old_string: 'seed',
          new_string: 'edited',
        });
        return result.ok ? 'ok' : result.denial.reason;
      };
      expect(await editFile('pages/[id].tsx', '[id].tsx', 'pages')).toBe('ok');
      expect(await editFile('pages/[id].tsx', 'i.tsx', 'pages')).toContain('path not allowed');
      expect(await editFile('pages/[id].tsx', 'd.tsx', 'pages')).toContain('path not allowed');
      // And why `?` stays refused in safeFile: the same compiler widens it
      // to any one-character sibling, beyond the single finding file.
      expect(await editFile('src/a?.ts', 'ab.ts', 'src')).toBe('ok');
    });
  });
});
