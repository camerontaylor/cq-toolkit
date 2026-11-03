// Split provenance: test/harness/tools.test.ts was split by subject into the
// tools.*.test.ts siblings in this directory (shared fixtures live in
// tools.helpers.ts). This file keeps the W1.4 process-group cancellation and
// run-result cases.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { buildTools } from '../../src/harness/tools.js';
import { alive, expectDead, readPid, runOnly, withScratch } from './tools.helpers.js';

// ---------------------------------------------------------------------------
// W1.4 — `run` spawns in its OWN PROCESS GROUP; timeout and abort
// (`execute(input, { signal })`) SIGKILL the whole group, so a grandchild
// the shell forked dies with it. A kill is a RESULT
// ({ ok: true, exitCode: null, killed: true }), never a denial; only a
// failed spawn denies ('run failed: …'). These cases fork `sleep` (an
// external binary) on purpose — the group kill is the thing under test.
// ---------------------------------------------------------------------------

const GRANDCHILD = 'sleep 60 & echo $! > pid.txt; wait';
const GRANDCHILD_PATTERN = 're:^sleep 60 & echo \\$! > pid\\.txt; wait$';

describe('run: process-group cancellation (W1.4)', () => {
  test.skipIf(process.platform === 'win32')(
    'abort kills the whole group — the forked grandchild dies too',
    async () => {
      await withScratch(async (scratchDir) => {
        const run = buildTools(runOnly([GRANDCHILD_PATTERN]), scratchDir).find(
          (t) => t.name === 'bash',
        );
        const controller = new AbortController();
        const pending = run?.execute({ command: GRANDCHILD }, { signal: controller.signal });
        const pid = await readPid(join(scratchDir, 'pid.txt'));
        expect(alive(pid)).toBe(true);
        controller.abort();
        const result = await pending;
        expect(result).toMatchObject({ ok: true, exitCode: null, killed: true });
        if (result?.ok) expect(result.output).toMatch(/^CANCELLED: killed by signal/);
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
            (t) => t.name === 'bash',
          );
          const result = await run?.execute({ command: GRANDCHILD });
          expect(result).toMatchObject({ ok: true, exitCode: null, killed: true });
          if (result?.ok) expect(result.output).toMatch(/^TIMEOUT: /);
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
        (t) => t.name === 'bash',
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
      const run = buildTools(runOnly(['echo']), scratchDir).find((t) => t.name === 'bash');
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
      const run = buildTools(runOnly(['exit']), scratchDir).find((t) => t.name === 'bash');
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
        (t) => t.name === 'bash',
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
        (t) => t.name === 'bash',
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
        (t) => t.name === 'bash',
      );
      const result = await run?.execute({ command: 'echo nope' });
      expect(result?.ok).toBe(false);
      if (!result?.ok) {
        expect(result?.denial.tool).toBe('bash');
        expect(result?.denial.reason.startsWith('EXECUTION_ERROR: bash failed: ')).toBe(true);
      }
    });
  });
});
