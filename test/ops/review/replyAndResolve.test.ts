// E3 slice 1 — tests for replyAndResolve (src/ops/review/replyAndResolve.ts).
//
// Pinned here (the module doc's contract clauses, each mapped to a test):
//   a. PUSH-BEFORE-POST ORDERING (no rollback — a landed push stays
//      landed): a nonzero push exit posts NOTHING (no POST/graphql argv
//      ever runs), returns pushed=false with empty posted/failed and zero
//      skips — every action stays retriable; pushError carries the code +
//      stderr (≤500 chars); a seam-level push throw fails closed
//      identically, with the throw message as pushError.
//   b. DEDUPE: an actionId already in the dispatch log skips entirely — no
//      invocation, counted in skippedAlreadyDispatched (cross-run AND
//      within-run duplicates).
//   c. REPLY-BEFORE-RESOLVE (I11 ordering): replies and issue comments all
//      execute (input order) before ANY resolve mutation.
//   d. CRASH REPLAY (the key test): run 1 fails on the resolve — the replies
//      are already RECORDED at post time; re-running the same action list
//      against a clean gh skips the recorded replies (no duplicate post)
//      and retries only the resolves.
//   e. PER-ACTION FAILURE ISOLATION: a failing reply or resolve lands in
//      `failed` (GhError-shaped message / GraphQL-errors message), is NOT
//      recorded (retriable), and never stops its siblings. THE IDEMPOTENT
//      EXCEPTION: a resolve whose GraphQL errors say "already resolved" is
//      a SUCCESS-EQUIVALENT replay — recorded, counted in
//      skippedAlreadyResolved, never failed — so a mutation that landed
//      but whose record didn't converges on the re-run.
//   f. RECORD-BEFORE-NEXT: every success is logged immediately after its own
//      mutation, before the next action starts (asserted via an interleaved
//      event stream of gh invocations and log records).
//   Plus: argv shapes (REST posts with -F in_reply_to / -f body; the resolve
//   mutation riding `-f query=` with NO variable named `query` — the I11
//   collision rule), the no-push configuration, result record shapes
//   (created comment ids / thread ids / injected nowMs; 'unknown' when the
//   response body is unmineable), resolve confirmation (only a response
//   with isResolved=true records; {} / data-null / false → failed,
//   retried), empty-body rejection, seam-level throw isolation for the
//   main run, and the fileDispatchLog behaviors (missing = empty, mid-file
//   corruption = loud throw, truncated FINAL line = tolerated, record =
//   single-line append — interleaved load/record cycles never lose a
//   record or leave a truncated PRIOR line).
//
// The gh seam is INJECTED (fakes routing on argv, recording invocation
// order); no spawned process, no network, no real clocks (nowMs injected).
import { describe, expect, test } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileDispatchLog, replyAndResolve } from '../../../src/ops/review/replyAndResolve.js';
import type { DispatchLog, DispatchRecord, ReplyAndResolveOpts, ReviewAction } from '../../../src/ops/review/replyAndResolve.js';
import type { GhFn, GhResult } from '../../../src/ops/review/gh.js';

// ---------------------------------------------------------------------------
// Fixtures + fakes
// ---------------------------------------------------------------------------

const NOW = 1_750_000_000_000;
const REPO = { owner: 'octo', repo: 'widget', pr: 7 } as const;

const mkReply = (actionId: string, threadRootRestId: number, body = `fixed in head — see root ${threadRootRestId}`): ReviewAction => ({
  kind: 'review_reply',
  actionId,
  threadRootRestId,
  body,
});
const mkIssue = (actionId: string, body = 'summary: all threads addressed'): ReviewAction => ({
  kind: 'issue_comment',
  actionId,
  body,
});
const mkResolve = (actionId: string, threadId: string): ReviewAction => ({
  kind: 'resolve_thread',
  actionId,
  threadId,
});

/** Value of the `<name>=…` argv entry gh `-f/-F` args carry. */
const flagValue = (args: string[], name: string): string => {
  const entry = args.find((a) => a.startsWith(`${name}=`));
  return entry === undefined ? '' : entry.slice(name.length + 1);
};

/** One recorded gh invocation: a short routing label plus the full argv. */
interface GhCall {
  label: string;
  args: string[];
}

