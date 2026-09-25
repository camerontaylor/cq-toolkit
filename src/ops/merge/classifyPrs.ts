// classifyPrs — the I2 merge-acceptance decision table (goal F1, ws-f
// scope item 1; UC §3 row 41: "the decision table is the product" — the
// BEHAVIOR is ported exactly, as fresh code). Pure and deterministic:
// plain data in, a plain verdict out, no I/O, no gh calls, NO CLOCK —
// `nowMs` is injected by the caller (acceptance-critical: the settle row
// must be as testable as it is decided, and a table that steals time from
// the ambient clock is neither).
//
// I2 — NOTHING MERGES UNINVITED. Every candidate PR is offered to exactly
// one of five words, in this order, FIRST MATCH WINS:
//   1. draft                                  → `never`       (is_draft)
//   2. merge state DIRTY                      → `conflicting` (merge_conflicts);
//      UNKNOWN → `awaiting` (merge_state_ambiguous — GitHub could not
//      determine mergeability: fail closed); BLOCKED → `awaiting`
//      (merge_state_blocked — branch protection unmet: fail closed);
//      only CLEAN, BEHIND, and HAS_HOOKS reach the evidence rows
//   3. truncated review data                  → `awaiting`    (review_data_truncated)
//   4. last-commit-time unknown               → `awaiting`    (last_commit_unknown)
//   5. unresolved external threads > 0        → `has-issues`  (unresolved_external_threads)
//   6. outstanding post-commit objection
//      (a non-author CHANGES_REQUESTED)       → `awaiting`    (merge_objection_outstanding)
//   7. no acceptable review OF THE LAST
//      COMMIT's head state                    → `awaiting`    (no_acceptable_review)
//   8. explicit all-clear postdating the
//      last commit — bypasses ONLY the settle
//      wait; the review-of-head requirement
//      holds regardless                       → `eligible`    (explicit_all_clear)
//   9. last commit ≥ settle window ago
//      (with an acceptable review)            → `eligible`    (settle_window_elapsed)
//      else (settle not reached)              → `awaiting`    (settle_window_pending)
// Rows 3 and 4 FAIL CLOSED on purpose: truncated data means verdicts are
// MISSING from the set, and an unknown last-commit time means the settle
// and all-clear rows cannot be evaluated — neither may ever be read past.
//
// Definitional rules (the data lives in ./classify.config.js; the table
// only applies it):
//   - "No reviewer privileged": an ACCEPTABLE review is ANY review whose
//     author ≠ the PR author (bots count, humans count — no identity is
//     special), whose body is not a bot skip/failure notice (skipPatterns),
//     and whose VERDICT is APPROVED or COMMENTED — a CHANGES_REQUESTED
//     verdict is an objection, not acceptance (the cross-family reading
//     agrees: classifyThreads treats it as actionable); DISMISSED is
//     void; a null/unknown verdict never counts. Author self-reviews
//     never count.
//   - THE TEMPORAL QUALIFIER (DOCTRINE §I2, canonical): an acceptable
//     review is a review of the LAST COMMIT's exact head state — submitted
//     STRICTLY AFTER the last commit. Evidence covering an earlier commit
//     never qualifies, no matter how long the settle, and no matter when
//     it was resubmitted; a null/unparseable submittedAt never qualifies
//     (fail toward awaiting). The lane brief's simplified row table
//     omitted this qualifier; the implementation aligns to canonical
//     doctrine — that alignment is recorded in the PR body, NOT a
//     deviation from I2. The row-8 all-clear (review body or top-level
//     conversation comment) bypasses ONLY the settle wait — it can never
//     stand in for the review-of-head requirement.
//   - AN OUTSTANDING OBJECTION IS NOT SILENCE (row 6, deliberate
//     strictness under NOTHING MERGES UNINVITED): a non-author
//     CHANGES_REQUESTED against the head state must be resolved or
//     withdrawn before the quiet window can carry the PR — it blocks
//     ahead of the all-clear and settle rows, no matter how long the
//     settle runs.
//   - Row 5's externality is ROOT-only, inherited deliberately from the
//     shared countUnresolvedThreads (the ws-f single-shared-module
//     constraint): an author-rooted thread carrying an external reply does
//     not block — recorded as the intended I2 reading for the shared
//     vocabulary.
//   - Null/absent authorLogin on reviews and comments is NOT the author
//     (external — counts, fail toward accepting evidence), per the
//     established house rule and mirroring countUnresolvedThreads.
//
// The five-word verdict vocabulary IS the I2 contract with every consumer
// downstream (dispatch, reporting, the sweep driver). It is FROZEN:
// changing a word — adding, removing, renaming — is a recorded deviation,
// never a casual edit.
import { countUnresolvedThreads } from '../review/threads.js';
import type { RestComment, ReviewSummary, ReviewThread } from '../review/threads.js';
import type { ClassifyPrConfig } from './classify.config.js';
import { defaultClassifyPrConfig } from './classify.config.js';

