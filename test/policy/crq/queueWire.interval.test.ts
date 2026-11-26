import { describe, expect, test } from 'vitest';
import { parseJsonValue } from '../../../src/policy/crq/jsonValue.js';
import { QueueRefused } from '../../../src/policy/crq/queueReceipt.js';
import { decodeInventoryBinding } from '../../../src/policy/crq/queueWire.js';

function binding(after: string, before: string): unknown {
  return parseJsonValue(
    JSON.stringify({ repo: 'o/r', targetSelector: 'promoted-main', after, before }),
  );
}

describe('decodeInventoryBinding interval refusals', () => {
  test('an empty or inverted interval is a QueueRefused, not a bare ReconcileRefused', () => {
    expect(() =>
      decodeInventoryBinding(binding('2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z')),
    ).toThrow(QueueRefused);
    expect(() =>
      decodeInventoryBinding(binding('2026-01-03T00:00:00Z', '2026-01-02T00:00:00Z')),
    ).toThrow(QueueRefused);
  });

  test('a malformed timestamp is a QueueRefused', () => {
    expect(() => decodeInventoryBinding(binding('yesterday', '2026-01-02T00:00:00Z'))).toThrow(
      QueueRefused,
    );
  });

  test('a valid interval decodes', () => {
    expect(
      decodeInventoryBinding(binding('2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z')).before,
    ).toBe('2026-01-02T00:00:00Z');
  });
});
