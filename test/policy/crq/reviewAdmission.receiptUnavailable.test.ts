import { describe, expect, test } from 'vitest';
import { JsonObject, toPlainJson } from '../../../src/policy/crq/jsonValue.js';
import { fromPlainJson } from '../../../src/policy/crq/queueDoc.js';
import { admit, retryRequest, reviewStatus } from '../../../src/policy/crq/reviewAdmission.js';

const RESOLVED = {
  repo: 'r',
  base_commit: 'a',
  head_commit: 'b',
  base_tree: 't1',
  head_tree: 't2',
  scope: 's',
  projection: 'p',
  config_digest: 'c',
  profile: { adapter: 'x', revision: '1' },
};

function obj(value: unknown): JsonObject {
  return fromPlainJson(value) as JsonObject;
}

function input(requestId: string, verifyReceipt: (item: JsonObject) => boolean) {
  return {
    requestId,
    inputs: obj({ target: 'x' }),
    resolved: obj(RESOLVED),
    profile: obj({ adapter: 'x', revision: '1' }),
    at: '2026-01-01T00:00:00Z',
    repeat: false,
    ancestryRepeat: false,
    verifyReceipt,
  };
}

function doneQueue(): JsonObject {
  return obj({
    items: [
      {
        id: 'lr-old',
        kind: 'local-review',
        identity_inputs: RESOLVED,
        generation: 1,
        state: 'done',
        scope_adequate: true,
        receipt_id: 'rcpt',
        observers: [],
      },
    ],
    review_requests: {},
  });
}

describe('review admission receipt-unavailable persistence', () => {
  test('an observed admission keeps the resubmit cue on status and retry replay', () => {
    const first = admit(
      doneQueue(),
      input('req-1', () => false),
    );
    expect(toPlainJson(first.result)).toMatchObject({
      action: 'observed',
      next_action: 'resubmit',
      reason: 'receipt-unavailable',
    });
    const status = toPlainJson(reviewStatus(first.queue, 'req-1')) as Record<string, unknown>;
    expect(status.next_action).toBe('resubmit');
    expect(status.reason).toBe('receipt-unavailable');
    const key = first.queue.get('review_requests');
    expect(key).toBeDefined();
    const replay = retryRequest(
      first.queue,
      'req-1',
      (first.queue.get('review_requests') as JsonObject).get('req-1') !== undefined
        ? (((first.queue.get('review_requests') as JsonObject).get('req-1') as JsonObject).get(
            'key_digest',
          ) as string)
        : '',
    );
    expect(toPlainJson(replay as JsonObject)).toMatchObject({
      next_action: 'resubmit',
      reason: 'receipt-unavailable',
    });
  });

  test('a later reuse whose receipt verifies clears the stale mark', () => {
    const first = admit(
      doneQueue(),
      input('req-1', () => false),
    );
    const second = admit(
      first.queue,
      input('req-2', () => true),
    );
    expect(toPlainJson(second.result)).toMatchObject({ action: 'reused' });
    expect(toPlainJson(second.result)).not.toHaveProperty('next_action');
    const items = toPlainJson(second.queue.get('items') as never) as Array<Record<string, unknown>>;
    expect(items[0]).not.toHaveProperty('receipt_unavailable');
    expect(toPlainJson(reviewStatus(second.queue, 'req-1'))).not.toHaveProperty('next_action');
  });
});
