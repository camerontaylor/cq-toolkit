// replyAndResolve — E3 slice 1 (goal E3; UC §2 row 36 + the row-34
// idempotency constraint): post the responder's replies and resolve review
// threads over the gh seam, CRASH-SAFELY.
//
// The dispatch contract (each clause is load-bearing and pinned in
// test/ops/review/replyAndResolve.test.ts):
//   a. PUSH-BEFORE-POST ORDERING (with dispatch replay — not atomicity):
//      when opts.push is configured it runs FIRST and must exit 0 before
//      ANY post is attempted — replies reference the pushed head, so a
//      failed push must post nothing at all (a reply about a fix nobody
//      can see is worse than no reply). A failed push returns pushed:false
//      with an empty posted/failed and skips nothing — every action
//      remains retriable on the next run — and carries `pushError` (code +
//      stderr, ≤500 chars) so the caller can say WHY without a second run.
//      NO ROLLBACK: a landed push is not undone on later failures — the
//      guarantee is ordering + replay, never a two-phase commit.
//   b. DEDUPE: the dispatch log is the cross-run memory. An action whose
//      actionId is already recorded is skipped entirely (no duplicate post)
//      and counted in skippedAlreadyDispatched. actionId is the dedupe key —
//      callers must derive it from stable coordinates (thread root id, PR
//      number), never from run-local state. Each action's load-check-post-
//      record runs under the file-backed log's withLogLock when available,
//      so two JOBS processing the same PR cannot both post the same reply
//      (cross-process dedupe); in-memory logs run unlocked (in-process
//      callers are single-threaded), one action per critical section.
//   c. REPLY-BEFORE-RESOLVE (I11 ordering): within one run ALL review_reply
//      and issue_comment posts execute before ANY resolve_thread mutation.
//      Resolving a thread hides it — a crash after an early resolve would
//      strand its not-yet-posted siblings into looking "done" on re-read.
//   d. CRASH WINDOWS: a record is written immediately after its own
//      mutation succeeds, BEFORE the next action starts — the crash window
//      is always between a post and its record (re-run = duplicate risk for
//      that ONE action), never the reverse (a record for a post that never
//      happened would permanently swallow it).
//   e. PER-ACTION FAILURE ISOLATION: one nonzero gh response does not stop
//      the run; the failure lands in `failed` with the GhError-shaped
//      message and is NOT recorded — failed actions retry on the next run.
//      THE IDEMPOTENT EXCEPTION: a resolve whose GraphQL errors say the
//      thread is "already resolved" is a SUCCESS-EQUIVALENT replay (the
//      previous run's mutation landed but its record did not — the crash
//      window) — it is recorded and counted in skippedAlreadyResolved, so
//      the re-run converges instead of failing forever.
//   f. Every success is recorded via dispatchLog.record before the next
//      action starts (no interleaving, no batching of records) — and for a
//      resolve, success means the mutation RESPONSE confirmed
//      isResolved=true, not merely exit 0.
//
// The transport mirrors E1/E2 shapes: REST posts ride `gh api -X POST` with
// argv-only flags (`-F in_reply_to=<id>` — typed coercion like `-F pr=`;
// `-f body=<text>` — a raw string; gh handles escaping, no shell), and the
// resolve mutation rides `gh api graphql -f query=<document>`. THE COLLISION
// RULE (I11 trap) applies to the mutation document: it rides the `-f query=`
// slot, so it must never declare a GraphQL variable named `query` — the
// variable here is `threadId`.
//
// Structure purity: no Date.now (nowMs is injected), no direct I/O —
// everything goes through opts.run, opts.push.run, and the DispatchLog.
// Owner/repo spellings are validated by gh.ts's shared ghNameOk (GH_NAME_OK
// charset + the dot-segment rule); this module keeps only its own
// module-prefixed fail-loud error message.
import { appendFile, open, readFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { lock } from 'proper-lockfile';
import { GH_NAME_OK, GhError, ghNameOk } from './gh.js';
import type { GhFn, GhResult } from './gh.js';

/** Reply to a review thread by posting to its ROOT comment's REST id. */
export interface ReviewReplyAction {
  kind: 'review_reply';
  /** Caller-assigned stable id — the dedupe key across runs. */
  actionId: string;
  /** The thread's ROOT comment's REST numeric id (ReviewThread.rootDatabaseId). */
  threadRootRestId: number;
  /** Markdown body of the reply. */
  body: string;
}

/** Post a top-level PR conversation comment (the issues collection). */
export interface IssueCommentAction {
  kind: 'issue_comment';
  /** Caller-assigned stable id — the dedupe key across runs. */
  actionId: string;
  /** Markdown body of the comment. */
  body: string;
}

/** Resolve a review thread via the GraphQL resolveReviewThread mutation. */
export interface ResolveThreadAction {
  kind: 'resolve_thread';
  /** Caller-assigned stable id — the dedupe key across runs. */
  actionId: string;
  /** The GraphQL reviewThread node id. */
  threadId: string;
}

/** One dispatchable responder action. */
export type ReviewAction = ReviewReplyAction | IssueCommentAction | ResolveThreadAction;

/** One recorded successful dispatch — the dedupe memory's unit. */
export interface DispatchRecord {
  /** The action's stable id (the dedupe key). */
  actionId: string;
  /** Which action kind produced the record. */
  kind: ReviewAction['kind'];
  /** The created comment's REST id, or the resolved thread id. */
  resultRef: string;
  /** When the dispatch happened: the run's injected nowMs. */
  at: number;
}

/**
 * The crash-safe dispatch memory. `load` returns every prior record (an
 * absent log = empty history); `record` persists one entry before the
 * caller proceeds. Injectable: tests use an in-memory log, the CLI uses
 * fileDispatchLog.
 */
export interface DispatchLog {
  load(): Promise<DispatchRecord[]>;
  record(entry: DispatchRecord): Promise<void>;
  /**
   * OPTIONAL cross-process serialization for ONE action's load →
   * check → post → record sequence. The file-backed log provides it (a
   * `<logPath>.lock` lockfile, proper-lockfile, bounded retries — failure
   * to acquire within the bound throws loud naming the path); the
   * in-memory log does not: in-process callers are single-threaded, and
   * cross-process dedupe needs the file-backed log. Callers must hold the
   * lock around exactly ONE action's sequence, never the whole batch (a
   * whole-batch critical section is an avoidably long lock).
   */
  withLogLock?: <T>(fn: () => Promise<T>) => Promise<T>;
}

/**
 * The file-backed DispatchLog: one JSON record per line (JSON-lines-ish).
 * `load` reads the whole file — a missing file is an EMPTY log (first run).
 * It parses line-by-line and is CRASH-TOLERANT AT THE TAIL: `record` is a
 * single-line `appendFile`, so a crash mid-append can only truncate the
 * FINAL line — a truncated tail line is tolerated (dropped; the action was
 * never truly recorded, so the next run retries it safely), while a broken
 * line MID-FILE (more records follow it) still throws a clear message:
 * dispatching on top of an unreadable log would silently duplicate prior
 * posts, so mid-file corruption stays loud, never tolerant. `record`
 * appends exactly one newline-terminated line — no read-modify-write, so
 * interleaved loads/records can never lose a record and a crash can never
 * damage PRIOR lines — and it repairs the tail before appending: junk is
 * truncated, while an unterminated tail that already parses as a complete
 * record is KEPT (load() counts it dispatched) and only its newline
 * boundary is added — the retry never discards a landed dispatch nor
 * concatenates onto junk.
 */
export function fileDispatchLog(path: string): DispatchLog {
  const load = async (): Promise<DispatchRecord[]> => {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw err;
    }
    const records: DispatchRecord[] = [];
    const lines = text.split('\n');
    // Trailing newline(s) are termination, not content.
    let lastContent = lines.length - 1;
    while (lastContent >= 0 && (lines[lastContent] ?? '').trim() === '') {
      lastContent -= 1;
    }
    for (let i = 0; i <= lastContent; i++) {
      const line = (lines[i] ?? '').trim();
      if (line === '') continue;
      try {
        records.push(JSON.parse(line) as DispatchRecord);
      } catch {
        if (i === lastContent) {
          // Truncated FINAL line — a crash mid-append. Drop it: the record
          // never landed, so the action stays retriable on the next run.
          break;
        }
        throw new Error(
          `fileDispatchLog: dispatch log at ${JSON.stringify(path)} is corrupt (line ${i + 1} does not parse as JSON, and later lines follow it) — refusing to dispatch on top of an unreadable log; fix or remove the file and re-run`,
        );
      }
    }
    return records;
  };
  const record = async (entry: DispatchRecord): Promise<void> => {
    // A discarded partial tail is truncated before the retry appends, so a
    // crash mid-append can never poison the next record — BUT not every
    // unterminated tail is garbage: a crash AFTER the record's closing '}'
    // but BEFORE its '\n' left a VALID record that load() already parses
    // and counts dispatched. The repair therefore mirrors load() exactly:
    // an unterminated tail that parses as JSON is KEPT (only its '\n'
    // boundary is added — truncating it would discard a landed dispatch
    // and cause a repost), while a tail that does not parse is truncated.
    // Either way the new record lands on a clean newline boundary.
    let handle: FileHandle | null = null;
    let boundaryNeeded = false;
    try {
      handle = await open(path, 'r+');
      const bytes = await handle.readFile();
      const keep = bytes.lastIndexOf(0x0a) + 1; // through the last COMPLETE line
      if (keep < bytes.length) {
        const tail = bytes.subarray(keep).toString('utf8');
        try {
          JSON.parse(tail);
          // The tail IS a complete record — keep it byte-for-byte; only
          // the newline boundary is missing.
          boundaryNeeded = true;
        } catch {
          await handle.truncate(keep); // junk tail: cut it
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
      // Missing file (the very first record): nothing to repair —
      // appendFile creates it below.
    } finally {
      await handle?.close();
    }
    if (boundaryNeeded) {
      await appendFile(path, '\n', 'utf8');
    }
    await appendFile(path, `${JSON.stringify(entry)}\n`, 'utf8');
  };
  /**
   * The cross-process dedupe lock: serializes ONE action's load → check →
   * post → record so two jobs processing the same PR cannot both see the
   * actionId unseen and both POST (a duplicate user-visible reply). Same
   * proper-lockfile pattern as the worktree registry: `<path>.lock`,
   * bounded retries, loud throw naming the path on failure. The log file
   * is materialized (empty) before locking — proper-lockfile lstats the
   * target, and an empty file is a valid empty log.
   */
  const withLogLock = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      await appendFile(path, '', 'utf8');
    } catch {
      // Materialization is best-effort: a failure here (e.g. missing
      // directory) surfaces from the lock attempt below with the path.
    }
    let release: (() => Promise<void>) | undefined;
    try {
      release = await lock(path, {
        stale: 10_000,
        retries: { retries: 5, minTimeout: 25, maxTimeout: 200 },
      });
    } catch (err) {
      throw new Error(
        `fileDispatchLog: could not acquire the dispatch log lock ${JSON.stringify(`${path}.lock`)} within the retry bound — refusing an unserialized check-post-record; clear the stale lock and re-run`,
        { cause: err },
      );
    }
    if (release === undefined) {
      throw new Error(
        `fileDispatchLog: could not acquire the dispatch log lock ${JSON.stringify(`${path}.lock`)} within the retry bound — refusing an unserialized check-post-record; clear the stale lock and re-run`,
      );
    }
    try {
      return await fn();
    } finally {
      await release();
    }
  };
  return { load, record, withLogLock };
}

