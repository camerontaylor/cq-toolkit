import { describe, expect, test } from 'vitest';
import { AcpDriver } from '../../src/driver/acp/index.js';
import { driverOptions, invocation, withScratch, narrationOf } from './acp.helpers.js';

describe('acp driver specifics (fake ACP server)', () => {
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

  test('a session/request_permission naming a FOREIGN session is rejected: no answer, no evidence — the ungated tool card fails the run (PR #37 review, Codex P2)', async () => {
    await withScratch(async (scratchDir, store) => {
      // FAKE_ACP_FOREIGN_PERMISSION_SESSION: the ask names a session that
      // is not this run's. The driver must fail the request BEFORE any
      // answer-table or evidence effects — the foreign ask must not mark
      // its toolCallId permission-first (the never-asks bypass) — and the
      // vendor's subsequent tool card, ungated by any accepted ask, fails
      // the run exactly like any never-asks evidence.
      const driver = new AcpDriver(
        driverOptions(
          scratchDir,
          {
            FAKE_ACP_MODE: 'tool-then-reply',
            FAKE_ACP_TOOL: 'edit',
            FAKE_ACP_INPUT: '{"path":"a.txt"}',
            FAKE_ACP_FOREIGN_PERMISSION_SESSION: '1',
          },
          [],
        ),
      );
      const result = await driver.run(invocation({ prompt: 'foreign-ask run' }));
      expect(result.stopReason).toBe('error'); // ungated execution is an error, never green
      const narration = await narrationOf(store, result.sessionId as string);
      expect(narration.some((line) => line.includes('"permission-not-scoped"'))).toBe(true);
      expect(narration.some((line) => line.includes('"never-asks"'))).toBe(true); // the bypass is closed
    });
  });
});
