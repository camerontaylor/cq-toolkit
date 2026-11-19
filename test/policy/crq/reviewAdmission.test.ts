import { describe, expect, it } from 'vitest';
import { JsonNumber, JsonObject, type JsonValue } from '../../../src/policy/crq/jsonValue.js';
import {
  LOCAL_REVIEW_KIND,
  admit,
  keyDigest,
  retryRequest,
  reviewStatus,
} from '../../../src/policy/crq/reviewAdmission.js';

const obj = (entries: [string, JsonValue][]) => new JsonObject(entries);
const resolved = obj([
  ['repo', 'o/r'],
  ['base_tree', 'a'],
  ['head_tree', 'b'],
]);
const inputs = obj([['target', 't']]);

function request(requestId: string, verifyReceipt: boolean) {
  return {
    requestId,
    inputs,
    resolved,
    profile: obj([['adapter', 'x']]),
    at: '2026-01-01T00:00:00Z',
    repeat: false,
    ancestryRepeat: false,
    verifyReceipt: () => verifyReceipt,
  };
}

const adequateItem = obj([
  ['id', 'lr-1'],
  ['kind', LOCAL_REVIEW_KIND],
  ['identity_inputs', resolved],
  ['generation', JsonNumber.int(1)],
  ['state', 'done'],
  ['receipt_id', 'r1'],
  ['scope_adequate', true],
]);

describe('receipt-unavailable recovery cue', () => {
  it('persists across replay and status, then clears when the receipt verifies again', () => {
    const first = admit(obj([['items', [adequateItem]]]), request('req-1', false));
    expect(first.result.get('action')).toBe('observed');
    expect(first.result.get('next_action')).toBe('resubmit');
    expect(first.result.get('reason')).toBe('receipt-unavailable');

    const replay = retryRequest(first.queue, 'req-1', keyDigest(inputs, false));
    expect(replay?.get('next_action')).toBe('resubmit');
    expect(replay?.get('reason')).toBe('receipt-unavailable');
    expect(reviewStatus(first.queue, 'req-1').get('reason')).toBe('receipt-unavailable');

    const second = admit(first.queue, request('req-2', true));
    expect(second.result.get('action')).toBe('reused');
    expect(second.result.get('reason')).toBeUndefined();
    expect(reviewStatus(second.queue, 'req-1').get('reason')).toBeUndefined();
  });
});
