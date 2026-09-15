// classifyThreads — E2 slice 1 (goal E2, ws-e items 2–3; UC §2 rows 34–35;
// invariant I6): the PURE decision table over a FetchedReviewState. Every
// thread, review summary, and top-level conversation comment gets exactly
// one verdict from the FROZEN five-word vocabulary
// `actionable | responded | resolved | blocked | skip` (ThreadVerdict — the
// workstream contract; changing it is a recorded deviation, not a refactor).
//
// THE DECISION TABLE — 15 rows — fire first-match-wins, top to bottom,
// within each kind; the trailing row of each table is the total fallback.
// Each row is a small named pure function below, and the tables are the
// arrays THREAD_ROWS / REVIEW_ROWS / COMMENT_ROWS.
//
//   THREADS (state.threads — replies already attached by fetchReviewState):
//     1. resolved                                        → resolved   (thread_resolved)
//     2. root authored by the responder (config)         → skip       (responder_authored)
//     3. root body matches a config.skipPatterns entry   → skip       (bot_skip_notice)
//     4. isOutdated && config.blockOnOutdatedThreads     → blocked    (outdated_unresolved)
//     5. replies non-empty AND the LAST reply (by
//        timestamp order as given; null timestamps =
//        nowMs per config FOR ORDERING) is authored by
//        the responder AND parses for real — an
//        un-timestamped last reply is no one's word
//        (fails toward actionable)                       → responded  (responder_last_word)
//     6. else                                            → actionable (thread_needs_response)
//
//   REVIEWS (state.reviews — summary comments):
//     7. authored by the responder (config)              → skip       (responder_authored)
//     8. body matches a config.skipPatterns entry        → skip       (bot_skip_notice)
//     9. state === 'DISMISSED' && skipDismissedReviews   → skip       (review_dismissed)
//    10. a responder TOP-LEVEL issue comment with a REAL parsed createdAt
//        strictly greater than submittedAt (or its nowMs fallback)
//        exists in state.restIssueComments — summary-answer evidence is
//        ISSUE comments ONLY: thread replies (restReviewComments)
//        address threads via row 5 and never count as summary answers
//        (otherwise one late reply would void every older unaddressed
//        summary — fail-open)                        → skip       (review_already_answered)
//    11. EMPTY body && (state === 'APPROVED' →
//        approval_no_body; state === 'COMMENTED' →
//        commented_no_body; state === null →
//        empty_summary_no_state; CHANGES_REQUESTED stays
//        actionable — the state itself is signal), gated on
//        config.skipApprovalReviews                      → skip       (approval_no_body |
//                                                                     commented_no_body |
//                                                                     empty_summary_no_state)
//    12. else                                            → actionable (review_summary_needs_response)
//
//   TOP-LEVEL conversation comments (state.restIssueComments):
//    13. authored by the responder (config)              → skip       (responder_authored)
//    14. body matches a config.skipPatterns entry        → skip       (bot_skip_notice)
//    15. else                                            → actionable (top_level_summary)
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
// reply timing; the approval/empty-summary row (11) sits AFTER the answered
// row and immediately BEFORE the fallback (12) — emptiness is only
// consulted once every content-based row had its say, so a NON-empty
// APPROVED body still reaches the fallback as actionable (fails toward
// action: the approver may have noted follow-ups). Comments mirror the
// threads head: authorship (13) beats the bot notice (14).
//
// "Responder" is CONFIG-DRIVEN (config.responderIs): the only value today,
// 'pr-author', reads `state.authorLogin` — the PR author in the merge-prs
// context, the party answering review feedback on their own PR. The switch
// is exhaustive (compiler-checked), so widening the union later is data
// plus one arm. A null authorLogin (deleted/anonymized account) is NEVER
// the responder — external, fail toward `actionable`.
//
// FAIL-CLOSED TRUNCATION PROPAGATION: the result carries the fetched
// state's truncated/truncatedBecause flag VERBATIM (defensively cloned),
// and consumers MUST consult it before dispatching batches — a cap hit or
// a `reviewThreads.lag` fetch means fresh threads are MISSING from the
// verdict set, so an unconsulted dispatcher would plan against incomplete
// evidence. planReviewBatch (E2 slice 2) enforces this structurally: it
// takes the full Classification and REFUSES truncated data.
//
// Purity: no I/O, no Date.now() anywhere — `nowMs` is the ONLY clock and is
// an injected parameter (the auditor's acceptance check). ISO timestamps
// convert with a local Date.parse helper; null or unparseable values fall
// back per config.treatNullCreatedAtAs where timestamps order things
// ('nowMs' → brand-new; 'epochMs' → ancient), EXCEPT that two verdicts
// demand a REAL parsed timestamp (parseRealMs below — it never falls back,
// so it fails toward actionable): an answering reply (row 10) and a
// thread's last word (row 5). All heuristics and thresholds live in
// classify.config.ts AS DATA — this module only reads them.
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
 *     empty approvals, the responder's own words).
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
 * fail-closed truncation flag, copied verbatim (truncatedBecause is
 * defensively cloned — TruncationFlag contract: never silently dropped).
 * Consumers MUST consult `truncated`/`truncatedBecause` before dispatching
 * batches — a cap hit or a `reviewThreads.lag` fetch means fresh threads
 * are MISSING from the verdict set, so an unconsulted dispatcher would
 * plan against incomplete evidence; planReviewBatch refuses such a result
 * outright. Fail closed downstream, exactly like the fetch layer.
 */
