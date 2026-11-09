import { describe, expect, test } from 'vitest';
import { AcpDriver } from '../../src/driver/acp/index.js';
import { driverOptions, invocation, withScratch, narrationOf } from './acp.helpers.js';

describe('acp driver specifics (fake ACP server)', () => {
  test('the mode pin is observable: the session really runs in build (the echo proves the pin landed)', async () => {
    await withScratch(async (scratchDir, store) => {
      const driver = new AcpDriver(
        driverOptions(
          scratchDir,
          {
            FAKE_ACP_MODE: 'tool-then-reply',
            FAKE_ACP_TOOL: 'read',
            FAKE_ACP_INPUT: JSON.stringify({ path: 'note.txt' }),
          },
          [],
        ),
      );
      const result = await driver.run(invocation({ prompt: 'mode-pin run' }));
      const record = await store.load(result.sessionId as string);
      // The fixture echoes the session mode AFTER the pin: '[mode:build]',
      // never '[mode:yolo]' — a driver that skipped the pin would fail here.
      expect(
        record?.messages.some((m) => m.role === 'assistant' && m.content.includes('[mode:build]')),
      ).toBe(true);
      expect(
        record?.messages.some((m) => m.role === 'assistant' && m.content.includes('[mode:yolo]')),
      ).toBe(false);
    });
  });

  test('the mode pin must be CONFIRMED: a response echoing yolo (or echoing nothing) fails the run pre-prompt (#39)', async () => {
    await withScratch(async (scratchDir, store) => {
      // FAKE_ACP_IGNORE_MODE_PIN: the pin request is answered 2xx but the
      // fixture never applies it — the echo names 'yolo'. A driver that
      // trusts the 2xx prompts into the policy void; the fixed driver
      // requires one confirmation surface to name 'build' — the echo, the
      // response's mode configOption, or a fresh current_mode_update — and
      // refuses to prompt when none does (this persona provides none).
      const driver = new AcpDriver(
        driverOptions(scratchDir, { FAKE_ACP_MODE: 'ok', FAKE_ACP_IGNORE_MODE_PIN: '1' }, []),
      );
      const result = await driver.run(invocation({ prompt: 'unconfirmed pin run' }));
      expect(result.stopReason).toBe('error');
      expect(result.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }); // never prompted — unmeasured
      const narration = await narrationOf(store, result.sessionId as string);
      const marker = narration.find((line) => line.includes('"handshake-failure"'));
      expect(marker !== undefined && marker.includes('mode pin was not confirmed')).toBe(true);
      expect(marker !== undefined && marker.includes("'yolo'")).toBe(true);
      const record = await store.load(result.sessionId as string);
      expect(record?.messages.some((m) => m.role === 'assistant')).toBe(false); // the prompt never fired
    });
  });

  test('the mode pin confirms from the NOTIFICATION surface: the live shape (no modes echo, current_mode_update build before the response) prompts normally', async () => {
    await withScratch(async (scratchDir, store) => {
      // FAKE_ACP_MODE_PIN_NOTIFICATION: the live vendor's recorded shape
      // (probe 2026-09-14) — the set_config_option answer carries NO modes
      // member; the switch is broadcast as current_mode_update 'build'
      // written BEFORE the response line. The driver must confirm the pin
      // from that surface and prompt; an echo-only gate would fail every
      // live run pre-prompt (round-1 review finding 1).
      const driver = new AcpDriver(
        driverOptions(
          scratchDir,
          {
            FAKE_ACP_MODE: 'tool-then-reply',
            FAKE_ACP_TOOL: 'read',
            FAKE_ACP_INPUT: JSON.stringify({ path: 'note.txt' }),
            FAKE_ACP_MODE_PIN_NOTIFICATION: '1',
          },
          [],
        ),
      );
      const result = await driver.run(invocation({ prompt: 'notification-pin run' }));
      expect(result.stopReason).toBe('complete'); // confirmed via current_mode_update — the prompt fired
      const record = await store.load(result.sessionId as string);
      expect(
        record?.messages.some((m) => m.role === 'assistant' && m.content.includes('[mode:build]')),
      ).toBe(true);
    });
  });

  test('the mode pin confirms from the CONFIG-OPTION response: no modes echo, no notification, configOptions mode=build prompts normally', async () => {
    await withScratch(async (scratchDir, store) => {
      // FAKE_ACP_MODE_PIN_CONFIG_OPTION: the compliant-agent shape ACP
      // allows — the set_config_option answer returns the session's
      // current values in `configOptions`, so the applied switch is the
      // `mode` entry's currentValue, with NO modes echo and NO
      // current_mode_update. A driver verifying only those two surfaces
      // would reject this successful pin before every prompt.
      const driver = new AcpDriver(
        driverOptions(
          scratchDir,
          {
            FAKE_ACP_MODE: 'tool-then-reply',
            FAKE_ACP_TOOL: 'read',
            FAKE_ACP_INPUT: JSON.stringify({ path: 'note.txt' }),
            FAKE_ACP_MODE_PIN_CONFIG_OPTION: '1',
          },
          [],
        ),
      );
      const result = await driver.run(invocation({ prompt: 'config-option-pin run' }));
      expect(result.stopReason).toBe('complete'); // confirmed via configOptions — the prompt fired
      const record = await store.load(result.sessionId as string);
      expect(
        record?.messages.some((m) => m.role === 'assistant' && m.content.includes('[mode:build]')),
      ).toBe(true);
    });
  });

  test('a PRE-pin mode report naming build is STALE — it cannot confirm the pin (PR #53 review, Codex P1)', async () => {
    await withScratch(async (scratchDir, store) => {
      // FAKE_ACP_PRE_PIN_MODE_BUILD: the agent announces its initial mode
      // 'build' right after session/new (the loading-an-already-build-
      // session shape), and the pin answer carries NO modes echo and NO
      // fresh notification. The only 'build' observation predates the pin
      // request, so a driver that checks observedMode alone would accept
      // the STALE value and prompt without proving THIS pin landed — the
      // fixed driver snapshots the update seq before sending the pin and
      // requires the naming to be newer.
      const driver = new AcpDriver(
        driverOptions(scratchDir, { FAKE_ACP_MODE: 'ok', FAKE_ACP_PRE_PIN_MODE_BUILD: '1' }, []),
      );
      const result = await driver.run(invocation({ prompt: 'stale-mode run' }));
      expect(result.stopReason).toBe('error');
      expect(result.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }); // never prompted — unmeasured
      const narration = await narrationOf(store, result.sessionId as string);
      const marker = narration.find((line) => line.includes('"handshake-failure"'));
      expect(marker !== undefined && marker.includes('mode pin was not confirmed')).toBe(true);
      expect(marker !== undefined && marker.includes('STALE')).toBe(true); // the evidence names the staleness
      const record = await store.load(result.sessionId as string);
      expect(record?.messages.some((m) => m.role === 'assistant')).toBe(false); // the prompt never fired
    });
  });

  test('a POST-PIN mode downgrade is narrated (cq: mode-downgrade) — evidence, never classified alone (round-3, the round-2 fix pinned)', async () => {
    await withScratch(async (scratchDir, store) => {
      // FAKE_ACP_MODE_DOWNGRADE: after the confirmed pin (materialization
      // already reported build) the harness reports yolo MID-TURN. The
      // settle-time marker must carry the evidence; the verdict stays what
      // the wire said (the never-asks tripwire remains the error path).
      const driver = new AcpDriver(
        driverOptions(scratchDir, { FAKE_ACP_MODE: 'ok', FAKE_ACP_MODE_DOWNGRADE: '1' }, []),
      );
      const result = await driver.run(invocation({ prompt: 'downgrade run' }));
      expect(result.stopReason).toBe('complete');
      const narration = await narrationOf(store, result.sessionId as string);
      const marker = narration.find((line) => line.includes('"mode-downgrade"'));
      expect(marker !== undefined && marker.includes("'yolo'")).toBe(true);
    });
  });

  test('an UNSHAPEABLE pin answer is the not-confirmed evidence — distinct from an absent modes echo (round-3, the round-2 fix pinned)', async () => {
    await withScratch(async (scratchDir, store) => {
      // FAKE_ACP_PIN_UNSHAPEABLE: the set_config_option answer carries
      // modes as a bare string — the safeParse fails, and the failure
      // evidence must say 'unshapeable pin response', not the ambiguous
      // 'no mode echo'.
      const driver = new AcpDriver(
        driverOptions(scratchDir, { FAKE_ACP_MODE: 'ok', FAKE_ACP_PIN_UNSHAPEABLE: '1' }, []),
      );
      const result = await driver.run(invocation({ prompt: 'unshapeable pin run' }));
      expect(result.stopReason).toBe('error');
      const narration = await narrationOf(store, result.sessionId as string);
      const marker = narration.find((line) => line.includes('"handshake-failure"'));
      expect(marker !== undefined && marker.includes('unshapeable pin response')).toBe(true);
      const record = await store.load(result.sessionId as string);
      expect(record?.messages.some((m) => m.role === 'assistant')).toBe(false); // the prompt never fired
    });
  });

  test('protocol-version mismatch: a different negotiated integer fails the run pre-prompt, naming BOTH numbers (§3)', async () => {
    await withScratch(async (scratchDir, store) => {
      const driver = new AcpDriver(
        driverOptions(scratchDir, { FAKE_ACP_MODE: 'ok', FAKE_ACP_PROTOCOL_VERSION: '2' }, []),
      );
      const result = await driver.run(invocation({ prompt: 'mismatch run' }));
      expect(result.stopReason).toBe('error'); // never prompted past a mismatch
      const narration = await narrationOf(store, result.sessionId as string);
      const marker = narration.find((line) => line.includes('"handshake-failure"'));
      expect(marker !== undefined && marker.includes('requested 1, agent answered 2')).toBe(true);
    });
  });
});
