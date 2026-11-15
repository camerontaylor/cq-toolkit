/**
 * Inactive launch-binding bridge: Python-style in-place queue edits over the
 * immutable `JsonObject` queue.
 *
 * Python's `start_one`/`launch` hold `q` and `item` references and edit them in
 * place (`item["state"] = ...`, `q.setdefault("starts", []).append(...)`),
 * then read the result back through the same `item`. The TS port never mutates
 * a queue: `reserveAndSpawnReview` returns a new one. A {@link QueueCell} is
 * the one mutable holder: every edit is copy-on-write along its path and
 * replaces `cell.queue`, and an {@link ItemRef} reads through the cell, so a
 * handle taken before an edit (or before a launch) observes the edit after it,
 * as a Python `item` reference does. Nothing here touches disk, a lock or a
 * clock, and no queue consumer changes type.
 *
 * Differences from Python, deliberately kept:
 *  - No aliasing: `meta["capture"] = item["capture"]` shares one dict in Python,
 *    so a later in-place edit of either would show in both. Values here are
 *    immutable, so an edit never shows in a value copied earlier.
 *  - After a launch that throws once its reservation was saved, the cell holds
 *    the last durably saved queue (Python's in-memory queue at that point).
 */
import { JsonObject, type JsonValue } from '../policy/crq/jsonValue.js';
import { withObjectKeys } from '../policy/crq/queueDoc.js';
import {
  reserveAndSpawnReview,
  type ReviewLaunchEffects,
  type ReviewLaunchInput,
} from './reviewLaunch.js';

export type PythonEditError = 'KeyError' | 'IndexError' | 'TypeError' | 'AttributeError';

/** The Python exception the same in-place edit would have raised. */
export class QueueEditError extends Error {
  override readonly name = 'QueueEditError';
  readonly pythonError: PythonEditError;

  constructor(pythonError: PythonEditError, message: string) {
    super(message);
    this.pythonError = pythonError;
  }
}

/** A dict key or a list index, from the queue root down. */
export type PathStep = string | number;

function kindOf(value: JsonValue | undefined): string {
  if (value === null || value === undefined) return 'NoneType';
  if (value instanceof JsonObject) return 'dict';
  if (Array.isArray(value)) return 'list';
  if (typeof value === 'string') return 'str';
  return 'number';
}

/** Python list indexing: negative indexes wrap, anything else out of range is an IndexError. */
function listIndex(list: readonly JsonValue[], step: PathStep, what: string): number {
  if (typeof step !== 'number' || !Number.isInteger(step))
    throw new QueueEditError('TypeError', `list indices must be integers, not ${typeof step}`);
  const index = step < 0 ? step + list.length : step;
  if (index < 0 || index >= list.length)
    throw new QueueEditError('IndexError', `${what} index out of range`);
  return index;
}

function dictKey(step: PathStep): string {
  if (typeof step !== 'string') throw new QueueEditError('KeyError', String(step));
  return step;
}

/** `container[step]`, with the Python exception a miss or a wrong container raises. */
function child(container: JsonValue, step: PathStep): JsonValue {
  if (container instanceof JsonObject) {
    const key = dictKey(step);
    const value = container.get(key);
    if (value === undefined) throw new QueueEditError('KeyError', key);
    return value;
  }
  if (Array.isArray(container)) return container[listIndex(container, step, 'list')] as JsonValue;
  throw new QueueEditError('TypeError', `'${kindOf(container)}' object is not subscriptable`);
}

/** `container[step] = value` as a new container. */
function withChild(container: JsonValue, step: PathStep, value: JsonValue): JsonValue {
  if (container instanceof JsonObject) return withObjectKeys(container, [[dictKey(step), value]]);
  if (Array.isArray(container)) {
    const next = [...container];
    next[listIndex(container, step, 'list assignment')] = value;
    return next;
  }
  throw new QueueEditError(
    'TypeError',
    `'${kindOf(container)}' object does not support item assignment`,
  );
}

/** Rewrite the value at `path` (copy-on-write along it); `[]` is the root. */
function editAt(
  root: JsonValue,
  path: readonly PathStep[],
  change: (target: JsonValue) => JsonValue,
): JsonValue {
  const [head, ...rest] = path;
  if (head === undefined) return change(root);
  return withChild(root, head, editAt(child(root, head), rest, change));
}

function dictTarget(target: JsonValue, method: string): JsonObject {
  if (target instanceof JsonObject) return target;
  throw new QueueEditError(
    'AttributeError',
    `'${kindOf(target)}' object has no attribute '${method}'`,
  );
}

/** The queue a caller edits in place, and the handle it reads back through. */
export class QueueCell {
  #queue: JsonObject;

  constructor(queue: JsonObject) {
    this.#queue = queue;
  }

  /** The current document (immutable; replaced by every edit). */
  get queue(): JsonObject {
    return this.#queue;
  }

  /** Take a queue a transaction returned (launch, blocked save) as the new current one. */
  adopt(queue: JsonObject): void {
    this.#queue = queue;
  }

