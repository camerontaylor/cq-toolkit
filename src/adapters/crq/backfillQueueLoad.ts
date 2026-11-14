import { createReadStream } from 'node:fs';
import {
  ADMISSION_HISTORY_LIMIT,
  ADMISSION_HISTORY_MARKER,
} from '../../policy/crq/admissionHistory.js';
import {
  JsonNumber,
  JsonObject,
  parseJsonValue,
  type JsonValue,
} from '../../policy/crq/jsonValue.js';
import { pyTruthy, withObjectKeys, withoutObjectKey } from '../../policy/crq/queueDoc.js';

/** Incremental reader: at most one admission row and the non-history document are retained. */
class QueueReader {
  private readonly input: AsyncIterator<Buffer>;
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private buffer = '';
  private offset = 0;
  private ended = false;
  constructor(path: string) {
    this.input = createReadStream(path, { highWaterMark: 65536 })[Symbol.asyncIterator]();
  }
  async close(): Promise<void> {
    await this.input.return?.();
  }
  async peek(): Promise<string> {
    while (this.offset === this.buffer.length && !this.ended) {
      const next = await this.input.next();
      this.ended = Boolean(next.done);
      this.buffer = next.done
        ? this.decoder.decode()
        : this.decoder.decode(next.value, { stream: true });
      this.offset = 0;
    }
    return this.buffer[this.offset] ?? '';
  }
  async take(): Promise<string> {
    const char = await this.peek();
    if (char) this.offset++;
    return char;
  }
  async whitespace(): Promise<void> {
    while (' \t\r\n'.includes(await this.peek()) && (await this.peek())) await this.take();
  }
  async delimiter(expected: string): Promise<void> {
    await this.whitespace();
    if ((await this.take()) !== expected) throw new Error('invalid queue JSON delimiter');
  }
  async value(): Promise<JsonValue> {
    await this.whitespace();
    const parts: string[] = [];
    let consumed = false;
    let depth = 0;
    let string = false;
    let escaped = false;
    let structured = false;
    while (true) {
      if (!(await this.peek())) break;
      const start = this.offset;
      let finished = false;
      while (this.offset < this.buffer.length) {
        const char = this.buffer[this.offset] as string;
        if (!string && depth === 0 && consumed && (structured || ',]} \t\r\n'.includes(char))) {
          finished = true;
          break;
        }
        this.offset++;
        consumed = true;
        if (string) {
          if (escaped) escaped = false;
          else if (char === '\\') escaped = true;
          else if (char === '"') {
            string = false;
            if (depth === 0) structured = true;
          }
        } else if (char === '"') string = true;
        else if (char === '{' || char === '[') {
          depth++;
          structured = true;
        } else if (char === '}' || char === ']') depth--;
      }
      parts.push(this.buffer.slice(start, this.offset));
      if (finished) break;
    }
    return parseJsonValue(parts.join(''), {
      duplicates: 'error',
      parseConstant: (raw) =>
        JsonNumber.float(raw === 'NaN' ? NaN : raw === 'Infinity' ? Infinity : -Infinity, raw),
    });
  }
}

function object(value: JsonValue | undefined, label: string): JsonObject {
  if (!(value instanceof JsonObject)) throw new Error(`${label} must be an object`);
  return value;
}

/** Summarize without converting lossless integer and float values to JS numbers. */
function summarize(value: JsonValue): JsonObject {
  const row = object(value, 'admission');
  const observation = row.get('observation');
  const observationValue =
    observation === undefined || observation === null
      ? null
      : (() => {
          const source = object(observation, 'observation');
          return new JsonObject(
            ['successful', 'observed_at', 'remaining']
              .filter((key) => source.has(key))
              .map((key) => [key, source.get(key) as JsonValue]),
          );
        })();
  const reservations = object(
    row.has('reservations') ? row.get('reservations') : new JsonObject([]),
    'reservations',
  );
  const counts = new Map<string, number>();
  for (const [, hold] of reservations.entries) {
    const state = object(hold, 'reservation').get('quota_state') ?? 'unknown';
    if (typeof state !== 'string') throw new Error('reservation quota_state must be a string');
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }
  const countValue = row.has('reservation_counts')
    ? (row.get('reservation_counts') as JsonValue)
    : new JsonObject([...counts].map(([key, count]) => [key, JsonNumber.int(count)]));
  const fields = ['at', 'item', 'ordinary_eligible', 'effective_remaining', 'decision'];
  return new JsonObject([
    ...fields.filter((key) => row.has(key)).map((key) => [key, row.get(key) as JsonValue] as const),
    ['observation', observationValue],
    ['reservation_counts', countValue],
  ]);
}

