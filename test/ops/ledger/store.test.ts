// Ledger lane C4 — store-slice test evidence: the flat format is
// byte-deterministic (same state → same bytes, regardless of insertion
// order, pinned over a seeded shuffle) and parseLedger is strict (every
// violation of the committed format is a LedgerFormatError — a hand-edited
// unsorted or duplicate-laden file is never silently normalized).
import { describe, expect, test } from 'vitest';
import type { LedgerEntry, LedgerFile } from '../../../src/ops/ledger/store.js';
import {
  LedgerFormatError,
  parseLedger,
  serializeLedger,
  sortEntries,
} from '../../../src/ops/ledger/store.js';

/** Ten signatures spanning the byte range; insertion order is deliberately unsorted. */
const SIGNATURES = [
  'sig-delta',
  'sig-alpha',
  'sig-echo',
  'sig-beta',
  'sig-kappa',
  'sig-gamma',
  'sig-iota',
  'sig-zeta',
  'sig-eta',
  'sig-theta',
];

/** Deterministic LCG so the shuffle property test never flakes. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/** Fisher–Yates shuffle driven by the seeded LCG. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const copy = [...items];
  const next = seededRandom(seed);
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    const a = copy[i] as T;
    const b = copy[j] as T;
    copy[i] = b;
    copy[j] = a;
  }
  return copy;
}

/** A fixed entry pool — counts and optional fields travel WITH the signature. */
const POOL: LedgerEntry[] = SIGNATURES.map((signature, i) => ({
  signature,
  count: i + 1,
  ...(i % 3 === 0 ? { component: `comp-${signature}` } : {}),
  ...(i % 4 === 0 ? { note: `note-${signature}` } : {}),
}));

/** The pool in seeded-shuffled ORDER only (payloads are invariant across seeds). */
function shuffledFile(seed: number): LedgerFile {
  return { version: 1, entries: shuffled(POOL, seed) };
}

describe('serializeLedger / parseLedger round trip', () => {
  test('file → text → file is identical, and serialization is byte-stable', () => {
    const file = shuffledFile(7);
    const text = serializeLedger(file);
    // parse returns the entries in canonical order — the file's content,
    // however it was arranged in memory.
    expect(parseLedger(text)).toEqual({ version: 1, entries: sortEntries(file.entries) });
    expect(serializeLedger(parseLedger(text))).toBe(text);
    expect(serializeLedger(file)).toBe(text);
  });

  test('the bytes themselves: schema key order, 2-space indent, one trailing newline', () => {
    const text = serializeLedger({
      version: 1,
      entries: [
        { signature: 'sig-b', count: 1 },
        { signature: 'sig-a', count: 2, component: 'core', note: 'flaky env' },
      ],
    });
    expect(text).toBe(
      `{
  "version": 1,
  "entries": [
    {
      "signature": "sig-a",
      "count": 2,
      "component": "core",
      "note": "flaky env"
    },
    {
      "signature": "sig-b",
      "count": 1
    }
  ]
}
`,
    );
  });

  test('insert order shuffled across 20 seeds → identical serialized text', () => {
    const expected = serializeLedger(shuffledFile(0));
    for (let seed = 1; seed <= 20; seed++) {
      expect(serializeLedger(shuffledFile(seed))).toBe(expected);
    }
  });

  test('optional fields absent vs undefined serialize identically', () => {
    const absent = serializeLedger({ version: 1, entries: [{ signature: 's', count: 1 }] });
    const undef = serializeLedger({
      version: 1,
      entries: [{ signature: 's', count: 1, component: undefined, note: undefined }],
    });
    expect(undef).toBe(absent);
  });

  test('serializeLedger refuses a non-integer count (NaN would render to null) and duplicate signatures', () => {
    expect(() =>
      serializeLedger({ version: 1, entries: [{ signature: 's', count: Number.NaN }] }),
    ).toThrow(LedgerFormatError);
    expect(() =>
      serializeLedger({ version: 1, entries: [{ signature: 's', count: 1.5 }] }),
    ).toThrow(LedgerFormatError);
    expect(() =>
      serializeLedger({ version: 1, entries: [{ signature: 's', count: 1 }, { signature: 's', count: 2 }] }),
    ).toThrow(LedgerFormatError);
  });
});

