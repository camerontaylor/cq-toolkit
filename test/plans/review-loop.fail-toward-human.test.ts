// Fail-toward-human paths (finding 6 + Codex P1): refusal before the fix
// stage, publish- and reply-stage push failures, budget exhaustion, and the
// thread with no REST root id.
import { describe, expect, test } from 'vitest';
import type { OpInvocation } from '../../src/driver/types.js';
import {
  completeWorker,
  defaultWorld,
  fixLine,
  isGhMutation,
  iso,
  NEW_SHA,
  restComment,
  ROOT_AGE,
  runLoop,
} from './review-loop.helpers.js';

describe('fail-toward-human paths (finding 6 + Codex P1)', () => {
  test('a truncated classification refuses before the fix stage — no report, needs-human with the causes, zero mutations', async () => {
    const world = defaultWorld();
    // An orphan REST chain root = reviewThreads lag → the fail-closed flag.
    world.pullsComments = [restComment(999, 'reviewer', 'orphan chain root', iso(ROOT_AGE), null)];
    const ghLog: string[][] = [];
    const invocations: OpInvocation[] = [];
    const { outcome } = await runLoop(world, { driverResults: [], invocations, ghLog });
    expect(outcome.status).toBe('needs-human');
    expect(outcome.reasons).toEqual(['reviewThreads.lag']);
    expect(outcome.fixReport).toBeUndefined();
    expect(outcome.plan.jobs).toEqual([]);
    expect(outcome.actionsPosted).toBe(0);
    expect(invocations).toHaveLength(0);
    expect(ghLog.some((args) => isGhMutation(args))).toBe(false);
  });

  test('a push failing at the stage-5 publish → needs-human with the push reason, nothing posts', async () => {
    const world = defaultWorld();
    world.pushFailAt = 1;
    const { outcome } = await runLoop(world, {
      driverResults: [completeWorker(fixLine(true, 's', [NEW_SHA]))],
    });
    expect(outcome.status).toBe('needs-human');
    expect(outcome.reasons.some((reason) => reason.startsWith('push failed (exit 1)'))).toBe(true);
    expect(outcome.reasons.some((reason) => reason.startsWith('dispatch push failed:'))).toBe(true);
    expect(outcome.actionsPosted).toBe(0);
    expect(outcome.reply?.pushed).toBe(false);
  });

  test('a push failing only at the reply stage → needs-human with the dispatch push reason, nothing posts', async () => {
    const world = defaultWorld();
    world.pushFailAt = 2; // the stage-5 publish lands; the reply-stage push fails
    const { outcome } = await runLoop(world, {
      driverResults: [completeWorker(fixLine(true, 's', [NEW_SHA]))],
    });
    expect(outcome.status).toBe('needs-human');
    expect(outcome.reasons.some((reason) => reason.startsWith('dispatch push failed:'))).toBe(true);
    expect(outcome.reasons.some((reason) => reason.startsWith('push failed (exit'))).toBe(false);
    expect(outcome.verify?.progress).toBe(true);
    expect(outcome.actionsPosted).toBe(0);
    expect(outcome.reply?.pushed).toBe(false);
    expect(outcome.reply?.posted).toEqual([]);
  });

  test('a budget-exhausted fix row feeds hasFailures and posts nothing for its thread', async () => {
    const { outcome } = await runLoop(defaultWorld(), {
      driverResults: [completeWorker(fixLine(true, 's', [NEW_SHA]), { stopReason: 'budget' })],
    });
    expect(outcome.status).toBe('needs-human');
    expect(
      outcome.reasons.some((reason) => reason.includes('fix job fix-1 ended budget-exhausted')),
    ).toBe(true);
    expect(outcome.reasons.some((reason) => reason.includes('budget cap hit'))).toBe(true);
    expect(outcome.actionsPosted).toBe(0);
    expect(outcome.reply).toBeUndefined();
  });

  test('a thread with no REST root id → recorded reason, no actions for it', async () => {
    const world = defaultWorld();
    world.threads = [
      // Deleted root: no databaseId, no anchor — but the thread classifies
      // actionable (null author is never the responder).
      {
        id: 'T-noanchor',
        isResolved: false,
        isOutdated: false,
        path: 'src/a.ts',
        line: null,
        comments: { nodes: [] },
      },
    ];
    const { outcome } = await runLoop(world, {
      driverResults: [completeWorker(fixLine(true, 'Did it.', [NEW_SHA]))],
    });
    expect(outcome.status).toBe('needs-human');
    expect(outcome.reasons.some((reason) => reason.includes('no root REST id'))).toBe(true);
    expect(outcome.actionsPosted).toBe(0);
    expect(outcome.reply).toBeUndefined();
  });
});