/**
 * The frozen I2 vocabulary — the ONLY five things that can be said about a
 * candidate PR. `never`: not now and not by this pipeline (drafts);
 * `conflicting`: the branch cannot merge as it stands (dirty merge state);
 * `awaiting`: the PR is fine but not ready — the table is waiting on data,
 * a first look, or quiet time; `has-issues`: a human owes the PR work
 * (unresolved external review threads); `eligible`: the I2 acceptance
 * condition holds — dispatch may offer the merge. Changing the vocabulary
 * is a recorded deviation.
 */
export type PrMergeVerdict = 'never' | 'conflicting' | 'awaiting' | 'has-issues' | 'eligible';

/** The decision table's output: the verdict, WHY (stable snake_case, one
 * value per table row — safe to log, group, and assert on), and the
 * unresolved-external-thread count the row-5 decision was made from
 * (surfaced on EVERY verdict, whatever row fired, so callers never
 * recount). */
export interface PrClassification {
  verdict: PrMergeVerdict;
  reason:
    | 'is_draft'
    | 'merge_conflicts'
    | 'merge_state_ambiguous'
    | 'merge_state_blocked'
    | 'review_data_truncated'
    | 'last_commit_unknown'
    | 'unresolved_external_threads'
    | 'merge_objection_outstanding'
    | 'no_acceptable_review'
    | 'explicit_all_clear'
    | 'settle_window_elapsed'
    | 'settle_window_pending';
  unresolvedExternalThreads: number;
}

/**
 * One candidate PR with everything the table needs, already fetched: the
 * GraphQL/REST review snapshot (threads, reviews, top-level conversation
 * comments), the PR's own flags, and its last commit time. Shapes come
 * from the shared review/threads.js vocabulary — the single surface this
 * family imports from review/.
 */
export interface PrCandidate {
  /** The PR number. */
  pr: number;
  /** The PR author's GitHub login, or null when unavailable. */
  authorLogin: string | null;
  /** Whether the PR is a draft (row 1 — never offered to merge). */
  draft: boolean;
  /**
   * GraphQL mergeState enum (uppercase); a future REST-fed boundary must
   * normalize case to this union before calling. DIRTY = merge conflicts
   * (row 2, conflicting); UNKNOWN (mergeability undeterminable) and
   * BLOCKED (branch protection unmet) fail closed to awaiting (row 2);
   * CLEAN, BEHIND, and HAS_HOOKS reach the evidence rows.
   */
  mergeState: 'DIRTY' | 'BEHIND' | 'CLEAN' | 'UNKNOWN' | 'HAS_HOOKS' | 'BLOCKED';
  /** The fail-closed truncation flag from the fetch layer (row 3). */
  truncated: boolean;
  /** The PR's review threads (row 5 counts the unresolved external ones). */
  threads: ReviewThread[];
  /** The PR's submitted reviews (rows 6 and 7). */
  reviews: ReviewSummary[];
  /** The PR's flat conversation comments (row 7 reads the TOP-LEVEL ones). */
  issueComments: RestComment[];
  /** The head commit's ISO 8601 timestamp, or null when unresolvable (row 4). */
  lastCommitAt: string | null;
  /** The exact current head SHA, when fetched. */
  headRefOid?: string | null | undefined;
}

/**
 * `Date.parse` a timestamp, or null when it is absent/unparseable — the
 * table never compares NaN (every NaN comparison is false, which would
 * silently read as "no evidence" in one row and "fresh evidence" in
 * another; here ambiguity is a named null the caller handles explicitly).
 */
const parseMs = (iso: string | null): number | null => {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
};

/**
 * Evaluate a config pattern with any STICKY/GLOBAL flag stripped (the E2
 * approach in classifyThreads, mirrored): a /g or /y RegExp keeps
 * `lastIndex` across .test() calls, so the Nth classification would
 * depend on the N-1 before it — a nondeterministic table. The caller's
 * RegExp objects are never mutated; a fresh flag-stripped expression is
 * rebuilt per read.
 */
const evalPattern = (pattern: RegExp, body: string): boolean =>
  new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, '')).test(body);