/**
 * An injected GhFn that routes on argv (the mutation, the pulls-comments
 * POST, the issues-comments POST), records every invocation into `calls`
 * (and, when given, a shared event stream for interleaving assertions),
 * and succeeds by default — created comments get sequential ids starting
 * at 8001. `fail(label)` returns a forced GhResult for the labeled call.
 */
const recordingGh = (
  calls: GhCall[],
  events?: string[],
  fail?: (label: string) => GhResult | undefined,
): GhFn => {
  let nextCommentId = 8001;
  return async (args: string[]): Promise<GhResult> => {
    const label = args.includes('graphql')
      ? `resolve:${flagValue(args, 'threadId')}`
      : args.some((a) => a.includes('/pulls/'))
        ? `reply:${flagValue(args, 'in_reply_to')}`
        : 'issue-comment';
    calls.push({ label, args });
    events?.push(`gh:${label}`);
    const forced = fail?.(label);
    if (forced !== undefined) {
      return forced;
    }
    if (args.includes('graphql')) {
      return {
        code: 0,
        stdout: JSON.stringify({ data: { resolveReviewThread: { thread: { id: flagValue(args, 'threadId'), isResolved: true } } } }),
        stderr: '',
      };
    }
    return { code: 0, stdout: JSON.stringify({ id: nextCommentId++ }), stderr: '' };
  };
};

/** An in-memory DispatchLog; optionally mirrors records into the event stream. */
const memLog = (initial: DispatchRecord[] = [], events?: string[]): DispatchLog & { records: DispatchRecord[] } => {
  const records = [...initial];
  return {
    records,
    load: async () => [...records],
    record: async (entry: DispatchRecord) => {
      events?.push(`record:${entry.actionId}`);
      records.push({ ...entry });
    },
  };
};

/** Base opts: the coords, an injected clock, no push unless overridden. */
const baseOpts = (
  run: GhFn,
  dispatchLog: DispatchLog,
  push?: { run: GhFn; args: string[] } | null,
): ReplyAndResolveOpts => ({
  ...REPO,
  run,
  push: push ?? null,
  dispatchLog,
  nowMs: NOW,
});

/** A push runner resolving with `code` (records its argv). */
const pushRun = (calls: string[][], code = 0): GhFn => async (args: string[]) => {
  calls.push(args);
  return { code, stdout: '', stderr: code === 0 ? '' : 'fatal: unable to access' };
};

// ---------------------------------------------------------------------------
// a. PUSH-BEFORE-POST ORDERING (no rollback)
// ---------------------------------------------------------------------------

