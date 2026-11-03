// Split provenance: test/ops/merge/classifyPrs.test.ts was split by subject into
// classifyPrs.{rows,temporal,all-clear,allClearPattern,acceptance,config,objections}.test.ts
// plus classifyPrs.helpers.ts (shared fixtures). This file carries the
// outstanding-objection row (row 6, merge_objection_outstanding).
import { describe, expect, test } from 'vitest';
import { REVIEW_ACCEPT_SETTLE_MS } from '../../../src/ops/merge/classify.config.js';
import { classifyPr } from '../../../src/ops/merge/classifyPrs.js';
import { BEFORE_COMMIT, SETTLED_MS, approved, candidate } from './classifyPrs.helpers.js';

// ---------------------------------------------------------------------------
// Row 6 — an outstanding objection is not silence (NOTHING MERGES UNINVITED)
// ---------------------------------------------------------------------------

describe('classifyPr — outstanding objections (row 6, merge_objection_outstanding)', () => {
  test('post-commit CHANGES_REQUESTED + post-commit APPROVED + settle elapsed → awaiting', () => {
    // The exact mixed case: an approval cannot carry a PR that also
    // carries an open objection — the objection must be resolved first.
    const result = classifyPr(
      candidate({
        reviews: [
          approved({ state: 'CHANGES_REQUESTED', body: 'the retry loop can spin forever' }),
          approved({ id: 'PRR_2' }),
        ],
      }),
      SETTLED_MS,
    );
    expect(result.verdict).toBe('awaiting');
    expect(result.reason).toBe('merge_objection_outstanding');
  });

  test('a post-commit CHANGES_REQUESTED review alone → awaiting (merge_objection_outstanding)', () => {
    const result = classifyPr(
      candidate({ reviews: [approved({ state: 'CHANGES_REQUESTED' })] }),
      SETTLED_MS,
    );
    expect(result.verdict).toBe('awaiting');
    expect(result.reason).toBe('merge_objection_outstanding');
  });

  test('CHANGES_REQUESTED + settle fully elapsed → STILL awaiting (settle never cures an open objection)', () => {
    const result = classifyPr(
      candidate({ reviews: [approved({ state: 'CHANGES_REQUESTED' })] }),
      SETTLED_MS + REVIEW_ACCEPT_SETTLE_MS,
    );
    expect(result.verdict).toBe('awaiting');
    expect(result.reason).toBe('merge_objection_outstanding');
  });

  test('a CHANGES_REQUESTED submitted pre-commit does NOT trigger (same temporal screen)', () => {
    const result = classifyPr(
      candidate({
        reviews: [approved({ state: 'CHANGES_REQUESTED', submittedAt: BEFORE_COMMIT })],
      }),
      SETTLED_MS,
    );
    expect(result.verdict).toBe('awaiting');
    expect(result.reason).toBe('no_acceptable_review');
  });

  test('a CHANGES_REQUESTED by the PR author does not trigger (non-author rule)', () => {
    const result = classifyPr(
      candidate({
        reviews: [approved({ state: 'CHANGES_REQUESTED', authorLogin: 'pr-author' })],
      }),
      SETTLED_MS,
    );
    expect(result.verdict).toBe('awaiting');
    expect(result.reason).toBe('no_acceptable_review');
  });

  test('withdrawn — the verdict flips to APPROVED and the objection stops blocking', () => {
    const result = classifyPr(
      candidate({
        reviews: [approved({ body: 'withdrawing my objection — resolved upstream' })],
      }),
      SETTLED_MS,
    );
    expect(result.verdict).toBe('eligible');
    expect(result.reason).toBe('settle_window_elapsed');
  });
});
