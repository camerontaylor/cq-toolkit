import { describe, expect, test } from 'vitest';
import { parseIndependentReview } from '../../src/shared/independent-review.js';

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