/** What to dispatch against, and everything the dispatch needs injected. */
export interface ReplyAndResolveOpts {
  /** Repository owner (org or user login). */
  owner: string;
  /** Repository name. */
  repo: string;
  /** Pull request number. */
  pr: number;
  /** The gh seam every post/mutation rides. */
  run: GhFn;
  /**
   * The branch push that must succeed BEFORE anything posts (push-before-
   * post ORDERING — there is NO rollback: a landed push is not undone on
   * later failures): `run` is a GhFn (often the same runner), `args` the
   * full composed argv (e.g. ['push','origin','refs/heads/branch']) — this
   * module only runs them and checks the exit code. Null/absent = no push
   * needed; posting starts immediately.
   */
  push?: { run: GhFn; args: string[] } | null;
  /** The dispatch memory (dedupe across runs). */
  dispatchLog: DispatchLog;
  /** The injected clock for DispatchRecord.at — never Date.now. */
  nowMs: number;
}

/** The dispatch outcome. `posted` non-empty always implies `pushed` true. */
export interface ReplyAndResolveResult {
  /** Whether the configured push succeeded — or none was configured. */
  pushed: boolean;
  /**
   * Why the push failed, when it did: the exit code plus the captured
   * stderr, capped at 500 characters (a push can spew pages of output; the
   * result must stay log-line sized). Absent when pushed is true. A failed
   * push posts nothing, so this is the ONLY diagnostic the caller gets.
   */
  pushError?: string;
  /** Records of every successful post/mutation, in execution order. */
  posted: DispatchRecord[];
  /** Per-action failures — NOT recorded; they retry on the next run. */
  failed: Array<{ action: ReviewAction; error: string }>;
  /**
   * Resolve actions withheld this run because a review_reply in the same
   * batch failed — resolving would hide the unanswered thread. Withheld
   * resolves land in `failed` (unrecorded, retried once the reply lands).
   */
  withheld: number;
  /** Actions skipped because their actionId was already dispatched. */
  skippedAlreadyDispatched: number;
  /**
   * Resolves whose mutation had ALREADY landed in a previous run (GitHub
   * answers a resolve of an already-resolved thread with an "already
   * resolved" GraphQL error): SUCCESS-EQUIVALENT replays — recorded with
   * the thread id as resultRef and counted here, never in `failed`. The
   * run converges instead of retrying a finished mutation forever.
   */
  skippedAlreadyResolved: number;
}

