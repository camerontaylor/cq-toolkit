/** Inactive start_one ordering projection. Eligibility and owner dispatch remain unbound. */
import {
  JsonObject,
  comparePythonNumbers,
  pythonNumbersEqual,
  type JsonValue,
} from './jsonValue.js';
import { pyTruthy } from './queueDoc.js';
import { backgroundTurn, rank, type ScheduleContext } from './tickSchedule.js';

function launchRecord(value: JsonValue): Record<string, unknown> | null {
  if (!(value instanceof JsonObject)) return null;
  return {
    run_id: value.get('run_id'),
    started_at: value.get('started_at'),
    band: value.get('band'),
  };
}

/** Project only fields read by rank/backgroundTurn; original objects remain authoritative. */
function project(item: JsonObject): Record<string, unknown> {
  const cycles = item.get('cycles');
  const author = item.get('author');
  const cycle = author instanceof JsonObject ? author.get('cycle') : undefined;
  const generation = item.get('generation');
  const attempts = item.get('attempts');
  const run = item.get('run');
  return {
    kind: item.get('kind'),
    repo: item.get('repo'),
    followup: item.get('followup'),
    source: item.get('source'),
    created_at: item.get('created_at'),
    cycles: Array.isArray(cycles) ? cycles : [],
    author: { cycle: (comparePythonNumbers(cycle ?? 1, 1) ?? 0) > 0 ? 2 : 1 },
    generation: generation === undefined || pythonNumbersEqual(generation, 1) ? 1 : 2,
    repeat_requested: item.get('repeat_requested'),
    ancestry_repeat: item.get('ancestry_repeat'),
    attempts: Array.isArray(attempts) ? attempts.map(launchRecord) : [],
    run: run === undefined ? null : launchRecord(run),
  };
}

/**
 * Python start_one's stable initial and background-turn ordering, returning original
 * indexes. This does not select an eligible item or invoke coverage or any owner.
 */
export function admissionOrder(
  queue: JsonObject,
  context: ScheduleContext,
  only: string | null,
): {
  indexes: number[];
  background: boolean;
} {
  const items = queue.get('items');
  if (!Array.isArray(items)) throw new Error('queue.items must be an array');
  const all = items.map((item, index) => {
    if (!(item instanceof JsonObject)) throw new Error('invalid queue item');
    return { item, index, fields: project(item) };
  });
  const live = all.filter(({ item }) => item.get('kind') !== 'promotion');
  const order = (item: JsonObject) => (item.has('order') ? item.get('order') : 999);
  live.sort((a, b) => {
    const priority =
      Number(!pyTruthy(a.item.get('operator_priority'))) -
      Number(!pyTruthy(b.item.get('operator_priority')));
    const tier = rank(a.fields, context) - rank(b.fields, context);
    if (priority || tier) return priority || tier;
    const ordering = comparePythonNumbers(order(a.item), order(b.item));
    if (ordering === null) throw new Error('invalid item order');
    return ordering || a.index - b.index;
  });
  const background =
    !only &&
    backgroundTurn({ items: all.map(({ fields }) => fields) }) &&
    live.some(({ item, fields }) => item.get('state') === 'pending' && rank(fields, context) < 2);
  if (background)
    live.sort((a, b) => {
      const key = (row: typeof a) => [
        Number(!pyTruthy(row.item.get('operator_priority'))),
        Number(!(rank(row.fields, context) >= 2 && rank(row.fields, context) <= 3)),
      ];
      const x = key(a);
      const y = key(b);
      return x[0]! - y[0]! || x[1]! - y[1]!;
    });
  return { indexes: live.map(({ index }) => index), background: Boolean(background) };
}
