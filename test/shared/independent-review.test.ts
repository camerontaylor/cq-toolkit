import { describe, expect, test } from 'vitest';
import {
  parseIndependentReview,
  parseSameAccountReviewFlag,
} from '../../src/shared/independent-review.js';

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
    marker({ authorAgentId: 'reviewer-agent' }),
    marker({ independent: false }),
    marker({ verdict: 'APPROVED' }),
    marker({ headSha: 'bad' }),
    `${marker()} ${marker()}`,
    `${marker()} <!-- cq-agent-review: broken`,
    '<!-- cq-agent-review: {not-json} -->',
  ])('rejects malformed or duplicate marker %s', (body) => {
    expect(parseIndependentReview(body)).toEqual({ kind: 'invalid' });
  });
});

describe('parseSameAccountReviewFlag', () => {
  test('defaults blank to false and accepts only exact true or false', () => {
    expect(parseSameAccountReviewFlag(undefined, 'FLAG')).toBe(false);
    expect(parseSameAccountReviewFlag('  ', 'FLAG')).toBe(false);
    expect(parseSameAccountReviewFlag('true', 'FLAG')).toBe(true);
    expect(parseSameAccountReviewFlag('false', 'FLAG')).toBe(false);
    expect(() => parseSameAccountReviewFlag('TRUE', 'FLAG')).toThrow(
      'FLAG: expected true or false',
    );
    expect(() => parseSameAccountReviewFlag('yes', 'FLAG')).toThrow('FLAG: expected true or false');
  });
});