/** Cap for the composed pushError detail — a push can spew pages of output;
 * the result must stay log-line sized. */
const PUSH_ERROR_MAX = 500;

/** Compose the pushError detail from the exit code and stderr, capped at
 * PUSH_ERROR_MAX characters (head kept — the first lines of a git push
 * failure carry the `! [rejected]` / `fatal:` payload). */
const pushFailureDetail = (code: number, stderr: string): string => {
  const trimmed = stderr.trim();
  const detail = `push failed (exit ${code})${trimmed === '' ? '' : `: ${trimmed}`}`;
  return detail.length <= PUSH_ERROR_MAX ? detail : detail.slice(0, PUSH_ERROR_MAX);
};

/**
 * The resolve mutation. COLLISION RULE: the document rides gh's
 * `-f query=` slot, so no GraphQL variable here may be named `query` —
 * the variable is `threadId` (an ID, sent raw via `-f`).
 */
const RESOLVE_MUTATION = `mutation ($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } }
}`;

/** Minimal shape of the `gh api graphql` payload this function reads. */
interface GraphqlPayload {
  /** Server-side GraphQL errors — non-empty means the mutation did not land. */
  errors?: Array<{ message?: string }>;
  /** The mutation's effect — the ONLY proof a resolve landed. */
  data?: {
    resolveReviewThread?: {
      thread?: {
        id?: unknown;
        isResolved?: unknown;
      } | null;
    } | null;
  } | null;
}

