// Split provenance: this suite was split out of
// test/ops/review/classifyThreads.test.ts into the classifyThreads.*.test.ts
// siblings in this directory; shared fixtures live in classifyThreads.helpers.ts.
//
// E2 slice 1 — tests for the classifyThreads pure decision table
// (src/ops/review/classifyThreads.ts + classify.config.ts), round 1.
//
// Pinned here:
//   1. The FULL decision table, one test per row (rows 1–15 of the module
//      doc): threads (resolved / responder-authored / bot-skip / outdated /
//      responder-last-word / fallback), reviews (responder-authored /
//      bot-skip / dismissed / already-answered / empty-body triple —
//      approval_no_body | commented_no_body | empty_summary_no_state — /
//      fallback), top-level comments (responder-authored / bot-skip /
//      fallback).
//   2. Row-order precedence: threads (resolved beats outdated 1 > 4;
//      responder-authored beats bot-skip and outdated 2 > 3, 2 > 4) and
//      reviews (responder-authored beats bot-skip and dismissed 7 > 8, 7 > 9;
//      bot-skip beats dismissed 8 > 9; dismissed beats answered 9 > 10;
//      dismissed beats the approval/empty row 9 > 11).
//   3. Truncation propagation: truncated/truncatedBecause are copied
//      VERBATIM (defensively cloned) from the fetched state — consumers
//      must consult the flag before dispatching batches (a
//      reviewThreads.lag fetch means fresh threads are missing from the
//      verdict set; fail closed downstream).
//   4. Null handling: null/unparseable timestamps fall back per
//      config.treatNullCreatedAtAs (both values) where timestamps ORDER
//      things; a null authorLogin is never the responder (fails toward
//      actionable); a null responder matches nobody.
//   5. Two verdicts demand a REAL reply timestamp: ANSWERING a review
//      (row 10) and a thread's LAST WORD (row 5) — a null/unparseable
//      reply never speaks (fails toward actionable), under either
//      treatNullCreatedAtAs value. Summary-answer evidence is TOP-LEVEL
//      issue comments ONLY (restIssueComments): thread replies
//      (restReviewComments) answer threads via row 5 and never void a
//      review summary.
//   6. nowMs is the ONLY clock: moving the injected nowMs moves the
//      null-submittedAt fallback and thread last-word ordering.
//   7. Both-values coverage for the flip-able config flags
//      (blockOnOutdatedThreads, skipResponderAuthoredThreads,
//      skipDismissedReviews, skipApprovalReviews), mirroring the timestamp
//      pair style.
//   8. config.responderIs is REAL: the 'pr-author' value selects
//      state.authorLogin via the exhaustive switch.
//   9. Every default skipPattern fires on its bot-anchored phrasing class
//      and none fires on human sentences ("review failed to consider",
//      "I'm not reviewing the migrations this pass").
//  10. A single state exercises all five frozen verdicts.
//
// Pure data tests: no gh, no I/O, no clocks — instant by construction.
//
// Split across sibling files: decisionTable (this file), truncation,
// precedence, nullTimestamps, answering, answerScan, nullAuthor, configFlags,
// responderIs, skipPatterns, statelessPatterns, verdictCensus.
import { describe, expect, test } from 'vitest';
import type { ClassifiedItem } from '../../../src/ops/review/classifyThreads.js';
import type { FetchedReviewState } from '../../../src/adapters/forge-github/fetchReviewState.js';
import {
  baseState,
  itemsOf,
  restComment,
  review,
  said,
  thread,
  T1,
  T2,
} from './classifyThreads.helpers.js';

// ---------------------------------------------------------------------------
// The decision table — rows 1–15, one test each (16 cases: row 11 carries
// two case flavors, APPROVED and null-state; COMMENTED/CHANGES_REQUESTED
// arms live in the approval describe below)
// ---------------------------------------------------------------------------

interface RowCase {
  name: string;
  state: FetchedReviewState;
  expected: ClassifiedItem[];
}

