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
});
