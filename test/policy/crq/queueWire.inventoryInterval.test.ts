// An invalid inventory interval is a wire refusal (QueueRefused), never a
// ReconcileRefused escaping the decoder.
import { describe, expect, test } from 'vitest';
import { decodeInventoryBinding } from '../../../src/policy/crq/queueWire.js';
import { ReconcileRefused } from '../../../src/policy/crq/reconcileCheckpoint.js';
import { QueueRefused } from '../../../src/policy/crq/queueReceipt.js';

const binding = (after: string, before: string) => ({
  repo: 'acme/widgets',
  targetSelector: 'promoted-main',
  after,
  before,
});

describe('decodeInventoryBinding interval', () => {
  test('equal after/before is refused as QueueRefused', () => {
    const t = '2026-11-20T00:00:00Z';
    expect(() => decodeInventoryBinding(binding(t, t))).toThrow(QueueRefused);
  });

  test('a valid interval decodes', () => {
    const decoded = decodeInventoryBinding(binding('2026-11-20T00:00:00Z', '2026-11-20T01:00:00Z'));
    expect(decoded.repo).toBe('acme/widgets');
    expect(decoded.after).toBe('2026-11-20T00:00:00Z');
    expect(decoded.before).toBe('2026-11-20T01:00:00Z');
  });

  test.each([
    ['impossible calendar month', '2026-13-01T00:00:00Z', '2026-11-20T01:00:00Z'],
    ['malformed before', '2026-11-20T00:00:00Z', '2026-11-20 01:00'],
  ])('%s is refused as QueueRefused, not a leaked ReconcileRefused', (_name, after, before) => {
    const decode = (): unknown => decodeInventoryBinding(binding(after, before));
    expect(decode).toThrow(QueueRefused);
    expect(decode).not.toThrow(ReconcileRefused);
  });
});