/**
 * True when the body matches any configured bot skip/failure pattern — a
 * bot notice is neither acceptance evidence, nor an objection, nor an
 * all-clear, however it is phrased. Evaluated flag-stripped (evalPattern).
 */
const matchesSkipPattern = (body: string, config: ClassifyPrConfig): boolean =>
  config.skipPatterns.some((pattern) => evalPattern(pattern, body));

const isTrustedReviewer = (review: ReviewSummary, ctx: ReviewContext): boolean => {
  if (ctx.config.trustedBots === undefined && ctx.config.trustedAssociations === undefined)
    return true;
  if (review.authorLogin === null || review.authorLogin === ctx.config.automationLogin)
    return false;
  if (ctx.config.excludedLogins?.includes(review.authorLogin)) return false;
  const bots = ctx.config.trustedBots ?? [];
  const associations = ctx.config.trustedAssociations ?? [];
  return (
    bots.includes(review.authorLogin) ||
    (review.authorAssociation != null && associations.includes(review.authorAssociation))
  );
};

const isAutomation = (review: ReviewSummary, config: ClassifyPrConfig): boolean =>
  config.automationLogin !== undefined && review.authorLogin === config.automationLogin;

const isTrustedLogin = (login: string | null, config: ClassifyPrConfig): boolean => {
  if (config.trustedBots === undefined && config.trustedAssociations === undefined) return true;
  if (login === null || login === config.automationLogin) return false;
  if (config.excludedLogins?.includes(login)) return false;
  return (config.trustedBots ?? []).includes(login);
};

/** Fold the complete review stream, retaining the latest submitted opinion per actor. */
const latestReviewPerActor = (reviews: readonly ReviewSummary[]): ReviewSummary[] => {
  const latest = new Map<string | null, ReviewSummary>();
  for (const review of reviews) {
    const key = review.authorLogin;
    const prior = latest.get(key);
    if (
      prior === undefined ||
      (parseMs(review.submittedAt) ?? 0) >= (parseMs(prior.submittedAt) ?? 0)
    ) {
      latest.set(key, review);
    }
  }
  return [...latest.values()];
};

/**
 * The context the review-evidence predicates read: who the PR author is,
 * the last commit's parsed ms (null only before row 4 has failed closed),
 * and the config.
 */
interface ReviewContext {
  authorLogin: string | null;
  lastCommitMs: number | null;
  config: ClassifyPrConfig;
  headRefOid?: string | null | undefined;
}

/**
 * The shared SCREEN every review must pass before its verdict can mean
 * anything to the table: a non-author (a null reviewer login is not the
 * author — external, counts, mirroring countUnresolvedThreads' exact
 * comparison), a body that is not a bot skip/failure notice
 * (matchesSkipPattern), and the TEMPORAL QUALIFIER — submitted STRICTLY
 * AFTER the last commit (evidence covering an earlier commit never
 * qualifies; a null/unparseable submittedAt never qualifies — fail
 * toward awaiting). `lastCommitMs` is typed nullable only so the
 * predicate stays total: the table has already failed closed on an
 * unknown commit by row 4, before any evidence row can call.
 */
const isReviewableEvidence = (review: ReviewSummary, ctx: ReviewContext): boolean => {
  if (ctx.authorLogin !== null && review.authorLogin === ctx.authorLogin) return false;
  if (!isTrustedReviewer(review, ctx)) return false;
  if (
    matchesSkipPattern(review.body, ctx.config) &&
    (ctx.config.automationLogin === undefined || !isAutomation(review, ctx.config))
  )
    return false;
  if (
    ctx.headRefOid !== undefined &&
    ctx.headRefOid !== null &&
    review.commitOid !== ctx.headRefOid
  )
    return false;
  const submittedMs = parseMs(review.submittedAt);
  return submittedMs !== null && ctx.lastCommitMs !== null && submittedMs > ctx.lastCommitMs;
};

/**
 * Whether a review's VERDICT can carry acceptance evidence (row 7) or
 * all-clear evidence (row 8): only APPROVED or COMMENTED. A
 * CHANGES_REQUESTED verdict is handled by its own row (isObjection — an
 * objection, not acceptance; the cross-family reading agrees:
 * classifyThreads treats it as actionable feedback to answer). DISMISSED
 * is void; a null/unknown state never counts (fail toward awaiting).
 */
const stateCounts = (state: ReviewSummary['state'], config: ClassifyPrConfig): boolean =>
  state !== null && (config.acceptReviewStates ?? ['APPROVED', 'COMMENTED']).includes(state);

/**
 * An ACCEPTABLE review for row 7: reviewable evidence whose verdict
 * carries acceptance (stateCounts). No reviewer is privileged: bots and
 * humans count identically.
 */
