// Split provenance: test/ops/review/replyAndResolve.test.ts was split into
// replyAndResolve.{pushBeforePost,ordering,failureIsolation,outcomes,argv,validation,dispatchLog,concurrency}.test.ts
// plus this shared fixtures module. Everything below the fixtures banner moved
// unchanged; this header is the original file header, kept with the family.
//
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
import type {
  DispatchLog,
  DispatchRecord,
  ReplyAndResolveOpts,
  ReviewAction,
} from '../../../src/ops/review/replyAndResolve.js';
import type { GhFn, GhResult } from '../../../src/adapters/forge-github/gh.js';

// ---------------------------------------------------------------------------
// Fixtures + fakes
// ---------------------------------------------------------------------------

export const NOW = 1_750_000_000_000;
export const REPO = { owner: 'octo', repo: 'widget', pr: 7 } as const;

export const mkReply = (
  actionId: string,
  threadRootRestId: number,
  body = `fixed in head — see root ${threadRootRestId}`,
): ReviewAction => ({
  kind: 'review_reply',
  actionId,
  threadRootRestId,
  body,
});
export const mkIssue = (
  actionId: string,
  body = 'summary: all threads addressed',
): ReviewAction => ({
  kind: 'issue_comment',
  actionId,
  body,
});
export const mkResolve = (actionId: string, threadId: string): ReviewAction => ({
  kind: 'resolve_thread',
  actionId,
  threadId,
});

/** Value of the `<name>=…` argv entry gh `-f/-F` args carry. */
export const flagValue = (args: string[], name: string): string => {
  const entry = args.find((a) => a.startsWith(`${name}=`));
  return entry === undefined ? '' : entry.slice(name.length + 1);
};

/** One recorded gh invocation: a short routing label plus the full argv. */
export interface GhCall {
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
export const recordingGh = (
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
        stdout: JSON.stringify({
          data: {
            resolveReviewThread: { thread: { id: flagValue(args, 'threadId'), isResolved: true } },
          },
        }),
        stderr: '',
      };
    }
    return { code: 0, stdout: JSON.stringify({ id: nextCommentId++ }), stderr: '' };
  };
};

/** An in-memory DispatchLog; optionally mirrors records into the event stream. */
export const memLog = (
  initial: DispatchRecord[] = [],
  events?: string[],
): DispatchLog & { records: DispatchRecord[] } => {
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
export const baseOpts = (
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
export const pushRun =
  (calls: string[][], code = 0): GhFn =>
  async (args: string[]) => {
    calls.push(args);
    return { code, stdout: '', stderr: code === 0 ? '' : 'fatal: unable to access' };
  };
