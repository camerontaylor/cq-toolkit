/** Rolling closed-PR discovery, ported from crq.py's closed-updated-v1 adapter. */
import { JsonNumber, parseJsonValue } from './jsonValue.js';
import {
  fromPlainJson,
  isJsonInt,
  isJsonRecord,
  jsonIntValue,
  pyTruthy,
  recordEntries,
  recordGet,
  recordHas,
} from './queueDoc.js';
import { pythonJsonText } from './pythonJson.js';
import { MAX_CURSOR_BYTES, ReconcileRefused, normalizeInterval } from './reconcileCheckpoint.js';
import { DISCOVERY_BRANCHES } from './reconcileInventory.js';

const PAGE = 100n;
const OVERLAP = 20n;
const ANCHORS = 40;
const MAX_TIES = 100;
const LOOKAHEAD = 25n;
const FIELDS = ['v', 'n', 'p', 'f', 'fs', 'fa', 'h', 'hs', 'ha', 'o', 'a', 'x', 'k', 'c'];
const V1_FIELDS = ['n', 'p', 'f', 'fs', 'fa', 'h', 'hs', 'ha', 'o', 'u', 't', 'k', 'c'];
type Anchor = [bigint, string];
interface State {
  v: bigint;
  n: bigint;
  p: bigint;
  f: string;
  fs: bigint[];
  fa: boolean;
  h: string | null;
  hs: bigint[];
  ha: boolean;
  o: bigint;
  a: Anchor[];
  x: bigint;
  k: bigint;
  c: bigint;
}
function fresh(after: string): State {
  return {
    v: 2n,
    n: 0n,
    p: 0n,
    f: after,
    fs: [],
    fa: false,
    h: null,
    hs: [],
    ha: false,
    o: 0n,
    a: [],
    x: 0n,
    k: 0n,
    c: 0n,
  };
}
function integer(value: unknown): bigint | null {
  if (isJsonInt(value)) return jsonIntValue(value);
  return typeof value === 'number' && Number.isSafeInteger(value) ? BigInt(value) : null;
}
function timestamp(value: unknown): value is string {
  try {
    normalizeInterval('1970-01-01T00:00:00Z', value);
    return true;
  } catch {
    return false;
  }
}
function sameFields(value: unknown, fields: string[]): boolean {
  return (
    isJsonRecord(value) &&
    recordEntries(value).length === fields.length &&
    fields.every((key) => recordHas(value, key))
  );
}
function decode(cursor: string | null, after: string): State {
  if (cursor === null || /^[1-9][0-9]*$/.test(cursor)) return fresh(after);
  let raw: unknown;
  try {
    raw = parseJsonValue(cursor);
  } catch {
    throw new ReconcileRefused('invalid closed-PR page cursor');
  }
  if (sameFields(raw, V1_FIELDS)) return fresh(after);
  const invalid = (): never => {
    throw new ReconcileRefused('invalid closed-PR page cursor');
  };
  if (!isJsonRecord(raw) || !sameFields(raw, FIELDS)) return invalid();
  const count = (key: string): bigint => {
    const n = integer(recordGet(raw, key));
    return n === null || n < 0n ? invalid() : n;
  };
  const list = (key: string): bigint[] => {
    const value = recordGet(raw, key);
    if (!Array.isArray(value) || value.length > MAX_TIES) return invalid();
    const result = value.map((entry) => {
      const n = integer(entry);
      return n === null || n <= 0n ? invalid() : n;
    });
    if (new Set(result).size !== result.length) return invalid();
    return result;
  };
  const flag = (key: string): boolean => {
    const v = recordGet(raw, key);
    return typeof v === 'boolean' ? v : invalid();
  };
  const f = recordGet(raw, 'f');
  const h = recordGet(raw, 'h');
  const anchors = recordGet(raw, 'a');
  if (
    !timestamp(f) ||
    (h !== null && !timestamp(h)) ||
    !Array.isArray(anchors) ||
    anchors.length > ANCHORS
  )
    return invalid();
  const a: Anchor[] = anchors.map((entry): Anchor => {
    if (!Array.isArray(entry) || entry.length !== 2) return invalid();
    const n = integer(entry[0]);
    const t: unknown = entry[1];
    if (n === null || n <= 0n || !timestamp(t)) return invalid();
    return [n, t];
  });
  const s: State = {
    v: count('v'),
    n: count('n'),
    p: count('p'),
    f,
    fs: list('fs'),
    fa: flag('fa'),
    h,
    hs: list('hs'),
    ha: flag('ha'),
    o: count('o'),
    a,
    x: count('x'),
    k: count('k'),
    c: count('c'),
  };
  if (
    s.v !== 2n ||
    (s.fa && s.fs.length > 0) ||
    (s.ha && s.hs.length > 0) ||
    (s.p === 0n && (s.f !== after || s.fs.length > 0 || s.fa)) ||
    (s.k === 0n && (s.h !== null || s.o !== 0n || s.a.length > 0 || s.x !== 0n)) ||
    (s.o !== 0n && s.a.length === 0)
  )
    return invalid();
  return s;
}
function encode(state: State): string {
  return pythonJsonText(fromPlainJson(state), {
    asciiOnly: true,
    sortKeys: false,
    keyOrder: 'code-point',
    indent: null,
    spacedSeparators: false,
  });
}
function window(offset: bigint): [number, number, bigint] {
  if (offset <= 0n) return [100, 1, 0n];
  let bestEnd = 0n;
  let bestSize = 0n;
  for (let w = 1n; w <= PAGE; w += 1n) {
    const end = (offset / w) * w + w;
    if (end > bestEnd || (end === bestEnd && w > bestSize)) {
      bestEnd = end;
      bestSize = w;
    }
  }
  const start = bestEnd - bestSize;
  return [Number(bestSize), Number(start / bestSize + 1n), start];
}
interface Row {
  number: bigint;
  updated: string;
  raw: ReturnType<typeof fromPlainJson>;
  merged: unknown;
  base: unknown;
  head: unknown;
  sha: unknown;
}
function rowsOf(value: unknown, size: number): Row[] {
  if (!Array.isArray(value) || value.length > size)
    throw new ReconcileRefused('invalid closed-PR page');
  return value.map((item) => {
    if (!isJsonRecord(item)) throw new ReconcileRefused('invalid closed-PR record');
    const number = integer(recordGet(item, 'number'));
    const updated = recordGet(item, 'updated_at');
    if (number === null || number <= 0n) throw new ReconcileRefused('invalid closed-PR record');
    normalizeInterval('1970-01-01T00:00:00Z', updated);
    if (!recordHas(item, 'merged_at')) throw new ReconcileRefused('missing merge metadata');
    return {
      number,
      updated: updated as string,
      raw: fromPlainJson(item),
      merged: recordGet(item, 'merged_at'),
      base: recordGet(item, 'base'),
      head: recordGet(item, 'head'),
      sha: recordGet(item, 'merge_commit_sha'),
    };
  });
}
function key(number: bigint, updated: string): string {
  return `${number.toString()}:${updated}`;
}
function child(value: unknown, name: string): unknown {
  return isJsonRecord(value) ? recordGet(value, name) : undefined;
}

