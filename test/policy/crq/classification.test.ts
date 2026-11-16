import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { classify, noFreshScheduling } from '../../../src/policy/crq/classification.js';
import {
  JsonNumber,
  JsonObject,
  parseJsonValue,
  toPlainJson,
} from '../../../src/policy/crq/jsonValue.js';

const root = parseJsonValue(
  readFileSync(
    new URL('../../../apps/crq-python/fixtures/group-p/classify.json', import.meta.url),
    'utf8',
  ),
);
if (!(root instanceof JsonObject) || !Array.isArray(root.get('cases')))
  throw new Error('invalid classifier vectors');
const cases = root.get('cases') as JsonObject[];
const encoder = new TextEncoder();

describe.each(cases.map((c) => [String(c.get('name')), c] as const))(
  'Python classifier %s',
  (_name, vector) => {
    test('preserves the complete lossless result', () => {
      const input = vector.get('input');
      const expected = vector.get('expect');
      if (!(input instanceof JsonObject) || !(expected instanceof JsonObject))
        throw new Error('invalid case');
      const stream = input.get('ndjson');
      const exit = input.get('exit_code');
      if (stream !== null && typeof stream !== 'string') throw new Error('invalid stream');
      if (exit !== null && !(exit instanceof JsonNumber)) throw new Error('invalid exit');
      const actual = classify(
        stream === null ? null : encoder.encode(stream),
        exit === null ? null : Number(exit.integer),
      );
      expect(toPlainJson(actual, { bigints: true })).toEqual(
        toPlainJson(expected.get('value')!, { bigints: true }),
      );
    });
  },
);

test('D2 scheduling divergence is separate from the canonical receipt', () => {
  const noFresh = classify(
    encoder.encode(
      '{"type":"complete","status":"review_completed","message":"no fresh detailed review"}\n',
    ),
    0,
  );
  expect(noFresh.get('outcome')).toBe('skipped');
  expect(noFresh.get('counted')).toBe(false);
  expect(noFreshScheduling(noFresh)).toEqual({
    state: 'blocked',
    reason: 'skipped:no-fresh',
    retriable: true,
  });
  const otherSkip = classify(encoder.encode('{"type":"complete","status":"review_skipped"}\n'), 0);
  expect(noFreshScheduling(otherSkip)).toBeNull();
  expect(noFreshScheduling(classify(null, 0))).toBeNull();
});
