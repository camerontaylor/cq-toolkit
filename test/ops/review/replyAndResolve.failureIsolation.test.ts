// Split provenance: test/ops/review/replyAndResolve.test.ts was split into
// subject files; this file carries clause (e), per-action failure isolation,
// including the withholding rule and the already-resolved idempotent replay.
import { describe, expect, test } from 'vitest';
import { replyAndResolve } from '../../../src/ops/review/replyAndResolve.js';
import type { ReviewAction } from '../../../src/ops/review/replyAndResolve.js';
import {
  baseOpts,
  memLog,
  mkIssue,
  mkReply,
  mkResolve,
  NOW,
  recordingGh,
  type GhCall,
} from './replyAndResolve.helpers.js';

// ---------------------------------------------------------------------------
// e. PER-ACTION FAILURE ISOLATION
// ---------------------------------------------------------------------------

describe('per-action failure isolation', () => {
  test('WITHHOLDING: a failed review_reply withholds every resolve in the batch — the thread is never hidden behind a missing reply', async () => {
    const calls: GhCall[] = [];
    const log = memLog();
    const result = await replyAndResolve(
      [mkReply('r1', 1201), mkResolve('res1', 'PRRT_kwA')],
      baseOpts(
        recordingGh(calls, undefined, (label) =>
          label === 'reply:1201'
            ? { code: 1, stdout: '', stderr: 'gh: comment rejected' }
            : undefined,
        ),
        log,
      ),
    );
    expect(result.pushed).toBe(true);
    // The reply failed…
    expect(result.failed[0]?.action.actionId).toBe('r1');
    // …and the resolve was WITHHELD: not executed, not recorded, retriable.
    expect(result.withheld).toBe(1);
    expect(result.failed.some((f) => f.action.actionId === 'res1')).toBe(true);
    expect(result.failed.find((f) => f.action.actionId === 'res1')?.error).toContain('withheld');
    expect(calls.map((c) => c.label)).toEqual(['reply:1201']);
    expect((await log.load()).map((r) => r.actionId)).toEqual([]);
  });

  test('WITHHOLDING releases on the next run: the reply lands, the resolve executes', async () => {
    const calls: GhCall[] = [];
    const log = memLog();
    const result = await replyAndResolve(
      [mkReply('r1', 1201), mkResolve('res1', 'PRRT_kwA')],
      baseOpts(recordingGh(calls), log),
    );
    expect(result.pushed).toBe(true);
    expect(result.withheld).toBe(0);
    expect(result.posted.map((r) => r.actionId)).toEqual(['r1', 'res1']);
    expect(result.failed).toHaveLength(0);
  });

  test('a MIDDLE reply failing does not stop the others — it lands in failed with the GhError-ish message and is NOT recorded', async () => {
    const calls: GhCall[] = [];
    const log = memLog();
    const result = await replyAndResolve(
      [mkReply('r1', 1201), mkReply('rmid', 1202), mkIssue('i1')],
      baseOpts(
        recordingGh(calls, undefined, (label) =>
          label === 'reply:1202'
            ? { code: 1, stdout: '', stderr: 'gh: comment payload rejected' }
            : undefined,
        ),
        log,
      ),
    );
    expect(result.pushed).toBe(true);
    expect(result.posted.map((r) => r.actionId)).toEqual(['r1', 'i1']);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.action.actionId).toBe('rmid');
    // GhError-shaped message: exit code, the argv, and the stderr.
    expect(result.failed[0]?.error).toContain('exit 1');
    expect(result.failed[0]?.error).toContain('in_reply_to=1202');
    expect(result.failed[0]?.error).toContain('gh: comment payload rejected');
    // NOT recorded — the next run retries it.
    expect((await log.load()).map((r) => r.actionId)).toEqual(['r1', 'i1']);
    // The siblings all ran.
    expect(calls.map((c) => c.label)).toEqual(['reply:1201', 'reply:1202', 'issue-comment']);
  });

  test('failing resolves are isolated the same way — nonzero exit AND other GraphQL-errors-on-200 both land in failed, unrecorded', async () => {
    const calls: GhCall[] = [];
    const log = memLog();
    const result = await replyAndResolve(
      [mkReply('r1', 1201), mkResolve('s1', 'PRRT_1'), mkResolve('s2', 'PRRT_2')],
      baseOpts(
        recordingGh(calls, undefined, (label) => {
          if (label === 'resolve:PRRT_1')
            return { code: 4, stdout: '', stderr: 'gh: mutation conflicted' };
          if (label === 'resolve:PRRT_2') {
            // A 200 whose body carries server-side GraphQL errors OTHER
            // than the idempotent already-resolved case — the mutation did
            // NOT land; a safe retry.
            return {
              code: 0,
              stdout: JSON.stringify({ errors: [{ message: 'Bad credentials' }] }),
              stderr: '',
            };
          }
          return undefined;
        }),
        log,
      ),
    );
    expect(result.posted.map((r) => r.actionId)).toEqual(['r1']);
    expect(result.failed.map((f) => f.action.actionId)).toEqual(['s1', 's2']);
    expect(result.skippedAlreadyResolved).toBe(0);
    expect(result.failed[0]?.error).toContain('exit 4');
    expect(result.failed[1]?.error).toContain('GraphQL errors: Bad credentials');
    // Neither resolve was recorded; the reply was.
    expect((await log.load()).map((r) => r.actionId)).toEqual(['r1']);
  });

  test('a resolve the server calls ALREADY RESOLVED is a SUCCESS-EQUIVALENT replay — recorded, skippedAlreadyResolved, never failed', async () => {
    const calls: GhCall[] = [];
    const log = memLog();
    const result = await replyAndResolve(
      [mkReply('r1', 1201), mkResolve('s1', 'PRRT_1')],
      baseOpts(
        recordingGh(calls, undefined, (label) => {
          if (label === 'resolve:PRRT_1') {
            // The mutation's effects are already in place (a prior run's
            // mutation landed, its record did not — the crash window);
            // GitHub answers with this GraphQL error.
            return {
              code: 0,
              stdout: JSON.stringify({ errors: [{ message: 'Thread is already resolved.' }] }),
              stderr: '',
            };
          }
          return undefined;
        }),
        log,
      ),
    );
    // NOT a failure: the run converged instead of retrying forever.
    expect(result.failed).toEqual([]);
    expect(result.skippedAlreadyResolved).toBe(1);
    // Recorded exactly like a landed success — resultRef is the thread id.
    expect(result.posted.map((r) => r.actionId)).toEqual(['r1', 's1']);
    expect(result.posted[1]).toEqual({
      actionId: 's1',
      kind: 'resolve_thread',
      resultRef: 'PRRT_1',
      at: NOW,
    });
    expect(await log.load()).toEqual([
      { actionId: 'r1', kind: 'review_reply', resultRef: '8001', at: NOW },
      { actionId: 's1', kind: 'resolve_thread', resultRef: 'PRRT_1', at: NOW },
    ]);
    // The reply sibling ran normally.
    expect(calls.map((c) => c.label)).toEqual(['reply:1201', 'resolve:PRRT_1']);
  });

  test('a MIXED errors payload (already-resolved next to a real failure) is NOT idempotent — failed, unrecorded', async () => {
    const calls: GhCall[] = [];
    const log = memLog();
    const result = await replyAndResolve(
      [mkReply('r1', 1201), mkResolve('s1', 'PRRT_1')],
      baseOpts(
        recordingGh(calls, undefined, (label) =>
          label === 'resolve:PRRT_1'
            ? {
                code: 0,
                stdout: JSON.stringify({
                  errors: [
                    { message: 'Thread is already resolved' },
                    { message: 'Bad credentials' },
                  ],
                }),
                stderr: '',
              }
            : undefined,
        ),
        log,
      ),
    );
    // Already-resolved must be the SOLE error to read as a landed replay —
    // a mixed payload does not prove the mutation landed, so it stays a
    // plain retriable failure.
    expect(result.skippedAlreadyResolved).toBe(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.action.actionId).toBe('s1');
    expect(result.failed[0]?.error).toContain(
      'GraphQL errors: Thread is already resolved; Bad credentials',
    );
    expect((await log.load()).map((r) => r.actionId)).toEqual(['r1']);
  });

  test('IDEMPOTENT REPLAY across runs: mutation landed, record did not → the re-run converges (skippedAlreadyResolved 1, failed 0, no duplicate anything)', async () => {
    const actions: ReviewAction[] = [mkResolve('s1', 'PRRT_1'), mkResolve('s2', 'PRRT_2')];

    // Run 1: BOTH mutations land, but gh answers s1 with the
    // already-resolved error (the prior run's record never made it).
    const calls1: GhCall[] = [];
    const log = memLog();
    const run1 = await replyAndResolve(
      actions,
      baseOpts(
        recordingGh(calls1, undefined, (label) =>
          label === 'resolve:PRRT_1'
            ? {
                code: 0,
                stdout: JSON.stringify({ errors: [{ message: 'Thread is already resolved' }] }),
                stderr: '',
              }
            : undefined,
        ),
        log,
      ),
    );
    expect(run1.failed).toEqual([]);
    expect(run1.skippedAlreadyResolved).toBe(1);
    expect(run1.posted.map((r) => r.actionId)).toEqual(['s1', 's2']);
    // The replay was RECORDED — the log now carries it once.
    expect((await log.load()).map((r) => r.actionId)).toEqual(['s1', 's2']);

    // Run 2: clean gh, SAME action list, SAME log — s1 is now deduped like
    // any dispatched action: no second mutation, no duplicate record.
    const calls2: GhCall[] = [];
    const run2 = await replyAndResolve(actions, baseOpts(recordingGh(calls2), log));
    expect(run2.failed).toEqual([]);
    expect(run2.skippedAlreadyResolved).toBe(0);
    expect(run2.skippedAlreadyDispatched).toBe(2);
    expect(run2.posted).toEqual([]);
    // The mutation for s1 ran exactly ONCE across both runs.
    expect(calls1.filter((c) => c.label === 'resolve:PRRT_1')).toHaveLength(1);
    expect(calls2.filter((c) => c.label === 'resolve:PRRT_1')).toHaveLength(0);
    // No duplicate anything: one record per action, period.
    expect(await log.load()).toHaveLength(2);
  });
});
