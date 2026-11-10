import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { AcpDriver } from '../../src/driver/acp/index.js';
import { driverOptions, invocation, withScratch, narrationOf } from './acp.helpers.js';

describe('acp driver specifics (fake ACP server)', () => {
  test('THE NEVER-ASKS TRIWIRE: an ungated tool_call is evidence + an error verdict — never green', async () => {
    await withScratch(async (scratchDir, store) => {
      const driver = new AcpDriver(
        driverOptions(
          scratchDir,
          {
            FAKE_ACP_MODE: 'never-asks',
            FAKE_ACP_TOOL: 'run',
            FAKE_ACP_INPUT: JSON.stringify({ command: 'echo never-asks-marker > ungated.txt' }),
          },
          [],
        ),
      );
      const result = await driver.run(invocation({ prompt: 'never-asks run' }));
      // Even under an UNRESTRICTED policy (every ask would be answered
      // allow), a harness that never asks is a policy void — fail loud.
      expect(result.stopReason).toBe('error');
      const narration = await narrationOf(store, result.sessionId as string);
      const marker = narration.find((line) => line.includes('"never-asks"'));
      expect(marker !== undefined && marker.includes('call_ungated_')).toBe(true);
      // The ungated execution really happened (visceral evidence): the file exists.
      const record = await store.load(result.sessionId as string);
      const workspace = record?.workspace as string;
      const ungated = await readFile(join(workspace, 'ungated.txt'), 'utf8');
      expect(ungated).toContain('never-asks-marker');
    });
  });

  test.each([
    ['pending', 'complete', false],
    ['in_progress', 'error', true],
  ] as const)(
    'a %s report before permission produces %s and ungated evidence=%s',
    async (status, stopReason, ungated) => {
      await withScratch(async (scratchDir, store) => {
        const driver = new AcpDriver(
          driverOptions(
            scratchDir,
            {
              FAKE_ACP_MODE: 'tool-then-reply',
              FAKE_ACP_TOOL: 'run',
              FAKE_ACP_INPUT: JSON.stringify({ command: 'echo pre-permission-ok' }),
              FAKE_ACP_BEFORE_ASK_STATUS: status,
            },
            [],
          ),
        );
        const result = await driver.run(invocation({ prompt: 'pre-permission status' }));
        expect(result.stopReason).toBe(stopReason);
        expect(result.denials).toEqual([]);
        const narration = await narrationOf(store, result.sessionId as string);
        expect(narration.some((line) => line.includes('"never-asks"'))).toBe(ungated);
        const record = await store.load(result.sessionId as string);
        expect(
          record?.messages.some(
            (message) => message.role === 'tool' && message.content.includes('pre-permission-ok'),
          ),
        ).toBe(true);
      });
    },
  );

  test('THE DENIED-EXECUTION TRIPWIRE (#45): a denied toolCallId reporting completed is ungated-execution evidence — error, never green', async () => {
    await withScratch(async (scratchDir, store) => {
      // FAKE_ACP_DENY_BUT_COMPLETE: the ask fires, the driver answers
      // reject — and the fixture EXECUTES the tool anyway, reporting the
      // same toolCallId completed (first-channel-wins keeps the id on the
      // 'permission' channel, so the never-asks wire alone would miss
      // this bypass). The verdict fails loud; the bypass is real (the
      // file exists) but never persisted as a governed tool message.
      const driver = new AcpDriver(
        driverOptions(
          scratchDir,
          {
            FAKE_ACP_MODE: 'tool-then-reply',
            FAKE_ACP_TOOL: 'run',
            FAKE_ACP_INPUT: JSON.stringify({
              command: 'echo denied-but-ran-marker > denied-ran.txt',
            }),
            FAKE_ACP_DENY_BUT_COMPLETE: '1',
          },
          [],
        ),
      );
      const result = await driver.run(
        invocation({
          prompt: 'denied-but-completed run',
          toolPolicy: { allow: ['read'], mode: 'allowlist' },
        }),
      );
      expect(result.stopReason).toBe('error');
      // `kind` is ABSENT from the ask's toolCall on the recorded wire — the
      // denial reason says so honestly (the same shape as the reject test).
      expect(result.denials).toHaveLength(1);
      expect(result.denials[0]?.tool).toBe('unknown');
      expect(result.denials[0]?.reason).toBe(
        'tool policy: missing ACP tool kind; cannot enforce allowlist',
      );
      const narration = await narrationOf(store, result.sessionId as string);
      const marker = narration.find((line) => line.includes('"denied-tool-completed"'));
      expect(marker !== undefined && marker.includes('call_run_')).toBe(true);
      const record = await store.load(result.sessionId as string);
      const workspace = record?.workspace as string;
      const bypassed = await readFile(join(workspace, 'denied-ran.txt'), 'utf8');
      expect(bypassed).toContain('denied-but-ran-marker'); // the bypass really happened
      expect(record?.messages.some((m) => m.role === 'tool' && m.toolName === 'run')).toBe(false); // governed surface only
    });
  });

  test('the completed bypass evidence is LATCHED: a later failed update for the same id cannot erase it (CodeRabbit P1)', async () => {
    await withScratch(async (scratchDir, store) => {
      // DENY_BUT_COMPLETE + LATE_FAIL: denied → completed (the bypass) →
      // then a further update reports failed for the same id. The mutable
      // final status must not wipe the latch: the verdict stays 'error'.
      const driver = new AcpDriver(
        driverOptions(
          scratchDir,
          {
            FAKE_ACP_MODE: 'tool-then-reply',
            FAKE_ACP_TOOL: 'run',
            FAKE_ACP_INPUT: JSON.stringify({ command: 'echo latch-marker > latch.txt' }),
            FAKE_ACP_DENY_BUT_COMPLETE: '1',
            FAKE_ACP_LATE_FAIL: '1',
          },
          [],
        ),
      );
      const result = await driver.run(
        invocation({ prompt: 'latch run', toolPolicy: { allow: ['read'], mode: 'allowlist' } }),
      );
      expect(result.stopReason).toBe('error'); // latched — the late failed status did not downgrade it
      const narration = await narrationOf(store, result.sessionId as string);
      expect(narration.some((line) => line.includes('"denied-tool-completed"'))).toBe(true);
    });
  });

  test('the probe-recorded placeholder permission card is not the tool execution: the run stays a clean complete', async () => {
    await withScratch(async (scratchDir, store) => {
      // The strategy records the bridge's placeholder card — title
      // 'tool permission (<Tool>)', status 'pending', kind 'other',
      // emitted while the ask is PENDING — and warns the driver must not
      // treat that card as the tool execution. With the card live on the
      // wire (FAKE_ACP_PLACEHOLDER_CARD) the run must complete normally:
      // the card's id is the ASK's id (permission precedes it — no
      // never-asks evidence), 'pending' is not 'failed' (no denial), and
      // the real execution still lands in the record.
      const driver = new AcpDriver(
        driverOptions(
          scratchDir,
          {
            FAKE_ACP_MODE: 'tool-then-reply',
            // A tool that genuinely SUCCEEDS in the fresh workspace (run +
            // echo): the clean shape — the placeholder card must add no
            // denial of its own, and a succeeding execution adds none
            // either (a failed read would muddy the assertion with the
            // second denial channel).
            FAKE_ACP_TOOL: 'run',
            FAKE_ACP_INPUT: JSON.stringify({
              command: 'echo placeholder-card-ok > placeholder-card-marker.txt',
            }),
            FAKE_ACP_PLACEHOLDER_CARD: '1',
          },
          [],
        ),
      );
      const result = await driver.run(invocation({ prompt: 'placeholder-card run' }));
      expect(result.stopReason).toBe('complete');
      expect(result.denials).toEqual([]);
      const narration = await narrationOf(store, result.sessionId as string);
      expect(narration.some((line) => line.includes('"never-asks"'))).toBe(false);
      const record = await store.load(result.sessionId as string);
      // The REAL execution is what the record carries (allow-answered,
      // completed) and the turn settled the normal permission round-trip.
      expect(
        record?.messages.some(
          (m) => m.role === 'tool' && m.toolName === 'run' && m.content.includes('"ok":true'),
        ),
      ).toBe(true);
      expect(
        record?.messages.some(
          (m) => m.role === 'assistant' && m.content.includes('[permission:allow_once]'),
        ),
      ).toBe(true);
    });
  });
});
