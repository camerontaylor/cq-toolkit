// Smoke test: the toolkit barrel loads cleanly. No exports yet in T0.2 —
// module lines land in phase 1+.
import * as toolkit from './index.js';
import { expect, test } from 'vitest';

test('toolkit barrel module loads as an object', () => {
  expect(typeof toolkit).toBe('object');
  expect(toolkit).not.toBeNull();
});