describe('push-before-post', () => {
  test('a FAILED push posts NOTHING — zero gh POST/graphql invocations, pushed=false, nothing failed or skipped (all retriable), and pushError names the failure', async () => {
    const calls: GhCall[] = [];
    const pushCalls: string[][] = [];
    const result = await replyAndResolve(
      [mkReply('r1', 1201), mkIssue('i1'), mkResolve('s1', 'PRRT_1')],
      baseOpts(recordingGh(calls), memLog(), { run: pushRun(pushCalls, 1), args: ['push', 'origin', 'refs/heads/branch'] }),
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
      baseOpts(recordingGh(calls), memLog(), { run: throwingPush, args: ['push', 'origin', 'main'] }),
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

// ---------------------------------------------------------------------------
// c. ordering + f. record-before-next
// ---------------------------------------------------------------------------

describe('reply-before-resolve ordering and record-before-next', () => {
  test('happy path: replies and issue comments execute (input order) before ANY resolve; each success is recorded BEFORE the next action starts', async () => {
    const events: string[] = [];
    const calls: GhCall[] = [];
    const log = memLog([], events);
    const result = await replyAndResolve(
      [mkReply('r1', 1201), mkIssue('i1'), mkReply('r2', 1202), mkResolve('s1', 'PRRT_1'), mkResolve('s2', 'PRRT_2')],
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
    const actions: ReviewAction[] = [mkReply('r1', 1201), mkReply('r2', 1202), mkResolve('s1', 'PRRT_1'), mkResolve('s2', 'PRRT_2')];

    // Run 1: the gh seam returns nonzero for the resolve mutation ONLY.
    const calls1: GhCall[] = [];
    const log = memLog();
    const run1 = await replyAndResolve(
      actions,
      baseOpts(
        recordingGh(calls1, undefined, (label) =>
          label.startsWith('resolve:') ? { code: 1, stdout: '', stderr: 'gh: GraphQL: internal error' } : undefined,
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

// ---------------------------------------------------------------------------
// e. PER-ACTION FAILURE ISOLATION
// ---------------------------------------------------------------------------

describe('per-action failure isolation', () => {
  test('a MIDDLE reply failing does not stop the others — it lands in failed with the GhError-ish message and is NOT recorded', async () => {
    const calls: GhCall[] = [];
    const log = memLog();
    const result = await replyAndResolve(
      [mkReply('r1', 1201), mkReply('rmid', 1202), mkIssue('i1')],
      baseOpts(
        recordingGh(calls, undefined, (label) => (label === 'reply:1202' ? { code: 1, stdout: '', stderr: 'gh: comment payload rejected' } : undefined)),
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
          if (label === 'resolve:PRRT_1') return { code: 4, stdout: '', stderr: 'gh: mutation conflicted' };
          if (label === 'resolve:PRRT_2') {
            // A 200 whose body carries server-side GraphQL errors OTHER
            // than the idempotent already-resolved case — the mutation did
            // NOT land; a safe retry.
            return { code: 0, stdout: JSON.stringify({ errors: [{ message: 'Bad credentials' }] }), stderr: '' };
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
            return { code: 0, stdout: JSON.stringify({ errors: [{ message: 'Thread is already resolved.' }] }), stderr: '' };
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
    expect(result.posted[1]).toEqual({ actionId: 's1', kind: 'resolve_thread', resultRef: 'PRRT_1', at: NOW });
    expect((await log.load())).toEqual([
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
                  errors: [{ message: 'Thread is already resolved' }, { message: 'Bad credentials' }],
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
    expect(result.failed[0]?.error).toContain('GraphQL errors: Thread is already resolved; Bad credentials');
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
            ? { code: 0, stdout: JSON.stringify({ errors: [{ message: 'Thread is already resolved' }] }), stderr: '' }
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
    expect((await log.load())).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// outcome-parsing gaps — every non-conforming gh outcome is isolated+unrecorded
// ---------------------------------------------------------------------------

describe('non-conforming gh outcomes', () => {
  test('a resolve printing NON-JSON stdout lands in failed and is NOT recorded (outcome unknown → retry)', async () => {
    const calls: GhCall[] = [];
    const log = memLog();
    const result = await replyAndResolve(
      [mkReply('r1', 1201), mkResolve('s1', 'PRRT_1')],
      baseOpts(
        recordingGh(calls, undefined, (label) =>
          label === 'resolve:PRRT_1' ? { code: 0, stdout: 'gh: rendered an error page, not JSON', stderr: '' } : undefined,
        ),
        log,
      ),
    );
    // The reply sibling was unaffected.
    expect(result.posted.map((r) => r.actionId)).toEqual(['r1']);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.action.actionId).toBe('s1');
    expect(result.failed[0]?.error).toContain('non-JSON');
    // NOT recorded — the next run retries it (recording an unknown outcome
    // could swallow a mutation that never landed).
    expect(await log.load()).toEqual([{ actionId: 'r1', kind: 'review_reply', resultRef: '8001', at: NOW }]);
  });

  test.each([
    ['an EMPTY response object', {}],
    ['a null data payload', { data: null }],
    ['an isResolved:false thread', { data: { resolveReviewThread: { thread: { id: 'PRRT_1', isResolved: false } } } }],
    ['a response with no thread', { data: { resolveReviewThread: {} } }],
  ])('a resolve confirmed by NOTHING (%s) → failed with "resolve mutation did not land", unrecorded', async (_label, stdoutBody) => {
    const calls: GhCall[] = [];
    const log = memLog();
    const result = await replyAndResolve(
      [mkReply('r1', 1201), mkResolve('s1', 'PRRT_1')],
      baseOpts(
        recordingGh(calls, undefined, (label) =>
          label === 'resolve:PRRT_1' ? { code: 0, stdout: JSON.stringify(stdoutBody), stderr: '' } : undefined,
        ),
        log,
      ),
    );
    // Exit 0 + no errors is not proof: the response must CONFIRM the
    // resolve. The reply sibling was unaffected.
    expect(result.posted.map((r) => r.actionId)).toEqual(['r1']);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.action.actionId).toBe('s1');
    expect(result.failed[0]?.error).toContain('resolve mutation did not land');
    // NOT recorded — the next run retries it.
    expect(await log.load()).toEqual([{ actionId: 'r1', kind: 'review_reply', resultRef: '8001', at: NOW }]);
  });

  test('a resolve the response CONFIRMS (isResolved true) is recorded exactly like a landed success', async () => {
    const calls: GhCall[] = [];
    const log = memLog();
    const result = await replyAndResolve(
      [mkResolve('s1', 'PRRT_1')],
      baseOpts(
        recordingGh(calls, undefined, (label) =>
          label === 'resolve:PRRT_1'
            ? { code: 0, stdout: JSON.stringify({ data: { resolveReviewThread: { thread: { id: 'PRRT_1', isResolved: true } } } }), stderr: '' }
            : undefined,
        ),
        log,
      ),
    );
    expect(result.failed).toEqual([]);
    expect(result.posted).toEqual([{ actionId: 's1', kind: 'resolve_thread', resultRef: 'PRRT_1', at: NOW }]);
    expect(await log.load()).toEqual([{ actionId: 's1', kind: 'resolve_thread', resultRef: 'PRRT_1', at: NOW }]);
  });

  test('a THROWN main-run gh seam failure fails just that action with the throw message — siblings proceed', async () => {
    const calls: GhCall[] = [];
    const base = recordingGh(calls);
    const log = memLog();
    const throwingRun: GhFn = async (args) => {
      if (args.some((a) => a.includes('in_reply_to=1202'))) {
        throw new Error('spawn gh ENOMEM');
      }
      return base(args);
    };
    const result = await replyAndResolve(
      [mkReply('r1', 1201), mkReply('rmid', 1202), mkIssue('i1')],
      baseOpts(throwingRun, log),
    );
    expect(result.pushed).toBe(true);
    // The thrown seam failure became that ONE action's failure, message
    // carrying the throw string; siblings ran and were recorded.
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.action.actionId).toBe('rmid');
    expect(result.failed[0]?.error).toContain('spawn gh ENOMEM');
    expect(result.posted.map((r) => r.actionId)).toEqual(['r1', 'i1']);
    // The throwing invocation never even reached the recorder — the seam
    // threw before delegating — but the SIBLINGS all ran, in order.
    expect(calls.map((c) => c.label)).toEqual(['reply:1201', 'issue-comment']);
    expect((await log.load()).map((r) => r.actionId)).toEqual(['r1', 'i1']);
  });

  test("a success whose body cannot be mined records resultRef 'unknown' — recording is never blocked by an unparseable body", async () => {
    const calls: GhCall[] = [];
    const log = memLog();
    const result = await replyAndResolve(
      [mkReply('r1', 1201), mkIssue('i1')],
      baseOpts(
        recordingGh(calls, undefined, (label) => {
          if (label === 'reply:1201') return { code: 0, stdout: '<html>gateway garbage</html>', stderr: '' };
          if (label === 'issue-comment') return { code: 0, stdout: JSON.stringify({ id: 'not-a-number' }), stderr: '' };
          return undefined;
        }),
        log,
      ),
    );
    // Both posts SUCCEEDED (exit 0): recorded with the best-effort ref.
    expect(result.failed).toEqual([]);
    expect(result.posted.map((r) => r.resultRef)).toEqual(['unknown', 'unknown']);
    expect((await log.load()).map((r) => r.resultRef)).toEqual(['unknown', 'unknown']);
  });
});

// ---------------------------------------------------------------------------
// argv shapes + the GraphQL collision rule
// ---------------------------------------------------------------------------

describe('argv shapes', () => {
  test('reply POSTs to pulls comments with -F in_reply_to and -f body; issue comment POSTs to the issues collection', async () => {
    const calls: GhCall[] = [];
    await replyAndResolve(
      [mkReply('r1', 1201, 'the fix landed in abc123'), mkIssue('i1', 'all threads addressed')],
      baseOpts(recordingGh(calls), memLog()),
    );
    expect(calls[0]?.args).toEqual([
      'api',
      '-X',
      'POST',
      'repos/octo/widget/pulls/7/comments',
      '-F',
      'in_reply_to=1201',
      '-f',
      'body=the fix landed in abc123',
    ]);
    expect(calls[1]?.args).toEqual([
      'api',
      '-X',
      'POST',
      'repos/octo/widget/issues/7/comments',
      '-f',
      'body=all threads addressed',
    ]);
  });

  test('the resolve mutation rides `-f query=` with NO GraphQL variable named `query` (the collision rule) and `-f threadId=`', async () => {
    const calls: GhCall[] = [];
    await replyAndResolve([mkResolve('s1', 'PRRT_1')], baseOpts(recordingGh(calls), memLog()));
    expect(calls).toHaveLength(1);
    const args = calls[0]?.args ?? [];
    expect(args[0]).toBe('api');
    expect(args[1]).toBe('graphql');
    // Every value rides a raw `-f` — no `-F` coercion anywhere.
    expect(args.some((a) => a === '-F')).toBe(false);
    const doc = flagValue(args, 'query');
    expect(doc).toContain('mutation ($threadId: ID!)');
    expect(doc).toContain('resolveReviewThread');
    // THE COLLISION RULE: the document must not declare a variable named
    // `query` — it rides the `-f query=` slot itself.
    expect(doc).not.toMatch(/\$query\b/);
    expect(flagValue(args, 'threadId')).toBe('PRRT_1');
    // Both flag values are preceded by the raw-string flag.
    for (let i = 0; i < args.length; i++) {
      if (/^(query|threadId)=/.test(args[i] ?? '')) {
        expect(args[i - 1]).toBe('-f');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// validation fails loud BEFORE any I/O
// ---------------------------------------------------------------------------

describe('pre-flight validation', () => {
  test.each([
    ['bad owner', { ...REPO, owner: '../evil' }, [mkReply('r1', 1201)]],
    ['bad repo', { ...REPO, repo: 'bad repo' }, [mkReply('r1', 1201)]],
    ['dot owner (dot segment into the request path)', { ...REPO, owner: '.' }, [mkReply('r1', 1201)]],
    ['dotdot repo (dot segment into the request path)', { ...REPO, repo: '..' }, [mkReply('r1', 1201)]],
    ['bad pr', { ...REPO, pr: 0 }, [mkReply('r1', 1201)]],
    ['empty actionId', REPO, [mkReply('', 1201)]],
    ['bad threadRootRestId', REPO, [mkReply('r1', 0)]],
    ['empty threadId', REPO, [mkResolve('s1', '')]],
    ['whitespace threadId', REPO, [mkResolve('s1', '   ')]],
    ['whitespace reply body', REPO, [mkReply('r1', 1201, '   ')]],
    ['empty issue-comment body', REPO, [mkIssue('i1', '')]],
  ])('%s throws before a single gh invocation or push', async (_label, optsPartial, actions) => {
    const calls: GhCall[] = [];
    const pushCalls: string[][] = [];
    const opts = {
      ...optsPartial,
      run: recordingGh(calls),
      push: { run: pushRun(pushCalls), args: ['push', 'origin', 'main'] },
      dispatchLog: memLog(),
      nowMs: NOW,
    } as ReplyAndResolveOpts;
    await expect(replyAndResolve(actions, opts)).rejects.toThrow(/replyAndResolve:/);
    expect(calls).toEqual([]);
    expect(pushCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// fileDispatchLog — the file-backed DispatchLog
// ---------------------------------------------------------------------------

describe('fileDispatchLog', () => {
  test('a missing log file loads as an EMPTY log, and record creates the file and round-trips', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cq-dispatch-'));
    try {
      const path = join(dir, 'dispatch.jsonl');
      const log = fileDispatchLog(path);
      expect(await log.load()).toEqual([]);
      const first: DispatchRecord = { actionId: 'r1', kind: 'review_reply', resultRef: '8001', at: NOW };
      const second: DispatchRecord = { actionId: 's1', kind: 'resolve_thread', resultRef: 'PRRT_1', at: NOW };
      await log.record(first);
      await log.record(second);
      // One JSON record per line (JSON-lines-ish), newline-terminated.
      const text = await readFile(path, 'utf8');
      expect(text.split('\n')).toEqual([JSON.stringify(first), JSON.stringify(second), '']);
      // A FRESH log instance over the same path sees both records (the
      // cross-run memory).
      expect(await fileDispatchLog(path).load()).toEqual([first, second]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('MID-FILE corruption throws a CLEAR error — dispatching on an unreadable log would duplicate posts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cq-dispatch-'));
    try {
      const path = join(dir, 'dispatch.jsonl');
      // A broken line with MORE records after it is not a truncated tail —
      // it is real corruption: load must refuse loudly.
      const first: DispatchRecord = { actionId: 'r1', kind: 'review_reply', resultRef: '8001', at: NOW };
      const third: DispatchRecord = { actionId: 's1', kind: 'resolve_thread', resultRef: 'PRRT_1', at: NOW };
      await writeFile(path, `${JSON.stringify(first)}\n{"actionId":"r2","kind":\n${JSON.stringify(third)}\n`, 'utf8');
      const log = fileDispatchLog(path);
      await expect(log.load()).rejects.toThrow(/corrupt.*line 2.*later lines follow/s);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a TRUNCATED FINAL line (a crash mid-append) is TOLERATED — prior records load, the record is retriable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cq-dispatch-'));
    try {
      const path = join(dir, 'dispatch.jsonl');
      const first: DispatchRecord = { actionId: 'r1', kind: 'review_reply', resultRef: '8001', at: NOW };
      // The second line was cut off mid-write by a crash — no newline, no
      // closing brace.
      await writeFile(path, `${JSON.stringify(first)}\n{"actionId":"r2","kind`, 'utf8');
      const log = fileDispatchLog(path);
      // The intact prefix loads; the truncated tail is dropped, NOT thrown.
      // The r2 record never landed, so its action stays retriable.
      expect(await log.load()).toEqual([first]);
      expect(await fileDispatchLog(path).load()).toEqual([first]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('record() REPAIRS a partial tail before appending — the retry can never concatenate onto unterminated bytes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cq-dispatch-'));
    try {
      const path = join(dir, 'dispatch.jsonl');
      const first: DispatchRecord = { actionId: 'r1', kind: 'review_reply', resultRef: '8001', at: NOW };
      const second: DispatchRecord = { actionId: 'r2', kind: 'issue_comment', resultRef: '8002', at: NOW + 1 };
      // The crash residue: a complete line followed by unterminated partial
      // bytes ("line1\npartialtail").
      await writeFile(path, `${JSON.stringify(first)}\n{"actionId":"r2","kind`, 'utf8');
      const log = fileDispatchLog(path);
      await log.record(second);
      // The partial tail was TRUNCATED before the append, so the new record
      // is whole and parseable — not concatenated into a dropped junk line.
      expect(await log.load()).toEqual([first, second]);
      const text = await readFile(path, 'utf8');
      expect(text.endsWith('\n')).toBe(true);
      expect(text.split('\n')).toEqual([JSON.stringify(first), JSON.stringify(second), '']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('record APPENDS one line: N interleaved load/record cycles always leave parseable content', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cq-dispatch-'));
    try {
      const path = join(dir, 'dispatch.jsonl');
      const log = fileDispatchLog(path);
      // Interleave loads (including ones racing the record) with records;
      // after EVERY cycle the on-disk log must parse line-by-line — an
      // append can only ever add whole lines, and loads never rewrite.
      for (let cycle = 0; cycle < 20; cycle++) {
        await Promise.all([
          log.load(),
          log.record({ actionId: `r${cycle}`, kind: 'issue_comment', resultRef: String(cycle), at: NOW + cycle }),
          log.load(),
          log.load(),
        ]);
        const text = await readFile(path, 'utf8');
        for (const line of text.split('\n')) {
          if (line.trim() === '') continue;
          expect(() => JSON.parse(line)).not.toThrow();
        }
      }
      // Every record survived (appends never overwrite), and a FRESH log
      // instance sees the whole history.
      const history = await fileDispatchLog(path).load();
      expect(history).toHaveLength(20);
      expect(history.map((r) => r.actionId)).toEqual(Array.from({ length: 20 }, (_v, i) => `r${i}`));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
