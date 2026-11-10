import { expect, test } from 'vitest';
import { formatCqTrailers } from '../../src/shared/cqTrailers.js';

test('rejects embedded newlines in trailer values', () => {
  expect(() => formatCqTrailers([['Cq-Run', 'run/a\nCq-Forged: x']])).toThrow(
    'Cq trailer Cq-Run contains an embedded newline',
  );
  expect(() => formatCqTrailers([['Cq-Run', 'run/a\rMore']])).toThrow('embedded newline');
});

test('rejects embedded newlines in trailer keys', () => {
  expect(() => formatCqTrailers([['Cq-Task: pass\nCq-Status', 'ok']])).toThrow(
    'Cq trailer key contains an embedded newline',
  );
  expect(() => formatCqTrailers([['Cq-Run\rMore', 'run/a']])).toThrow('embedded newline');
});

test('joins entries as Key: value lines', () => {
  expect(
    formatCqTrailers([
      ['Cq-Run', 'run/a'],
      ['Cq-Tier', 'worker'],
    ]),
  ).toBe('Cq-Run: run/a\nCq-Tier: worker');
  expect(formatCqTrailers([])).toBe('');
});
