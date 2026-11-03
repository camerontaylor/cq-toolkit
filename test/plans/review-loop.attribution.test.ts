// Attribution and escalation: per-item commit attribution (round-3 item 3),
// blocked-classification escalation (item 10), and attribution under
// promptOverride (slice 9 item 1).
import { describe, expect, test } from 'vitest';
import type { OpInvocation } from '../../src/driver/types.js';
import {
  actionableThread,
  BEEF_SHA,
  completeWorker,
  defaultWorld,
  fixLine,
  isGhMutation,
  NEW_SHA,
  runLoop,
  SHA,
} from './review-loop.helpers.js';

describe('per-item commit attribution (round-3 item 3)', () => {
  test('a commit naming only item A resolves A; item B gets the attribution reason', async () => {
    const world = defaultWorld();
    world.threads = [
      actionableThread('T1', 'src/a.ts', 3, 101),
      actionableThread('T2', 'src/b.ts', 8, 102),
    ];
    world.knownShas = [SHA, NEW_SHA, BEEF_SHA];
    // BOTH commits exist, but only T1's is named.
    world.commitMessages = {
      [NEW_SHA]: 'Fix review item T1 in src/a.ts',
      [BEEF_SHA]: 'Fix review item T1 in src/b.ts too',
    };
    const { outcome } = await runLoop(world, {
      driverResults: [
        completeWorker(fixLine(true, 'Fixed.', [NEW_SHA])),
        completeWorker(fixLine(true, 'Fixed.', [BEEF_SHA])),
      ],
    });
    expect(outcome.status).toBe('needs-human');
    expect(
      outcome.reasons.some(
        (reason) => reason.includes('T2') && reason.includes('unverified-commits'),
      ),
    ).toBe(true);
    expect(outcome.actionsPosted).toBe(3); // reply+resolve for T1, bare reply for T2
    expect(outcome.reply?.posted.some((record) => record.kind === 'resolve_thread')).toBe(true);
  });

  test('a commit naming item B resolves B', async () => {
    const world = defaultWorld();
    world.threads = [
      actionableThread('T1', 'src/a.ts', 3, 101),
      actionableThread('T2', 'src/b.ts', 8, 102),
    ];
    world.knownShas = [SHA, NEW_SHA, BEEF_SHA];
    world.commitMessages = {
      [NEW_SHA]: 'Fix review item T1 in src/a.ts',
      [BEEF_SHA]: 'Fix review item T2 in src/b.ts',
    };
    const { outcome } = await runLoop(world, {
      driverResults: [
        completeWorker(fixLine(true, 'Fixed A.', [NEW_SHA])),
        completeWorker(fixLine(true, 'Fixed B.', [BEEF_SHA])),
      ],
    });
    expect(outcome.status).toBe('ok');
    expect(outcome.actionsPosted).toBe(4);
  });
});

describe('blocked classification escalation (round-3 item 10)', () => {
  const outdatedThread = (): Record<string, unknown> => ({
    ...(actionableThread('T-b', 'src/c.ts', 1, 103) as Record<string, unknown>),
    isOutdated: true,
  });

  test('blocked-only → needs-human with the reason, zero mutations, driver uncalled', async () => {
    const world = defaultWorld();
    world.threads = [outdatedThread()];
    const ghLog: string[][] = [];
    const invocations: OpInvocation[] = [];
    const { outcome } = await runLoop(world, { driverResults: [], invocations, ghLog });
    expect(outcome.status).toBe('needs-human');
    expect(outcome.reasons).toEqual(['blocked: T-b requires human decision']);
    expect(outcome.fixReport?.counts.done).toBe(0);
    expect(invocations).toHaveLength(0);
    expect(ghLog.some((args) => isGhMutation(args))).toBe(false);
  });

  test('blocked + actionable → the actionable item fixes, outcome stays needs-human', async () => {
    const world = defaultWorld();
    world.threads = [outdatedThread(), actionableThread('T1', 'src/a.ts', 3, 101)];
    const { outcome } = await runLoop(world, {
      driverResults: [completeWorker(fixLine(true, 'Fixed.', [NEW_SHA]))],
    });
    expect(outcome.status).toBe('needs-human');
    expect(outcome.reasons).toEqual(['blocked: T-b requires human decision']);
    expect(outcome.actionsPosted).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Slice 9 — attribution under override, observed worktree movement,
// round-versioned dispatch keys, already-answered skip
// ---------------------------------------------------------------------------

describe('attribution under promptOverride (slice 9 item 1)', () => {
  test('an override-run worker whose commit names the item resolves normally', async () => {
    const world = defaultWorld();
    const { outcome } = await runLoop(world, {
      driverResults: [completeWorker(fixLine(true, 'Fixed.', [NEW_SHA]))],
      promptOverride: 'OVERRIDE PROMPT',
    });
    expect(outcome.status).toBe('ok');
    expect(outcome.actionsPosted).toBe(2);
    expect(outcome.reply?.posted.some((record) => record.kind === 'resolve_thread')).toBe(true);
  });
});
