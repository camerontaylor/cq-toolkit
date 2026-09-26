// The acp driver's REAL-PROCESS contracts (plan 003 F2): the fake ACP
// server (test/fixtures/fake-acp-server.mjs) as a real child over real
// stdio. Every case here is an OS-level boundary the in-process persona
// (acp.test.ts) cannot model — see the classification table in
// docs/test-performance-notes.md:
//   - the three governed cancel/kill tests (real signals, grace windows,
//     kill escalation, a prompt write wedged behind a real pipe buffer);
//   - the stdout frame straddle (a real child's split flushes);
//   - the resume sidecar (the real handshake + the sidecar on disk);
//   - the two broken-stdin cases (a real closed fd 0: the answer and
//     rejection writes really fail while the vendor stays alive).
import type { ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { AcpDriver, ACP_SESSION_FILE } from '../../src/driver/acp/index.js';
import type { AcpDriverOptions } from '../../src/driver/acp/index.js';
import { spawnAcpProcess } from '../../src/driver/acp/process.js';
import type { AcpSpawnFn } from '../../src/driver/acp/process.js';
import { runLadder } from '../../src/kernel/governor.js';
import type { Clock } from '../../src/kernel/governor.js';
import { baseDriverOptions, invocation, narrationOf, withScratch } from './acp-harness.js';
import type { SpawnCall } from './acp-harness.js';

/**
 * A spawn seam that records every call and merges `extraEnv` over the
 * driver's child env before delegating to the REAL spawnAcpProcess — the
 * fixture is a real process in a real workspace, only the MODEL is fake.
 */
function recordingSpawn(calls: SpawnCall[], extraEnv: Record<string, string> = {}): AcpSpawnFn {
  return (opts) => {
    calls.push({ command: opts.command, args: [...opts.args], env: { ...opts.env } });
    return spawnAcpProcess({ ...opts, env: { ...opts.env, ...extraEnv } });
  };
}

/** Base driver options for the real-process contracts. */
function driverOptions(
  scratchDir: string,
  extraEnv: Record<string, string>,
  calls: SpawnCall[],
): AcpDriverOptions {
  return baseDriverOptions(scratchDir, recordingSpawn(calls, extraEnv));
}

/** Calls `onInFlight` once the child observably holds the prompt the driver dispatched. */
type PromptInFlight = (child: ChildProcess, onInFlight: () => void) => void;

/**
 * A governed deadline that lands MID-PROMPT by construction: a manual clock
 * whose first rung (the signal) fires only once `inFlight` observes the
 * prompt on the real child. A wall-clock deadline races the handshake — on
 * a loaded host it fired before the prompt (the pre-prompt-abort branch,
 * no session/cancel), so a mid-prompt assertion measured the host, not the
 * driver. Later rungs never fire: a driver that cannot settle hangs into
 * the test timeout, the regression signal these tests document.
 */
function midPromptDeadline(
  options: AcpDriverOptions,
  inFlight: PromptInFlight,
): { options: AcpDriverOptions; clock: Clock } {
  let fireSignal: (() => void) | undefined;
  const clock: Clock = {
    now: () => 0,
    setTimeout: (fn) => {
      fireSignal ??= fn; // only rung 1 is flushable — the later rungs must never fire
      return { rung: 'signal' };
    },
    clearTimeout: () => undefined,
  };
  const inner = options.spawn ?? spawnAcpProcess;
  const spawn: AcpSpawnFn = (opts) => {
    const child = inner(opts);
    // setImmediate, not a synchronous fire: this seam attaches its taps
    // BEFORE the driver's own stdout listener (AcpWire, constructed with no
    // await after the spawn), so it sees each chunk first. Deferring past
    // the current I/O callback lets the driver fold the chunk that proves
    // the prompt is in flight before the abort lands — a deadline firing
    // on an idle mid-prompt wait, not inside the driver's frame handling.
    inFlight(child, () => setImmediate(() => fireSignal?.()));
    return child;
  };
  return { options: { ...options, spawn }, clock };
}

/** The fixture HOLDS the prompt: it emits usage_update only from its session/prompt flows. */
const fixtureHoldsPrompt: PromptInFlight = (child, onInFlight) => {
  let seen = '';
  const tap = (chunk: string): void => {
    seen += chunk;
    if (!seen.includes('"usage_update"')) return;
    child.stdout?.off('data', tap);
    onInFlight();
  };
  child.stdout?.on('data', tap);
};

/** The stalled-write test's prompt size: large enough to wedge behind any OS pipe buffer. */
const WEDGED_PROMPT_CHARS = 1024 * 1024;

/**
 * Backlog that only the wedged prompt can produce. The handshake frames
 * (initialize, session establishment, the mode pin) total a few KiB, so
 * even all of them queued at once stay far below this; the pipe buffer
 * (16–64 KiB) is irrelevant because writableLength counts a chunk in full
 * until its write callback, and the unread prompt's callback never fires.
 */
const WEDGED_PROMPT_BACKLOG = WEDGED_PROMPT_CHARS / 2;

/**
 * The prompt write is WEDGED: the stalled-stdin fixture never reads the
 * prompt, so the driver's stdin holds a prompt-scale backlog that never
 * drains. A state predicate polled until true or the child exits — never
 * a deadline.
 */
const promptWriteWedged: PromptInFlight = (child, onInFlight) => {
  const poll = (): void => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if ((child.stdin?.writableLength ?? 0) > WEDGED_PROMPT_BACKLOG) onInFlight();
    else setTimeout(poll, 10);
  };
  poll();
};

