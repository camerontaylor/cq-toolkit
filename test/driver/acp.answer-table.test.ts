import { describe, expect, test } from 'vitest';
import { AcpDriver } from '../../src/driver/acp/index.js';
import type { SpawnCall } from './acp.helpers.js';
import { driverOptions, invocation, withScratch, narrationOf } from './acp.helpers.js';

describe('acp driver specifics (fake ACP server)', () => {
  test('answer table: allow selects allow_once (the vendor-string optionId echoed)', async () => {
    await withScratch(async (scratchDir, store) => {
      const calls: SpawnCall[] = [];
      const driver = new AcpDriver(
        driverOptions(
          scratchDir,
          {
            FAKE_ACP_MODE: 'tool-then-reply',
            FAKE_ACP_TOOL: 'read',
            FAKE_ACP_INPUT: JSON.stringify({ path: 'note.txt' }),
          },
          calls,
        ),
      );
      const result = await driver.run(invocation({ prompt: 'allow run' }));
      expect(result.stopReason).toBe('complete');
      // The fixture echoes the ANSWERED optionId: the default options offer
      // allow_once first, and the driver's ALLOW side of the answer table
      // selects exactly that vendor string.
      const record = await store.load(result.sessionId as string);
      expect(
        record?.messages.some(
          (m) => m.role === 'assistant' && m.content.includes('[permission:allow_once]'),
        ),
      ).toBe(true);
      // The gate fired (a permission round-trip happened) and the read
      // executed: a real role 'tool' message for the executed read.
      expect(record?.messages.some((m) => m.role === 'tool' && m.toolName === 'read')).toBe(true);
    });
  });

  test('answer table: the allow_always fallback when ONLY allow_always is offered', async () => {
    await withScratch(async (scratchDir, store) => {
      const driver = new AcpDriver(
        driverOptions(
          scratchDir,
          {
            FAKE_ACP_MODE: 'tool-then-reply',
            FAKE_ACP_TOOL: 'read',
            FAKE_ACP_INPUT: JSON.stringify({ path: 'note.txt' }),
            // Only the always-allow option exists — the ALLOW side must fall through to it.
            FAKE_ACP_OPTIONS: JSON.stringify([{ optionId: 'a_always', kind: 'allow_always' }]),
          },
          [],
        ),
      );
      const result = await driver.run(invocation({ prompt: 'allow-always run' }));
      expect(result.stopReason).toBe('complete');
      const record = await store.load(result.sessionId as string);
      expect(
        record?.messages.some(
          (m) => m.role === 'assistant' && m.content.includes('[permission:a_always]'),
        ),
      ).toBe(true);
    });
  });

  test('answer table: reject selects reject_once — the denial is synthesized AT the answer', async () => {
    await withScratch(async (scratchDir, store) => {
      const driver = new AcpDriver(
        driverOptions(
          scratchDir,
          {
            FAKE_ACP_MODE: 'tool-then-reply',
            FAKE_ACP_TOOL: 'edit',
            FAKE_ACP_INPUT: JSON.stringify({ path: 'x.txt', oldText: 'a', newText: 'b' }),
          },
          [],
        ),
      );
      // Allowlist that does NOT contain 'edit': the DENY side selects the
      // reject_once option — which on the reference vendor's option table
      // carries the VENDOR STRING 'deny' (probe verbatim).
      const result = await driver.run(
        invocation({ prompt: 'reject run', toolPolicy: { allow: ['read'], mode: 'allowlist' } }),
      );
      expect(result.stopReason).toBe('complete'); // the turn settles end_turn after a deny (probed)
      // `kind` is absent in this probe: the governed identity is the
      // unknown; neither the call ID nor the vendor title authorizes it.
      expect(result.denials).toHaveLength(1);
      expect(result.denials[0]?.tool).toBe('unknown');
      expect(result.denials[0]?.reason).toBe(
        'tool policy: missing ACP tool kind; cannot enforce allowlist',
      );
      const record = await store.load(result.sessionId as string);
      expect(
        record?.messages.some(
          (m) => m.role === 'assistant' && m.content.includes('[permission:deny]'),
        ),
      ).toBe(true);
      // The denied tool never executed: no role 'tool' message for it.
      expect(record?.messages.some((m) => m.role === 'tool' && m.toolName === 'edit')).toBe(false);
    });
  });

  test('answer table: a deny with NO reject option fails the run, naming the offered options', async () => {
    await withScratch(async (scratchDir, store) => {
      const driver = new AcpDriver(
        driverOptions(
          scratchDir,
          {
            FAKE_ACP_MODE: 'tool-then-reply',
            FAKE_ACP_TOOL: 'edit',
            // An allow-only option set: the deny side has NO answer (strategy §2.1 — fail the run).
            FAKE_ACP_OPTIONS: JSON.stringify([{ optionId: 'only_allow', kind: 'allow_once' }]),
          },
          [],
        ),
      );
      const result = await driver.run(
        invocation({
          prompt: 'deny-deadlock run',
          toolPolicy: { allow: ['read'], mode: 'allowlist' },
        }),
      );
      expect(result.stopReason).toBe('error'); // never answered 'cancelled'; never hung
      const narration = await narrationOf(store, result.sessionId as string);
      const failed = narration.find((line) => line.includes('"permission-answer-failed"'));
      expect(failed !== undefined && failed.includes('"only_allow"')).toBe(true);
      expect(failed !== undefined && failed.includes('"allow_once"')).toBe(true);
    });
  });

  test('answer table: an ALLOW decision with no allow option fails the run, narrating the ALLOW side — not the deny wording', async () => {
    await withScratch(async (scratchDir, store) => {
      const driver = new AcpDriver(
        driverOptions(
          scratchDir,
          {
            FAKE_ACP_MODE: 'tool-then-reply',
            FAKE_ACP_TOOL: 'read',
            // A reject-only option set: the ALLOW side has NO answer —
            // the mirror image of the deny-side deadlock (round-2 review:
            // both sides fail the run loudly, each narrated as its OWN
            // side, never mislabeled).
            FAKE_ACP_OPTIONS: JSON.stringify([{ optionId: 'only_reject', kind: 'reject_once' }]),
          },
          [],
        ),
      );
      // Unrestricted policy → the decision is ALLOW → no allow option
      // exists → the run fails.
      const result = await driver.run(invocation({ prompt: 'allow-deadlock run' }));
      expect(result.stopReason).toBe('error'); // never answered 'cancelled'; never hung
      const narration = await narrationOf(store, result.sessionId as string);
      const failed = narration.find((line) => line.includes('"permission-answer-failed"'));
      expect(failed !== undefined && failed.includes('"side":"allow"')).toBe(true);
      expect(
        failed !== undefined && failed.includes('no allow option offered on the allow side'),
      ).toBe(true);
      expect(failed !== undefined && failed.includes('no reject option offered')).toBe(false);
    });
  });

  test('answer table: the SELECTION failure pins the verdict error even when the tolerant vendor settles end_turn anyway', async () => {
    await withScratch(async (scratchDir, store) => {
      // The tolerant-vendor persona (FAKE_ACP_IGNORE_CANCEL: the cancel
      // notification is swallowed, the termination SIGNAL is ignored, an
      // unanswered ask TIMES OUT into an end_turn settle) + the allow-side
      // deadlock: the driver cannot answer the ask and terminates the
      // child — the vendor ignores the termination, times out its
      // unanswered ask, and settles end_turn with real usage anyway. A
      // driver that trusts the wire outcome reads that shape as
      // 'complete'; the failed ENFORCEMENT pins 'error' (the
      // answerWriteFailed mirror, round-3) while the measurement still
      // folds — it really happened.
      const driver = new AcpDriver({
        ...driverOptions(
          scratchDir,
          {
            FAKE_ACP_MODE: 'tool-then-reply',
            FAKE_ACP_TOOL: 'read',
            FAKE_ACP_OPTIONS: JSON.stringify([{ optionId: 'only_reject', kind: 'reject_once' }]),
            FAKE_ACP_IGNORE_CANCEL: '1',
          },
          [],
        ),
        // The SIGTERM grace gives the fixture's 250 ms settle timer a wide
        // margin over the failed-selection ladder's SIGKILL escalation
        // (review-debt #48): the timer starts when the ASK goes out,
        // BEFORE the driver handles the failed selection — at the old
        // 500 ms the settle-to-SIGKILL margin was ~250 ms of real time, a
        // race a loaded runner could lose (fixture killed before its
        // end_turn folded).
        termGraceMs: 2000,
        killGraceMs: 500,
      });
      const result = await driver.run(
        invocation({ prompt: 'tolerant-vendor selection-failure run' }),
      );
      expect(result.stopReason).toBe('error'); // pinned — never 'complete', however green the wire looks
      expect(result.usage).toEqual({ input: 10, output: 5, cacheRead: 2, cacheWrite: 3 }); // the end_turn measurement folds
      // Seam v3: the wire carried numeric usage, so the verdict declares measured.
      expect(result.usageProvenance).toBe('measured');
      const narration = await narrationOf(store, result.sessionId as string);
      const failed = narration.find((line) => line.includes('"permission-answer-failed"'));
      expect(failed !== undefined && failed.includes('"side":"allow"')).toBe(true);
    });
  }, 20_000);
});
