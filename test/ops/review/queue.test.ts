import { describe, expect, test } from 'vitest';
import {
  QueueBindingSchema,
  QueueBindSchema,
} from '../../../src/ops/review/internal/queueProtocol.js';

describe('queue pre-PR binding', () => {
  const binding = {
    kind: 'deferred-author',
    repo: 'owner/repo',
    producer: 'cycle-1',
    head: 'a'.repeat(40),
    target: 'merge-queue',
    targetSelector: 'promoted-main',
  };
  test('records debt before a PR or merge exists', () => {
    expect(QueueBindingSchema.parse(binding)).toEqual(binding);
    expect(QueueBindSchema.parse({ requestId: 'request-1', binding, pr: 12 })).toMatchObject({
      pr: 12,
    });
  });
  test('refuses authority fields, invalid repositories, selectors and mutable heads', () => {
    for (const patch of [
      { issuer: 'queue' },
      { repo: '../repo' },
      { targetSelector: 'HEAD' },
      { head: 'main' },
    ]) {
      expect(QueueBindingSchema.safeParse({ ...binding, ...patch }).success).toBe(false);
    }
  });
});
