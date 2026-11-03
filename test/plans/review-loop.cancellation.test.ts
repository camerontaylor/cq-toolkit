// Parent cancellation during publication and replies, and the pre-dispatch
// expected-head gate.
import { describe, expect, test } from 'vitest';
import type { OpInvocation } from '../../src/driver/types.js';
import {
  actionableThread,
  completeWorker,
  defaultWorld,
  fixLine,
  isGhMutation,
  NEW_SHA,
  runLoop,
} from './review-loop.helpers.js';

describe('parent cancellation during publication and replies', () => {
  test.each(['initial-push', 'reply'] as const)(
    'held %s cannot dispatch remaining forge mutations',
    async (heldAt) => {
      const world = defaultWorld();
      world.threads.push(actionableThread('T3', 'src/b.ts', 1, 103));
      const parent = new AbortController();
      let release!: () => void, entered!: () => void;
      const held = new Promise<void>((r) => {
        entered = r;
      });
      const gate = new Promise<void>((r) => {
        release = r;
      });
      let heldOnce = false;
      const ghLog: string[][] = [];
      const pending = runLoop(world, {
        signal: parent.signal,
        ghLog,
        driverResults: [
          completeWorker(fixLine(true, 'fixed held cancellation', [NEW_SHA])),
          completeWorker(fixLine(true, 'fixed held cancellation', [NEW_SHA])),
        ],
        gitHook: async (args, run) => {
          const result = await run(args);
          if (heldAt === 'initial-push' && args[2] === 'push' && !heldOnce) {
            heldOnce = true;
            entered();
            await gate;
          }
          return result;
        },
        ghHook: async (args, run) => {
          const result = await run(args);
          if (heldAt === 'reply' && isGhMutation(args) && !heldOnce) {
            heldOnce = true;
            entered();
            await gate;
          }
          return result;
        },
      });
      await held;
      parent.abort();
      const landed = ghLog.filter(isGhMutation).length;
      release();
      const { outcome } = await pending;
      expect(outcome.status).toBe('needs-human');
      expect(outcome.reasons.join(' ')).toContain('parent cancelled');
      expect(ghLog.filter(isGhMutation)).toHaveLength(landed);
      expect(landed).toBe(heldAt === 'reply' ? 1 : 0);
      expect(outcome.reply?.posted.filter((row) => row.kind === 'review_reply').length ?? 0).toBe(
        landed,
      );
      expect(outcome.reply?.posted.some((row) => row.kind === 'resolve_thread') ?? false).toBe(
        false,
      );
    },
  );
});

test('an expected-head mismatch refuses before forge reads, actions or worker dispatch', async () => {
  const world = defaultWorld();
  const invocations: OpInvocation[] = [];
  const result = await runLoop(world, { expectedHead: 'f'.repeat(40), invocations });
  expect(result.outcome.status).toBe('needs-human');
  expect(result.outcome.reasons).toContain('PR head changed before dispatch');
  expect(result.ghLog).toEqual([]);
  expect(invocations).toEqual([]);
});