describe('parseLedger rejections (the deterministic format is load-bearing)', () => {
  const entryA = `{
    "signature": "sig-a",
    "count": 1
  }`;
  const entryB = `{
    "signature": "sig-b",
    "count": 2
  }`;

  test('invalid JSON is a LedgerFormatError', () => {
    expect(() => parseLedger('{not json')).toThrow(LedgerFormatError);
    expect(() => parseLedger('')).toThrow(LedgerFormatError);
  });

  test('a wrong version is rejected (missing, non-1, stringified)', () => {
    const body = `"entries": [${entryA}]`;
    expect(() => parseLedger(`{${body}}`)).toThrow(LedgerFormatError);
    expect(() => parseLedger(`{"version": 2, ${body}}`)).toThrow(LedgerFormatError);
    expect(() => parseLedger(`{"version": "1", ${body}}`)).toThrow(LedgerFormatError);
  });

  test('duplicate signatures are rejected, adjacent or not', () => {
    expect(() => parseLedger(`{"version": 1, "entries": [${entryA}, ${entryA}]}`)).toThrow(
      LedgerFormatError,
    );
    expect(() =>
      parseLedger(`{"version": 1, "entries": [${entryA}, ${entryB}, ${entryA}]}`),
    ).toThrow(LedgerFormatError);
  });

  test('unsorted entries are rejected (a hand-edited file is a format error, never normalized)', () => {
    expect(() => parseLedger(`{"version": 1, "entries": [${entryB}, ${entryA}]}`)).toThrow(
      LedgerFormatError,
    );
  });

  test('a count below 1 (or fractional) is rejected', () => {
    const zero = entryA.replace('"count": 1', '"count": 0');
    const negative = entryA.replace('"count": 1', '"count": -1');
    const fractional = entryA.replace('"count": 1', '"count": 1.5');
    for (const bad of [zero, negative, fractional]) {
      expect(() => parseLedger(`{"version": 1, "entries": [${bad}]}`)).toThrow(LedgerFormatError);
    }
  });

  test('entries outside the record boundary field bounds are rejected (sig ≤ 500; component ≤ 200; note ≤ 500; never empty)', () => {
    // At the bounds exactly: valid (the boundary accepts, so the parse
    // must too — the two boundaries reject the same states).
    const atBounds = `{"signature": "${'s'.repeat(500)}", "count": 1, "component": "${'c'.repeat(200)}", "note": "${'n'.repeat(500)}"}`;
    expect(() => parseLedger(`{"version": 1, "entries": [${atBounds}]}`)).not.toThrow();
    // One step past each bound, and each empty-optional state: all format
    // errors — a hand-edited file cannot hold what no valid record could
    // produce (an overlong signature no record can increment; an EMPTY
    // component/note that reads as present and can never be backfilled).
    const overlongSignature = `{"signature": "${'s'.repeat(501)}", "count": 1}`;
    const emptyComponent = `{"signature": "sig-a", "count": 1, "component": ""}`;
    const overlongComponent = `{"signature": "sig-a", "count": 1, "component": "${'c'.repeat(201)}"}`;
    const emptyNote = `{"signature": "sig-a", "count": 1, "note": ""}`;
    const overlongNote = `{"signature": "sig-a", "count": 1, "note": "${'n'.repeat(501)}"}`;
    for (const bad of [overlongSignature, emptyComponent, overlongComponent, emptyNote, overlongNote]) {
      expect(() => parseLedger(`{"version": 1, "entries": [${bad}]}`)).toThrow(LedgerFormatError);
    }
  });

  test('a non-object entry (string, null, array, number) is rejected', () => {
    for (const bad of ['"sig-a"', 'null', '[]', '7']) {
      expect(() => parseLedger(`{"version": 1, "entries": [${bad}]}`)).toThrow(LedgerFormatError);
    }
  });

  test('structural violations are rejected: non-object root, missing/non-array entries, unknown keys', () => {
    expect(() => parseLedger('[]')).toThrow(LedgerFormatError);
    expect(() => parseLedger('null')).toThrow(LedgerFormatError);
    expect(() => parseLedger('{"version": 1}')).toThrow(LedgerFormatError);
    expect(() => parseLedger('{"version": 1, "entries": "sig-a"}')).toThrow(LedgerFormatError);
    expect(() => parseLedger(`{"version": 1, "entries": [${entryA}], "extra": true}`)).toThrow(
      LedgerFormatError,
    );
    expect(() =>
      parseLedger(`{"version": 1, "entries": [{"signature": "sig-a", "count": 1, "extra": 1}]}`),
    ).toThrow(LedgerFormatError);
  });

  test('an empty ledger parses (recording is the only writer, so empty is a real state)', () => {
    expect(parseLedger('{"version": 1, "entries": []}')).toEqual({ version: 1, entries: [] });
  });
});

describe('sortEntries', () => {
  test('returns the canonical byte-wise ascending order without mutating the input', () => {
    const input: LedgerEntry[] = shuffledFile(3).entries;
    const snapshot = [...input];
    const sorted = sortEntries(input);
    expect(input).toEqual(snapshot);
    expect(sorted.map((entry) => entry.signature)).toEqual([...SIGNATURES].sort());
    expect([...sorted.map((entry) => entry.count)].sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
  });

  test('is stable for equal signatures (a plain array helper; duplicate rejection lives in parseLedger)', () => {
    const first: LedgerEntry = { signature: 'same', count: 1 };
    const second: LedgerEntry = { signature: 'same', count: 2 };
    const sorted = sortEntries([first, second, { signature: 'aaa', count: 1 }]);
    expect(sorted).toEqual([{ signature: 'aaa', count: 1 }, first, second]);
  });

  test('orders by code point — UTF-8 byte order, so a non-BMP signature sorts by its true bytes', () => {
    const sorted = sortEntries([{ signature: '�', count: 1 }, { signature: '🚀', count: 1 }]);
    // U+FFFD (EF BF BD in UTF-8) sorts before U+1F680 (F0 9F 9A 80), even
    // though the rocket's surrogate high half (D83D) would flip UTF-16
    // code-unit order.
    expect(sorted.map((entry) => entry.signature)).toEqual(['�', '🚀']);
  });
});

describe('LedgerFormatError', () => {
  test('is an Error subclass with a distinct name', () => {
    const err = new LedgerFormatError('boom');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('LedgerFormatError');
    expect(err.message).toBe('boom');
  });
});