  /** `target[key] = value`; an existing key keeps its position, a new one appends. */
  set(path: readonly PathStep[], key: PathStep, value: JsonValue): void {
    this.#edit(path, (target) => withChild(target, key, value));
  }

  /** `target.setdefault(key, value)`; a present key, even a null one, is untouched. */
  setdefault(path: readonly PathStep[], key: string, value: JsonValue): void {
    this.#edit(path, (target) => {
      const dict = dictTarget(target, 'setdefault');
      return dict.has(key) ? dict : withObjectKeys(dict, [[key, value]]);
    });
  }

  /** `target.append(value)` on a list. */
  append(path: readonly PathStep[], value: JsonValue): void {
    this.#edit(path, (target) => {
      if (!Array.isArray(target))
        throw new QueueEditError(
          'AttributeError',
          `'${kindOf(target)}' object has no attribute 'append'`,
        );
      return [...target, value];
    });
  }

  /** `target.update(...)`: assignment for each pair, in order. */
  update(path: readonly PathStep[], entries: ReadonlyArray<readonly [string, JsonValue]>): void {
    this.#edit(path, (target) => withObjectKeys(dictTarget(target, 'update'), entries));
  }

  /** `del target[key]`; a missing dict key is a KeyError. */
  delete(path: readonly PathStep[], key: PathStep): void {
    this.#edit(path, (target) => {
      if (target instanceof JsonObject) {
        const name = dictKey(key);
        if (!target.has(name)) throw new QueueEditError('KeyError', name);
        return new JsonObject(target.entries.filter(([entry]) => entry !== name));
      }
      if (Array.isArray(target)) {
        const index = listIndex(target, key, 'list assignment');
        return target.filter((_, position) => position !== index);
      }
      throw new QueueEditError(
        'TypeError',
        `'${kindOf(target)}' object doesn't support item deletion`,
      );
    });
  }

  /** `target.pop(key, None)`; a missing key is a no-op. */
  pop(path: readonly PathStep[], key: string): void {
    this.#edit(path, (target) => {
      // list.pop takes one argument, so Python's two-argument call is a TypeError.
      if (Array.isArray(target))
        throw new QueueEditError('TypeError', 'pop expected at most 1 argument');
      const dict = dictTarget(target, 'pop');
      return dict.has(key) ? new JsonObject(dict.entries.filter(([entry]) => entry !== key)) : dict;
    });
  }

  /** `queue["items"][index]` as a live reference. */
  item(index: number): ItemRef {
    return new ItemRef(this, index);
  }

  /** The value at `path`, or the Python exception reading it would raise. */
  read(path: readonly PathStep[]): JsonValue {
    return path.reduce<JsonValue>((value, step) => child(value, step), this.#queue);
  }

  /**
   * Run the launch reservation transaction on one item and adopt its queue.
   * If it throws after saving the reservation, adopt the last saved queue (the
   * state Python's in-memory queue holds at that point) and rethrow; if it
   * throws before any save the cell is untouched.
   */
  async launch(input: ReviewLaunchInput, effects: ReviewLaunchEffects): Promise<{ runId: string }> {
    let lastSaved: JsonObject | undefined;
    const saving: ReviewLaunchEffects = {
      ...effects,
      saveQueue: async (queue) => {
        await effects.saveQueue(queue);
        lastSaved = queue;
      },
    };
    try {
      const result = await reserveAndSpawnReview(this.#queue, input, saving);
      this.#queue = result.queue;
      return { runId: result.runId };
    } catch (error) {
      if (lastSaved) this.#queue = lastSaved;
      throw error;
    }
  }

  #edit(path: readonly PathStep[], change: (target: JsonValue) => JsonValue): void {
    this.#queue = editAt(this.#queue, path, change) as JsonObject;
  }
}

/** Python's `item` for `queue["items"][index]`: reads and edits go through the cell. */
export class ItemRef {
  readonly #cell: QueueCell;
  readonly #index: number;

  constructor(cell: QueueCell, index: number) {
    this.#cell = cell;
    this.#index = index;
  }

  get #path(): PathStep[] {
    return ['items', this.#index];
  }

  /** The item as it is now. */
  get value(): JsonObject {
    const value = this.#cell.read(this.#path);
    if (!(value instanceof JsonObject))
      throw new QueueEditError('TypeError', 'queue item is not a dict');
    return value;
  }

  /** `item[key]`, undefined when absent (use {@link has} to tell null from missing). */
  get(key: string): JsonValue | undefined {
    return this.value.get(key);
  }

  has(key: string): boolean {
    return this.value.has(key);
  }

  set(key: string, value: JsonValue): void {
    this.#cell.set(this.#path, key, value);
  }

  setdefault(key: string, value: JsonValue): void {
    this.#cell.setdefault(this.#path, key, value);
  }

  /** `item.setdefault(key, []).append(value)`. */
  appendTo(key: string, value: JsonValue): void {
    this.#cell.setdefault(this.#path, key, []);
    this.#cell.append([...this.#path, key], value);
  }

  /** `item[key].update(...)`. */
  updateIn(key: string, entries: ReadonlyArray<readonly [string, JsonValue]>): void {
    this.#cell.update([...this.#path, key], entries);
  }
}
