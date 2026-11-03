// Split provenance: test/ops/review/replyAndResolve.test.ts was split into
// subject files; this file carries the cross-job convergence, log-lock and
// cancellation cases.
import { describe, expect, test } from 'vitest';
import type { DispatchLog, DispatchRecord } from '../../../src/ops/review/replyAndResolve.js';
import { replyAndResolve } from '../../../src/ops/review/replyAndResolve.js';
import {
  baseOpts,
  memLog,
  mkReply,
  mkResolve,
  NOW,
  recordingGh,
  type GhCall,
} from './replyAndResolve.helpers.js';

// ---------------------------------------------------------------------------
// review-debt #122 — the resolves loop refreshes the seen set BEFORE the
// outer dedupe check
// ---------------------------------------------------------------------------

describe('two-job convergence on a late-recorded resolve (review-debt #122)', () => {
  test('a resolve another job recorded after our startup classifies as skippedAlreadyDispatched, not withheld', async () => {
    // Job B's batch: the resolve X plus a FAILING reply sibling — the exact
    // shape where the withholding rule would otherwise eat the converged
    // resolve. Job A's record for X lands after B's startup load (call 1)
    // AND after the failing reply's posts-loop refresh (call 2), so ONLY the
    // resolves-loop refresh (call 3, the fix) can see it.
    const calls: GhCall[] = [];
    let loads = 0;
    const aRecord: DispatchRecord = {
      actionId: 's-x',
      kind: 'resolve_thread',
      resultRef: 'PRRT_X',
      at: NOW - 1,
    };
    const log: DispatchLog = {
      load: async () => {
        loads += 1;
        return loads < 3 ? [] : [{ ...aRecord }];
      },
      record: async () => undefined,
      withLogLock: async <T>(fn: () => Promise<T>) => fn(),
    };
    const result = await replyAndResolve(
      [mkResolve('s-x', 'PRRT_X'), mkReply('r-fail', 1201)],
      baseOpts(
        recordingGh(calls, undefined, (label) =>
          label === 'reply:1201' ? { code: 1, stdout: '', stderr: 'boom' } : undefined,
        ),
        log,
      ),
    );
    // Converged: X counted as already dispatched — not failed, not withheld,
    // and no second mutation was posted for it. Only the failed reply shows.
    expect(result.skippedAlreadyDispatched).toBe(1);
    expect(result.withheld).toBe(0);
    expect(result.failed.map((failure) => failure.action.actionId)).toEqual(['r-fail']);
    expect(result.posted).toEqual([]);
    expect(calls.some((call) => call.label === 'resolve:PRRT_X')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// round-1 reviewer — the resolve dedupe decision runs INSIDE the log lock
// ---------------------------------------------------------------------------

describe('resolve dedupe decision under the log lock (round-1 restructure)', () => {
  test('a record landing at lock-entry no longer misclassifies the converged resolve', async () => {
    // Deterministic interleave: job A's record for X lands exactly when job
    // B first ENTERS a withLogLock section (modeling A winning the lock
    // while B waited). Pre-restructure, B's refresh ran before the lock and
    // the record landed after it — the stale seen check classified the
    // converged resolve as withheld; now the refresh + check are atomic
    // inside the section.
    const calls: GhCall[] = [];
    let landed = false;
    const records: DispatchRecord[] = [];
    const log: DispatchLog = {
      load: async () => [...records],
      record: async (entry) => {
        records.push({ ...entry });
      },
      withLogLock: async <T>(fn: () => Promise<T>) => {
        if (!landed) {
          landed = true;
          records.push({
            actionId: 's-x',
            kind: 'resolve_thread',
            resultRef: 'PRRT_X',
            at: NOW - 1,
          });
        }
        return fn();
      },
    };
    const result = await replyAndResolve(
      [mkResolve('s-x', 'PRRT_X'), mkReply('r-fail', 1201)],
      baseOpts(
        recordingGh(calls, undefined, (label) =>
          label === 'reply:1201' ? { code: 1, stdout: '', stderr: 'boom' } : undefined,
        ),
        log,
      ),
    );
    // Converged: skipped, not withheld; only the failed reply; no second
    // mutation. The withhold reason strings are unchanged.
    expect(result.skippedAlreadyDispatched).toBe(1);
    expect(result.withheld).toBe(0);
    expect(result.failed.map((failure) => failure.action.actionId)).toEqual(['r-fail']);
    expect(
      result.failed.some((failure) =>
        failure.error.startsWith('withheld: a review_reply in this batch failed'),
      ),
    ).toBe(false);
    expect(result.posted).toEqual([]);
    expect(calls.some((call) => call.label === 'resolve:PRRT_X')).toBe(false);
  });
});

describe('cancellation admission with landed receipts', () => {
  test.each(['push', 'reply', 'resolve', 'log-lock'] as const)(
    'cancellation during held %s withholds every subsequent mutation',
    async (heldAt) => {
      const parent = new AbortController();
      let release!: () => void, entered!: () => void;
      const held = new Promise<void>((r) => {
        entered = r;
      });
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const calls: GhCall[] = [];
      const log = memLog();
      const normal = recordingGh(calls);
      const actions = [
        mkReply('r1', 1201),
        mkReply('r2', 1202),
        mkResolve('s1', 'PRRT_1'),
        mkResolve('s2', 'PRRT_2'),
      ];
      let lockHeld = false;
      if (heldAt === 'log-lock')
        log.withLogLock = async (body) => {
          if (!lockHeld) {
            lockHeld = true;
            entered();
            await gate;
          }
          return body();
        };
      const pending = replyAndResolve(actions, {
        ...baseOpts(
          async (args) => {
            const result = await normal(args);
            if (
              (heldAt === 'reply' && calls.length === 1) ||
              (heldAt === 'resolve' && calls.length === 3)
            ) {
              entered();
              await gate;
            }
            return result;
          },
          log,
          heldAt === 'push'
            ? {
                args: ['push', 'origin', 'HEAD'],
                run: async () => {
                  entered();
                  await gate;
                  return { code: 0, stdout: '', stderr: '' };
                },
              }
            : null,
        ),
        signal: parent.signal,
      });
      await held;
      parent.abort();
      const landed = [...calls];
      release();
      const result = await pending;
      expect(calls).toEqual(landed);
      expect(log.records.map((record) => record.actionId)).toEqual(
        heldAt === 'reply' ? ['r1'] : heldAt === 'resolve' ? ['r1', 'r2', 's1'] : [],
      );
      expect(result.pushed).toBe(true);
      const replayCalls: GhCall[] = [];
      const replay = await replyAndResolve(actions, baseOpts(recordingGh(replayCalls), log));
      expect(replay.failed).toEqual([]);
      expect(replayCalls).toHaveLength(4 - landed.length);
      expect(log.records.map((record) => record.actionId)).toEqual(['r1', 'r2', 's1', 's2']);
    },
  );
});