function retire(queue: JsonObject): JsonObject {
  const items = queue.get('items');
  if (!Array.isArray(items)) throw new Error('queue items must be an array');
  return withObjectKeys(queue, [
    [
      'items',
      items.map((value) => {
        let item = object(value, 'queue item');
        if (item.get('kind') === 'promotion') return item;
        item = withoutObjectKey(item, 'boost');
        const cycles = item.get('cycles') === undefined ? [] : item.get('cycles');
        if (item.get('kind') === 'open' && !Array.isArray(cycles))
          throw new Error('open cycles must be an array');
        if (
          item.get('kind') === 'open' &&
          Array.isArray(cycles) &&
          cycles.length > 0 &&
          (item.get('state') === 'pending' || item.get('state') === 'blocked') &&
          !pyTruthy(item.get('optional_cycle'))
        ) {
          item = withObjectKeys(item, [
            ['state', 'done'],
            ['not_before', null],
            ['last_error', null],
          ]);
        }
        return item;
      }),
    ],
  ]);
}

/** `crq.load_queue()` preview: read-only, incremental compaction plus retirement. */
export async function loadInventoryQueue(path: string): Promise<JsonObject> {
  const reader = new QueueReader(path);
  try {
    const entries: Array<readonly [string, JsonValue]> = [];
    const seen = new Set<string>();
    await reader.delimiter('{');
    await reader.whitespace();
    while ((await reader.peek()) !== '}') {
      const key = await reader.value();
      if (typeof key !== 'string' || seen.has(key))
        throw new Error('invalid or duplicate queue key');
      seen.add(key);
      await reader.delimiter(':');
      let value: JsonValue;
      if (key === 'backfill_admissions') {
        await reader.delimiter('[');
        await reader.whitespace();
        const rows: JsonValue[] = [];
        while ((await reader.peek()) !== ']') {
          rows.push(summarize(await reader.value()));
          if (rows.length > ADMISSION_HISTORY_LIMIT) rows.shift();
          await reader.whitespace();
          if ((await reader.peek()) === ']') break;
          await reader.delimiter(',');
          await reader.whitespace();
          if ((await reader.peek()) === ']') throw new Error('trailing admission comma');
        }
        await reader.delimiter(']');
        value = rows;
      } else value = await reader.value();
      entries.push([key, value]);
      await reader.whitespace();
      if ((await reader.peek()) === '}') break;
      await reader.delimiter(',');
      await reader.whitespace();
      if ((await reader.peek()) === '}') throw new Error('trailing queue comma');
    }
    await reader.delimiter('}');
    await reader.whitespace();
    if (await reader.peek()) throw new Error('trailing queue data');
    let queue = new JsonObject(entries);
    const version = queue.has(ADMISSION_HISTORY_MARKER)
      ? queue.get(ADMISSION_HISTORY_MARKER)
      : JsonNumber.int(0);
    if (
      !(version instanceof JsonNumber) ||
      version.kind !== 'int' ||
      version.integer === null ||
      version.integer < 0n ||
      version.integer > 1n
    ) {
      throw new Error('unsupported admission history version');
    }
    if (queue.has('backfill_admissions') && version.integer !== 1n)
      queue = withObjectKeys(queue, [[ADMISSION_HISTORY_MARKER, JsonNumber.int(1)]]);
    return retire(queue);
  } finally {
    await reader.close();
  }
}
