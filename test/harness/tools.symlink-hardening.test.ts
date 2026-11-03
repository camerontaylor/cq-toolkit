// Split provenance: test/harness/tools.test.ts was split by subject into the
// tools.*.test.ts siblings in this directory (shared fixtures live in
// tools.helpers.ts). This file keeps the fix-5 symlink-hardening cases.
//
// Harness tool-surface tests — PR 10 round-1 fixes 1 and 5, plus issue #18:
//   - fix 1 (HIGH): token-prefix command patterns must NOT bless shell
//     metacharacters (the exec shell interprets what the token prefix never
//     saw); anchored re: patterns are the documented escape hatch.
//   - fix 5 (MED): pre-existing symlinks pointing outside the workspace are
//     denied on read/edit (realpath re-check; the TOCTOU window stays
//     documented, not tested — it is not deterministically exercisable).
//   - issue #18: exec's maxBuffer is sized above the output cap so a noisy
//     command returns a TRUNCATED RESULT (capOutput truncates), never the
//     1 MiB default's string-code rejection dressed up as a run failure.
//
// NO EXTERNAL BINARIES (review round 3, finding 1): every ALLOWED case
// actually EXECUTES through /bin/sh, so its command must be shell BUILTINS
// only (echo / printf / exit / true / false). DENIED cases never execute —
// their command strings may name whatever the judgment is about.
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { buildTools } from '../../src/harness/tools.js';
import { defaultHarnessConfig } from '../../src/harness/config.js';
import type { HarnessConfig } from '../../src/harness/config.js';
import { withScratch } from './tools.helpers.js';

describe('symlink hardening (fix 5)', () => {
  test('a pre-existing symlink pointing outside the workspace is denied on read and edit', async () => {
    await withScratch(async (scratchDir) => {
      const workspace = join(scratchDir, 'ws');
      const outside = join(scratchDir, 'outside');
      await mkdir(workspace, { recursive: true });
      await mkdir(outside, { recursive: true });
      await writeFile(join(outside, 'secret.txt'), 'top secret', 'utf8');
      await symlink(join(outside, 'secret.txt'), join(workspace, 'link.txt'));

      const tools = buildTools(defaultHarnessConfig, workspace);
      const read = tools.find((t) => t.name === 'read');
      const edit = tools.find((t) => t.name === 'edit');

      const readResult = await read?.execute({ path: 'link.txt' });
      expect(readResult?.ok).toBe(false);
      if (!readResult?.ok) {
        expect(readResult?.denial.reason).toContain('path escape');
        expect(readResult?.denial.reason).toContain('symlink');
      }

      const editResult = await edit?.execute({ path: 'link.txt', oldText: 'secret', newText: 'x' });
      expect(editResult?.ok).toBe(false);
      if (!editResult?.ok) {
        expect(editResult?.denial.reason).toContain('path escape');
        expect(editResult?.denial.reason).toContain('symlink');
      }
      // The outside file is untouched.
      await expect(read?.execute({ path: 'link.txt' })).resolves.toMatchObject({ ok: false });
    });
  });

  test('a real file inside the workspace still reads fine (no false positives)', async () => {
    await withScratch(async (scratchDir) => {
      const workspace = join(scratchDir, 'ws');
      await mkdir(workspace, { recursive: true });
      await writeFile(join(workspace, 'real.txt'), 'plain content', 'utf8');
      const read = buildTools(defaultHarnessConfig, workspace).find((t) => t.name === 'read');
      const result = await read?.execute({ path: 'real.txt' });
      expect(result?.ok).toBe(true);
    });
  });

  test('an in-workspace symlink cannot use its lexical name to bless an out-of-pattern target', async () => {
    await withScratch(async (scratchDir) => {
      const workspace = join(scratchDir, 'ws');
      await mkdir(join(workspace, 'src'), { recursive: true });
      await writeFile(join(workspace, 'secret.txt'), 'top secret', 'utf8');
      await writeFile(join(workspace, 'src', 'real.txt'), 'plain content', 'utf8');
      // src/link → ../secret.txt: INSIDE the workspace, OUTSIDE the 'src/**'
      // pattern — the lexical name matches while the I/O would land on
      // 'secret.txt', so the realpath-side allowlist check must deny.
      await symlink(join('..', 'secret.txt'), join(workspace, 'src', 'link'));

      const srcOnly: HarnessConfig = {
        ...defaultHarnessConfig,
        tools: {
          ...defaultHarnessConfig.tools,
          read: { enabled: true, pathPatterns: ['src/**'], maxOutputChars: 10_000 },
          edit: { enabled: true, pathPatterns: ['src/**'], maxOutputChars: 10_000 },
        },
      };
      const tools = buildTools(srcOnly, workspace);
      const read = tools.find((t) => t.name === 'read');
      const edit = tools.find((t) => t.name === 'edit');

      const viaLink = await read?.execute({ path: 'src/link' });
      expect(viaLink?.ok).toBe(false);
      if (!viaLink?.ok) {
        expect(viaLink?.denial.reason).toBe(
          "PATH_DENIED: path not allowed by harness config allowlist: 'src/link'",
        );
      }

      // Same gate on the write side.
      const editViaLink = await edit?.execute({ path: 'src/link', oldText: 'top', newText: 'x' });
      expect(editViaLink?.ok).toBe(false);
      if (!editViaLink?.ok) {
        expect(editViaLink?.denial.reason).toContain(
          'path not allowed by harness config allowlist',
        );
      }

      // The out-of-pattern target stays unreachable by its own name too…
      await expect(read?.execute({ path: 'secret.txt' })).resolves.toMatchObject({ ok: false });
      // …and the real in-pattern file still reads (no false positive).
      await expect(read?.execute({ path: 'src/real.txt' })).resolves.toMatchObject({ ok: true });
    });
  });
});