/** Fetch one resumable REST window. The callback owns transport and aggregate budget. */
export async function recentMergedPage(
  rest: (size: number, page: number) => Promise<unknown>,
  cursor: string | null,
  after: string,
): Promise<{ records: unknown[]; has_next_page: boolean; next_cursor: string | null }> {
  const state = decode(cursor, after);
  const [size, page, start] = window(state.o);
  const rows = rowsOf(await rest(size, page), size);
  let next: State = { ...state, n: state.n + 1n, k: state.k + 1n };
  let passed = [...state.a];
  let cut = -1;
  if (passed.length > 0) {
    const positions = new Map<string, number>();
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const row = rows[i]!;
      positions.set(key(row.number, row.updated), i);
    }
    const found = passed
      .map(([n, t]) => positions.get(key(n, t)))
      .filter((i): i is number => i !== undefined);
    if (found.length > 0) cut = Math.max(...found);
    else if (start > 0n) {
      next.o = start > PAGE ? start - PAGE : 0n;
      return { records: [], has_next_page: true, next_cursor: encode(next) };
    } else {
      passed = [];
      next.x = 0n;
    }
  }
  const seen = new Set(state.fs);
  const head =
    state.k !== 0n
      ? state.h
      : rows.reduce<string | null>(
          (best, row) => (best === null || row.updated > best ? row.updated : best),
          null,
        );
  let headSeen = new Set(state.hs);
  let headAll = state.ha;
  const records: unknown[] = [];
  let ended = rows.length < size;
  const below = (row: Row): boolean =>
    row.updated < state.f || (row.updated === state.f && state.p === 0n);
  const take = (row: Row): void => {
    if (row.updated === head && !headAll) {
      headSeen.add(row.number);
      if (headSeen.size > MAX_TIES) {
        headSeen = new Set();
        headAll = true;
      }
    }
    if (state.p > 0n && row.updated === state.f) {
      if (seen.has(row.number)) return;
      if (!state.fa) next.c += 1n;
    } else next.c += 1n;
    const ref = child(row.base, 'ref');
    if (pyTruthy(row.merged) && typeof ref === 'string' && DISCOVERY_BRANCHES.includes(ref)) {
      records.push(
        fromPlainJson({
          number: JsonNumber.int(row.number),
          mergedAt: row.merged,
          mergeCommit: { oid: row.sha ?? null },
          headRefOid: child(row.head, 'sha') ?? null,
        }),
      );
    }
  };
  const remembered = new Set(passed.map(([n, t]) => key(n, t)));
  for (const row of rows.slice(0, cut + 1))
    if (!remembered.has(key(row.number, row.updated)) && !below(row)) take(row);
  for (const row of rows.slice(cut + 1)) {
    const anchor: Anchor = [row.number, row.updated];
    passed = [...passed, anchor].slice(-ANCHORS);
    if (below(row)) {
      next.x += 1n;
      if (next.x >= LOOKAHEAD) {
        ended = true;
        break;
      }
      continue;
    }
    next.x = 0n;
    take(row);
  }
  if (ended) {
    if (state.k === 0n || (state.p > 0n && next.c === 0n))
      return { records, has_next_page: false, next_cursor: null };
    // A multi-request pass must rescan its head for rows that moved above the anchor.
    next = {
      ...fresh(after),
      n: state.n + 1n,
      p: state.p + 1n,
      f: head!,
      fs: [...headSeen].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
      fa: headAll,
    };
  } else {
    next = {
      ...next,
      h: head,
      hs: [...headSeen].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
      ha: headAll,
      a: passed,
      o:
        start + BigInt(rows.length) - 1n > OVERLAP
          ? start + BigInt(rows.length) - 1n - OVERLAP
          : 0n,
    };
  }
  let encoded = encode(next);
  if (Buffer.byteLength(encoded) > MAX_CURSOR_BYTES) {
    if (next.fs.length > 0) {
      next.fs = [];
      next.fa = true;
    }
    if (next.hs.length > 0) {
      next.hs = [];
      next.ha = true;
    }
    encoded = encode(next);
    if (Buffer.byteLength(encoded) > MAX_CURSOR_BYTES)
      throw new ReconcileRefused('closed-PR numbers too large for the scan cursor');
  }
  return { records, has_next_page: true, next_cursor: encoded };
}
