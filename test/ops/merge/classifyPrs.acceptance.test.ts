// Split provenance: test/ops/merge/classifyPrs.test.ts was split by subject into
// classifyPrs.{rows,temporal,all-clear,allClearPattern,acceptance,config,objections}.test.ts
// plus classifyPrs.helpers.ts (shared fixtures). This file carries what counts
// as acceptable review evidence: plain exact-head PASS signals, the row-6
// reviewer rules, and the row-7 verdict states.
import { describe, expect, test } from 'vitest';
import { classifyPr } from '../../../src/ops/merge/classifyPrs.js';
import {
  PENDING_MS,
  SETTLED_MS,
  agentMarker,
  approved,
  candidate,
  comment,
  settleCandidate,
  thread,
} from './classifyPrs.helpers.js';

describe('plain independent review acceptance', () => {
  test.each([{ authorType: 'Bot' }, { authorLogin: 'reviewer[bot]' }])(
    'ignores bot review signals: %j',
    (author) => {
      expect(
        classifyPr(
          candidate({
            headRefOid: 'a'.repeat(40),
            issueComments: [
              comment({
                body: `${'a'.repeat(40)} PASS`,
                ...author,
              }),
            ],
          }),
          PENDING_MS,
        ).reason,
      ).toBe('no_acceptable_review');
    },
  );

  test('accepts a plain top-level PR comment with the exact head and PASS', () => {
    expect(
      classifyPr(
        candidate({
          headRefOid: 'a'.repeat(40),
          issueComments: [comment({ body: `opus ${'a'.repeat(40)} PASS` })],
        }),
        PENDING_MS,
      ).reason,
    ).toBe('settle_window_pending');
  });
  test.each([`Reviewer opus: ${'a'.repeat(40)} PASS`, agentMarker('PASS')])(
    'accepts a shared-account exact-head PASS without opt-in: %s',
    (body) => {
      const pr = candidate({
        authorLogin: 'pr-author',
        headRefOid: 'a'.repeat(40),
        reviews: [approved({ authorLogin: 'pr-author', state: 'COMMENTED', body })],
      });
      expect(classifyPr(pr, PENDING_MS).reason).toBe('settle_window_pending');
    },
  );
  test.each(['PASS', `${'b'.repeat(40)} PASS`, `${'a'.repeat(40)} HOLD`])(
    'ignores evidence missing the current head and PASS: %s',
    (body) => {
      expect(
        classifyPr(
          candidate({
            headRefOid: 'a'.repeat(40),
            reviews: [approved({ state: 'COMMENTED', body })],
          }),
          PENDING_MS,
        ).reason,
      ).toBe('no_acceptable_review');
    },
  );
});

// ---------------------------------------------------------------------------
// What counts as an acceptable review (row 6) — no reviewer privileged
// ---------------------------------------------------------------------------

describe('classifyPr — acceptable-review rules (row 6)', () => {
  test('an author self-review does not satisfy row 6', () => {
    const result = classifyPr(
      candidate({ reviews: [approved({ authorLogin: 'pr-author' })] }),
      SETTLED_MS,
    );
    expect(result.verdict).toBe('awaiting');
    expect(result.reason).toBe('no_acceptable_review');
  });

  test('a bot skip/failure notice does not satisfy row 7 (skipPatterns)', () => {
    const result = classifyPr(
      candidate({
        reviews: [
          approved({
            authorLogin: 'coderabbitai[bot]',
            state: 'COMMENTED',
            body: 'CodeRabbit skipped this run because of a configuration error.',
          }),
        ],
      }),
      SETTLED_MS,
    );
    expect(result.reason).toBe('no_acceptable_review');
  });

  test('a SPLIT-LINE bot notice ("CodeRabbit" alone on its line, verb on the next) is not a review', () => {
    // Round 3: the bounded window spans line breaks ([\s\S]{0,80}, kept in
    // sync with ws-e's copy) — the split rendering does not dodge the skip
    // screen.
    const result = classifyPr(
      candidate({
        reviews: [
          approved({
            authorLogin: 'coderabbitai[bot]',
            state: 'COMMENTED',
            body: 'CodeRabbit\nskipped this run',
          }),
        ],
      }),
      SETTLED_MS,
    );
    expect(result.verdict).toBe('awaiting');
    expect(result.reason).toBe('no_acceptable_review');
  });

  test('a DISMISSED review does not satisfy row 6 (voided verdict)', () => {
    const result = classifyPr(
      candidate({ reviews: [approved({ state: 'DISMISSED' })] }),
      SETTLED_MS,
    );
    expect(result.reason).toBe('no_acceptable_review');
  });

  test('a non-author BOT review DOES satisfy row 6 (no reviewer privileged)', () => {
    const result = classifyPr(
      candidate({
        reviews: [
          approved({
            authorLogin: 'coderabbitai[bot]',
            state: 'COMMENTED',
            body: 'reviewed the diff and left two nitpicks.',
          }),
        ],
      }),
      SETTLED_MS,
    );
    expect(result.verdict).toBe('eligible');
    expect(result.reason).toBe('settle_window_elapsed');
  });

  test('a null-authorLogin review DOES satisfy row 6 (external — fail toward accepting)', () => {
    const result = classifyPr(
      candidate({ reviews: [approved({ authorLogin: null })] }),
      SETTLED_MS,
    );
    expect(result.verdict).toBe('eligible');
    expect(result.reason).toBe('settle_window_elapsed');
  });

  test("the author's own unresolved thread does not block (row 5 excludes the PR author)", () => {
    const result = classifyPr(
      settleCandidate({ threads: [thread({ authorLogin: 'pr-author' })] }),
      SETTLED_MS,
    );
    expect(result.unresolvedExternalThreads).toBe(0);
    expect(result.reason).toBe('settle_window_elapsed');
  });
});

// ---------------------------------------------------------------------------
// Acceptance VERDICTS (row 6) — only APPROVED/COMMENTED carry evidence
// ---------------------------------------------------------------------------

describe('classifyPr — acceptance states (row 7)', () => {
  test('a post-commit COMMENTED review IS acceptable (control: the settle flow works)', () => {
    const result = classifyPr(
      candidate({ reviews: [approved({ state: 'COMMENTED' })] }),
      SETTLED_MS,
    );
    expect(result.verdict).toBe('eligible');
    expect(result.reason).toBe('settle_window_elapsed');
  });

  test('a null-state review never counts (fail toward awaiting)', () => {
    const result = classifyPr(candidate({ reviews: [approved({ state: null })] }), SETTLED_MS);
    expect(result.verdict).toBe('awaiting');
    expect(result.reason).toBe('no_acceptable_review');
  });
});