const isAcceptableReview = (review: ReviewSummary, ctx: ReviewContext): boolean =>
  isReviewableEvidence(review, ctx) && stateCounts(review.state, ctx.config);

/**
 * An OUTSTANDING OBJECTION for row 6: reviewable evidence (non-author,
 * non-skip-notice body, postdating the last commit) whose verdict is
 * CHANGES_REQUESTED — an open objection to the head state. An objection
 * is not silence: under NOTHING MERGES UNINVITED it must be resolved or
 * withdrawn (the verdict moves off CHANGES_REQUESTED) before the quiet
 * window can carry the PR, no matter how long the settle.
 */
const isObjection = (review: ReviewSummary, ctx: ReviewContext): boolean =>
  isReviewableEvidence(review, ctx) && review.state === 'CHANGES_REQUESTED';

/**
 * Whether one piece of evidence (a review, or a top-level conversation
 * comment) is an explicit all-clear for row 8. A BOT SKIP/FAILURE NOTICE
 * is never all-clear evidence, however it is phrased (skipPatterns fire
 * first — "… No further changes will be made." appended to a bot's skip
 * line must not read as approval). Otherwise: body matches
 * config.allClearPattern, authored by a non-author (null counts as
 * non-author, per the house rule), and timestamped STRICTLY AFTER
 * lastCommitMs. The all-clear bypasses ONLY the settle wait — it can
 * never substitute for row 7's review-of-head requirement. Evidence with
 * an absent/unparseable timestamp cannot be shown to postdate the commit
 * and never qualifies — fail closed.
 */
const isAllClearAfter = (
  body: string,
  evidenceAuthorLogin: string | null,
  createdAt: string | null,
  prAuthorLogin: string | null,
  lastCommitMs: number,
  config: ClassifyPrConfig,
): boolean => {
  if (matchesSkipPattern(body, config)) return false;
  if (prAuthorLogin !== null && evidenceAuthorLogin === prAuthorLogin) return false;
  if (!evalPattern(config.allClearPattern, body)) return false;
  const atMs = parseMs(createdAt);
  if (atMs === null) return false;
  return atMs > lastCommitMs;
};

/**
 * Run one candidate PR through the I2 decision table (rows in the order
 * documented on the module — first match wins). `nowMs` is the caller's
 * clock reading, injected so the settle boundary is fully determined by
 * inputs: same candidate + same nowMs → deep-equal classification, always.
 * `config` defaults to defaultClassifyPrConfig; R3 tunes policy by passing
 * an override, never by editing this function.
 */
