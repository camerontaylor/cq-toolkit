import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { AcpDriver } from '../../src/driver/acp/index.js';
import { spawnAcpProcess } from '../../src/driver/acp/process.js';
import type { AcpSpawnFn } from '../../src/driver/acp/process.js';
import { SESSIONS_DIR } from '../../src/driver/conformance.js';
import { runLadder } from '../../src/kernel/governor.js';
import type { Clock } from '../../src/kernel/governor.js';
import type { SpawnCall } from './acp.helpers.js';
import {
  FAKE_ACP_SERVER,
  driverOptions,
  midPromptDeadline,
  fixtureHoldsPrompt,
  WEDGED_PROMPT_CHARS,
  promptWriteWedged,
  invocation,
  withScratch,
  narrationOf,
} from './acp.helpers.js';

describe('acp driver specifics (fake ACP server)', () => {
  test('cancel maps to aborted: the governed signal settles via session/cancel + the cancelled response (§2.3)', async () => {
    await withScratch(async (scratchDir, store) => {
      const calls: SpawnCall[] = [];
      const { options, clock } = midPromptDeadline(
        driverOptions(scratchDir, { FAKE_ACP_MODE: 'block-until-abort' }, calls),
        fixtureHoldsPrompt,
      );
      const driver = new AcpDriver({ ...options, termGraceMs: 500, killGraceMs: 500 });
      // The deadline lands MID-PROMPT (the fixture holds the prompt): the
      // governed signal fires → session/cancel → the cancelled prompt
      // response (usage null) settles the run.
      const outcome = await runLadder(
        async (ctx) => driver.run(invocation({ prompt: 'cancel run' }), { signal: ctx.signal }),
        { wallClockMs: 60_000 }, // nominal — the manual clock owns when it fires
        { op: 'acp', jobKey: 'acp-cancel', attempt: 1 },
        { clock },
      );
      expect(outcome.outcome).toBe('completed');
      if (outcome.outcome !== 'completed') return;
      expect(outcome.markers.some((marker) => marker.rung === 'signal')).toBe(true); // the deadline really fired
      expect(outcome.value.stopReason).toBe('aborted');
      expect(outcome.value.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }); // usage: null — unmeasured
      // Seam v3: `usage: null` is no wire measurement, so the placeholder is declared.
      expect(outcome.value.usageProvenance).toBe('unmeasured');
      expect(outcome.value.costUSD).toBeUndefined(); // never a cost on an unmeasured verdict
      const narration = await narrationOf(store, outcome.value.sessionId as string);
      expect(narration.some((line) => line.includes('"pre-prompt-abort"'))).toBe(false); // the abort landed mid-prompt
      expect(narration.some((line) => line.includes('"cancel-sent"'))).toBe(true);
    });
  }, 20_000);

  test('a vendor that IGNORES session/cancel cannot hang the governed cancel: the kill rung reaches the child mid-prompt', async () => {
    await withScratch(async (scratchDir, store) => {
      // block-until-abort + the swallow knob: the turn NEVER settles
      // protocol-side. The governed signal fires mid-prompt → the
      // session/cancel courtesy write → the settle ladder terminates the
      // child → the pending prompt rejects on the wire's exit path → the
      // run settles 'aborted'. Without the mid-prompt kill rung (Codex P1)
      // THIS test hangs into its timeout.
      const { options, clock } = midPromptDeadline(
        driverOptions(
          scratchDir,
          { FAKE_ACP_MODE: 'block-until-abort', FAKE_ACP_IGNORE_CANCEL: '1' },
          [],
        ),
        fixtureHoldsPrompt,
      );
      const driver = new AcpDriver({ ...options, termGraceMs: 300, killGraceMs: 300 });
      const outcome = await runLadder(
        async (ctx) =>
          driver.run(invocation({ prompt: 'ignore-cancel run' }), { signal: ctx.signal }),
        { wallClockMs: 60_000 }, // nominal — the manual clock owns when it fires
        { op: 'acp', jobKey: 'acp-ignore-cancel', attempt: 1 },
        { clock },
      );
      expect(outcome.outcome).toBe('completed');
      if (outcome.outcome !== 'completed') return;
      expect(outcome.markers.some((marker) => marker.rung === 'signal')).toBe(true); // the deadline really fired
      expect(outcome.value.stopReason).toBe('aborted');
      expect(outcome.value.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }); // unmeasured — the turn never settled protocol-side
      const narration = await narrationOf(store, outcome.value.sessionId as string);
      expect(narration.some((line) => line.includes('"pre-prompt-abort"'))).toBe(false); // the abort landed mid-prompt
      // The courtesy write landed BEFORE the ladder fired (the settled-write
      // ordering), then the kill settled the run.
      expect(narration.some((line) => line.includes('"cancel-sent"'))).toBe(true);
    });
  }, 20_000);

  test('attach-time abort recheck: a governed signal that fired before the listener attach still cancels the child — the run settles aborted', async () => {
    await withScratch(async (scratchDir, store) => {
      // Manual clock: the ladder's rung-1 timer fires ONLY when the test
      // flushes it — and the flush happens INSIDE the spawn seam, i.e.
      // synchronously between the spawn and the driver's abort-listener
      // attach. That is exactly the window the attach-time recheck guards:
      // the pre-dispatch `signal.aborted` check ran long before, so the
      // abort is injected while appendMessage()/readAcpSessionId()-shaped
      // awaits have already passed; the listener then attaches to an
      // ALREADY-aborted signal, which NEVER receives the abort event. The
      // unfixed driver runs the whole handshake + prompt to 'complete'
      // past a fired deadline; the fixed one cancels the child pre-prompt.
      let fireSignal: (() => void) | undefined;
      const clock: Clock = {
        now: () => 0,
        setTimeout: (fn) => {
          fireSignal ??= fn; // only rung 1 is flushable — the later rungs must never fire
          return { rung: 'signal' };
        },
        clearTimeout: () => undefined,
      };
      const calls: SpawnCall[] = [];
      const abortingSpawn: AcpSpawnFn = (opts) => {
        calls.push({ command: opts.command, args: [...opts.args], env: { ...opts.env } });
        const child = spawnAcpProcess(opts);
        fireSignal?.(); // the governed deadline lands before the listener attach
        return child;
      };
      const driver = new AcpDriver({
        command: ['node', FAKE_ACP_SERVER],
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        workspaceRoot: join(scratchDir, 'workspaces'),
        modelEnv: 'FAKE_ACP_MODEL',
        termGraceMs: 500,
        killGraceMs: 500,
        spawn: abortingSpawn,
      });
      const outcome = await runLadder(
        async (ctx) =>
          driver.run(invocation({ prompt: 'pre-attach abort run' }), { signal: ctx.signal }),
        { wallClockMs: 60_000 }, // nominal — the manual clock owns when it fires
        { op: 'acp', jobKey: 'acp-pre-attach-abort', attempt: 1 },
        { clock },
      );
      expect(outcome.outcome).toBe('completed'); // the run settled, not ladder-killed
      if (outcome.outcome !== 'completed') return;
      expect(outcome.markers.some((marker) => marker.rung === 'signal')).toBe(true); // the deadline really fired
      expect(outcome.value.stopReason).toBe('aborted');
      // The child was cancelled BEFORE the handshake: no session was ever
      // established, so no assistant turn exists and exactly one spawn
      // (the child that received the termination) happened.
      const record = await store.load(outcome.value.sessionId as string);
      expect(record?.messages.some((m) => m.role === 'assistant')).toBe(false);
      expect(calls).toHaveLength(1);
      const narration = await narrationOf(store, outcome.value.sessionId as string);
      const marker = narration.find((line) => line.includes('"pre-prompt-abort"'));
      expect(marker !== undefined).toBe(true); // the abort path RAN at attach time
      expect(narration.some((line) => line.includes('"cancel-sent"'))).toBe(false); // pre-prompt — nothing to cancel
    });
  });

  test('a cancel write stalled behind a wedged prompt cannot gate the kill: the bounded grace starts the ladder (Codex P1)', async () => {
    await withScratch(async (scratchDir, store) => {
      // The fixture goes deaf (pauses stdin) right AFTER the mode pin, so
      // the 1 MiB prompt write wedges: only the OS pipe buffer's worth is
      // accepted, the rest sits in the driver's stream queue FOREVER, and
      // the courtesy session/cancel write's callback queues BEHIND it —
      // notify() never settles. The old ladder was gated on the write's
      // .finally(), never fired, and the run hung past the decided kill
      // (THIS test times out on that regression). The fixed driver races
      // the write against cancelWriteGraceMs and runs the ladder
      // regardless of which wins.
      const { options, clock } = midPromptDeadline(
        driverOptions(
          scratchDir,
          { FAKE_ACP_MODE: 'block-until-abort', FAKE_ACP_STOP_READ_BEFORE_PROMPT: '1' },
          [],
        ),
        promptWriteWedged,
      );
      const driver = new AcpDriver({
        ...options,
        termGraceMs: 300,
        killGraceMs: 300,
        cancelWriteGraceMs: 100,
      });
      const outcome = await runLadder(
        async (ctx) =>
          driver.run(invocation({ prompt: 'x'.repeat(WEDGED_PROMPT_CHARS) }), {
            signal: ctx.signal,
          }),
        { wallClockMs: 60_000 }, // nominal — the manual clock owns when it fires
        { op: 'acp', jobKey: 'acp-stalled-cancel-write', attempt: 1 },
        { clock },
      );
      expect(outcome.outcome).toBe('completed');
      if (outcome.outcome !== 'completed') return;
      expect(outcome.markers.some((marker) => marker.rung === 'signal')).toBe(true); // the deadline really fired
      expect(outcome.value.stopReason).toBe('aborted');
      expect(outcome.value.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }); // unmeasured — the turn never settled protocol-side
      const narration = await narrationOf(store, outcome.value.sessionId as string);
      expect(narration.some((line) => line.includes('"pre-prompt-abort"'))).toBe(false); // the abort landed mid-prompt
      // The bounded grace may win the write race or the write may settle
      // first depending on the host pipe capacity. In either case the
      // governed abort must settle, rather than waiting on the child.
      expect(
        narration.some(
          (line) => line.includes('"cancel-write-stalled"') || line.includes('"cancel-sent"'),
        ),
      ).toBe(true);
    });
  }, 20_000);

  test('answer-write failure fails the run loudly: a broken enforcement channel settles error, never hangs', async () => {
    await withScratch(async (scratchDir, store) => {
      // The fixture destroys its own stdin as the permission ask goes out
      // and KEEPS RUNNING: the driver's ALLOW answer write fails (EPIPE)
      // with the prompt still pending. A driver that only narrates the
      // failure hangs here forever (no timeouts by design — I8) — THIS
      // test fails by its timeout on that regression; a correct driver
      // terminates the child via the settle ladder and settles 'error'
      // with the write-failure evidence (Codex P1).
      const driver = new AcpDriver({
        ...driverOptions(
          scratchDir,
          {
            FAKE_ACP_MODE: 'tool-then-reply',
            FAKE_ACP_TOOL: 'read',
            FAKE_ACP_INPUT: JSON.stringify({ path: 'note.txt' }),
            FAKE_ACP_CLOSE_STDIN_ON_PERMISSION: '1',
          },
          [],
        ),
        termGraceMs: 500,
        killGraceMs: 500,
      });
      const result = await driver.run(invocation({ prompt: 'broken-channel run' }));
      expect(result.stopReason).toBe('error');
      expect(result.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }); // unmeasured — the prompt never settled
      expect(result.costUSD).toBeUndefined(); // never a cost on an unmeasured verdict
      const narration = await narrationOf(store, result.sessionId as string);
      const failed = narration.find((line) => line.includes('"permission-answer-send-failed"'));
      expect(failed !== undefined).toBe(true); // the write-failure evidence
    });
  }, 20_000);
});
