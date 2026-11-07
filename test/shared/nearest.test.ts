import { describe, expect, test } from 'vitest';
import { nearestKey } from '../../src/shared/nearest.js';

describe('nearestKey', () => {
  test('a short typo reaches a longer intended key', () => {
    expect(nearestKey('hi', ['low', 'high'])).toBe('high');
    expect(nearestKey('rev', ['review'])).toBe('review');
  });

  test('very short typos do not match unrelated short names', () => {
    expect(nearestKey('x', ['run'])).toBeUndefined();
    expect(nearestKey('ab', ['run', 'out'])).toBeUndefined();
  });

  test('picks the closest candidate and is case-insensitive', () => {
    expect(nearestKey('BUDGET', ['budgets', 'budget2x'])).toBe('budgets');
  });
});
