// Split provenance: test/ops/review/replyAndResolve.test.ts was split into
// subject files; this file carries clause (a), push-before-post ordering.
import { describe, expect, test } from 'vitest';
import { replyAndResolve } from '../../../src/ops/review/replyAndResolve.js';
import type { GhFn } from '../../../src/adapters/forge-github/gh.js';
import {
  baseOpts,
  memLog,
  mkIssue,
  mkReply,
  mkResolve,
  pushRun,
  recordingGh,
  type GhCall,
} from './replyAndResolve.helpers.js';

// ---------------------------------------------------------------------------
// a. PUSH-BEFORE-POST ORDERING (no rollback)
// ---------------------------------------------------------------------------

describe('push-before-post', () => {
  test('a FAILED push posts NOTHING — zero gh POST/graphql invocations, pushed=false, nothing failed or skipped (all retriable), and pushError names the failure', async () => {
    const calls: GhCall[] = [];
    const pushCalls: string[][] = [];
    const result = await replyAndResolve(
      [mkReply('r1', 1201), mkIssue('i1'), mkResolve('s1', 'PRRT_1')],
      baseOpts(recordingGh(calls), memLog(), {
        run: pushRun(pushCalls, 1),
        args: ['push', 'origin', 'refs/heads/branch'],
      }),
    );
    expect(result.pushed).toBe(false);
    expect(result.posted).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.skippedAlreadyDispatched).toBe(0);
    expect(result.skippedAlreadyResolved).toBe(0);
    // pushError: code + stderr — the caller's only diagnostic (nothing posted).
    expect(result.pushError).toContain('exit 1');
    expect(result.pushError).toContain('fatal: unable to access');
    // NO POST argv ever ran — not one reply, comment, or mutation.
    expect(calls).toEqual([]);
    // The push itself ran exactly once, with the caller-composed argv.
    expect(pushCalls).toEqual([['push', 'origin', 'refs/heads/branch']]);
  });

  test('a THROWN push (spawn-level failure) fails closed identically — nothing posted, nothing attempted, pushError carries the throw message', async () => {
    const calls: GhCall[] = [];
    const pushCalls: string[][] = [];
    const throwingPush: GhFn = async (args) => {
      pushCalls.push(args);
      throw new Error('spawn gh ENOENT');
    };
    const result = await replyAndResolve(
      [mkReply('r1', 1201)],
      baseOpts(recordingGh(calls), memLog(), {
        run: throwingPush,
        args: ['push', 'origin', 'main'],
      }),
    );
    expect(result.pushed).toBe(false);
    expect(result.posted).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.skippedAlreadyDispatched).toBe(0);
    expect(result.skippedAlreadyResolved).toBe(0);
    expect(result.pushError).toContain('spawn gh ENOENT');
    expect(calls).toEqual([]);
    expect(pushCalls).toEqual([['push', 'origin', 'main']]);
  });

  test('pushError is capped at 500 characters even when the push spews pages of stderr', async () => {
    const longStderr = 'x'.repeat(2000);
    const failingPush: GhFn = async () => ({ code: 1, stdout: '', stderr: longStderr });
    const result = await replyAndResolve(
      [mkReply('r1', 1201)],
      baseOpts(recordingGh([]), memLog(), { run: failingPush, args: ['push', 'origin', 'main'] }),
    );
    expect(result.pushed).toBe(false);
    expect(result.pushError).toHaveLength(500);
    expect(result.pushError).toContain('exit 1');
  });

  test('no push configured → posting proceeds immediately (pushed=true)', async () => {
    const calls: GhCall[] = [];
    const result = await replyAndResolve(
      [mkReply('r1', 1201), mkResolve('s1', 'PRRT_1')],
      baseOpts(recordingGh(calls), memLog(), null),
    );
    expect(result.pushed).toBe(true);
    expect(result.posted).toHaveLength(2);
    expect(calls.map((c) => c.label)).toEqual(['reply:1201', 'resolve:PRRT_1']);
  });
});
