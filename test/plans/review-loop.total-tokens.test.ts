import { describe, expect, it } from 'vitest';
import { totalTokens } from '../../src/plans/review-loop.js';

describe('review-loop totalTokens', () => {
  it('is 0 for absent usage', () => {
    expect(totalTokens(undefined)).toBe(0);
  });

  it('sums the frozen fields', () => {
    expect(totalTokens({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 })).toBe(10);
  });

  it('adds reasoning tokens like the governor fold', () => {
    expect(totalTokens({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: 5 })).toBe(
      15,
    );
  });
});
