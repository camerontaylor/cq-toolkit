// `retainedReceiptDocument`: the document half of `local_review_runtime.retained`.
import { describe, expect, test } from 'vitest';
import {
  retainedReceiptDocument,
  receiptRetainsItem,
} from '../../../src/ops/crq/reviewCapability.js';
import { JsonObject, parseJsonValue } from '../../../src/policy/crq/jsonValue.js';

const doc = (v: unknown): JsonObject => parseJsonValue(JSON.stringify(v)) as JsonObject;
const ID = 'd'.repeat(64);
const IDENTITY = 'a'.repeat(64);
const SHA = '1'.repeat(40);
const profile = { adapter: 'coderabbit-cli', revision: 'r1' };
const inputs = {
  v: 1,
  repo: 'o/r',
  base_commit: SHA,
  base_tree: SHA,
  head_commit: SHA,
  head_tree: SHA,
  scope: 'full-diff',
  projection: 'p',
  config_digest: 'c'.repeat(64),
  profile,
};
const receipt = (over: Record<string, unknown> = {}): Uint8Array =>
  new TextEncoder().encode(
    JSON.stringify({
      v: 1,
      kind: 'local-review-full-diff',
      identity: IDENTITY,
      identity_inputs: inputs,
      profile: { ...profile, flags: [] },
      run_id: 'run-20261115T000000Z-abcdef12',
      outcome: 'findings',
      scope_adequate: true,
      findings: [],
      report: '',
      observed: {},
      independent_acceptance: false,
      ...over,
    }),
  );
const item = (over: Record<string, unknown> = {}): JsonObject =>
  doc({ id: 'i1', identity: IDENTITY, identity_inputs: inputs, receipt_id: ID, ...over });
const reader = (bytes: Uint8Array) => () => Promise.resolve(bytes);

describe('retainedReceiptDocument', () => {
  test('returns the verified document so callers can read run_id and outcome', async () => {
    const found = await retainedReceiptDocument(item(), reader(receipt()));
    expect(found?.get('outcome')).toBe('findings');
    expect(found?.get('run_id')).toBe('run-20261115T000000Z-abcdef12');
    expect(await receiptRetainsItem(item(), reader(receipt()))).toBe(true);
  });

  test('is null when the item names no receipt', async () => {
    expect(await retainedReceiptDocument(item({ receipt_id: null }), reader(receipt()))).toBeNull();
  });

  test.each([
    ['another identity', { identity: 'b'.repeat(64) }],
    ['different identity inputs', { identity_inputs: { ...inputs, repo: 'o/other' } }],
    ['an inadequate scope', { scope_adequate: false }],
    ['an outcome that is not clean or findings', { outcome: 'no-verdict' }],
  ])('is null for %s', async (_name, over) => {
    expect(await retainedReceiptDocument(item(), reader(receipt(over)))).toBeNull();
    expect(await receiptRetainsItem(item(), reader(receipt(over)))).toBe(false);
  });

  test('is null for an unreadable, undecodable or non-object receipt', async () => {
    expect(
      await retainedReceiptDocument(item(), () => Promise.reject(new Error('gone'))),
    ).toBeNull();
    expect(await retainedReceiptDocument(item(), reader(new Uint8Array([0xff, 0xfe])))).toBeNull();
    expect(
      await retainedReceiptDocument(item(), reader(new TextEncoder().encode('[1]'))),
    ).toBeNull();
  });
});
