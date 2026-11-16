import { describe, expect, it } from 'vitest';
import { repairOwnRange } from '../../src/queue-runner/repairOwnRange.js';
import { parseJsonValue, type JsonObject } from '../../src/policy/crq/jsonValue.js';

const q = (v: unknown) => parseJsonValue(JSON.stringify(v)) as JsonObject;

describe('repairOwnRange', () => {
  it('is false for an empty range even when nothing is owned', () => {
    expect(repairOwnRange(q({}), [])).toBe(false);
  });
  it('needs every commit owned', () => {
    const queue = q({ repair_own_commits: ['a', 'b'] });
    expect(repairOwnRange(queue, ['a', 'b'])).toBe(true);
    expect(repairOwnRange(queue, ['a', 'c'])).toBe(false);
    expect(repairOwnRange(q({}), ['a'])).toBe(false);
  });
  it('refuses a malformed ownership list', () => {
    expect(() => repairOwnRange(q({ repair_own_commits: 'a' }), ['a'])).toThrow('array');
  });
});
