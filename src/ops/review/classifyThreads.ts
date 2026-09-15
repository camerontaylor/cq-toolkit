// classifyThreads — E2 slice 1 (goal E2, ws-e items 2–3; UC §2 rows 34–35;
// invariant I6): the PURE decision table over a FetchedReviewState. Every
// thread, review summary, and top-level conversation comment gets exactly
// one verdict from the FROZEN five-word vocabulary
// `actionable | responded | resolved | blocked | skip` (ThreadVerdict — the
// workstream contract; changing it is a recorded deviation, not a refactor).
//
// THE DECISION TABLE — rows fire first-match-wins, top to bottom, within
// each kind; the trailing row of each table is the total fallback. Each row
// is a small named pure function below, and the tables are the arrays
// THREAD_ROWS / REVIEW_ROWS / COMMENT_ROWS (14 rows total).
//
//   THREADS (state.threads — replies already attached by fetchReviewState):
//     1. resolved                                        → resolved   (thread_resolved)
//     2. root authored by the responder (config)         → skip       (responder_authored)
//     3. root body matches a config.skipPatterns entry   → skip       (bot_skip_notice)
//     4. isOutdated && config.blockOnOutdatedThreads     → blocked    (outdated_unresolved)
//     5. replies non-empty AND the LAST reply (by
//        timestamp order as given; null timestamps =
//        nowMs per config) is authored by the responder  → responded  (responder_last_word)
//     6. else                                            → actionable (thread_needs_response)
//
//   REVIEWS (state.reviews — summary comments):
//     7. authored by the responder (config)              → skip       (responder_authored)
//     8. body matches a config.skipPatterns entry        → skip       (bot_skip_notice)
//     9. state === 'DISMISSED' && skipDismissedReviews   → skip       (review_dismissed)
//    10. a responder comment with a REAL parsed createdAt
//        strictly greater than submittedAt (or its nowMs
//        fallback) exists in restReviewComments OR
//        restIssueComments — the natural answer to a
//        review summary is often a top-level comment     → skip       (review_already_answered)
//    11. else                                            → actionable (review_summary_needs_response)
//
//   TOP-LEVEL conversation comments (state.restIssueComments):
//    12. authored by the responder (config)              → skip       (responder_authored)
//    13. body matches a config.skipPatterns entry        → skip       (bot_skip_notice)
//    14. else                                            → actionable (top_level_summary)
//        (top-level PR conversation comments ARE actionable
//        review summaries — the workstream contract)
//
// Row order is load-bearing. Threads: resolution answers a thread outright
// (1 beats 4); a responder-authored thread is not outstanding feedback no
// matter how stale or bot-flavored its body (2 beats 3 and 4); only then
// does staleness (4) or the conversation's last word (5) decide. Reviews:
// responder-authorship (7) PRECEDES the bot-notice (8) and dismissed (9)
// rows — the responder's own review is never outstanding feedback no matter
// what it carries, and when it is ALSO dismissed, `responder_authored` wins
// on authorship alone (documented call: authorship settles it first); a bot
// notice precedes dismissal (8 beats 9); a dismissed verdict precedes the
// answered check (9 beats 10) — a voided review stays void regardless of
// reply timing. Comments mirror the threads head: authorship (12) beats the
// bot notice (13).
//
// "Responder" is `state.authorLogin` — the PR author in the merge-prs
// context (ClassifyConfig.responderIs): the party answering review feedback
// on their own PR. A null authorLogin (deleted/anonymized account) is NEVER
// the responder — external, fail toward `actionable`.
//
// FAIL-CLOSED TRUNCATION PROPAGATION: the result carries the fetched
// state's truncated/truncatedBecause flag VERBATIM (Classification), and
// consumers MUST consult it before dispatching batches — a cap hit or a
// `reviewThreads.lag` fetch means fresh threads are MISSING from the
// verdict set, so an unconsulted dispatcher would plan against incomplete
// evidence. planReviewBatch (E2 slice 2) intentionally does NOT consult it:
// it takes plain items, so the flag check belongs to the dispatching layer.
//
// Purity: no I/O, no Date.now() anywhere — `nowMs` is the ONLY clock and is
// an injected parameter (the auditor's acceptance check). ISO timestamps
// convert with a local Date.parse helper; null or unparseable values fall
// back per config.treatNullCreatedAtAs where timestamps order things
// ('nowMs' → brand-new; 'epochMs' → ancient), EXCEPT that an answering
// reply needs a REAL parsed timestamp (parseRealMs below — it never falls
// back, so it fails toward actionable). All heuristics and thresholds live
// in classify.config.ts AS DATA — this module only reads them.
import { defaultClassifyConfig } from './classify.config.js';
import type { ClassifyConfig } from './classify.config.js';
import type { FetchedReviewState } from './fetchReviewState.js';
import type { RestComment, ReviewSummary, ReviewThread, ThreadComment } from './threads.js';

