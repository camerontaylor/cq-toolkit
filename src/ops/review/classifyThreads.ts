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
// THREAD_ROWS / REVIEW_ROWS / COMMENT_ROWS.
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
//     7. body matches a config.skipPatterns entry        → skip       (bot_skip_notice)
//     8. a responder reply postdates review.submittedAt
//        ("responder reply" = any state.restReviewComments
//        comment authored by the responder whose createdAt,
//        or its nowMs fallback, is STRICTLY GREATER than
//        submittedAt, or its nowMs fallback)             → skip       (review_already_answered)
//     9. else                                            → actionable (review_summary_needs_response)
//
//   TOP-LEVEL conversation comments (state.restIssueComments):
//    10. authored by the responder (config)              → skip       (responder_authored)
//    11. body matches a config.skipPatterns entry        → skip       (bot_skip_notice)
//    12. else                                            → actionable (top_level_summary)
//        (top-level PR conversation comments ARE actionable
//        review summaries — the workstream contract)
//
// Row order is load-bearing: resolution answers a thread outright (1 beats
// 4); a responder-authored thread is not outstanding feedback no matter how
// stale or bot-flavored its body (2 beats 3 and 4); only then does
// staleness (4) or the conversation's last word (5) decide.
//
// "Responder" is `state.authorLogin` — the PR author in the merge-prs
// context (ClassifyConfig.responderIs): the party answering review feedback
// on their own PR. A null authorLogin (deleted/anonymized account) is NEVER
// the responder — external, fail toward `actionable`.
//
// Purity: no I/O, no Date.now() anywhere — `nowMs` is the ONLY clock and is
// an injected parameter (the auditor's acceptance check). ISO timestamps
// convert with a local Date.parse helper; null or unparseable values fall
// back per config.treatNullCreatedAtAs ('nowMs' → brand-new — it can never
// be "already answered", so it fails toward actionable; 'epochMs' →
// ancient). All heuristics and thresholds live in classify.config.ts AS
// DATA — this module only reads them.
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
 *   - `skip` — not feedback at all (bot notices, responder's own words).
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

/** Everything a row needs besides the item itself. Plain data, no clocks. */
interface RowContext {
  /** state.authorLogin — the responder (see module doc); null matches nobody. */
  responder: string | null;
  /** The injected clock, in epoch ms — the only time source in this module. */
  nowMs: number;
  /** The R3-tunable heuristics (classify.config.ts). */
  config: ClassifyConfig;
  /** The flat REST review comments — row 8's "responder reply" source. */
  restReviewComments: readonly RestComment[];
}

/**
 * ISO 8601 → epoch ms. Null or unparseable input falls back per
 * config.treatNullCreatedAtAs: 'nowMs' → `nowMs` (brand-new — fails toward
 * actionable), 'epochMs' → 0 (ancient).
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
// REVIEW rows (module doc rows 7–9)
// ---------------------------------------------------------------------------

/** Row 7 — a bot skip/failure notice is not a review (I2). */
const botSkipReviewRow: RowFn<ReviewSummary> = (review, ctx) =>
  matchesSkipPattern(review.body, ctx.config)
    ? reviewItem(review, 'skip', 'bot_skip_notice')
    : null;

/** Row 8 — a responder reply postdating the review means its summary is
 * already answered (workstream contract: review-body summaries skip when a
 * responder reply postdates them). Strictly greater: equal ms do not count. */
const reviewAlreadyAnsweredRow: RowFn<ReviewSummary> = (review, ctx) => {
  const submittedMs = toMs(review.submittedAt, ctx.nowMs, ctx.config);
  const answered = ctx.restReviewComments.some(
    (comment) =>
      isResponder(comment.authorLogin, ctx.responder) &&
      toMs(comment.createdAt, ctx.nowMs, ctx.config) > submittedMs,
  );
  return answered ? reviewItem(review, 'skip', 'review_already_answered') : null;
};

/** Row 9 — fallback: a review summary awaits a response. */
const reviewNeedsResponseRow: TotalRowFn<ReviewSummary> = (review) =>
  reviewItem(review, 'actionable', 'review_summary_needs_response');

/** The REVIEW table (rows 7–8; row 9 is the fallback passed to decide). */
const REVIEW_ROWS: readonly RowFn<ReviewSummary>[] = [botSkipReviewRow, reviewAlreadyAnsweredRow];

// ---------------------------------------------------------------------------
// TOP-LEVEL COMMENT rows (module doc rows 10–12)
// ---------------------------------------------------------------------------

/** Row 10 — the responder's own conversation comment: not feedback. */
const responderAuthoredCommentRow: RowFn<RestComment> = (comment, ctx) =>
  ctx.config.skipResponderAuthoredThreads && isResponder(comment.authorLogin, ctx.responder)
    ? commentItem(comment, 'skip', 'responder_authored')
    : null;

/** Row 11 — a bot skip/failure notice is not a review (I2). */
const botSkipCommentRow: RowFn<RestComment> = (comment, ctx) =>
  matchesSkipPattern(comment.body, ctx.config)
    ? commentItem(comment, 'skip', 'bot_skip_notice')
    : null;

/** Row 12 — fallback: top-level PR conversation comments ARE actionable
 * review summaries (workstream contract). */
const topLevelSummaryRow: TotalRowFn<RestComment> = (comment) =>
  commentItem(comment, 'actionable', 'top_level_summary');

/** The COMMENT table (rows 10–11; row 12 is the fallback passed to decide). */
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
 * input order within each collection). `nowMs` is the only clock. See the
 * module doc comment for the decision table.
 */
export function classifyThreads(
  state: FetchedReviewState,
  nowMs: number,
  config: ClassifyConfig = defaultClassifyConfig,
): ClassifiedItem[] {
  const ctx: RowContext = {
    responder: state.authorLogin,
    nowMs,
    config,
    restReviewComments: state.restReviewComments,
  };
  return [
    ...state.threads.map((thread) => decide(THREAD_ROWS, threadNeedsResponseRow, thread, ctx)),
    ...state.reviews.map((review) => decide(REVIEW_ROWS, reviewNeedsResponseRow, review, ctx)),
    ...state.restIssueComments.map((comment) =>
      decide(COMMENT_ROWS, topLevelSummaryRow, comment, ctx),
    ),
  ];
}