export interface Classification {
  /** One item per thread, review, and top-level comment (in that order). */
  items: ClassifiedItem[];
  /** Verbatim from state.truncated. */
  truncated: boolean;
  /** Verbatim (defensively cloned) from state.truncatedBecause. */
  truncatedBecause: string[];
}

/** Everything a row needs besides the item itself. Plain data, no clocks. */
interface RowContext {
  /** The config-selected responder; null matches nobody. */
  responder: string | null;
  /** The injected clock, in epoch ms — the only time source in this module. */
  nowMs: number;
  /** The R3-tunable heuristics (classify.config.ts). */
  config: ClassifyConfig;
  /** Flat REST issue comments — row 10's answer scan (the ONLY summary-
   * answer evidence; thread replies answer threads via row 5). */
  restIssueComments: readonly RestComment[];
}

/**
 * Resolve the responder per config.responderIs. Exhaustive switch with a
 * never-assert: widening the union later is config data plus exactly one
 * new arm here — a forgotten arm is a COMPILE error, never a silent
 * fallthrough.
 */
const responderOf = (state: FetchedReviewState, config: ClassifyConfig): string | null => {
  switch (config.responderIs) {
    case 'pr-author':
      return state.authorLogin;
    default: {
      const unreachable: never = config.responderIs;
      throw new Error(`classifyThreads: unknown config.responderIs ${String(unreachable)}`);
    }
  }
};

/**
 * ISO 8601 → epoch ms for ORDERING uses (a thread's last-word comparison;
 * a review's submittedAt side). Null or unparseable input falls back per
 * config.treatNullCreatedAtAs: 'nowMs' → nowMs (brand-new), 'epochMs' → 0
 * (ancient). NOT used where a verdict demands a REAL timestamp — see
 * parseRealMs.
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
 * fallback. Two verdicts require a REAL parsed timestamp: an ANSWERING
 * reply (row 10) and a thread's LAST WORD (row 5). A null/unparseable
 * timestamp never speaks (under 'nowMs' it is not counted at all; under
 * 'epochMs' the ordering fallback would be 0, which never postdates a past
 * review) — either way the row fails toward actionable.
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

/** True when the body matches any configured bot skip/failure pattern (I2).
 * Each pattern is evaluated via a FRESH expression with any `g`/`y` flag
 * stripped: config patterns are data, and a stateful pattern's `lastIndex`
 * survives across `.test()` calls, so repeated classification of identical
 * bodies would alternate between match and no-match — a nondeterministic
 * table. Rebuilding per call keeps the decision pure. */
const matchesSkipPattern = (body: string, config: ClassifyConfig): boolean =>
  config.skipPatterns.some((pattern) =>
    new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, '')).test(body),
  );

