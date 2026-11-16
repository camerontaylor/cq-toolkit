import { describe, expect, it } from 'vitest';
import { admissionOrder } from '../../../src/policy/crq/admissionOrder.js';
import { JsonNumber, JsonObject, type JsonValue } from '../../../src/policy/crq/jsonValue.js';

const context = {
  config: { primaryRepo: 'o/r', repos: [], localReviewAgingMinutes: 60 },
  nowMicros: 0n,
};
const row = (kind: string, entries: [string, JsonValue][] = []) =>
  new JsonObject([['kind', kind], ['state', 'pending'], ...entries]);
const queue = (items: JsonObject[]) =>
  new JsonObject([
    ['items', items],
    ['unknown', JsonNumber.int('90071992547409933')],
  ]);

describe('inactive admission ordering', () => {
  it('orders all owners by priority and rank without losing original indexes or values', () => {
    const q = queue([
      row('open'),
      row('author', [['operator_priority', true]]),
      row('delta'),
      row('local-review'),
      row('promotion'),
    ]);
    expect(admissionOrder(q, context, null).indexes).toEqual([1, 0, 3, 2]);
    expect(q.get('unknown')).toEqual(JsonNumber.int('90071992547409933'));
  });
  it('compares large integer order exactly and keeps stable ties', () => {
    const q = queue([
      row('open', [['order', JsonNumber.int('9007199254740993')]]),
      row('open', [['order', JsonNumber.int('9007199254740992')]]),
      row('open', [['order', JsonNumber.int('9007199254740992')]]),
    ]);
    expect(admissionOrder(q, context, null).indexes).toEqual([1, 2, 0]);
  });
  it('gives background work a turn after two interactive launches, except selective starts', () => {
    const history = [
      new JsonObject([
        ['run_id', 'a'],
        ['started_at', '2026-01-01T00:00:00Z'],
        ['band', 'interactive'],
      ]),
      new JsonObject([
        ['run_id', 'b'],
        ['started_at', '2026-01-01T00:01:00Z'],
        ['band', 'interactive'],
      ]),
    ];
    const q = queue([
      row('open', [['attempts', history]]),
      row('merged'),
      row('coverage'),
      row('delta'),
    ]);
    expect(admissionOrder(q, context, null)).toEqual({ indexes: [1, 0, 3, 2], background: true });
    expect(admissionOrder(q, context, 'x')).toEqual({ indexes: [0, 3, 1, 2], background: false });
  });
  it('uses run records and preserves operator priority during the background re-sort', () => {
    const run = (id: string, at: string) =>
      new JsonObject([
        ['run_id', id],
        ['started_at', at],
        ['band', 'interactive'],
      ]);
    const q = queue([
      row('open', [
        ['operator_priority', true],
        ['run', run('a', '2026-01-01T00:00:00Z')],
      ]),
      row('delta', [['run', run('b', '2026-01-01T00:01:00Z')]]),
      row('merged'),
      row('merged', [['operator_priority', true]]),
    ]);
    expect(admissionOrder(q, context, null)).toEqual({ indexes: [3, 0, 2, 1], background: true });
  });
  it('does not grant a background turn for a malformed launch timestamp', () => {
    const q = queue([
      row('open', [
        [
          'attempts',
          [
            new JsonObject([
              ['run_id', 'a'],
              ['started_at', '2026-01-01T00:00:00Z'],
              ['band', 'interactive'],
            ]),
            new JsonObject([
              ['run_id', 'b-20260101T000100Z'],
              ['started_at', 'invalid'],
              ['band', 'interactive'],
            ]),
          ],
        ],
      ]),
      row('merged'),
    ]);
    expect(admissionOrder(q, context, null)).toEqual({ indexes: [0, 1], background: false });
  });
  it('compares string orders and refuses a null author cycle like Python', () => {
    expect(
      admissionOrder(
        queue([row('open', [['order', 'z']]), row('open', [['order', 'a']])]),
        context,
        null,
      ).indexes,
    ).toEqual([1, 0]);
    const author = row('author', [['author', new JsonObject([['cycle', null]])]]);
    expect(() => admissionOrder(queue([author, row('open')]), context, null)).toThrow(
      'invalid author cycle',
    );
  });
});
