// The independent reviewers' exact probes (PR #343 at c95807ca and
// c05577e2), folded in from their probe file; the free-text probes send the
// legacy shape, exactly as the reviewers did, and the leave-unchanged one
// sends v2.
import { describe, expect, test } from 'vitest';
import type { OpInvocation } from '../../src/driver/types.js';
import {
  completeWorker,
  defaultWorld,
  fixLine,
  flagValue,
  iso,
  legacyFixLine,
  REPLY_AGE,
  restComment,
  ROOT_AGE,
  runLoop,
} from './review-loop.helpers.js';

// The independent reviewers' exact probes (PR #343 at c95807ca and c05577e2),
// folded in from their probe file. The free-text probes send the legacy
// shape, exactly as the reviewers did; the leave-unchanged one sends v2.
describe('independent PR343 exact-head regressions', () => {
  test.each([
    'Investigating why the test fails.',
    'I am investigating why no changes are applied.',
  ])('progress-only output %j must post nothing and stay retriable', async (summary) => {
    const world = { ...defaultWorld(), worktreeFollowsOrigin: true };
    const root = restComment(101, 'reviewer', 'Fix src/a.ts at 3.', iso(ROOT_AGE), null);
    world.pullsComments = [root];
    const ghLog: string[][] = [];
    const run1 = await runLoop(world, {
      driverResults: [completeWorker(legacyFixLine(false, summary, []))],
      ghLog,
      responderLogin: 'cq-automation[bot]',
    });
    const body = ghLog
      .filter((args) => args.includes('-X'))
      .map((args) => flagValue(args, 'body'))[0];
    // Observe the suppression consequence without relying on a dispatch log.
    if (body !== undefined) {
      const rerun = { ...defaultWorld(), worktreeFollowsOrigin: true };
      rerun.pullsComments = [
        root,
        restComment(9001, 'cq-automation[bot]', body, iso(REPLY_AGE), 101),
      ];
      const invocations: OpInvocation[] = [];
      const run2 = await runLoop(rerun, {
        driverResults: [],
        invocations,
        responderLogin: 'cq-automation[bot]',
      });
      expect(run2.outcome.status).toBe('ok');
      expect(invocations).toHaveLength(0);
      expect(run2.outcome.skipped).toContainEqual({ id: 'T1', reason: 'loop-replied-this-head' });
    }
    expect(run1.outcome.actionsPosted).toBe(0);
    expect(run1.outcome.status).toBe('needs-human');
  });
});

describe('independent PR343 c05577 outcome regressions', () => {
  test.each([
    'The investigation of `src/a.ts` is still in progress.',
    'Checking whether `src/a.ts` shows the reported issue.',
    'The next step is to inspect `src/a.ts` before making any changes.',
    'No changes are needed in the guard at `src/a.ts:3`.',
  ])('a non-answer %j must not post or settle', async (summary) => {
    const world = { ...defaultWorld(), worktreeFollowsOrigin: true };
    const root = restComment(101, 'reviewer', 'Fix src/a.ts at 3.', iso(ROOT_AGE), null);
    world.pullsComments = [root];
    const ghLog: string[][] = [];
    const run1 = await runLoop(world, {
      driverResults: [completeWorker(legacyFixLine(false, summary, []))],
      ghLog,
      responderLogin: 'cq-automation[bot]',
    });
    const body = ghLog
      .filter((args) => args.includes('-X'))
      .map((args) => flagValue(args, 'body'))[0];
    if (body !== undefined) {
      expect(body).toContain(summary);
      const rerun = { ...defaultWorld(), worktreeFollowsOrigin: true };
      rerun.pullsComments = [
        root,
        restComment(9001, 'cq-automation[bot]', body, iso(REPLY_AGE), 101),
      ];
      const invocations: OpInvocation[] = [];
      const run2 = await runLoop(rerun, {
        driverResults: [],
        invocations,
        responderLogin: 'cq-automation[bot]',
      });
      expect(run2.outcome.status).toBe('ok');
      expect(invocations).toHaveLength(0);
      expect(run2.outcome.skipped).toContainEqual({ id: 'T1', reason: 'loop-replied-this-head' });
    }
    expect(run1.outcome.actionsPosted).toBe(0);
    expect(run1.outcome.status).toBe('needs-human');
  });

  test('a completed no-change disposition using leave unchanged should post', async () => {
    const summary =
      'I am leaving `src/a.ts:3` unchanged because its guard already rejects empty input.';
    const world = { ...defaultWorld(), worktreeFollowsOrigin: true };
    // v2 contract: the disposition and its evidence, not the wording, make it an outcome.
    const { outcome } = await runLoop(world, {
      driverResults: [completeWorker(fixLine(false, summary, [], [{ path: 'src/a.ts', line: 3 }]))],
      responderLogin: 'cq-automation[bot]',
    });
    expect(outcome.actionsPosted).toBe(1);
    expect(outcome.status).toBe('ok');
  });
});
