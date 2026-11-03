// Resolve gating: the per-item commit gate (finding 2), spoof resistance
// (round-2 finding 2), the observability-only verify verdict (round-2
// finding 6), and the truncated-context cap (round-3 item 13).
import { describe, expect, test } from 'vitest';
import { MAX_ITEM_BODY_CHARS } from '../../src/ops/review/fixReviewItem.js';
import {
  actionableThread,
  BEFORE_SHA,
  completeWorker,
  defaultWorld,
  fixLine,
  NEW_SHA,
  runLoop,
  SHA,
} from './review-loop.helpers.js';

describe('per-item resolve gate (finding 2)', () => {
  test('a hallucinated sha → reply posts, resolve withheld with the unverified-commits reason', async () => {
    const world = defaultWorld();
    world.knownShas = [SHA]; // the claimed sha does not exist in the world
    const { outcome } = await runLoop(world, {
      driverResults: [completeWorker(fixLine(true, 'Claims the fix.', [NEW_SHA]))],
    });
    expect(outcome.status).toBe('needs-human');
    expect(outcome.reasons.some((reason) => reason.includes('unverified-commits'))).toBe(true);
    // Fail toward visible: the reply reports the claim; the thread stays open.
    expect(outcome.actionsPosted).toBe(1);
    expect(outcome.reply?.posted[0]?.kind).toBe('review_reply');
    expect(outcome.reply?.posted.some((record) => record.kind === 'resolve_thread')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Round-2 reviewer fixes — spoof-proof resolve gate + observability-only
// verify + doc truth
// ---------------------------------------------------------------------------

describe('resolve-gate spoofing (round-2 finding 2)', () => {
  test.each([
    ['the before-snapshot (base) sha', BEFORE_SHA],
    ['a fabricated unknown 40-hex sha', 'abcd'.repeat(10)],
  ])(
    '%s is rejected by the loop gate — reply posts, no resolve, unverified-commits reason',
    async (_name, sha) => {
      const { outcome } = await runLoop(defaultWorld(), {
        driverResults: [completeWorker(fixLine(true, 'Claims the fix.', [sha]))],
      });
      expect(outcome.status).toBe('needs-human');
      expect(outcome.reasons.some((reason) => reason.includes('unverified-commits'))).toBe(true);
      expect(outcome.actionsPosted).toBe(1);
      expect(outcome.reply?.posted[0]?.kind).toBe('review_reply');
      expect(outcome.reply?.posted.some((record) => record.kind === 'resolve_thread')).toBe(false);
    },
  );

  test('the literal HEAD never survives the op parse — the fix row fails instead', async () => {
    // Defense in depth: the 40-hex contract rejects 'HEAD' at the op, so
    // the loop sees a FAILED row (never a gate-eligible claim).
    const { outcome } = await runLoop(defaultWorld(), {
      driverResults: [completeWorker(fixLine(true, 'Claims the fix.', ['HEAD']))],
    });
    expect(outcome.status).toBe('needs-human');
    expect(outcome.reasons.some((reason) => reason.includes('fix job fix-1 ended failed'))).toBe(
      true,
    );
    expect(outcome.reasons.some((reason) => reason.includes('unverified-commits'))).toBe(false);
    expect(outcome.actionsPosted).toBe(0);
  });

  test('a real new commit is accepted — the resolve posts', async () => {
    const { outcome } = await runLoop(defaultWorld(), {
      driverResults: [completeWorker(fixLine(true, 'Fixed.', [NEW_SHA]))],
    });
    expect(outcome.status).toBe('ok');
    expect(outcome.reply?.posted.some((record) => record.kind === 'resolve_thread')).toBe(true);
  });
});

describe('VerifyOutcome is observability only (round-2 finding 6)', () => {
  test('a lagging origin after-snapshot does not block a locally-verified fix', async () => {
    const world = defaultWorld();
    world.laggingOrigin = true; // the REST read keeps serving the OLD head
    const { outcome } = await runLoop(world, {
      driverResults: [completeWorker(fixLine(true, 'Fixed.', [NEW_SHA]))],
    });
    // The PR-wide verdict still computes (and reads NO PROGRESS against the
    // lagging read), but it never feeds hasFailures: the per-item commit
    // verification is the only resolve gate, and the commit IS real.
    expect(outcome.status).toBe('ok');
    expect(outcome.reasons).toEqual([]);
    expect(outcome.verify?.summary).toBe('NO PROGRESS');
    expect(outcome.actionsPosted).toBe(2);
    expect(outcome.reply?.posted.map((record) => record.kind)).toEqual([
      'review_reply',
      'resolve_thread',
    ]);
  });
});

describe('truncated-context resolve gate (round-3 item 13)', () => {
  test('a context-truncated worker → reply posts, resolve withheld, needs-human', async () => {
    const world = defaultWorld();
    const threadNode = actionableThread('T1', 'src/a.ts', 3, 101) as {
      comments: { nodes: Array<{ body: string }> };
    };
    // The ROOT COMMENT's body is what the fetch maps to item.body — an
    // oversized one trips the op's context cap (round-3 item 13).
    const root = threadNode.comments.nodes[0];
    if (root === undefined) {
      throw new Error('fixture: root comment missing');
    }
    root.body = 'x'.repeat(MAX_ITEM_BODY_CHARS + 1);
    world.threads = [threadNode];
    const { outcome } = await runLoop(world, {
      driverResults: [completeWorker(fixLine(true, 'Fixed what I saw.', [NEW_SHA]))],
    });
    expect(outcome.status).toBe('needs-human');
    expect(outcome.reasons.some((reason) => reason.includes('truncated-context'))).toBe(true);
    expect(outcome.actionsPosted).toBe(1);
    expect(outcome.reply?.posted[0]?.kind).toBe('review_reply');
    expect(outcome.reply?.posted.some((record) => record.kind === 'resolve_thread')).toBe(false);
  });
});
