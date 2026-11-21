/**
 * `crq.new_item(q, [], False, **fields)` (crq.py:3100-3117) as the in-memory
 * `newItem` effect `finalize_publication` calls to enroll a verified repair's
 * fix PR (repair_tick.py:876). Inactive: nothing imports this outside tests.
 *
 * The queue is the plain mutable record `finalizePublication` already works on;
 * the only effect is the injected `event` (Python's `event("enrolled", ...)`),
 * so this module has no disk, clock, Git or forge access. Like Python it
 * mutates `q.items` in place, and the order and the failure points are part of
 * the contract, pinned by `test/queue-runner/publicationEnroll.test.ts` against
 * the real Python function:
 *
 * 1. The first live item whose `id` equals `fields.id` is returned untouched:
 *    ids are unique, so an existing item of any kind or state (a skipped one
 *    too) is sticky and nothing is appended or logged. A `promotion` item is
 *    not live, so it never blocks. An earlier live item with no `id` is a
 *    `KeyError`; the scan stops at the first match, so items after it are not
 *    read.
 * 2. `kind == "open"` overwrites any caller `prior_cycles` with 0 (new PRs
 *    always owe a real review). Finalize's `2 - fix_pr_cycles` is therefore
 *    never stored. The key keeps the position it already had in `fields`.
 * 3. The item is `order, state, cycles, attempts, **fields` with `notes` added
 *    and `why` removed, appended, and only then is the event written: a
 *    failing event leaves the item in the queue (and unsaved).
 * 4. `order` is one past the largest live `order` (a missing one counts as 0).
 */
import { PyError } from './pyErrors.js';
import { pyEq } from './repairBackfill.js';

type Rec = Record<string, unknown>;

/** The injected `event("enrolled", item=<id>, reason=<note>)`. */
export interface PublicationEnrollEffects {
  /** `c.iso()`. */
  iso(): string;
  event(id: string, reason: string): Promise<void>;
}

function isRec(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `d[key]`: a missing key is a `KeyError`. */
function req(o: Rec, key: string): unknown {
  if (!Object.hasOwn(o, key)) throw new PyError('KeyError', `'${key}'`);
  return o[key];
}

function define(o: Rec, key: string, value: unknown): void {
  Object.defineProperty(o, key, { value, enumerable: true, writable: true, configurable: true });
}

/** `x.get('kind')` on a queue entry: anything but a dict has no `get`. */
function kindOf(entry: unknown): unknown {
  if (!isRec(entry)) throw new PyError('AttributeError', 'item has no attribute get');
  return Object.hasOwn(entry, 'kind') ? entry.kind : null;
}

/** An `order` as the exact integer Python would add to: ints and bools; anything else is unmodelled. */
function orderValue(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'boolean') return value ? 1n : 0n;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'object' && value !== null && 'kind' in value && 'integer' in value) {
    const n = value as { kind: unknown; integer: unknown };
    if (n.kind === 'int' && typeof n.integer === 'bigint') return n.integer;
  }
  // A float or str order changes the type or the comparison: not modelled.
  throw new Error('unsupported item order representation');
}

/** `max((i.get("order", 0) for i in live_items(q)), default=0) + 1`. */
function nextOrder(live: readonly Rec[]): bigint {
  let max = 0n;
  let any = false;
  for (const item of live) {
    const n = Object.hasOwn(item, 'order') ? orderValue(item.order) : 0n;
    if (!any || n > max) max = n;
    any = true;
  }
  return max + 1n;
}

/**
 * The `order` in the representation the queue already holds: a plain number
 * while every integer is safe, a `bigint` beyond it.
 */
function orderOut(n: bigint): unknown {
  return n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n;
}

/** `f"{iso()} auto-enrolled: {fields.get('why', '')}"`; a non-str `why` would be `str()`-ed. */
function noteText(iso: string, fields: Rec): string {
  const why = Object.hasOwn(fields, 'why') ? fields.why : '';
  if (typeof why !== 'string') throw new Error('unsupported enrollment why');
  return `${iso} auto-enrolled: ${why}`;
}

export function publicationNewItem(
  effects: PublicationEnrollEffects,
): (q: Rec, fields: Rec) => Promise<void> {
  return async (q, fields) => {
    const all = req(q, 'items');
    if (!Array.isArray(all)) throw new TypeError('queue items must be a list');
    // `live_items(q)` builds the whole list first: a non-dict entry fails here.
    const live = all.filter((entry) => kindOf(entry) !== 'promotion') as Rec[];
    const wanted = Object.hasOwn(fields, 'id') ? fields.id : null;
    // `next(...)` over a generator: `i["id"]` is read until the first match.
    for (const entry of live) if (pyEq(req(entry, 'id'), wanted)) return;

    const own: Rec = {};
    for (const [key, value] of Object.entries(fields)) define(own, key, value);
    if (pyEq(Object.hasOwn(own, 'kind') ? own.kind : null, 'open')) define(own, 'prior_cycles', 0);

    const item: Rec = {};
    define(item, 'order', orderOut(nextOrder(live)));
    define(item, 'state', 'pending');
    define(item, 'cycles', []);
    define(item, 'attempts', []);
    for (const [key, value] of Object.entries(own)) define(item, key, value);
    const note = noteText(effects.iso(), fields);
    define(item, 'notes', [note]);
    delete item.why;
    all.push(item);
    await effects.event(String(req(item, 'id')), note);
  };
}