/**
 * The frozen verdict vocabulary (workstream contract; invariant I6):
 *   - `actionable` — outstanding feedback someone must address;
 *   - `responded` — the responder has the last word; wait for the reviewer;
 *   - `resolved` — finished; nothing to do;
 *   - `blocked` — a human must settle it (e.g. outdated unresolved);
 *   - `skip` — not feedback at all (bot notices, dismissed verdicts,
 *     the responder's own words).
 */
export type ThreadVerdict = 'actionable' | 'responded' | 'resolved' | 'blocked' | 'skip';

/** One classified item: exactly one verdict plus the row's stable reason. */
export interface ClassifiedItem {
  /** Which collection the item came from. */
  kind: 'thread' | 'review' | 'comment';
  /** The source id (thread/review node id; REST numeric id as a string). */
  id: string;
  /** The verdict from the frozen vocabulary. */
  verdict: ThreadVerdict;
  /** The anchored file path (threads only; null for reviews/comments). */
  path: string | null;
  /** Short stable snake_case code naming the deciding row. */
  reason: string;
}

/**
 * The classify result: per-item verdicts PLUS the fetched state's
 * fail-closed truncation flag, copied verbatim (TruncationFlag contract:
 * never silently dropped). Consumers MUST consult `truncated`/
 * `truncatedBecause` before dispatching batches — a cap hit or a
 * `reviewThreads.lag` fetch means fresh threads are MISSING from the
 * verdict set, so an unconsulted dispatcher would plan against incomplete
 * evidence; fail closed downstream, exactly like the fetch layer.
 */
export interface Classification {
  /** One item per thread, review, and top-level comment (in that order). */
  items: ClassifiedItem[];
  /** Verbatim from state.truncated. */
  truncated: boolean;
  /** Verbatim from state.truncatedBecause. */
  truncatedBecause: string[];
}

/** Everything a row needs besides the item itself. Plain data, no clocks. */
interface RowContext {
  /** state.authorLogin — the responder (see module doc); null matches nobody. */
  responder: string | null;
  /** The injected clock, in epoch ms — the only time source in this module. */
  nowMs: number;
  /** The R3-tunable heuristics (classify.config.ts). */
  config: ClassifyConfig;
  /** Flat REST review comments — row 10's answer scan (collection 1). */
  restReviewComments: readonly RestComment[];
  /** Flat REST issue comments — row 10's answer scan (collection 2). */
  restIssueComments: readonly RestComment[];
}

/**
 * ISO 8601 → epoch ms for ORDERING uses (a thread's last-word comparison;
 * a review's submittedAt side). Null or unparseable input falls back per
 * config.treatNullCreatedAtAs: 'nowMs' → nowMs (brand-new), 'epochMs' → 0
 * (ancient). NOT used for the answering-reply check — see parseRealMs.
 */
