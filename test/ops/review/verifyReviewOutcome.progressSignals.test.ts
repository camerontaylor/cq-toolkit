// E3 slice 2 — tests for verifyReviewOutcome
// (src/ops/review/verifyReviewOutcome.ts; UC §2 row 37).
//
// Split provenance: the progress-signal cases moved verbatim from
// test/ops/review/verifyReviewOutcome.test.ts; the shared fixtures live in
// `verifyReviewOutcome.helpers.ts`.
//
// Pinned here:
//   2. Each signal fires ALONE and lands its own reason + summary:
//      new-commit, responder-reply (new review id), responder-reply (new
//      issue id), thread-resolved.
//   3. Multiple reasons → all present in order, summary lists every kind.
//   4. The STRICT head sha: snapshots carry a VERIFIED string headSha — a
//      PR payload without a usable head.sha THROWS (a headless snapshot
//      could never see new-commit movement); identical shas → nothing,
//      different shas → new-commit.
import { describe, expect, test } from 'vitest';
import { verifyPrOutcome } from '../../../src/ops/review/verifyReviewOutcome.js';
import { baseSnapshot } from './verifyReviewOutcome.helpers.js';

// ---------------------------------------------------------------------------
// 2–4. Each signal alone; multiple reasons; the null-sha rule
// ---------------------------------------------------------------------------

describe('progress signals', () => {
  test('head sha changed alone → new-commit reason, summary "PROGRESS: new-commit"', () => {
    const outcome = verifyPrOutcome(baseSnapshot(), baseSnapshot({ headSha: 'def456' }), {
      responderLogin: null,
    });
    expect(outcome.progress).toBe(true);
    expect(outcome.reasons).toEqual([
      { kind: 'new-commit', detail: 'head sha moved "abc123" → "def456"' },
    ]);
    expect(outcome.summary).toBe('PROGRESS: new-commit');
  });

  test('a responder-AUTHORED new review comment with a KNOWN responder → responder-reply (the strict attribution gate passes)', () => {
    const outcome = verifyPrOutcome(
      baseSnapshot(),
      baseSnapshot({
        reviewComments: [
          { id: 9001, author: 'pr-author' },
          { id: 9002, author: 'pr-author' },
        ],
      }),
      { responderLogin: 'pr-author' },
    );
    expect(outcome.progress).toBe(true);
    expect(outcome.reasons).toHaveLength(1);
    expect(outcome.reasons[0]?.kind).toBe('responder-reply');
    // responderLogin is RECORDED in the detail — and the gate it passed.
    expect(outcome.reasons[0]?.detail).toContain('responder pr-author');
    expect(outcome.reasons[0]?.detail).toContain('attribution strict');
    expect(outcome.reasons[0]?.detail).toContain('9002');
    expect(outcome.summary).toBe('PROGRESS: responder-reply');
  });

  test('a THIRD-PARTY new comment with a KNOWN responder is NOT progress (attribution is strict — no certifying without evidence)', () => {
    const outcome = verifyPrOutcome(
      baseSnapshot(),
      baseSnapshot({
        reviewComments: [
          { id: 9001, author: 'pr-author' },
          { id: 9002, author: 'someone-else' },
        ],
      }),
      { responderLogin: 'pr-author' },
    );
    expect(outcome.progress).toBe(false);
    expect(outcome.reasons).toEqual([]);
    expect(outcome.summary).toBe('NO PROGRESS');
  });

  test('a NULL-author new comment with a KNOWN responder does NOT count (unattributable ≠ evidence)', () => {
    const outcome = verifyPrOutcome(
      baseSnapshot(),
      baseSnapshot({
        reviewComments: [
          { id: 9001, author: 'pr-author' },
          { id: 9002, author: null },
        ],
      }),
      { responderLogin: 'pr-author' },
    );
    expect(outcome.progress).toBe(false);
    expect(outcome.reasons).toEqual([]);
    expect(outcome.summary).toBe('NO PROGRESS');
  });

  test('mixed authorship: only the responder-attributed new comment lands in the reason detail', () => {
    const outcome = verifyPrOutcome(
      baseSnapshot(),
      baseSnapshot({
        reviewComments: [
          { id: 9001, author: 'pr-author' },
          { id: 9002, author: 'someone-else' },
          { id: 9003, author: 'pr-author' },
        ],
      }),
      { responderLogin: 'pr-author' },
    );
    expect(outcome.progress).toBe(true);
    expect(outcome.reasons[0]?.detail).toContain('9003');
    expect(outcome.reasons[0]?.detail).not.toContain('9002');
  });

  test('a new comment with an UNKNOWN responder login → blind id-novelty preserved (any author counts)', () => {
    const outcome = verifyPrOutcome(
      baseSnapshot(),
      baseSnapshot({
        issueComments: [
          { id: 5001, author: 'pr-author' },
          { id: 5002, author: 'someone-else' },
        ],
      }),
      { responderLogin: null },
    );
    expect(outcome.progress).toBe(true);
    expect(outcome.reasons).toHaveLength(1);
    expect(outcome.reasons[0]?.kind).toBe('responder-reply');
    // Blind mode named in the detail.
    expect(outcome.reasons[0]?.detail).toContain('author-blind');
    expect(outcome.reasons[0]?.detail).toContain('5002');
    expect(outcome.summary).toBe('PROGRESS: responder-reply');
  });

  test('a NEW resolved thread id alone → thread-resolved reason, summary "PROGRESS: thread-resolved"', () => {
    const outcome = verifyPrOutcome(
      baseSnapshot(),
      baseSnapshot({ resolvedThreadIds: ['PRRT_old', 'PRRT_new'] }),
      { responderLogin: null },
    );
    expect(outcome.progress).toBe(true);
    expect(outcome.reasons).toEqual([
      { kind: 'thread-resolved', detail: 'newly resolved thread ids [PRRT_new]' },
    ]);
    expect(outcome.summary).toBe('PROGRESS: thread-resolved');
  });

  test('multiple reasons → ALL present in the fixed order, summary lists every kind', () => {
    const outcome = verifyPrOutcome(
      baseSnapshot(),
      baseSnapshot({
        headSha: 'def456',
        reviewComments: [
          { id: 9001, author: 'pr-author' },
          { id: 9002, author: 'pr-author' },
        ],
        issueComments: [
          { id: 5001, author: 'pr-author' },
          { id: 5002, author: 'pr-author' },
        ],
        resolvedThreadIds: ['PRRT_old', 'PRRT_new'],
      }),
      { responderLogin: 'pr-author' },
    );
    expect(outcome.reasons.map((reason) => reason.kind)).toEqual([
      'new-commit',
      'responder-reply',
      'thread-resolved',
    ]);
    expect(outcome.summary).toBe('PROGRESS: new-commit, responder-reply, thread-resolved');
  });

  test('identical head shas → no new-commit reason (the sha is a VERIFIED string; only a real difference moves)', () => {
    const outcome = verifyPrOutcome(baseSnapshot(), baseSnapshot(), { responderLogin: null });
    expect(outcome.progress).toBe(false);
    expect(outcome.reasons).toEqual([]);
    expect(outcome.summary).toBe('NO PROGRESS');
  });
});