const ROW_CASES: RowCase[] = [
  {
    name: 'row 1 — a resolved thread → resolved (thread_resolved)',
    state: baseState({ threads: [thread({ id: 'T1', isResolved: true })] }),
    expected: [
      {
        kind: 'thread',
        id: 'T1',
        verdict: 'resolved',
        path: 'src/a.ts',
        reason: 'thread_resolved',
      },
    ],
  },
  {
    name: 'row 2 — a thread the responder authored → skip (responder_authored)',
    state: baseState({ threads: [thread({ id: 'T2', authorLogin: 'pr-author' })] }),
    expected: [
      { kind: 'thread', id: 'T2', verdict: 'skip', path: 'src/a.ts', reason: 'responder_authored' },
    ],
  },
  {
    name: 'row 3 — a thread whose root body is a bot skip notice → skip (bot_skip_notice)',
    state: baseState({ threads: [thread({ id: 'T3', body: 'CodeRabbit skipped this run' })] }),
    expected: [
      { kind: 'thread', id: 'T3', verdict: 'skip', path: 'src/a.ts', reason: 'bot_skip_notice' },
    ],
  },
  {
    name: 'row 4 — an outdated unresolved thread → blocked (outdated_unresolved)',
    state: baseState({ threads: [thread({ id: 'T4', isOutdated: true })] }),
    expected: [
      {
        kind: 'thread',
        id: 'T4',
        verdict: 'blocked',
        path: 'src/a.ts',
        reason: 'outdated_unresolved',
      },
    ],
  },
  {
    name: 'row 5 — the responder holds the last reply → responded (responder_last_word)',
    state: baseState({
      threads: [
        thread({
          id: 'T5',
          replies: [said('reviewer', T1, 'question'), said('pr-author', T2, 'fixed')],
        }),
      ],
    }),
    expected: [
      {
        kind: 'thread',
        id: 'T5',
        verdict: 'responded',
        path: 'src/a.ts',
        reason: 'responder_last_word',
      },
    ],
  },
  {
    name: 'row 6 — an unresolved external thread → actionable (thread_needs_response)',
    state: baseState({ threads: [thread({ id: 'T6' })] }),
    expected: [
      {
        kind: 'thread',
        id: 'T6',
        verdict: 'actionable',
        path: 'src/a.ts',
        reason: 'thread_needs_response',
      },
    ],
  },
  {
    name: 'row 7 — a review authored by the responder → skip (responder_authored)',
    state: baseState({ reviews: [review({ id: 'R7', authorLogin: 'pr-author' })] }),
    expected: [
      { kind: 'review', id: 'R7', verdict: 'skip', path: null, reason: 'responder_authored' },
    ],
  },
  {
    name: 'row 8 — a review whose body is a bot failure notice → skip (bot_skip_notice)',
    state: baseState({
      reviews: [
        review({ id: 'R8', body: 'CodeRabbit failed to complete: error after 3 attempts' }),
      ],
    }),
    expected: [
      { kind: 'review', id: 'R8', verdict: 'skip', path: null, reason: 'bot_skip_notice' },
    ],
  },
  {
    name: 'row 9 — a DISMISSED review → skip (review_dismissed)',
    state: baseState({ reviews: [review({ id: 'R9', state: 'DISMISSED' })] }),
    expected: [
      { kind: 'review', id: 'R9', verdict: 'skip', path: null, reason: 'review_dismissed' },
    ],
  },
  {
    name: 'row 10 — a responder TOP-LEVEL issue comment postdates the review → skip (review_already_answered)',
    state: baseState({
      reviews: [review({ id: 'R10', body: 'Please change X', submittedAt: T1 })],
      restIssueComments: [restComment({ id: 501, authorLogin: 'pr-author', createdAt: T2 })],
    }),
    expected: [
      { kind: 'review', id: 'R10', verdict: 'skip', path: null, reason: 'review_already_answered' },
      // The answer itself also classifies (row 13: the responder's own
      // comment is not feedback).
      { kind: 'comment', id: '501', verdict: 'skip', path: null, reason: 'responder_authored' },
    ],
  },
  {
    name: 'row 11 (APPROVED) — an approval with an EMPTY body → skip (approval_no_body)',
    state: baseState({ reviews: [review({ id: 'R11a', state: 'APPROVED', body: '' })] }),
    expected: [
      { kind: 'review', id: 'R11a', verdict: 'skip', path: null, reason: 'approval_no_body' },
    ],
  },
  {
    name: 'row 11 (null state) — a stateless review with an EMPTY body → skip (empty_summary_no_state)',
    state: baseState({ reviews: [review({ id: 'R11b', state: null, body: '   ' })] }),
    expected: [
      { kind: 'review', id: 'R11b', verdict: 'skip', path: null, reason: 'empty_summary_no_state' },
    ],
  },
  {
    name: 'row 12 — a plain review summary → actionable (review_summary_needs_response)',
    state: baseState({ reviews: [review({ id: 'R12', body: 'Please add a test' })] }),
    expected: [
      {
        kind: 'review',
        id: 'R12',
        verdict: 'actionable',
        path: null,
        reason: 'review_summary_needs_response',
      },
    ],
  },
  {
    name: 'row 13 — a conversation comment the responder authored → skip (responder_authored)',
    state: baseState({
      restIssueComments: [restComment({ id: 601, authorLogin: 'pr-author' })],
    }),
    expected: [
      { kind: 'comment', id: '601', verdict: 'skip', path: null, reason: 'responder_authored' },
    ],
  },
  {
    name: 'row 14 — a conversation comment matching a skip pattern → skip (bot_skip_notice)',
    state: baseState({
      restIssueComments: [restComment({ id: 602, body: 'CodeRabbit is skipping this draft' })],
    }),
    expected: [
      { kind: 'comment', id: '602', verdict: 'skip', path: null, reason: 'bot_skip_notice' },
    ],
  },
  {
    name: 'row 15 — a plain top-level comment → actionable (top_level_summary)',
    state: baseState({
      restIssueComments: [restComment({ id: 603, body: 'Overall: please split this module' })],
    }),
    expected: [
      {
        kind: 'comment',
        id: '603',
        verdict: 'actionable',
        path: null,
        reason: 'top_level_summary',
      },
    ],
  },
];

describe('classifyThreads decision table', () => {
  test.each(ROW_CASES)('$name', ({ state, expected }) => {
    expect(itemsOf(state)).toEqual(expected);
  });
});