export function classifyPr(
  candidate: PrCandidate,
  nowMs: number,
  config: ClassifyPrConfig = defaultClassifyPrConfig,
): PrClassification {
  // Row 5's count, computed once and surfaced on EVERY verdict (whatever
  // row fires) so callers never recount: unresolved threads whose root
  // author is external to the PR author — the E1 vocabulary's own
  // external-threads rule, with the PR author as the responder.
  const unresolvedExternalThreads = countUnresolvedThreads(candidate.threads, {
    excludeAuthorLogin: candidate.authorLogin,
  });

  // Row 1 — a draft is never offered to merge, whatever else is true.
  if (candidate.draft) {
    return { verdict: 'never', reason: 'is_draft', unresolvedExternalThreads };
  }
  // Row 2 — the branch's own merge state, ahead of every review row (a
  // conflicted PR's reviews describe code that cannot merge as-is). DIRTY
  // is the conflict lane; UNKNOWN and BLOCKED fail closed to awaiting
  // (GitHub could not determine mergeability / branch protection unmet —
  // neither may be read as mergeable). Only CLEAN, BEHIND, and HAS_HOOKS
  // continue to the evidence rows.
  switch (candidate.mergeState) {
    case 'DIRTY':
      return { verdict: 'conflicting', reason: 'merge_conflicts', unresolvedExternalThreads };
    case 'UNKNOWN':
      return { verdict: 'awaiting', reason: 'merge_state_ambiguous', unresolvedExternalThreads };
    case 'BLOCKED':
      return { verdict: 'awaiting', reason: 'merge_state_blocked', unresolvedExternalThreads };
    case 'CLEAN':
    case 'BEHIND':
    case 'HAS_HOOKS':
      break; // mergeable states — the evidence rows decide
  }
  // Row 3 — truncated review data: verdicts may be MISSING from the set,
  // so "no threads, no reviews" proves nothing. Fail closed ahead of every
  // evidence row (a truncated fetch can never look mergeable here).
  if (candidate.truncated) {
    return { verdict: 'awaiting', reason: 'review_data_truncated', unresolvedExternalThreads };
  }
  // Row 4 — last-commit time unknown: rows 7 and 8 both ORDER evidence
  // against the last commit, so without it they cannot be evaluated. Fail
  // closed (null and unparseable alike — parseMs never lets NaN through).
  const lastCommitMs = parseMs(candidate.lastCommitAt);
  if (lastCommitMs === null) {
    return { verdict: 'awaiting', reason: 'last_commit_unknown', unresolvedExternalThreads };
  }
  // Row 5 — a human owes the PR work: unresolved threads from reviewers
  // other than the author (the author's own threads do not block).
  if (unresolvedExternalThreads > 0) {
    return {
      verdict: 'has-issues',
      reason: 'unresolved_external_threads',
      unresolvedExternalThreads,
    };
  }
  // Rows 6–9 read review evidence; they share one screening context.
  const ctx: ReviewContext = {
    authorLogin: candidate.authorLogin,
    lastCommitMs,
    config,
    headRefOid: candidate.headRefOid,
  };
  const foldedReviews =
    config.trustedBots !== undefined || config.trustedAssociations !== undefined
      ? latestReviewPerActor(candidate.reviews)
      : candidate.reviews;
  // Row 6 — an OUTSTANDING OBJECTION: a non-author reviewer's
  // CHANGES_REQUESTED against the last commit's head state, not yet
  // withdrawn (verdict moved off CHANGES_REQUESTED). An objection is not
  // silence (DOCTRINE: NOTHING MERGES UNINVITED) — it blocks ahead of the
  // all-clear and settle rows, no matter how long the settle runs.
  if (foldedReviews.some((review) => isObjection(review, ctx))) {
    return {
      verdict: 'awaiting',
      reason: 'merge_objection_outstanding',
      unresolvedExternalThreads,
    };
  }
  // Row 7 — nobody has looked AT THIS CODE: no acceptable review of the
  // last commit's exact head state exists (non-author, verdict
  // APPROVED/COMMENTED, non-skip-notice, submitted STRICTLY AFTER the
  // last commit). Quiet is not acceptance until someone qualified has
  // spoken about the head state at least once — and no amount of settle
  // time cures evidence that predates the commit.
  const hasAcceptableReview = foldedReviews.some((review) => isAcceptableReview(review, ctx));
  if (!hasAcceptableReview) {
    return { verdict: 'awaiting', reason: 'no_acceptable_review', unresolvedExternalThreads };
  }
  // Row 8 — an explicit all-clear STRICTLY AFTER the last commit: a
  // non-author said the final code is fine (review body or top-level
  // conversation comment), so the settle wait is unnecessary. This
  // bypasses ONLY the settle wait — row 7's review-of-head requirement
  // already held before we got here. An all-clear at-or-before the commit
  // speaks about earlier code and falls through.
  const allClearAfterLastCommit =
    foldedReviews.some(
      (review) =>
        // A review body is all-clear evidence only when its VERDICT can
        // carry evidence at all (stateCounts — a DISMISSED or
        // CHANGES_REQUESTED "LGTM" body is a retracted note or an
        // objection, not an all-clear).
        stateCounts(review.state, config) &&
        isReviewableEvidence(review, ctx) &&
        isAllClearAfter(
          review.body,
          review.authorLogin,
          review.submittedAt,
          candidate.authorLogin,
          lastCommitMs,
          config,
        ),
    ) ||
    candidate.issueComments.some(
      (comment) =>
        // Only TOP-LEVEL conversation comments: a reply rides on someone
        // else's thread, it is not the commenter's own verdict on the PR.
        comment.inReplyToId === null &&
        isTrustedLogin(comment.authorLogin, config) &&
        isAllClearAfter(
          comment.body,
          comment.authorLogin,
          comment.createdAt,
          candidate.authorLogin,
          lastCommitMs,
          config,
        ),
    );
  if (allClearAfterLastCommit) {
    return { verdict: 'eligible', reason: 'explicit_all_clear', unresolvedExternalThreads };
  }
  // Row 9 — the settle window: an acceptable review exists (row 7
  // passed), so the question is only whether the PR has sat untouched
  // long enough for quiet to count as acceptance. Exactly AT the window
  // is elapsed (>=): the boundary belongs to eligible.
  if (nowMs - lastCommitMs >= config.settleWindowMs) {
    return { verdict: 'eligible', reason: 'settle_window_elapsed', unresolvedExternalThreads };
  }
  return { verdict: 'awaiting', reason: 'settle_window_pending', unresolvedExternalThreads };
}