const toMs = (iso: string | null, nowMs: number, config: ClassifyConfig): number => {
  if (iso !== null) {
    const parsed = Date.parse(iso);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return config.treatNullCreatedAtAs === 'nowMs' ? nowMs : 0;
};

/**
 * Strict ISO 8601 → epoch ms, or null when absent/unparseable — NO config
 * fallback. A reply counts as ANSWERING a review (row 10) only on a REAL
 * parsed timestamp: a null/unparseable reply never answers (under 'nowMs'
 * it is not counted at all; under 'epochMs' the ordering fallback would be
 * 0, which never postdates a past review) — either way row 10 fails toward
 * actionable.
 */
const parseRealMs = (iso: string | null): number | null => {
  if (iso === null) {
    return null;
  }
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? null : parsed;
};

/** True when the author is the responder. Null authors are NEVER the responder. */
const isResponder = (authorLogin: string | null, responder: string | null): boolean =>
  authorLogin !== null && authorLogin === responder;

/** True when the body matches any configured bot skip/failure pattern (I2). */
const matchesSkipPattern = (body: string, config: ClassifyConfig): boolean =>
  config.skipPatterns.some((pattern) => pattern.test(body));

/** The thread's LAST reply by timestamp order as given (attachRestReplies
 * already sorts createdAt-ascending, nulls last); equal ms keep the LATER
 * array entry, so "as given" order breaks ties toward the newest word.
 * Null timestamps convert per config, so under the default 'nowMs' a
 * timestamp-less reply counts as the newest. Empty replies → null. */
const lastReplyByMs = (
  thread: ReviewThread,
  nowMs: number,
  config: ClassifyConfig,
): ThreadComment | null => {
  let last: ThreadComment | null = null;
  let lastMs = Number.NEGATIVE_INFINITY;
  for (const reply of thread.replies) {
    const ms = toMs(reply.createdAt, nowMs, config);
    if (ms >= lastMs) {
      last = reply;
      lastMs = ms;
    }
  }
  return last;
};

// ---------------------------------------------------------------------------
// Item constructors
// ---------------------------------------------------------------------------

const threadItem = (thread: ReviewThread, verdict: ThreadVerdict, reason: string): ClassifiedItem => ({
  kind: 'thread',
  id: thread.id,
  verdict,
  path: thread.path,
  reason,
});

const reviewItem = (review: ReviewSummary, verdict: ThreadVerdict, reason: string): ClassifiedItem => ({
  kind: 'review',
  id: review.id,
  verdict,
  path: null,
  reason,
});

const commentItem = (comment: RestComment, verdict: ThreadVerdict, reason: string): ClassifiedItem => ({
  kind: 'comment',
  id: String(comment.id),
  verdict,
  path: null,
  reason,
});

// ---------------------------------------------------------------------------
// THREAD rows (module doc rows 1–6)
// ---------------------------------------------------------------------------

type RowFn<T> = (item: T, ctx: RowContext) => ClassifiedItem | null;

/** A TOTAL row (a table's closing fallback): always yields a verdict. */
type TotalRowFn<T> = (item: T, ctx: RowContext) => ClassifiedItem;

/** Row 1 — resolved is finished work; beats everything below it. */
const threadResolvedRow: RowFn<ReviewThread> = (thread) =>
  thread.isResolved ? threadItem(thread, 'resolved', 'thread_resolved') : null;

/** Row 2 — the responder opened this thread on their own PR: not
 * outstanding feedback (the external-threads rule). */
const responderAuthoredThreadRow: RowFn<ReviewThread> = (thread, ctx) =>
  ctx.config.skipResponderAuthoredThreads && isResponder(thread.authorLogin, ctx.responder)
    ? threadItem(thread, 'skip', 'responder_authored')
    : null;

/** Row 3 — a bot skip/failure notice is not a review (I2). */
const botSkipThreadRow: RowFn<ReviewThread> = (thread, ctx) =>
  matchesSkipPattern(thread.body, ctx.config)
    ? threadItem(thread, 'skip', 'bot_skip_notice')
    : null;

/** Row 4 — an outdated unresolved thread cannot be fixed by a
 * head-of-branch commit: human/awaiting, so `blocked`. */
const outdatedThreadRow: RowFn<ReviewThread> = (thread, ctx) =>
  thread.isOutdated && ctx.config.blockOnOutdatedThreads
    ? threadItem(thread, 'blocked', 'outdated_unresolved')
    : null;

/** Row 5 — the responder has answered the reviewer's latest word; nothing
 * to do until the reviewer returns. */
const responderLastWordRow: RowFn<ReviewThread> = (thread, ctx) => {
  const last = lastReplyByMs(thread, ctx.nowMs, ctx.config);
  return last !== null && isResponder(last.authorLogin, ctx.responder)
    ? threadItem(thread, 'responded', 'responder_last_word')
    : null;
};

/** Row 6 — fallback: an unresolved external thread awaits a response. */
const threadNeedsResponseRow: TotalRowFn<ReviewThread> = (thread) =>
  threadItem(thread, 'actionable', 'thread_needs_response');

/** The THREAD table (rows 1–5; row 6 is the fallback passed to decide). */
const THREAD_ROWS: readonly RowFn<ReviewThread>[] = [
  threadResolvedRow,
  responderAuthoredThreadRow,
  botSkipThreadRow,
  outdatedThreadRow,
  responderLastWordRow,
];

// ---------------------------------------------------------------------------
// REVIEW rows (module doc rows 7–11)
// ---------------------------------------------------------------------------

/** Row 7 — the responder authored this review on their own PR: not
 * outstanding feedback, whatever else it carries (bot-flavored body,
 * DISMISSED verdict — authorship settles it first; see the module doc's
 * ordering rationale). */
const responderAuthoredReviewRow: RowFn<ReviewSummary> = (review, ctx) =>
  ctx.config.skipResponderAuthoredThreads && isResponder(review.authorLogin, ctx.responder)
    ? reviewItem(review, 'skip', 'responder_authored')
    : null;

/** Row 8 — a bot skip/failure notice is not a review (I2). */
const botSkipReviewRow: RowFn<ReviewSummary> = (review, ctx) =>
  matchesSkipPattern(review.body, ctx.config)
    ? reviewItem(review, 'skip', 'bot_skip_notice')
    : null;

/** Row 9 — a DISMISSED verdict was voided downstream; re-surfacing it
 * would plan batches for noise (config.skipDismissedReviews). */
const reviewDismissedRow: RowFn<ReviewSummary> = (review, ctx) =>
  ctx.config.skipDismissedReviews && review.state === 'DISMISSED'
    ? reviewItem(review, 'skip', 'review_dismissed')
    : null;

/** Row 10 — a responder reply postdating the review means its summary is
 * already answered (workstream contract: review-body summaries skip when a
 * responder reply postdates them). The answer may live in EITHER comment
 * collection — restReviewComments or restIssueComments (the natural answer
 * to a review summary is often a top-level comment). Strictly greater:
 * equal ms do not count. The reply needs a REAL parsed timestamp — a
 * null/unparseable reply never answers (fails toward actionable). */
const reviewAlreadyAnsweredRow: RowFn<ReviewSummary> = (review, ctx) => {
  const submittedMs = toMs(review.submittedAt, ctx.nowMs, ctx.config);
  const answered = [...ctx.restReviewComments, ...ctx.restIssueComments].some((comment) => {
    if (!isResponder(comment.authorLogin, ctx.responder)) {
      return false;
    }
    const answeredMs = parseRealMs(comment.createdAt);
    return answeredMs !== null && answeredMs > submittedMs;
  });
  return answered ? reviewItem(review, 'skip', 'review_already_answered') : null;
};

/** Row 11 — fallback: a review summary awaits a response. */
const reviewNeedsResponseRow: TotalRowFn<ReviewSummary> = (review) =>
  reviewItem(review, 'actionable', 'review_summary_needs_response');

/** The REVIEW table (rows 7–10; row 11 is the fallback passed to decide). */
const REVIEW_ROWS: readonly RowFn<ReviewSummary>[] = [
  responderAuthoredReviewRow,
  botSkipReviewRow,
  reviewDismissedRow,
  reviewAlreadyAnsweredRow,
];

// ---------------------------------------------------------------------------
// TOP-LEVEL COMMENT rows (module doc rows 12–14)
// ---------------------------------------------------------------------------

/** Row 12 — the responder's own conversation comment: not feedback. */
const responderAuthoredCommentRow: RowFn<RestComment> = (comment, ctx) =>
  ctx.config.skipResponderAuthoredThreads && isResponder(comment.authorLogin, ctx.responder)
    ? commentItem(comment, 'skip', 'responder_authored')
    : null;

/** Row 13 — a bot skip/failure notice is not a review (I2). */
const botSkipCommentRow: RowFn<RestComment> = (comment, ctx) =>
  matchesSkipPattern(comment.body, ctx.config)
    ? commentItem(comment, 'skip', 'bot_skip_notice')
    : null;

/** Row 14 — fallback: top-level PR conversation comments ARE actionable
 * review summaries (workstream contract). */
const topLevelSummaryRow: TotalRowFn<RestComment> = (comment) =>
  commentItem(comment, 'actionable', 'top_level_summary');

/** The COMMENT table (rows 12–13; row 14 is the fallback passed to decide). */
const COMMENT_ROWS: readonly RowFn<RestComment>[] = [
  responderAuthoredCommentRow,
  botSkipCommentRow,
];

// ---------------------------------------------------------------------------
// The table walker and the entry point
// ---------------------------------------------------------------------------

/** First matching row wins; the named fallback row closes the table. */
const decide = <T>(
  rows: readonly RowFn<T>[],
  fallback: TotalRowFn<T>,
  item: T,
  ctx: RowContext,
): ClassifiedItem => {
  for (const row of rows) {
    const hit = row(item, ctx);
    if (hit !== null) {
      return hit;
    }
  }
  return fallback(item, ctx);
};

/**
 * Classify the FULL fetched review state into per-item verdicts. Pure and
 * total: every thread, review, and top-level comment yields exactly one
 * ClassifiedItem (threads first, then reviews, then top-level comments —
 * input order within each collection). `nowMs` is the only clock. The
 * returned Classification carries the state's truncation flag VERBATIM —
 * consumers MUST consult it before dispatching batches (see the module
 * doc's truncation section). See the module doc comment for the table.
 */
export function classifyThreads(
  state: FetchedReviewState,
  nowMs: number,
  config: ClassifyConfig = defaultClassifyConfig,
): Classification {
  const ctx: RowContext = {
    responder: state.authorLogin,
    nowMs,
    config,
    restReviewComments: state.restReviewComments,
    restIssueComments: state.restIssueComments,
  };
  return {
    items: [
      ...state.threads.map((thread) => decide(THREAD_ROWS, threadNeedsResponseRow, thread, ctx)),
      ...state.reviews.map((review) => decide(REVIEW_ROWS, reviewNeedsResponseRow, review, ctx)),
      ...state.restIssueComments.map((comment) =>
        decide(COMMENT_ROWS, topLevelSummaryRow, comment, ctx),
      ),
    ],
    // Truncation propagation, verbatim: the fail-closed flag rides the
    // result so no consumer can plan against a partial fetch unnoticed.
    truncated: state.truncated,
    truncatedBecause: state.truncatedBecause,
  };
}
