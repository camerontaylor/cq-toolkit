// E3 slice 2 — tests for verifyReviewOutcome
// (src/ops/review/verifyReviewOutcome.ts; UC §2 row 37).
//
// Split provenance: THE CONTRACT TEST moved verbatim from
// test/ops/review/verifyReviewOutcome.test.ts; the shared fixtures live in
// `verifyReviewOutcome.helpers.ts`.
//
// Pinned here:
//   1. THE CONTRACT TEST: a hallucinated "done" — before === after (byte-
//      identical snapshots) — is progress FALSE with the exact literal
//      summary 'NO PROGRESS'. Inputs are frozen (the verifier is pure and
//      must not mutate its evidence).
import { describe, expect, test } from 'vitest';
import type { PrSnapshot } from '../../../src/adapters/forge-github/snapshotPrState.js';
import { verifyPrOutcome } from '../../../src/ops/review/verifyReviewOutcome.js';
import { baseSnapshot } from './verifyReviewOutcome.helpers.js';

describe('the anti-hallucination contract', () => {
  test('identical snapshots (a hallucinated "done") → progress false, summary EXACTLY "NO PROGRESS"', () => {
    const before = Object.freeze({
      ...baseSnapshot(),
      reviewComments: Object.freeze([{ id: 9001, author: 'pr-author' }]),
      issueComments: Object.freeze([{ id: 5001, author: 'pr-author' }]),
      resolvedThreadIds: Object.freeze(['PRRT_old']),
    }) as PrSnapshot;
    const after = Object.freeze({
      ...baseSnapshot(),
      reviewComments: Object.freeze([{ id: 9001, author: 'pr-author' }]),
      issueComments: Object.freeze([{ id: 5001, author: 'pr-author' }]),
      resolvedThreadIds: Object.freeze(['PRRT_old']),
    }) as PrSnapshot;
    const outcome = verifyPrOutcome(before, after, { responderLogin: 'pr-author' });
    expect(outcome.progress).toBe(false);
    expect(outcome.reasons).toEqual([]);
    // The workstream contract literal — greppable, machine-checkable.
    expect(outcome.summary).toBe('NO PROGRESS');
    // Purity: frozen inputs were only read, never mutated.
    expect(before.headSha).toBe('abc123');
    expect(after.headSha).toBe('abc123');
  });
});
