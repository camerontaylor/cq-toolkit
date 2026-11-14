import { describe, expect, test } from 'vitest';
import { recentMergedPage } from '../../../src/policy/crq/recentDiscovery.js';
import {
  isJsonInt,
  isJsonRecord,
  jsonIntValue,
  recordGet,
} from '../../../src/policy/crq/queueDoc.js';

const AFTER = '2026-10-01T00:00:00Z';
const LATER = '2026-10-03T00:00:00Z';

type Row = {
  number: number;
  updated_at: string;
  merged_at: string | null;
  merge_commit_sha: string;
  base: { ref: string };
  head: { sha: string };
  sort?: string;
  tie?: number;
};

function fixture(count: number, unmerged: readonly number[] = []) {
  const rows = new Map<number, Row>();
  for (let n = 1; n <= count; n += 1) {
    const at = new Date(Date.parse('2026-10-02T00:00:00Z') + n * 1000)
      .toISOString()
      .replace('.000Z', 'Z');
    const sha = n.toString(16).padStart(40, '0');
    rows.set(n, {
      number: n,
      updated_at: at,
      merged_at: unmerged.includes(n) ? null : at,
      merge_commit_sha: sha,
      base: { ref: 'main' },
      head: { sha },
    });
  }
  const calls: [number, number][] = [];
  const hooks = new Map<number, () => void>();
  async function rest(size: number, page: number): Promise<unknown> {
    hooks.get(calls.length)?.();
    calls.push([size, page]);
    return [...rows.values()]
      .sort(
        (a, b) =>
          (b.sort ?? b.updated_at).localeCompare(a.sort ?? a.updated_at) ||
          (b.tie ?? b.number) - (a.tie ?? a.number),
      )
      .slice((page - 1) * size, page * size)
      .map(({ sort: _sort, tie: _tie, ...row }) => row);
  }
  function move(n: number) {
    const row = rows.get(n)!;
    row.updated_at = LATER;
    row.sort = LATER;
  }
  function bump(n: number) {
    const row = rows.get(n)!;
    row.sort ??= row.updated_at;
    row.updated_at = LATER;
  }
  async function scan() {
    let cursor: string | null = null;
    const found = new Set<number>();
    for (let i = 0; i < 40; i += 1) {
      const result = await recentMergedPage(rest, cursor, AFTER);
      for (const row of result.records) {
        if (!isJsonRecord(row)) throw new Error('invalid record');
        const number = recordGet(row, 'number');
        if (!isJsonInt(number)) throw new Error('invalid record number');
        found.add(Number(jsonIntValue(number)));
      }
      expect(result.has_next_page).toBe(result.next_cursor !== null);
      cursor = result.next_cursor;
      if (cursor === null) return found;
      expect(Buffer.byteLength(cursor)).toBeLessThanOrEqual(4096);
    }
    throw new Error('scan did not complete');
  }
  const expected = new Set(
    [...rows.values()].filter((row) => row.merged_at !== null).map((row) => row.number),
  );
  return { rows, calls, hooks, rest, move, bump, scan, expected };
}

describe('rolling closed PR discovery', () => {
  test('single page filters floor, unmerged and other branches without another request', async () => {
    const f = fixture(4, [2]);
    f.rows.get(3)!.base.ref = 'feature';
    f.rows.get(4)!.updated_at = AFTER;
    const found = await f.scan();
    expect(found).toEqual(new Set([1]));
    expect(f.calls).toEqual([[100, 1]]);
  });

  test('stale sort positions on both sides of a page boundary are read', async () => {
    const f = fixture(250);
    f.bump(230);
    f.bump(150);
    f.hooks.set(1, () => f.bump(151));
    expect(await f.scan()).toEqual(f.expected);
  });

  test('reopens and moves between page requests do not lose merges', async () => {
    const f = fixture(250, [200]);
    f.hooks.set(1, () => {
      f.rows.delete(200);
    });
    f.hooks.set(2, () => f.move(10));
    expect(await f.scan()).toEqual(f.expected);
    expect(f.calls).not.toContainEqual([100, 2]);
  });

  test('large reopen burst backs off to an anchored window', async () => {
    const unmerged = Array.from({ length: 30 }, (_, i) => i + 171);
    const f = fixture(250, unmerged);
    f.hooks.set(1, () => {
      for (const n of unmerged) f.rows.delete(n);
    });
    expect(await f.scan()).toEqual(f.expected);
    expect(f.calls.slice(0, 3)).toEqual([
      [100, 1],
      [79, 2],
      [100, 1],
    ]);
  });

  test('same-second rows swapping across a boundary are not missed', async () => {
    const f = fixture(250);
    f.rows.get(151)!.updated_at = f.rows.get(150)!.updated_at;
    f.hooks.set(1, () => {
      f.rows.get(150)!.tie = 1000000;
    });
    expect(await f.scan()).toEqual(f.expected);
  });

  test('oversized same-second group and a concurrent move complete', async () => {
    const f = fixture(600, [550]);
    for (let n = 100; n < 500; n += 1) f.rows.get(n)!.updated_at = '2026-10-02T00:05:00Z';
    f.hooks.set(2, () => {
      f.rows.delete(550);
      f.move(250);
    });
    expect(await f.scan()).toEqual(f.expected);
    expect(f.calls.every(([size]) => size <= 100)).toBe(true);
  });

  test('a row updated into the head second during traversal is retained', async () => {
    const f = fixture(600);
    for (let n = 600; n > 400; n -= 2) {
      f.rows.get(n)!.updated_at = '2026-10-02T00:50:00Z';
    }
    f.hooks.set(1, () => {
      f.rows.get(501)!.updated_at = '2026-10-02T00:50:00Z';
    });
    expect(await f.scan()).toEqual(f.expected);
  });

  test('a legacy numeric cursor safely restarts at the first page', async () => {
    const f = fixture(1);
    const result = await recentMergedPage(f.rest, '2', AFTER);
    expect(result.records).toHaveLength(1);
    expect(result.next_cursor).toBeNull();
    expect(f.calls).toEqual([[100, 1]]);
  });

  test('invalid cursors are rejected before reading the forge', async () => {
    const f = fixture(1);
    for (const cursor of ['{', '[]', '02', '{}']) {
      await expect(recentMergedPage(f.rest, cursor, AFTER)).rejects.toThrow(/cursor/i);
    }
    expect(f.calls).toEqual([]);
  });

  test('invalid pages and missing merge metadata are rejected', async () => {
    await expect(recentMergedPage(async () => ({}), null, AFTER)).rejects.toThrow();
    await expect(
      recentMergedPage(async () => [{ number: 1, updated_at: LATER }], null, AFTER),
    ).rejects.toThrow();
  });
});