/**
 * Mine the created comment's REST id out of a successful POST response.
 * Best-effort by design: the dedupe key is the actionId, so an unparseable
 * body must never block RECORDING (failing to record would turn the next
 * run into a duplicate post — the one crash window the row-34 constraint
 * forbids widening). Anything unreadable yields 'unknown'.
 */
const minedCommentRef = (stdout: string): string => {
  try {
    const raw = JSON.parse(stdout) as { id?: unknown };
    return typeof raw?.id === 'number' && Number.isSafeInteger(raw.id) ? String(raw.id) : 'unknown';
  } catch {
    return 'unknown';
  }
};

/**
 * Dispatch replies, issue comments, and thread resolutions over the gh seam
 * — push-before-post, log-deduped, reply-before-resolve, recorded as each
 * action lands (the full contract is the module doc; every clause is pinned
 * by a test). Sequential by design: order (c) and record-before-next (f)
 * are the idempotency guarantees, and action volume is review-scale.
 * Validation happens BEFORE the push, so a malformed action list can never
 * leave a pushed-but-unpostable state. A caller passing the same actionId
 * twice in one list gets the same skip treatment as a cross-run duplicate
 * (counted, not dispatched) — the dedupe set is the log PLUS this run's own
 * successes.
 */
export async function replyAndResolve(
  actions: readonly ReviewAction[],
  opts: ReplyAndResolveOpts,
): Promise<ReplyAndResolveResult> {
  // Pre-flight validation (fail loud before ANY I/O — nothing pushed, nothing
  // posted, nothing recorded).
  if (!ghNameOk(opts.owner) || !ghNameOk(opts.repo)) {
    throw new Error(
      `replyAndResolve: owner/repo must match ${String(GH_NAME_OK)} (never "." or "..") — got owner ${JSON.stringify(opts.owner)}, repo ${JSON.stringify(opts.repo)}`,
    );
  }
  if (!Number.isSafeInteger(opts.pr) || opts.pr <= 0) {
    throw new Error(
      `replyAndResolve: pr must be a positive safe integer — got ${JSON.stringify(opts.pr)}`,
    );
  }
  for (const action of actions) {
    if (action.actionId === '') {
      throw new Error(
        `replyAndResolve: action.actionId must be a non-empty string (the dedupe key across runs) — got ${JSON.stringify(action.actionId)}`,
      );
    }
    if (
      action.kind === 'review_reply' &&
      (!Number.isSafeInteger(action.threadRootRestId) || action.threadRootRestId <= 0)
    ) {
      throw new Error(
        `replyAndResolve: action ${JSON.stringify(action.actionId)} has threadRootRestId ${JSON.stringify(action.threadRootRestId)} — must be a positive safe integer`,
      );
    }
    if (action.kind === 'resolve_thread' && action.threadId.trim() === '') {
      throw new Error(
        `replyAndResolve: action ${JSON.stringify(action.actionId)} has an empty or whitespace-only threadId — must be the GraphQL reviewThread node id`,
      );
    }
    if (
      (action.kind === 'review_reply' || action.kind === 'issue_comment') &&
      action.body.trim() === ''
    ) {
      throw new Error(
        `replyAndResolve: action ${JSON.stringify(action.actionId)} has an empty/whitespace body — a contentless post would surface as a phantom "addressed" reply`,
      );
    }
  }

  // (a) PUSH-BEFORE-POST ORDERING: the push runs FIRST and gates EVERYTHING.
  // Nonzero exit — or a seam-level rejection (the GhFn contract resolves,
  // but a non-conforming injected runner may throw; either counts as a
  // failed push) — posts nothing and attempts nothing: posted/failed stay
  // empty and nothing is skipped, so every action remains retriable. There
  // is NO rollback: once the push lands it stays landed, whatever fails
  // later. pushError surfaces WHY (code + stderr / the throw message,
  // ≤500 chars) — a failed push posts nothing, so this detail is the
  // caller's only diagnostic.
  if (opts.push != null) {
    try {
      const pushResult = await opts.push.run(opts.push.args);
      if (pushResult.code !== 0) {
        return {
          pushed: false,
          pushError: pushFailureDetail(pushResult.code, pushResult.stderr),
          posted: [],
          failed: [],
          skippedAlreadyDispatched: 0,
          skippedAlreadyResolved: 0,
          withheld: 0,
        };
      }
    } catch (err) {
      return {
        pushed: false,
        pushError: pushFailureDetail(1, String(err)),
        posted: [],
        failed: [],
        skippedAlreadyDispatched: 0,
        skippedAlreadyResolved: 0,
        withheld: 0,
      };
    }
  }

  // (b) DEDUPE: the log (prior runs) is loaded once; this run's own successes
  // join the seen-set as they record, so a duplicated actionId inside one
  // action list skips exactly like a cross-run duplicate.
  const seen = new Set((await opts.dispatchLog.load()).map((r) => r.actionId));
  const posted: DispatchRecord[] = [];
  const failed: Array<{ action: ReviewAction; error: string }> = [];
  let skippedAlreadyDispatched = 0;
  let skippedAlreadyResolved = 0;
  let withheld = 0;

  // (c) REPLY-BEFORE-RESOLVE: the input order is preserved within each
  // phase; every post precedes every resolve.
  const posts = actions.filter((action) => action.kind !== 'resolve_thread');
  const resolves = actions.filter(
    (action): action is ResolveThreadAction => action.kind === 'resolve_thread',
  );

  /** Run one gh argv; a seam rejection (non-conforming runner) becomes a
   * GhResult-shaped failure — exit 1, the error as stderr — so the dispatch
   * loop stays total and the push-failure rule covers spawn-level failures. */
  const runGh = async (args: string[]): Promise<GhResult> => {
    try {
      return await opts.run(args);
    } catch (err) {
      return { code: 1, stdout: '', stderr: String(err) };
    }
  };

  // Per-action CROSS-PROCESS dedupe: when the log provides withLogLock
  // (the file-backed one does), each action's load-check-post-record runs
  // under the log lock — two jobs processing the same PR can no longer
  // both see the actionId unseen and both POST. Under the lock the seen-
  // set is RE-READ from the log (the startup snapshot predates the other
  // job's just-written record). The lock is held for exactly ONE action's
  // sequence, never the whole batch (an avoidably long critical section).
  // In-memory logs run unlocked: in-process callers are single-threaded;
  // cross-process safety needs the file-backed log.
  const runExclusive = <T>(body: () => Promise<T>): Promise<T> =>
    opts.dispatchLog.withLogLock === undefined ? body() : opts.dispatchLog.withLogLock(body);
  const refreshSeenUnderLock = async (): Promise<void> => {
    if (opts.dispatchLog.withLogLock === undefined) {
      return; // unlocked mode: the startup snapshot is the whole truth
    }
    for (const record of await opts.dispatchLog.load()) {
      seen.add(record.actionId);
    }
  };

  for (const action of posts) {
    await runExclusive(async () => {
      await refreshSeenUnderLock();
      if (seen.has(action.actionId)) {
        skippedAlreadyDispatched += 1;
        return;
      }
      const args =
        action.kind === 'review_reply'
          ? [
              'api',
              '-X',
              'POST',
              `repos/${opts.owner}/${opts.repo}/pulls/${opts.pr}/comments`,
              // `-F` coerces (the REST id is an integer — same reasoning as
              // `-F pr=` in fetchReviewState); `body` stays a raw `-f` string.
              '-F',
              `in_reply_to=${action.threadRootRestId}`,
              '-f',
              `body=${action.body}`,
            ]
          : [
              'api',
              '-X',
              'POST',
              `repos/${opts.owner}/${opts.repo}/issues/${opts.pr}/comments`,
              '-f',
              `body=${action.body}`,
            ];
      const result = await runGh(args);
      if (result.code !== 0) {
        // (e) isolated failure: message is GhError-shaped (exit code + argv +
        // stderr); NOT recorded — the next run retries it.
        failed.push({
          action,
          error: new GhError(result.code, result.stderr, args, 'failed').message,
        });
        return;
      }
      const record: DispatchRecord = {
        actionId: action.actionId,
        kind: action.kind,
        resultRef: minedCommentRef(result.stdout),
        at: opts.nowMs,
      };
      // (f) record BEFORE the next action starts — (d)'s crash-window rule.
      await opts.dispatchLog.record(record);
      seen.add(action.actionId);
      posted.push(record);
    });
  }

  // WITHHOLDING: a resolve whose sibling reply failed is withheld —
  // resolving would hide the unanswered conversation, and the retry would
  // then post the reply onto an already-resolved thread. Withheld resolves
  // are unrecorded failures: they retry once the reply lands.
  const replyFailed = failed.some((f) => f.action.kind === 'review_reply');
  for (const action of resolves) {
    // An already-dispatched resolve is DONE regardless of any failed reply
    // — the dedupe check must run first, or a converged action counts as
    // withheld forever.
    if (seen.has(action.actionId)) {
      skippedAlreadyDispatched += 1;
      continue;
    }
    if (replyFailed) {
      failed.push({
        action,
        error:
          'withheld: a review_reply in this batch failed — resolving would hide the unanswered thread',
      });
      withheld += 1;
      continue;
    }
    await runExclusive(async () => {
      await refreshSeenUnderLock();
      if (seen.has(action.actionId)) {
        skippedAlreadyDispatched += 1;
        return;
      }
      const args = [
        'api',
        'graphql',
        '-f',
        `query=${RESOLVE_MUTATION}`,
        '-f',
        `threadId=${action.threadId}`,
      ];
      const result = await runGh(args);
      if (result.code !== 0) {
        failed.push({
          action,
          error: new GhError(result.code, result.stderr, args, 'failed').message,
        });
        return;
      }
      // A 200 can still carry the mutation's failure: a non-empty GraphQL
      // errors array means the thread is NOT resolved — a safe retry.
      let payload: GraphqlPayload;
      try {
        payload = JSON.parse(result.stdout) as GraphqlPayload;
      } catch {
        failed.push({
          action,
          error: `gh api graphql printed non-JSON output (exit ${result.code}) — mutation outcome unknown, left unrecorded for retry`,
        });
        return;
      }
      if (payload.errors !== null && payload.errors !== undefined && payload.errors.length > 0) {
        const messages = payload.errors.map((error) => error.message ?? JSON.stringify(error));
        // SUCCESS-EQUIVALENT replay: GitHub rejects a resolve of an
        // already-resolved thread with this error — meaning a prior run's
        // mutation LANDED but its record did not (the one crash window).
        // Retrying would fail forever; the run must CONVERGE: record it
        // (resultRef = threadId, exactly the landed success) and count it
        // as an idempotent skip, NOT a failure. The reading is STRICT:
        // already-resolved must be the SOLE error — EVERY message must
        // match. A mixed payload (already-resolved next to a real failure
        // like Bad credentials) does not prove the mutation landed, so it
        // stays a plain failure: only a demonstrably-landed mutation may be
        // recorded as converged.
        if (messages.every((message) => /already resolved/i.test(message))) {
          const record: DispatchRecord = {
            actionId: action.actionId,
            kind: action.kind,
            resultRef: action.threadId,
            at: opts.nowMs,
          };
          await opts.dispatchLog.record(record);
          seen.add(action.actionId);
          posted.push(record);
          skippedAlreadyResolved += 1;
          return;
        }
        failed.push({
          action,
          error: `gh api graphql returned GraphQL errors: ${messages.join('; ')}`,
        });
        return;
      }
      // Exit 0 + no errors is still not PROOF: the mutation's EFFECT must be
      // visible in the response — resolveReviewThread.thread.isResolved ===
      // true. Anything else (an empty object, data null, isResolved false)
      // means the resolve mutation did not land: fail loud, leave unrecorded
      // — the next run retries it.
      if (payload.data?.resolveReviewThread?.thread?.isResolved !== true) {
        failed.push({
          action,
          error: `gh api graphql response did not confirm the resolve (resolveReviewThread.thread.isResolved !== true) — resolve mutation did not land, left unrecorded for retry`,
        });
        return;
      }
      const record: DispatchRecord = {
        actionId: action.actionId,
        kind: action.kind,
        resultRef: action.threadId,
        at: opts.nowMs,
      };
      await opts.dispatchLog.record(record);
      seen.add(action.actionId);
      posted.push(record);
    });
  }

  return {
    pushed: true,
    posted,
    failed,
    skippedAlreadyDispatched,
    skippedAlreadyResolved,
    withheld,
  };
}
