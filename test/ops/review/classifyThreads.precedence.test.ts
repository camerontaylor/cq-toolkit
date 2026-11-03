// Split provenance: test/ops/review/classifyThreads.test.ts was split into the
// classifyThreads.*.test.ts siblings in this directory; shared fixtures live in
// classifyThreads.helpers.ts.
import { describe, expect, test } from 'vitest';
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
// Row-order precedence
// ---------------------------------------------------------------------------

describe('row-order precedence — threads', () => {
  test('row 1 beats row 4 — a resolved outdated thread → resolved, not blocked', () => {
    expect(
      itemsOf(baseState({ threads: [thread({ id: 'TP1', isResolved: true, isOutdated: true })] })),
    ).toEqual([
      {
        kind: 'thread',
        id: 'TP1',
        verdict: 'resolved',
        path: 'src/a.ts',
        reason: 'thread_resolved',
      },
    ]);
  });

  test('row 2 beats row 4 — an outdated responder-authored thread → skip, not blocked', () => {
    expect(
      itemsOf(
        baseState({ threads: [thread({ id: 'TP2', authorLogin: 'pr-author', isOutdated: true })] }),
      ),
    ).toEqual([
      {
        kind: 'thread',
        id: 'TP2',
        verdict: 'skip',
        path: 'src/a.ts',
        reason: 'responder_authored',
      },
    ]);
  });

  test('row 2 beats row 3 — a responder-authored bot-skip body → responder_authored', () => {
    expect(
      itemsOf(
        baseState({
          threads: [
            thread({ id: 'TP3', authorLogin: 'pr-author', body: 'CodeRabbit skipped this run' }),
          ],
        }),
      ),
    ).toEqual([
      {
        kind: 'thread',
        id: 'TP3',
        verdict: 'skip',
        path: 'src/a.ts',
        reason: 'responder_authored',
      },
    ]);
  });

  test('row 5 only fires when the responder holds the LAST word — reviewer last → actionable', () => {
    expect(
      itemsOf(
        baseState({
          threads: [
            thread({
              id: 'TP4',
              replies: [said('pr-author', T1, 'fixed'), said('reviewer', T2, 'still broken')],
            }),
          ],
        }),
      ),
    ).toEqual([
      {
        kind: 'thread',
        id: 'TP4',
        verdict: 'actionable',
        path: 'src/a.ts',
        reason: 'thread_needs_response',
      },
    ]);
  });

  test('row 3 beats row 4 — a bot-notice body on an OUTDATED thread → skip, not blocked', () => {
    expect(
      itemsOf(
        baseState({
          threads: [thread({ id: 'TP5', isOutdated: true, body: 'CodeRabbit skipped this run' })],
        }),
      ),
    ).toEqual([
      { kind: 'thread', id: 'TP5', verdict: 'skip', path: 'src/a.ts', reason: 'bot_skip_notice' },
    ]);
  });

  test('row 4 beats row 5 — an OUTDATED thread where the responder holds the last word → blocked, not responded', () => {
    expect(
      itemsOf(
        baseState({
          threads: [
            thread({
              id: 'TP6',
              isOutdated: true,
              replies: [said('reviewer', T1), said('pr-author', T2)],
            }),
          ],
        }),
      ),
    ).toEqual([
      {
        kind: 'thread',
        id: 'TP6',
        verdict: 'blocked',
        path: 'src/a.ts',
        reason: 'outdated_unresolved',
      },
    ]);
  });
});

describe('row-order precedence — reviews (documented ordering)', () => {
  test('row 7 precedes rows 8–9 — a DISMISSED responder-authored review → responder_authored', () => {
    // Documented call: authorship settles it first — the responder's own
    // review is not outstanding feedback no matter what it carries.
    expect(
      itemsOf(
        baseState({
          reviews: [review({ id: 'RP1', authorLogin: 'pr-author', state: 'DISMISSED' })],
        }),
      ),
    ).toEqual([
      { kind: 'review', id: 'RP1', verdict: 'skip', path: null, reason: 'responder_authored' },
    ]);
  });

  test('row 7 precedes row 8 — a responder-authored review with a bot-notice body → responder_authored', () => {
    expect(
      itemsOf(
        baseState({
          reviews: [
            review({ id: 'RP2', authorLogin: 'pr-author', body: 'CodeRabbit skipped this run' }),
          ],
        }),
      ),
    ).toEqual([
      { kind: 'review', id: 'RP2', verdict: 'skip', path: null, reason: 'responder_authored' },
    ]);
  });

  test('row 8 precedes row 9 — a DISMISSED review with a bot-notice body → bot_skip_notice', () => {
    expect(
      itemsOf(
        baseState({
          reviews: [review({ id: 'RP3', state: 'DISMISSED', body: 'CodeRabbit skipped this run' })],
        }),
      ),
    ).toEqual([
      { kind: 'review', id: 'RP3', verdict: 'skip', path: null, reason: 'bot_skip_notice' },
    ]);
  });

  test('row 9 precedes row 10 — a dismissed review with a postdating responder reply → review_dismissed', () => {
    // Documented call: a voided review stays void regardless of reply
    // timing — dismissal answers the "should anyone act on this" question
    // more strongly than a reply does. (The reply is real row-10 evidence
    // — a top-level issue comment — so the precedence is genuinely
    // exercised.)
    expect(
      itemsOf(
        baseState({
          reviews: [review({ id: 'RP4', state: 'DISMISSED', submittedAt: T1 })],
          restIssueComments: [restComment({ id: 511, authorLogin: 'pr-author', createdAt: T2 })],
        }),
      ),
    ).toEqual([
      { kind: 'review', id: 'RP4', verdict: 'skip', path: null, reason: 'review_dismissed' },
      // The evidence comment itself classifies too (row 13).
      { kind: 'comment', id: '511', verdict: 'skip', path: null, reason: 'responder_authored' },
    ]);
  });

  test('row 9 precedes row 11 — a dismissed EMPTY-body review → review_dismissed, not empty_summary_no_state', () => {
    // Dismissal is the stronger void: it answers "should anyone act on
    // this" before the emptiness check (row 11) is ever consulted.
    expect(
      itemsOf(baseState({ reviews: [review({ id: 'RP5', state: 'DISMISSED', body: '' })] })),
    ).toEqual([
      { kind: 'review', id: 'RP5', verdict: 'skip', path: null, reason: 'review_dismissed' },
    ]);
  });

  test('row 11 sits before the fallback — a NON-empty APPROVED body → actionable, not skipped', () => {
    // Fails toward action: an approver may have noted follow-ups in the
    // body, so a text-carrying approval stays on the content rows.
    expect(
      itemsOf(
        baseState({
          reviews: [
            review({
              id: 'RP6',
              state: 'APPROVED',
              body: 'Approved — but please tighten the retry cap next time.',
            }),
          ],
        }),
      ),
    ).toEqual([
      {
        kind: 'review',
        id: 'RP6',
        verdict: 'actionable',
        path: null,
        reason: 'review_summary_needs_response',
      },
    ]);
  });
});
