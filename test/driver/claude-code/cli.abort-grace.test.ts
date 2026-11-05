// Split from test/driver/claude-code/cli.test.ts (pure move). The outer describe
// wrapper is reproduced so every full test title is unchanged.
// Subject: the governed termination ladder and process-group teardown.

import {
  baseOptions,
  FAKE_CLI,
  invocation,
  narrationOf,
  recordingSpawn,
  withScratch,
  SpawnCall,
} from './cli.helpers.js';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, onTestFinished, test } from 'vitest';
import { ClaudeCodeDriver } from '../../../src/driver/claude-code/index.js';
import { realClock, runLadder } from '../../../src/kernel/governor.js';

describe('claude-code driver, CLI transport specifics (fake agent CLI)', () => {
  test('grace ladder: a SIGTERM-ignoring child escalates to SIGKILL — both rungs observed in order', async () => {
    await withScratch(async (scratchDir, store) => {
      const calls: SpawnCall[] = [];
      let deadline: (() => void) | undefined;
      const deadlineHandle = Symbol('readiness-gated deadline');
      const spawn = recordingSpawn(calls, { FAKE_AGENT_MODE: 'ignore-sigterm' });
      const driver = new ClaudeCodeDriver({
        ...baseOptions(scratchDir, {}, calls),
        spawn: (options) => {
          const child = spawn(options);
          onTestFinished(() => {
            child.kill('SIGKILL');
          });
          child.onStdoutLine((line) => {
            // Init is emitted only after the fixture installs its SIGTERM handler.
            if (line.includes('"subtype":"init"')) queueMicrotask(() => deadline?.());
          });
          return child;
        },
        termGraceMs: 200,
        killGraceMs: 200,
      });
      const outcome = await runLadder(
        async (ctx) => driver.run(invocation({ prompt: 'stubborn run' }), { signal: ctx.signal }),
        { wallClockMs: 1000 },
        { op: 'subprocess', jobKey: 'subprocess-ladder', attempt: 1 },
        {
          clock: {
            now: realClock.now,
            setTimeout: (fn, ms) => {
              if (deadline === undefined) {
                deadline = fn;
                return deadlineHandle;
              }
              return realClock.setTimeout(fn, ms);
            },
            clearTimeout: (handle) => {
              if (handle !== deadlineHandle) realClock.clearTimeout(handle);
            },
          },
        },
      );
      expect(outcome.outcome).toBe('completed');
      if (outcome.outcome !== 'completed') return;
      expect(outcome.value.stopReason).toBe('aborted');
      // The driver's own ladder markers, recorded as session narration:
      // SIGTERM first (ignored by the fixture), then SIGKILL.
      const sessionId = outcome.value.sessionId as string;
      const narration = await narrationOf(store, sessionId);
      const rungs = narration
        .filter((line) => line.includes('"termination-rung"'))
        .map((line) => JSON.parse(line) as { rung: string });
      expect(rungs.map((r) => r.rung)).toEqual(['sigterm', 'sigkill']);
      const termination = narration.find((line) => line.includes('"termination"'));
      expect(termination !== undefined && termination.includes('"killed"')).toBe(true);
      // The child really was SIGKILLed: exactly one spawn, never completed.
      expect(calls).toHaveLength(1);
    });
  }, 20_000);

  test('graceful abort: a default-disposition child dies on SIGTERM — one rung, no SIGKILL', async () => {
    await withScratch(async (scratchDir, store) => {
      const driver = new ClaudeCodeDriver({
        ...baseOptions(
          scratchDir,
          { FAKE_AGENT_MODE: 'slow-exit-ms', FAKE_AGENT_SLOW_EXIT_MS: '10000' },
          [],
        ),
        termGraceMs: 200,
      });
      const outcome = await runLadder(
        async (ctx) => driver.run(invocation({ prompt: 'slow run' }), { signal: ctx.signal }),
        // > node startup: the abort must land after the driver attached the
        // ladder (an abort before the spawn path returns the early-aborted
        // verdict with no narration)
        { wallClockMs: 300 },
        { op: 'subprocess', jobKey: 'subprocess-graceful', attempt: 1 },
      );
      expect(outcome.outcome).toBe('completed');
      if (outcome.outcome !== 'completed') return;
      expect(outcome.value.stopReason).toBe('aborted');
      // error rides only stopReason 'error' (frozen WorkerResultSchema contract).
      expect(outcome.value.error).toBeUndefined();
      const narration = await narrationOf(store, outcome.value.sessionId as string);
      const rungs = narration
        .filter((line) => line.includes('"termination-rung"'))
        .map((line) => JSON.parse(line) as { rung: string });
      expect(rungs.map((r) => r.rung)).toEqual(['sigterm']); // no SIGKILL rung
      const termination = narration.find((line) => line.includes('"termination"'));
      expect(termination !== undefined && termination.includes('"terminated"')).toBe(true);
    });
  }, 20_000);

  test('abort kills the whole process GROUP: a fixture-spawned grandchild dies with the CLI (#19-9)', async () => {
    await withScratch(async (scratchDir) => {
      const pidFile = join(scratchDir, 'grandchild.pid');
      const calls: SpawnCall[] = [];
      // The binary template carries the fixture-only probe flag: the CLI
      // spawns a sleeping grandchild in ITS process group and records the
      // pid, then ignores SIGTERM (forcing the SIGKILL rung).
      // Readiness-gated deadline: the governed abort fires only once the
      // grandchild pid is on disk (the harness-mode CLI connects its MCP
      // server before init, so a fixed wall clock would race node startup).
      let deadline: (() => void) | undefined;
      const deadlineHandle = Symbol('pid-file-gated deadline');
      const firePidReady = async (): Promise<void> => {
        for (let i = 0; i < 1_000; i++) {
          try {
            await stat(pidFile);
            deadline?.();
            return;
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        }
      };
      const spawn = recordingSpawn(calls, { FAKE_AGENT_MODE: 'ignore-sigterm' });
      const driver = new ClaudeCodeDriver({
        ...baseOptions(scratchDir, {}, calls),
        binary: ['node', FAKE_CLI, '--spawn-grandchild', pidFile],
        spawn: (options) => {
          const child = spawn(options);
          onTestFinished(() => {
            child.kill('SIGKILL');
          });
          child.onStdoutLine((line) => {
            if (line.includes('"subtype":"init"')) firePidReady().catch(() => undefined);
          });
          return child;
        },
        termGraceMs: 200,
        killGraceMs: 200,
      });
      const outcome = await runLadder(
        async (ctx) => driver.run(invocation({ prompt: 'group kill run' }), { signal: ctx.signal }),
        { wallClockMs: 1000 },
        { op: 'subprocess', jobKey: 'subprocess-group', attempt: 1 },
        {
          clock: {
            now: realClock.now,
            setTimeout: (fn, ms) => {
              if (deadline === undefined) {
                deadline = fn;
                return deadlineHandle;
              }
              return realClock.setTimeout(fn, ms);
            },
            clearTimeout: (handle) => {
              if (handle !== deadlineHandle) realClock.clearTimeout(handle);
            },
          },
        },
      );
      expect(outcome.outcome).toBe('completed');
      if (outcome.outcome !== 'completed') return;
      expect(outcome.value.stopReason).toBe('aborted');

      // The grandchild pid was recorded; after the group kill it is DEAD —
      // poll process.kill(pid, 0) until ESRCH. A direct-child-only kill
      // would leave the (non-detached, group-inheriting) grandchild running.
      const grandchildPid = Number((await readFile(pidFile, 'utf8')).trim());
      expect(Number.isInteger(grandchildPid) && grandchildPid > 0).toBe(true);
      let dead = false;
      for (let i = 0; i < 200 && !dead; i++) {
        try {
          process.kill(grandchildPid, 0);
          await new Promise((resolve) => setTimeout(resolve, 25));
        } catch {
          dead = true; // ESRCH — the process is gone
        }
      }
      expect(dead).toBe(true);
    });
    // Structural OS-signal-ladder budget: SIGTERM grace, then SIGKILL, then
    // descendant teardown are each subject to host-load swings beyond the
    // five-second process-death poll above, after a PID-readiness poll of
    // up to 20s: the budget stays above both sequential windows.
  }, 30_000);
});
