import { describe, expect, test } from 'vitest';
import { AcpDriver } from '../../src/driver/acp/index.js';
import { driverOptions, invocation, withScratch, narrationOf } from './acp.helpers.js';

describe('acp driver specifics (fake ACP server)', () => {
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

  test('an oversized frame fails the CONNECTION (#42): error verdict naming the frame — never silent truncation', async () => {
    await withScratch(async (scratchDir, store) => {
      // FAKE_ACP_HUGE_FRAME: a >1 MiB frame prefix with NO newline, never
      // completed. The old shape narrated a truncation marker and kept
      // reading — a possibly-valid frame destroyed and the wire misframed
      // forever. The fixed wire fails the connection: the pending prompt
      // rejects naming the oversized frame and the run settles 'error'.
      const driver = new AcpDriver(
        driverOptions(scratchDir, { FAKE_ACP_MODE: 'ok', FAKE_ACP_HUGE_FRAME: '1' }, []),
      );
      const result = await driver.run(invocation({ prompt: 'oversized frame run' }));
      expect(result.stopReason).toBe('error');
      expect(result.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }); // the turn never settled protocol-side
      const narration = await narrationOf(store, result.sessionId as string);
      expect(narration.some((line) => line.includes('stdout line buffer overflow'))).toBe(true);
      const failure = narration.find((line) => line.includes('"prompt-failure"'));
      expect(failure !== undefined && failure.includes('oversized frame')).toBe(true);
    });
  });

  test('an oversized frame AFTER a settled turn still pins the verdict error — the connection failure is verdict evidence (CodeRabbit P2)', async () => {
    await withScratch(async (scratchDir, store) => {
      // HUGE_FRAME_AFTER_REPLY + IGNORE_CANCEL: a valid turn settles
      // end_turn FIRST, then the (signal-tolerant) harness emits the
      // oversized unterminated frame DURING the settle ladder's term
      // grace. The pending table is empty at failConnection (nothing left
      // to reject) — the stored connection failure must still pin 'error',
      // with the REAL measurement folded (the response did arrive).
      const driver = new AcpDriver(
        driverOptions(
          scratchDir,
          {
            FAKE_ACP_MODE: 'ok',
            FAKE_ACP_HUGE_FRAME_AFTER_REPLY: '1',
            FAKE_ACP_IGNORE_CANCEL: '1',
          },
          [],
        ),
      );
      const result = await driver.run(invocation({ prompt: 'post-reply overflow run' }));
      expect(result.stopReason).toBe('error'); // pinned past the green-looking response
      expect(result.usage).toEqual({ input: 10, output: 5, cacheRead: 2, cacheWrite: 3 }); // the real measurement folds
      const narration = await narrationOf(store, result.sessionId as string);
      expect(narration.some((line) => line.includes('stdout line buffer overflow'))).toBe(true);
      expect(narration.some((line) => line.includes('"connection-failed"'))).toBe(true);
    });
  });

  test('a COMPLETE newline-terminated frame over the line bound still fails the connection — the bound is a true bound (Codex P2)', async () => {
    await withScratch(async (scratchDir, store) => {
      // FAKE_ACP_HUGE_FRAME_COMPLETE: a whole >1 MiB frame, newline and
      // all. The extraction loop must enforce the bound on COMPLETE frames
      // too — the old check ran only on the unterminated leftover, so a
      // valid oversized frame folded as if nothing was wrong.
      const driver = new AcpDriver(
        driverOptions(scratchDir, { FAKE_ACP_MODE: 'ok', FAKE_ACP_HUGE_FRAME_COMPLETE: '1' }, []),
      );
      const result = await driver.run(invocation({ prompt: 'complete-oversized run' }));
      expect(result.stopReason).toBe('error');
      expect(result.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }); // never settled protocol-side
      const narration = await narrationOf(store, result.sessionId as string);
      // EITHER bound branch may fire depending on how the OS chunks the
      // 1.1 MB write: the complete-line bound (this test's subject) or the
      // unterminated-accumulation overflow — both fail the connection.
      const bounded =
        narration.some((line) => line.includes('exceeds the')) ||
        narration.some((line) => line.includes('stdout line buffer overflow'));
      expect(bounded).toBe(true);
      const failure = narration.find((line) => line.includes('"prompt-failure"'));
      expect(failure !== undefined && failure.includes('oversized frame')).toBe(true);
    });
  });
});
