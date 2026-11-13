import { describe, expect, test } from 'vitest';
import {
  isIgnoredBotAuthor,
  isReviewAppAuthor,
  parseIndependentReview,
  latestCrqReviewEvidence,
} from '../../src/shared/independent-review.js';

describe('cq-review App author', () => {
  test.each([
    ['Bot', 'cq-review[bot]', true],
    ['Bot', 'cq-review', true],
    ['User', 'cq-review[bot]', true],
    ['User', 'cq-review', false],
    ['Bot', 'CQ-REVIEW[bot]', false],
    ['Bot', 'cq-reviewer[bot]', false],
    [null, null, false],
  ] as const)('isReviewAppAuthor(%s, %s) is %s', (type, login, expected) => {
    expect(isReviewAppAuthor(type, login)).toBe(expected);
  });
  test('every other bot stays ignored; users are never ignored', () => {
    expect(isIgnoredBotAuthor('Bot', 'cq-review')).toBe(false);
    expect(isIgnoredBotAuthor('Bot', 'cq-review[bot]')).toBe(false);
    expect(isIgnoredBotAuthor('Bot', 'coderabbitai')).toBe(true);
    expect(isIgnoredBotAuthor('User', 'coderabbitai[bot]')).toBe(true);
    expect(isIgnoredBotAuthor('Bot', null)).toBe(true);
    expect(isIgnoredBotAuthor('User', 'cq-review')).toBe(false);
    expect(isIgnoredBotAuthor('User', 'alice')).toBe(false);
  });
});

const marker = (over: Record<string, unknown> = {}): string =>
  `<!-- cq-agent-review: ${JSON.stringify({
    version: 1,
    reviewerAgentId: 'reviewer-agent',
    authorAgentId: 'author-agent',
    headSha: 'a'.repeat(40),
    verdict: 'PASS',
    independent: true,
    ...over,
  })} -->`;

describe('parseIndependentReview', () => {
  test('matches the current head even when a comment mentions another full SHA first', () => {
    expect(
      parseIndependentReview(`${'b'.repeat(40)} base; ${'a'.repeat(40)} PASS`, 'a'.repeat(40)),
    ).toMatchObject({ kind: 'valid' });
    expect(parseIndependentReview(`${'b'.repeat(40)} PASS`, 'a'.repeat(40))).toEqual({
      kind: 'absent',
    });
  });
  test('accepts one strict, independent, head-bound PASS marker', () => {
    expect(parseIndependentReview(marker())).toMatchObject({
      kind: 'valid',
      attestation: { verdict: 'PASS' },
    });
  });

  test('ordinary prose does not create or supersede a marker', () => {
    expect(parseIndependentReview('I use cq-agent-review markers in our process.')).toEqual({
      kind: 'absent',
    });
  });

  test.each([
    `Reviewer opus: ${'a'.repeat(40)} PASS`,
    marker({ authorAgentId: 'reviewer-agent', independent: false }),
    `${marker()} ${marker()}`,
    `<!-- cq-agent-review-v2: ${'a'.repeat(40)} PASS -->`,
  ])('accepts head-bound PASS without syntax requirements: %s', (body) => {
    expect(parseIndependentReview(body)).toMatchObject({
      kind: 'valid',
      attestation: { headSha: 'a'.repeat(40), verdict: 'PASS' },
    });
  });

  test.each([
    `${'a'.repeat(40)} does not PASS`,
    `${'a'.repeat(40)} BYPASS this`,
    `${'a'.repeat(40)} PASSWORD leaked`,
    `${'a'.repeat(40)} PASS? no - HOLD`,
    `${'a'.repeat(40)} isn't PASS`,
  ])('rejects negated or unrelated PASS: %s', (body) => {
    expect(parseIndependentReview(body)).toEqual({ kind: 'absent' });
  });

  test.each(['PASS', `${'a'.repeat(40)} HOLD`, 'bad PASS'])(
    'ignores incomplete evidence: %s',
    (body) => {
      expect(parseIndependentReview(body)).toEqual({ kind: 'absent' });
    },
  );
});

describe('CRQ exact-head verdict', () => {
  const head = 'a'.repeat(40);
  const review = (verdict: string) =>
    `<!-- crq-findings run=pr7-r1 -->\n**Independent review (CodeRabbit CLI via crq): ${verdict} for \`${head}\`**\nReviewed range ${'b'.repeat(40)}..${head}.`;
  test('accepts CRQ PASS after its unchanged run marker', () => {
    expect(parseIndependentReview(review('PASS'), head)).toMatchObject({ kind: 'valid' });
  });
  test('rejects ITERATE even when the findings mention PASS', () => {
    expect(parseIndependentReview(review('ITERATE') + '\nFix the test before PASS.', head)).toEqual(
      { kind: 'absent' },
    );
  });
});

describe('CRQ history ambiguity', () => {
  const head = 'a'.repeat(40);
  const review = (verdict: string, at: string | null) => ({
    body: `<!-- crq-findings run=r -->\n**Independent review (CodeRabbit CLI via crq): ${verdict} for \`${head}\`**\n`,
    at,
  });
  test('missing chronology and tied contrary latest verdicts fail closed', () => {
    const pass = review('PASS', '2026-01-01T00:00:00Z');
    const iterate = review('ITERATE', pass.at);
    expect(latestCrqReviewEvidence([pass, iterate], head, (r) => r.at)).toEqual([]);
    expect(latestCrqReviewEvidence([pass, review('ITERATE', null)], head, (r) => r.at)).toEqual([]);
    const nonCrq = { body: `${head} PASS`, at: null };
    expect(
      latestCrqReviewEvidence([pass, review('ITERATE', null), nonCrq], head, (r) => r.at),
    ).toEqual([nonCrq]);
  });
});
