// verifyReviewOutcome — E3 slice 2 (goal E3; UC §2 row 37): the
// anti-hallucination VERIFY half — the PURE snapshot diff. A responder run
// CLAIMS it addressed the review; verifyPrOutcome checks whether the PR
// actually MOVED — a new head commit, a new comment, a newly resolved
// thread — and refuses to say progress happened without evidence. The
// snapshot CAPTURE half (snapshotPrState, the gh I/O) lives in the
// forge-github adapter since Phase 1.4:
// src/adapters/forge-github/snapshotPrState.ts.
//
// The contract (each clause pinned in test/ops/review/verifyReviewOutcome.test.ts):
//   - snapshotPrState (the adapter) captures the before/after evidence
//     (I/O through the gh seam only; `at` is the injected nowMs, never
//     Date.now). STRICT payloads: a PR object without a usable head.sha, a
//     REST comment entry without a numeric id, or a RESOLVED reviewThread
//     node without a string id each THROW — filtering would silently shrink
//     the evidence and a shrunk snapshot can only ever under-report movement
//     (a missed responder reply reads as NO PROGRESS).
//   - verifyPrOutcome is PURE: same snapshots (+ responder option) →
//     deep-equal outcome. Progress needs ANY ONE signal:
//       new-commit      — after.headSha !== before.headSha (snapshots are
//                         head-sha VERIFIED at capture time — snapshotPrState
//                         throws without one — so identical shas mean no
//                         signal and any difference means the PR moved).
//       responder-reply — a review- or issue-comment entry present in
//                         `after` and absent from `before` (REST-counted:
//                         GraphQL lags fresh writes, REST does not — the
//                         workstream contract counts comments over REST).
//                         Entries carry their author (REST snake_case
//                         user.login; absent → null). When the caller
//                         KNOWS the responder login, attribution is
//                         STRICT: a new comment counts as responder-reply
//                         evidence only if its author === responderLogin —
//                         a null author does NOT count, because
//                         certifying progress from an unattributable
//                         comment is exactly the hallucination this module
//                         exists to refuse (fail toward NOT certifying).
//                         When responderLogin is null the diff stays
//                         AUTHOR-BLIND by necessity: there is no claimed
//                         identity to check against, so any new id
//                         counts (a new comment is never nothing).
//       thread-resolved — a thread id in `after`'s resolved set that was
//                         not in `before`'s.
//   - summary: progress → "PROGRESS: " + kinds joined ", "; no evidence →
//     the EXACT literal "NO PROGRESS" (a hallucinated "done" with no
//     commit/reply/resolution lands here — explicit, greppable, machine-
//     checkable by the workstream).
import type { PrSnapshot } from '../../adapters/forge-github/snapshotPrState.js';

/** One observed movement, with a human-readable detail line. */
export interface ProgressReason {
  kind: 'new-commit' | 'responder-reply' | 'thread-resolved';
  detail: string;
}

/** The verify verdict: progress with evidence, or the explicit NO PROGRESS. */
export interface VerifyOutcome {
  /** True iff at least one signal fired. */
  progress: boolean;
  /** Every signal observed, in the fixed order new-commit → responder-reply → thread-resolved. */
  reasons: ProgressReason[];
  /** "PROGRESS: <kinds>" or the exact literal "NO PROGRESS". */
  summary: string;
}

/**
 * The PURE snapshot diff: compare before/after and name every movement.
 * Progress needs ANY ONE signal; no signal → progress=false and the exact
 * literal summary "NO PROGRESS" (the anti-hallucination contract: an
 * explicit, greppable refusal — never a guessed "done"). The reply signal
 * counts new comments by the responder when responderLogin is known;
 * comments with unknown authors do not qualify. With no known responder,
 * id-novelty is author-blind. Same inputs → deep-equal output; inputs are
 * read, never mutated.
 */
export function verifyPrOutcome(
  before: PrSnapshot,
  after: PrSnapshot,
  opts: { responderLogin: string | null },
): VerifyOutcome {
  const reasons: ProgressReason[] = [];

  // new-commit: plain !== — snapshots are head-sha VERIFIED at capture
  // time (snapshotPrState throws without one), so identical shas → no
  // signal; any difference → the PR moved.
  if (before.headSha !== after.headSha) {
    reasons.push({
      kind: 'new-commit',
      detail: `head sha moved ${JSON.stringify(before.headSha)} → ${JSON.stringify(after.headSha)}`,
    });
  }

  // responder-reply: a REST comment entry (either collection) present in
  // `after` and absent from `before` — gated by ATTRIBUTION when the
  // responder login is known (strict author === responderLogin; a null
  // author never counts: progress must not be certified from an
  // unattributable comment) and blind when it is null (any new id counts —
  // there is no claimed identity to check against).
  const newReviewEntries = after.reviewComments.filter(
    (entry) => !before.reviewComments.some((prior) => prior.id === entry.id),
  );
  const newIssueEntries = after.issueComments.filter(
    (entry) => !before.issueComments.some((prior) => prior.id === entry.id),
  );
  const countsAsReply = (entry: { author: string | null }): boolean =>
    opts.responderLogin === null || entry.author === opts.responderLogin;
  const countedReview = newReviewEntries.filter(countsAsReply);
  const countedIssue = newIssueEntries.filter(countsAsReply);
  if (countedReview.length > 0 || countedIssue.length > 0) {
    const who =
      opts.responderLogin === null
        ? 'responder unknown (id-novelty is author-blind)'
        : `responder ${opts.responderLogin} recorded (attribution strict: author === responderLogin)`;
    reasons.push({
      kind: 'responder-reply',
      detail: `${who}; new review comment ids [${countedReview.map((entry) => entry.id).join(', ')}]; new issue comment ids [${countedIssue.map((entry) => entry.id).join(', ')}]`,
    });
  }

  // thread-resolved: a thread id newly in the resolved set.
  const newResolvedIds = after.resolvedThreadIds.filter(
    (id) => !before.resolvedThreadIds.includes(id),
  );
  if (newResolvedIds.length > 0) {
    reasons.push({
      kind: 'thread-resolved',
      detail: `newly resolved thread ids [${newResolvedIds.join(', ')}]`,
    });
  }

  const progress = reasons.length > 0;
  return {
    progress,
    reasons,
    summary: progress
      ? `PROGRESS: ${reasons.map((reason) => reason.kind).join(', ')}`
      : 'NO PROGRESS',
  };
}