describe('acp driver real-process contracts (fake ACP server process)', () => {
  test('a foreign-session ask whose REJECTION write fails settles error — never a hung run (PR #97 review, Codex P1)', async () => {
    await withScratch(async (scratchDir, store) => {
      // FOREIGN ask + stdin destroyed: the failRequest write EPIPEs, and
      // the vendor would otherwise wait forever for an answer that can
      // never be delivered. The broken-channel posture applies: verdict
      // 'error', the child terminated via the settle ladder, the run
      // settles.
      const driver = new AcpDriver(
        driverOptions(
          scratchDir,
          {
            FAKE_ACP_MODE: 'tool-then-reply',
            FAKE_ACP_TOOL: 'edit',
            FAKE_ACP_INPUT: '{"path":"a.txt"}',
            FAKE_ACP_FOREIGN_PERMISSION_SESSION: '1',
            FAKE_ACP_CLOSE_STDIN_ON_PERMISSION: '1',
          },
          [],
        ),
      );
      const result = await driver.run(invocation({ prompt: 'foreign-ask-dead-stdin run' }));
      expect(result.stopReason).toBe('error');
      const narration = await narrationOf(store, result.sessionId as string);
      expect(narration.some((line) => line.includes('"permission-rejection-send-failed"'))).toBe(
        true,
      );
    });
  }, 20_000);

  test('stdout frame straddle: a ~20k-char frame split across flushes survives the line buffer intact (frames are the data)', async () => {
    await withScratch(async (scratchDir, store) => {
      // The fixture writes ONE session/update whose JSON line is ~20k
      // chars in TWO stdout flushes with no newline between. A driver with
      // the old 8000-char stdout cap destroyed the partial frame mid-JSON
      // (ACP defines no line-length limit) — the transcript lost the chunk
      // and the overflow narration fired; THIS test failed on both.
      const driver = new AcpDriver(
        driverOptions(scratchDir, { FAKE_ACP_MODE: 'ok', FAKE_ACP_BIG_FRAME: '1' }, []),
      );
      const result = await driver.run(invocation({ prompt: 'big-frame run' }));
      expect(result.stopReason).toBe('complete');
      const record = await store.load(result.sessionId as string);
      // BOTH ends of the straddled frame folded into the transcript: the
      // line buffer held the partial bytes across the flush boundary.
      expect(
        record?.messages.some(
          (m) => m.role === 'assistant' && m.content.includes('BIGFRAME-START'),
        ),
      ).toBe(true);
      expect(
        record?.messages.some((m) => m.role === 'assistant' && m.content.includes('BIGFRAME-END')),
      ).toBe(true);
      // No truncation marker — the frame was never treated as an overflow.
      const narration = await narrationOf(store, result.sessionId as string);
      expect(narration.some((line) => line.includes('stdout line buffer overflow'))).toBe(false);
    });
    // Real OS pipe/flush contract: the split frame crosses process stdout
    // writes, so this is intentionally given a structural process budget.
  }, 15_000);

  test('resume sidecar: the ACP session id persists to the workspace; session/load continues the SAME vendor session', async () => {
    await withScratch(async (scratchDir, store) => {
      const calls1: SpawnCall[] = [];
      const first = new AcpDriver(driverOptions(scratchDir, { FAKE_ACP_MODE: 'ok' }, calls1));
      const run1 = await first.run(invocation({ prompt: 'resume run one' }));
      const workspace = (await store.load(run1.sessionId as string))?.workspace as string;
      const acpId = (await readFile(join(workspace, ACP_SESSION_FILE), 'utf8')).trim();
      expect(acpId).toMatch(/^fake-acp-/);

      // The resumed run loads the RECORDED session (proven by the fixture
      // echoing the loaded id) and reuses the SAME workspace.
      const calls2: SpawnCall[] = [];
      const second = new AcpDriver(
        driverOptions(scratchDir, { FAKE_ACP_MODE: 'resume-echo' }, calls2),
      );
      if (run1.sessionId === undefined) throw new Error('first run must create a session');
      const run2 = await second.run(
        invocation({ prompt: 'resume run two', sessionRef: run1.sessionId }),
      );
      expect(run2.sessionId).toBe(run1.sessionId);
      expect(run2.stopReason).toBe('complete');
      const record = await store.load(run1.sessionId as string);
      expect(
        record?.messages.some(
          (m) => m.role === 'assistant' && m.content.includes(`resumed from acp session ${acpId}`),
        ),
      ).toBe(true);
      // ONE session record carries both runs' turns; the sidecar is stable.
      expect(
        record?.messages.some((m) => m.role === 'user' && m.content === 'resume run one'),
      ).toBe(true);
      expect(
        record?.messages.some((m) => m.role === 'user' && m.content === 'resume run two'),
      ).toBe(true);
      expect((await readFile(join(workspace, ACP_SESSION_FILE), 'utf8')).trim()).toBe(acpId);
    });
    // Real initialize → session/new → session/load and sidecar filesystem
    // contract; keep enough budget for the child process and two runs.
  }, 15_000);

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
        () => driver.run(invocation({ prompt: 'cancel run' })),
        { wallClockMs: 60_000 }, // nominal — the manual clock owns when it fires
        { op: 'acp', jobKey: 'acp-cancel', attempt: 1 },
        { clock },
      );
      expect(outcome.outcome).toBe('completed');
      if (outcome.outcome !== 'completed') return;
      expect(outcome.markers.some((marker) => marker.rung === 'signal')).toBe(true); // the deadline really fired
      expect(outcome.value.stopReason).toBe('aborted');
      expect(outcome.value.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }); // usage: null — unmeasured
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
        () => driver.run(invocation({ prompt: 'ignore-cancel run' })),
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
        () => driver.run(invocation({ prompt: 'x'.repeat(WEDGED_PROMPT_CHARS) })),
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
      // The grace won the race: the record says the vendor never consumed
      // the cancel before the SIGTERM — and the kill happened anyway.
      expect(narration.some((line) => line.includes('"cancel-write-stalled"'))).toBe(true);
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