/** The thread's LAST reply by timestamp order as given (attachRestReplies
 * already sorts createdAt-ascending, nulls last); equal ms keep the LATER
 * array entry, so "as given" order breaks ties toward the newest word.
 * Null timestamps convert per config FOR ORDERING ONLY — whether that last
 * reply may SPEAK (row 5) is decided on a real parsed timestamp. Empty
 * replies → null. */
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
 * to do until the reviewer returns. The last word must carry a REAL parsed
 * timestamp (parseRealMs): an un-timestamped last reply is no one's word,
 * so the row falls through to actionable (fails toward action — mirrors
 * row 10's answer rule). */
const responderLastWordRow: RowFn<ReviewThread> = (thread, ctx) => {
  const last = lastReplyByMs(thread, ctx.nowMs, ctx.config);
  const lastWordMs = last === null ? null : parseRealMs(last.createdAt);
  return last !== null && lastWordMs !== null && isResponder(last.authorLogin, ctx.responder)
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
// REVIEW rows (module doc rows 7–12)
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
 * responder reply postdates them). Summary-answer evidence comes from
 * TOP-LEVEL issue comments ONLY (state.restIssueComments): thread replies
 * (restReviewComments) address THREADS — that is row 5's business — and
 * never count as summary answers; counting them would let one late reply
 * void every older unaddressed summary (fail-open). Strictly greater:
 * equal ms do not count. The reply needs a REAL parsed timestamp — a
 * null/unparseable reply never answers (fails toward actionable). */
const reviewAlreadyAnsweredRow: RowFn<ReviewSummary> = (review, ctx) => {
  const submittedMs = toMs(review.submittedAt, ctx.nowMs, ctx.config);
  const answered = ctx.restIssueComments.some((comment) => {
    if (!isResponder(comment.authorLogin, ctx.responder)) {
      return false;
    }
    const answeredMs = parseRealMs(comment.createdAt);
    return answeredMs !== null && answeredMs > submittedMs;
  });
  return answered ? reviewItem(review, 'skip', 'review_already_answered') : null;
};

/** Row 11 — a review WITHOUT text is not outstanding feedback, gated on
 * config.skipApprovalReviews, one reason per arm:
 *   - state 'APPROVED' → `approval_no_body` — "approved" with no note
 *     means the reviewer is satisfied;
 *   - state 'COMMENTED' → `commented_no_body` — the reviewer wrapped up
 *     with no words; nothing actionable survives;
 *   - state null → `empty_summary_no_state` — no verdict and no words.
 * An EMPTY body with state 'CHANGES_REQUESTED' stays ACTIONABLE on
 * purpose: the state itself is signal — requested changes are outstanding
 * work even without accompanying prose. A NON-empty body always stays on
 * the content rows above regardless of state (fails toward action: the
 * reviewer may have noted follow-ups). Deliberately AFTER the answered
 * row and BEFORE the fallback. */
const approvalNoBodyRow: RowFn<ReviewSummary> = (review, ctx) => {
  if (!ctx.config.skipApprovalReviews || review.body.trim() !== '') {
    return null;
  }
  if (review.state === 'APPROVED') {
    return reviewItem(review, 'skip', 'approval_no_body');
  }
  if (review.state === 'COMMENTED') {
    return reviewItem(review, 'skip', 'commented_no_body');
  }
  if (review.state === null) {
    return reviewItem(review, 'skip', 'empty_summary_no_state');
  }
  return null;
};

/** Row 12 — fallback: a review summary awaits a response. */
const reviewNeedsResponseRow: TotalRowFn<ReviewSummary> = (review) =>
  reviewItem(review, 'actionable', 'review_summary_needs_response');

/** The REVIEW table (rows 7–11; row 12 is the fallback passed to decide). */
const REVIEW_ROWS: readonly RowFn<ReviewSummary>[] = [
  responderAuthoredReviewRow,
  botSkipReviewRow,
  reviewDismissedRow,
  reviewAlreadyAnsweredRow,
  approvalNoBodyRow,
];

// ---------------------------------------------------------------------------
// TOP-LEVEL COMMENT rows (module doc rows 13–15)
// ---------------------------------------------------------------------------

/** Row 13 — the responder's own conversation comment: not feedback. */
const responderAuthoredCommentRow: RowFn<RestComment> = (comment, ctx) =>
  ctx.config.skipResponderAuthoredThreads && isResponder(comment.authorLogin, ctx.responder)
    ? commentItem(comment, 'skip', 'responder_authored')
    : null;

/** Row 14 — a bot skip/failure notice is not a review (I2). */
const botSkipCommentRow: RowFn<RestComment> = (comment, ctx) =>
  matchesSkipPattern(comment.body, ctx.config)
    ? commentItem(comment, 'skip', 'bot_skip_notice')
    : null;

/** Row 15 — fallback: top-level PR conversation comments ARE actionable
 * review summaries (workstream contract). */
const topLevelSummaryRow: TotalRowFn<RestComment> = (comment) =>
  commentItem(comment, 'actionable', 'top_level_summary');

/** The COMMENT table (rows 13–14; row 15 is the fallback passed to decide). */
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
 * consumers MUST consult it before dispatching batches (planReviewBatch
 * refuses a truncated classification outright). See the module doc
 * comment for the 15-row table.
 */
export function classifyThreads(
  state: FetchedReviewState,
  nowMs: number,
  config: ClassifyConfig = defaultClassifyConfig,
): Classification {
  const ctx: RowContext = {
    responder: responderOf(state, config),
    nowMs,
    config,
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
    // Truncation propagation, verbatim (defensively cloned): the
    // fail-closed flag rides the result so no consumer can plan against a
    // partial fetch unnoticed.
    truncated: state.truncated,
    truncatedBecause: [...state.truncatedBecause],
  };
}
