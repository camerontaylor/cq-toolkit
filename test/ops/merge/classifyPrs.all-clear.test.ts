// Split provenance: test/ops/merge/classifyPrs.test.ts was split by subject into
// classifyPrs.{rows,temporal,all-clear,allClearPattern,acceptance,config,objections}.test.ts
// plus classifyPrs.helpers.ts (shared fixtures). This file carries the explicit
// all-clear row (row 7) strictness: strictly after, top-level, non-author, and
// timestamped.
import { describe, expect, test } from 'vitest';
import { defaultClassifyPrConfig } from '../../../src/ops/merge/classify.config.js';
import type { ClassifyPrConfig } from '../../../src/ops/merge/classify.config.js';
import { classifyPr } from '../../../src/ops/merge/classifyPrs.js';
import {
  BEFORE_COMMIT,
  LAST_COMMIT,
  PENDING_MS,
  SETTLED_MS,
  approved,
  candidate,
  comment,
  settleCandidate,
} from './classifyPrs.helpers.js';

// ---------------------------------------------------------------------------
// The explicit all-clear (row 7) — strictly after, top-level, non-author,
// timestamped; anything else falls through to the settle rows
// ---------------------------------------------------------------------------

describe('classifyPr — the explicit all-clear is strict', () => {
  test('all-clear at-or-before the last commit falls through (must postdate the final code)', () => {
    const result = classifyPr(
      settleCandidate({
        issueComments: [comment({ createdAt: BEFORE_COMMIT })],
      }),
      PENDING_MS,
    );
    expect(result.verdict).toBe('awaiting');
    expect(result.reason).toBe('settle_window_pending');
  });

  test('all-clear at EXACTLY the last commit time is not strictly after — falls through', () => {
    const result = classifyPr(
      settleCandidate({ issueComments: [comment({ createdAt: LAST_COMMIT })] }),
      PENDING_MS,
    );
    expect(result.reason).toBe('settle_window_pending');
  });

  test("the author's own all-clear does not count (non-author rule)", () => {
    const result = classifyPr(
      settleCandidate({
        issueComments: [comment({ authorLogin: 'pr-author', body: 'lgtm' })],
      }),
      PENDING_MS,
    );
    expect(result.reason).toBe('settle_window_pending');
  });

  test('a REPLY carrying the all-clear does not count (top-level only)', () => {
    const result = classifyPr(
      settleCandidate({ issueComments: [comment({ inReplyToId: 55, body: 'lgtm' })] }),
      PENDING_MS,
    );
    expect(result.reason).toBe('settle_window_pending');
  });

  test('an un-timestamped all-clear never qualifies (cannot be shown to postdate)', () => {
    const result = classifyPr(
      settleCandidate({ issueComments: [comment({ createdAt: null })] }),
      PENDING_MS,
    );
    expect(result.reason).toBe('settle_window_pending');
  });

  test('a caveat sentence ("looks good, but …") is not an all-clear (must END its line)', () => {
    const result = classifyPr(
      settleCandidate({
        reviews: [approved({ body: 'looks good, but fix the retry loop first' })],
      }),
      PENDING_MS,
    );
    expect(result.reason).toBe('settle_window_pending');
  });

  test('a SPLIT-LINE caveat ("LGTM" alone on its line, objection on the next) falls through', () => {
    // The whole-body anchor (round 3): with a multiline flag, "LGTM" alone
    // on line 1 would have matched; now the next-line objection kills it.
    const result = classifyPr(
      settleCandidate({
        issueComments: [comment({ body: 'LGTM\nbut fix the retry loop first' })],
      }),
      PENDING_MS,
    );
    expect(result.verdict).toBe('awaiting');
    expect(result.reason).toBe('settle_window_pending');
  });

  test('a bot skip notice is never all-clear evidence, even with a bare all-clear phrase on its own line', () => {
    // The skip guard in isAllClearAfter fires BEFORE the pattern: without
    // it, line 2 ("no further issues") is a bare line-start/end pattern
    // match, and a punted review would read as approval.
    const result = classifyPr(
      settleCandidate({
        issueComments: [
          comment({
            body: 'CodeRabbit skipped this run due to a configuration error.\nno further issues',
          }),
        ],
      }),
      PENDING_MS,
    );
    expect(result.verdict).toBe('awaiting');
    expect(result.reason).toBe('settle_window_pending');
  });

  test('a comment all-clear with ZERO reviews → awaiting (row 6 precedes row 7)', () => {
    // The all-clear bypasses ONLY the settle wait — it never stands in
    // for the review-of-head requirement.
    const result = classifyPr(candidate({ issueComments: [comment()] }), SETTLED_MS);
    expect(result.verdict).toBe('awaiting');
    expect(result.reason).toBe('no_acceptable_review');
  });

  test('a DISMISSED review with an "LGTM" body is not all-clear evidence (row 7 state filter)', () => {
    // Row 6 passes on the live review; the retracted "LGTM" must not
    // bypass the settle wait — it falls through to settle logic.
    const result = classifyPr(
      settleCandidate({
        reviews: [approved(), approved({ id: 'PRR_2', state: 'DISMISSED', body: 'LGTM' })],
      }),
      PENDING_MS,
    );
    expect(result.verdict).toBe('awaiting');
    expect(result.reason).toBe('settle_window_pending');
  });

  test('DISMISSED is void even when a hostile runtime config admits it (review r3)', () => {
    // The dispatch boundary refuses DISMISSED in acceptReviewStates, and
    // the TS union omits it — but classifyPr is a pure function any
    // non-typechecked caller can invoke. stateCounts holds the doctrine
    // directly: a retracted review is never acceptance evidence, whatever
    // set reaches it. Row 7 fails on the only review → no_acceptable_review.
    const result = classifyPr(
      settleCandidate({ reviews: [approved({ id: 'PRR_2', state: 'DISMISSED' })] }),
      SETTLED_MS,
      {
        ...defaultClassifyPrConfig,
        acceptReviewStates: ['DISMISSED'],
      } as unknown as ClassifyPrConfig,
    );
    expect(result.verdict).toBe('awaiting');
    expect(result.reason).toBe('no_acceptable_review');
  });

  test('a CHANGES_REQUESTED review with an "LGTM" body never reaches the all-clear row — the objection row fires first', () => {
    const result = classifyPr(
      settleCandidate({
        reviews: [approved(), approved({ id: 'PRR_2', state: 'CHANGES_REQUESTED', body: 'LGTM' })],
      }),
      PENDING_MS,
    );
    expect(result.verdict).toBe('awaiting');
    expect(result.reason).toBe('merge_objection_outstanding');
  });
});
