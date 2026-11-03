// Split provenance: test/ops/review/replyAndResolve.test.ts was split into
// subject files; this file carries clauses (c), (f), (b) and (d) — ordering,
// record-before-next, dedupe, and crash replay.
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
// c. ordering + f. record-before-next
// ---------------------------------------------------------------------------

describe('reply-before-resolve ordering and record-before-next', () => {
  test('happy path: replies and issue comments execute (input order) before ANY resolve; each success is recorded BEFORE the next action starts', async () => {
    const events: string[] = [];
    const calls: GhCall[] = [];
    const log = memLog([], events);
    const result = await replyAndResolve(
      [
        mkReply('r1', 1201),
        mkIssue('i1'),
        mkReply('r2', 1202),
        mkResolve('s1', 'PRRT_1'),
        mkResolve('s2', 'PRRT_2'),
      ],
      baseOpts(recordingGh(calls, events), log),
    );
    expect(result.pushed).toBe(true);
    expect(result.failed).toEqual([]);
    expect(result.skippedAlreadyDispatched).toBe(0);
    // The interleaved stream pins BOTH orderings at once: every gh call is
    // immediately followed by its record; all posts precede all mutations.
    expect(events).toEqual([
      'gh:reply:1201',
      'record:r1',
      'gh:issue-comment',
      'record:i1',
      'gh:reply:1202',
      'record:r2',
      'gh:resolve:PRRT_1',
      'record:s1',
      'gh:resolve:PRRT_2',
      'record:s2',
    ]);
    // Result records: created comment ids in dispatch order, thread ids for
    // resolves, the INJECTED clock (never Date.now).
    expect(result.posted).toEqual([
      { actionId: 'r1', kind: 'review_reply', resultRef: '8001', at: NOW },
      { actionId: 'i1', kind: 'issue_comment', resultRef: '8002', at: NOW },
      { actionId: 'r2', kind: 'review_reply', resultRef: '8003', at: NOW },
      { actionId: 's1', kind: 'resolve_thread', resultRef: 'PRRT_1', at: NOW },
      { actionId: 's2', kind: 'resolve_thread', resultRef: 'PRRT_2', at: NOW },
    ]);
  });
});

// ---------------------------------------------------------------------------
// b. DEDUPE
// ---------------------------------------------------------------------------

describe('dedupe via the dispatch log', () => {
  test('a pre-recorded actionId is skipped entirely — no invocation, counted in skippedAlreadyDispatched', async () => {
    const calls: GhCall[] = [];
    const log = memLog([
      { actionId: 'r1', kind: 'review_reply', resultRef: '7001', at: NOW - 1000 },
      { actionId: 's1', kind: 'resolve_thread', resultRef: 'PRRT_1', at: NOW - 1000 },
    ]);
    const result = await replyAndResolve(
      [mkReply('r1', 1201), mkIssue('i1'), mkResolve('s1', 'PRRT_1')],
      baseOpts(recordingGh(calls), log),
    );
    expect(result.skippedAlreadyDispatched).toBe(2);
    expect(result.posted.map((r) => r.actionId)).toEqual(['i1']);
    // Only the un-recorded action ran.
    expect(calls.map((c) => c.label)).toEqual(['issue-comment']);
  });

  test('a duplicated actionId WITHIN one run dispatches once (the run joins the dedupe set as it records)', async () => {
    const calls: GhCall[] = [];
    const result = await replyAndResolve(
      [mkReply('r1', 1201), mkReply('r1', 1201)],
      baseOpts(recordingGh(calls), memLog()),
    );
    expect(result.posted).toHaveLength(1);
    expect(result.skippedAlreadyDispatched).toBe(1);
    expect(calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// d. CRASH REPLAY (the key test)
// ---------------------------------------------------------------------------

describe('crash replay — reply recorded at post time, resolve retried', () => {
  test('run 1 fails on the resolve; the re-run with the SAME actions posts NO duplicate replies and retries only the resolves', async () => {
    const actions: ReviewAction[] = [
      mkReply('r1', 1201),
      mkReply('r2', 1202),
      mkResolve('s1', 'PRRT_1'),
      mkResolve('s2', 'PRRT_2'),
    ];

    // Run 1: the gh seam returns nonzero for the resolve mutation ONLY.
    const calls1: GhCall[] = [];
    const log = memLog();
    const run1 = await replyAndResolve(
      actions,
      baseOpts(
        recordingGh(calls1, undefined, (label) =>
          label.startsWith('resolve:')
            ? { code: 1, stdout: '', stderr: 'gh: GraphQL: internal error' }
            : undefined,
        ),
        log,
      ),
    );
    // Replies posted and RECORDED (the crash window is post→record, and the
    // record won); both resolves failed and are NOT recorded.
    expect(run1.posted.map((r) => r.actionId)).toEqual(['r1', 'r2']);
    expect(run1.failed.map((f) => f.action.actionId)).toEqual(['s1', 's2']);
    expect((await log.load()).map((r) => r.actionId)).toEqual(['r1', 'r2']);

    // Run 2: a CLEAN gh (nothing fails), the SAME action list, the SAME log.
    const calls2: GhCall[] = [];
    const run2 = await replyAndResolve(actions, baseOpts(recordingGh(calls2), log));
    expect(run2.skippedAlreadyDispatched).toBe(2);
    expect(run2.failed).toEqual([]);
    // The replies executed exactly ONCE across BOTH runs — dedupe via the log.
    expect(calls1.filter((c) => c.label.startsWith('reply:'))).toHaveLength(2);
    expect(calls2.filter((c) => c.label.startsWith('reply:'))).toHaveLength(0);
    // Only the resolves were attempted again — and landed.
    expect(calls2.map((c) => c.label)).toEqual(['resolve:PRRT_1', 'resolve:PRRT_2']);
    expect(run2.posted.map((r) => r.actionId)).toEqual(['s1', 's2']);
  });
});
