import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { AcpDriver } from '../../src/driver/acp/index.js';
import { SESSIONS_DIR } from '../../src/driver/conformance.js';
import type { SpawnCall } from './acp.helpers.js';
import {
  acpSidecarPath,
  driverOptions,
  invocation,
  withScratch,
  narrationOf,
} from './acp.helpers.js';

describe('acp driver specifics (fake ACP server)', () => {
  test('resume sidecar: the ACP session id persists to the workspace; session/load continues the SAME vendor session', async () => {
    await withScratch(async (scratchDir, store) => {
      const calls1: SpawnCall[] = [];
      const first = new AcpDriver(driverOptions(scratchDir, { FAKE_ACP_MODE: 'ok' }, calls1));
      const run1 = await first.run(invocation({ prompt: 'resume run one' }));
      const acpId = (
        await readFile(
          acpSidecarPath(join(scratchDir, SESSIONS_DIR), run1.sessionId as string),
          'utf8',
        )
      ).trim();
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
      expect(
        (
          await readFile(
            acpSidecarPath(join(scratchDir, SESSIONS_DIR), run1.sessionId as string),
            'utf8',
          )
        ).trim(),
      ).toBe(acpId);
    });
    // Real initialize → session/new → session/load and sidecar filesystem
    // contract; keep enough budget for the child process and two runs.
  }, 15_000);

  test('resume gate rung 2: unstable_resumeSession when only sessionCapabilities.resume is advertised — the recorded handle resumes (strategy §6)', async () => {
    await withScratch(async (scratchDir, store) => {
      const calls1: SpawnCall[] = [];
      const first = new AcpDriver(driverOptions(scratchDir, { FAKE_ACP_MODE: 'ok' }, calls1));
      const run1 = await first.run(invocation({ prompt: 'rung2 run one' }));
      const acpId = (
        await readFile(
          acpSidecarPath(join(scratchDir, SESSIONS_DIR), run1.sessionId as string),
          'utf8',
        )
      ).trim();

      const calls2: SpawnCall[] = [];
      // loadSession NOT advertised + sessionCapabilities.resume advertised:
      // the §6 middle rung — the driver must send unstable_resumeSession
      // (method + the recorded session id in params) instead of falling
      // straight to the honest partial.
      const second = new AcpDriver(
        driverOptions(
          scratchDir,
          { FAKE_ACP_MODE: 'resume-echo', FAKE_ACP_NO_LOADSESSION: '1', FAKE_ACP_RESUME: '1' },
          calls2,
        ),
      );
      if (run1.sessionId === undefined) throw new Error('first run must create a session');
      const run2 = await second.run(
        invocation({ prompt: 'rung2 run two', sessionRef: run1.sessionId }),
      );
      expect(run2.stopReason).toBe('complete');
      const record = await store.load(run2.sessionId as string);
      // The resume REQUEST carried the recorded session id: the fixture
      // adopted it and the echo proves protocol-side continuity (the
      // partial rung would have session/new'd a FRESH id and echoed THAT).
      expect(
        record?.messages.some(
          (m) => m.role === 'assistant' && m.content.includes(`resumed from acp session ${acpId}`),
        ),
      ).toBe(true);
      // NOT the honest-partial rung: no partial narration.
      const narration = await narrationOf(store, run2.sessionId as string);
      expect(narration.some((line) => line.includes('"resume-partial"'))).toBe(false);
    });
  });

  test('resume gate rung 3: neither capability advertised — the honest-partial narration names BOTH (the sidecar was recorded but is unusable)', async () => {
    await withScratch(async (scratchDir, store) => {
      const calls1: SpawnCall[] = [];
      const first = new AcpDriver(driverOptions(scratchDir, { FAKE_ACP_MODE: 'ok' }, calls1));
      const run1 = await first.run(invocation({ prompt: 'rung3 run one' }));
      const acpId = (
        await readFile(
          acpSidecarPath(join(scratchDir, SESSIONS_DIR), run1.sessionId as string),
          'utf8',
        )
      ).trim();
      expect(acpId).toMatch(/^fake-acp-/); // the sidecar was WRITTEN — rung 3 gates only its USE

      const calls2: SpawnCall[] = [];
      const second = new AcpDriver(
        driverOptions(
          scratchDir,
          { FAKE_ACP_MODE: 'resume-echo', FAKE_ACP_NO_LOADSESSION: '1' },
          calls2,
        ),
      );
      if (run1.sessionId === undefined) throw new Error('first run must create a session');
      const run2 = await second.run(
        invocation({ prompt: 'rung3 run two', sessionRef: run1.sessionId }),
      );
      expect(run2.stopReason).toBe('complete'); // honest partial, never a failure
      const record = await store.load(run2.sessionId as string);
      // The echo carries a FRESH session id (session/new), never the
      // recorded handle — workspace-only continuation.
      expect(
        record?.messages.some(
          (m) => m.role === 'assistant' && m.content.includes(`resumed from acp session ${acpId}`),
        ),
      ).toBe(false);
      expect(
        record?.messages.some(
          (m) => m.role === 'assistant' && m.content.includes('resumed from acp session'),
        ),
      ).toBe(true);
      const narration = await narrationOf(store, run2.sessionId as string);
      const partial = narration.find((line) => line.includes('"resume-partial"'));
      expect(partial !== undefined && partial.includes(acpId)).toBe(true);
      expect(
        partial !== undefined &&
          partial.includes('NEITHER loadSession NOR sessionCapabilities.resume'),
      ).toBe(true);
    });
  });

  test('session/load REPLAY: replayed prior-turn frames are suppressed — honest verdict, clean transcript, the count is the evidence', async () => {
    await withScratch(async (scratchDir, store) => {
      const calls1: SpawnCall[] = [];
      const first = new AcpDriver(driverOptions(scratchDir, { FAKE_ACP_MODE: 'ok' }, calls1));
      const run1 = await first.run(invocation({ prompt: 'replay run one' }));

      const calls2: SpawnCall[] = [];
      // The resumed run points the fixture at a REPLAYING session/load:
      // three prior-turn session/update frames (a text chunk, a
      // permission-less tool_call, a FAILED tool_call_update) arrive
      // BEFORE the load response — the reference-recorded replay shape
      // (strategy §6). A driver that folds them false-fires the
      // never-asks tripwire (verdict 'error' on an honest run), leaks the
      // prior-turn text into this run's transcript, and synthesizes a
      // phantom denial.
      const second = new AcpDriver(
        driverOptions(scratchDir, { FAKE_ACP_MODE: 'resume-echo', FAKE_ACP_REPLAY: '1' }, calls2),
      );
      if (run1.sessionId === undefined) throw new Error('first run must create a session');
      const run2 = await second.run(
        invocation({ prompt: 'replay run two', sessionRef: run1.sessionId }),
      );
      expect(run2.stopReason).toBe('complete'); // NOT the never-asks false 'error'
      expect(run2.denials).toEqual([]); // the replayed failed status synthesized no phantom denial
      const record = await store.load(run2.sessionId as string);
      // The replayed prior-turn text never joined THIS run's transcript —
      // the persisted assistant turn is this run's resume echo only.
      expect(
        record?.messages.some((m) => m.role === 'assistant' && m.content.includes('REPLAYED')),
      ).toBe(false);
      expect(
        record?.messages.some(
          (m) => m.role === 'assistant' && m.content.includes('resumed from acp session'),
        ),
      ).toBe(true);
      // The discard sink narrates the COUNT (honest evidence, never the
      // content): all three replayed frames were counted and discarded.
      const narration = await narrationOf(store, run2.sessionId as string);
      const marker = narration.find((line) => line.includes('"replayed-frames-discarded"'));
      expect(marker !== undefined && marker.includes('"count":3')).toBe(true);
      expect(narration.some((line) => line.includes('"never-asks"'))).toBe(false);
    });
  });

  test('the replay window is LINE-gated: a post-load update sharing the load response flush FOLDS; the pre-response bait is still discarded', async () => {
    await withScratch(async (scratchDir, store) => {
      const calls1: SpawnCall[] = [];
      const first = new AcpDriver(driverOptions(scratchDir, { FAKE_ACP_MODE: 'ok' }, calls1));
      const run1 = await first.run(invocation({ prompt: 'tail run one' }));

      const calls2: SpawnCall[] = [];
      // The resumed run's session/load emits the bait replay history, then
      // the RESPONSE LINE and a post-load agent_message_chunk in ONE stdout
      // flush. The tail post-dates the load settle: a driver that clears
      // the replay flag only at the load await's continuation processes the
      // WHOLE flush first and drops it (the round-2 chunk-boundary bug);
      // the wire-line gate folds it.
      const second = new AcpDriver(
        driverOptions(
          scratchDir,
          { FAKE_ACP_MODE: 'resume-echo', FAKE_ACP_REPLAY_WITH_TAIL: '1' },
          calls2,
        ),
      );
      if (run1.sessionId === undefined) throw new Error('first run must create a session');
      const run2 = await second.run(
        invocation({ prompt: 'tail run two', sessionRef: run1.sessionId }),
      );
      expect(run2.stopReason).toBe('complete'); // the bait never false-fired the tripwire
      expect(run2.denials).toEqual([]); // the replayed failed status synthesized no phantom denial
      const record = await store.load(run2.sessionId as string);
      // THE REGRESSION: the same-flush POST-load tail chunk FOLDED into
      // this run's transcript — and the resume echo folded after it.
      expect(
        record?.messages.some(
          (m) => m.role === 'assistant' && m.content.includes('POST-LOAD tail chunk'),
        ),
      ).toBe(true);
      expect(
        record?.messages.some(
          (m) => m.role === 'assistant' && m.content.includes('resumed from acp session'),
        ),
      ).toBe(true);
      // The PRE-response bait frames are still suppressed: no replayed
      // text, exactly the three-frame discard count, no never-asks.
      expect(
        record?.messages.some((m) => m.role === 'assistant' && m.content.includes('REPLAYED')),
      ).toBe(false);
      const narration = await narrationOf(store, run2.sessionId as string);
      const marker = narration.find((line) => line.includes('"replayed-frames-discarded"'));
      expect(marker !== undefined && marker.includes('"count":3')).toBe(true);
      expect(narration.some((line) => line.includes('"never-asks"'))).toBe(false);
    });
  });

  test('JSON-RPC string request ids: the permission answer echoes the id VERBATIM (no coercion into an uncorrelatable null)', async () => {
    await withScratch(async (scratchDir, store) => {
      // A string session/request_permission id is legal JSON-RPC (the
      // reference vendor sends numbers). A driver that Number()-coerces
      // answers 'id':null — the vendor's ask never resolves and the turn
      // hangs; on a regression THIS test fails by timeout.
      const driver = new AcpDriver(
        driverOptions(
          scratchDir,
          {
            FAKE_ACP_MODE: 'tool-then-reply',
            FAKE_ACP_TOOL: 'read',
            FAKE_ACP_INPUT: JSON.stringify({ path: 'note.txt' }),
            FAKE_ACP_STRING_REQUEST_IDS: '1',
          },
          [],
        ),
      );
      const result = await driver.run(invocation({ prompt: 'string-id run' }));
      expect(result.stopReason).toBe('complete');
      const record = await store.load(result.sessionId as string);
      // The answer CORRELATED: the fixture honored it and echoed the
      // selected optionId — proof the round-trip completed.
      expect(
        record?.messages.some(
          (m) => m.role === 'assistant' && m.content.includes('[permission:allow_once]'),
        ),
      ).toBe(true);
    });
  });
});
