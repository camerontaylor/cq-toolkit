import { describe, expect, test } from 'vitest';
import {
  backfillJobId,
  CrqDigest64,
  CrqRepository,
  CrqRequestId,
  CrqSha40,
  contentDigest,
  currentItemId,
  findingDeliveryKey,
  ledgerDigest,
  receiptDigest,
  repairJobId,
  reviewRunId,
} from '../../../src/policy/crq/ids.js';
import { parseUtc } from '../../../src/policy/crq/utc.js';
import { decideCompletion, parseReviewerStream } from '../../../src/ops/dev/coderabbit.js';

describe('ids derived by the Python writers', () => {
  test('current-<receipt digest[:32]> binds repo, PR, merge SHA, selector and policy', () => {
    const id = currentItemId({
      repo: 'owner/repo',
      pr: 101,
      merge_sha: 'a'.repeat(40),
      target_selector: 'promoted-main',
    });
    expect(id).toBe('current-4562411d6a7fdae5b60dfc05131deb61');
  });

  test('the legacy selector is part of the binding, not an alias erased before hashing', () => {
    const promoted = currentItemId({
      repo: 'owner/repo',
      pr: 101,
      merge_sha: 'a'.repeat(40),
      target_selector: 'promoted-main',
    });
    const legacy = currentItemId({
      repo: 'owner/repo',
      pr: 101,
      merge_sha: 'a'.repeat(40),
      target_selector: 'merge-queue',
    });
    expect(legacy).not.toBe(promoted);
  });

  test('run, repair and backfill ids match crq.launch / repair_tick / finding_delivery', () => {
    const launched = reviewRunId('pr101', parseUtc('2026-11-08T00:00:00.987654Z')!);
    expect(launched).toBe('pr101-20261108T000000Z');
    expect(repairJobId(launched)).toBe('crq-pr101-20261108T000000Z-F1');
    expect(repairJobId(launched, 12)).toBe('crq-pr101-20261108T000000Z-F12');
    expect(backfillJobId('finding-1')).toBe('crq-backfill-finding-1');
  });

  test('digest wrappers select the right canonical encoding', () => {
    expect(receiptDigest({ b: 1, a: [true, false, null] })).toBe(
      '087e44ed138472a81a4a0f8ae84e8f358d0d957d27f51123952aa88c007b1f9f',
    );
    expect(ledgerDigest({ canonical: 'a'.repeat(64), confirmation: 'b'.repeat(64) })).toBe(
      '78735e01cee2ada3117cc5d9ffdf3e1ffd3e89ea1caf2072a8398629565f378c',
    );
    expect(contentDigest(Buffer.from('abc', 'ascii'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  test('a delivery key is the canonical id until a confirmation exists', () => {
    const id = 'c'.repeat(64);
    expect(findingDeliveryKey(id)).toBe(id);
    expect(findingDeliveryKey(id, null)).toBe(id);
    expect(findingDeliveryKey(id, 'd'.repeat(64))).toMatch(/^[0-9a-f]{64}$/);
  });

  test('validation schemas match the Python grammars', () => {
    expect(CrqSha40.safeParse('a'.repeat(40)).success).toBe(true);
    expect(CrqSha40.safeParse('A'.repeat(40)).success).toBe(false);
    expect(CrqDigest64.safeParse('b'.repeat(64)).success).toBe(true);
    expect(CrqDigest64.safeParse('b'.repeat(63)).success).toBe(false);
    expect(CrqRequestId.safeParse('req-1.a_b').success).toBe(true);
    expect(CrqRequestId.safeParse('-bad').success).toBe(false);
    expect(CrqRepository.safeParse('owner/repo').success).toBe(true);
    expect(CrqRepository.safeParse('owner').success).toBe(false);
  });

  test('constructors refuse malformed bindings instead of deriving a misleading id', () => {
    expect(() =>
      currentItemId({
        repo: 'owner/repo',
        pr: 0,
        merge_sha: 'a'.repeat(40),
        target_selector: 'promoted-main',
      }),
    ).toThrow();
    expect(() =>
      currentItemId({
        repo: 'owner/repo',
        pr: 1,
        merge_sha: 'xyz',
        target_selector: 'promoted-main',
      }),
    ).toThrow();
    expect(() => reviewRunId('', 0)).toThrow();
    expect(() => repairJobId('run', 0)).toThrow();
  });
});

describe('D2 — no-fresh is intentionally NOT Python-parity', () => {
  test('the TS completion decision blocks an affirmative no-fresh completion', () => {
    const stream = parseReviewerStream(
      [
        JSON.stringify({ type: 'review_context' }),
        JSON.stringify({ type: 'status', status: 'reviewing' }),
        JSON.stringify({
          type: 'complete',
          status: 'review_completed',
          findings: 0,
          outcome: 'completed',
          message: 'No fresh detailed file review was performed in this run.',
        }),
        '',
      ].join('\n'),
    );
    const verdict = decideCompletion(0, stream);
    expect(verdict.kind).toBe('blocked');
    if (verdict.kind === 'blocked') {
      expect(verdict.reason).toContain('AFFIRMATIVE no-fresh');
    }
    // Python's group-P classify vector records this same run as a terminal
    // `skipped`. The plan's owner ruling D2 says the port keeps the TS
    // blocked/retriable semantics and records an explicit `skipped:no-fresh`
    // reason, so that vector family is deliberately not replayed in phase 1.1.
  });
});

test('repository grammar accepts Python Unicode word characters', () => {
  expect(CrqRepository.safeParse('é/仓库').success).toBe(true);
  expect(CrqRepository.safeParse('é/a b').success).toBe(false);
});
