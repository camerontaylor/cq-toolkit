/**
 * `backfill_accounting` differential and parser tests.
 *
 * The group-P family is the oracle's own vector file: every case is replayed
 * here, including the 53 `line_bytes` / `_int` / `_opt_str` / `_rows` /
 * `_hexstr` / `FACT_SHAPES` cases that were previously unported. The remaining
 * tests pin the byte-level parsers the vectors cannot express (blame headers,
 * name-status renames, the pinned hunk state machine and Python's list-index
 * semantics in `carry`).
 */
import { describe, expect, test } from 'vitest';
import {
  FACT_SHAPES,
  BackfillAccountingError,
  BackfillAccountingIndexError,
  blameFact,
  blameFromFact,
  carryFromFact,
  carryMatches,
  carrySelection,
  coverageFact,
  factInt,
  hexString,
  intervalRows,
  lineBytes,
  lineCount,
  lineRanges,
  optionalString,
  parseBlame,
  parseChangedIntervals,
  parseNameStatus,
  pythonSplitLines,
  splitNul,
  verifiedFact,
  type AccountingFactKind,
} from '../../../src/policy/crq/backfillAccounting.js';
import {
  JsonNumber,
  JsonObject,
  parseJsonValue,
  toPlainJson,
  type JsonValue,
} from '../../../src/policy/crq/jsonValue.js';
import { loadFamily, textAt, valueAt, type VectorCase } from './backfillFixtures.js';
import { ledgerJsonBytes } from '../../../src/policy/crq/pythonJson.js';

function json(value: unknown): JsonValue {
  return parseJsonValue(JSON.stringify(value));
}

function accountingVector(vector: VectorCase): unknown {
  switch (vector.source) {
    case 'backfill_accounting.line_bytes': {
      const data = Buffer.from(textAt(vector.input, 'base64'), 'base64');
      return lineBytes(new Uint8Array(data)).map((line) => Buffer.from(line).toString('base64'));
    }
    case 'backfill_accounting._int': {
      const low = toPlainJson(valueAt(vector.input, 'low') as JsonValue);
      return factInt(valueAt(vector.input, 'value') as JsonValue, low as number);
    }
    case 'backfill_accounting._opt_str':
      return optionalString(valueAt(vector.input, 'value') as JsonValue);
    case 'backfill_accounting._rows':
      return intervalRows(valueAt(vector.input, 'value') as JsonValue);
    case 'backfill_accounting._hexstr':
      return hexString(valueAt(vector.input, 'value') as JsonValue);
    case 'backfill_accounting.FACT_SHAPES': {
      const kind = textAt(vector.input, 'kind') as AccountingFactKind;
      return FACT_SHAPES[kind](valueAt(vector.input, 'value') as JsonValue);
    }
    default:
      throw new Error(`unported accounting vector ${vector.source}`);
  }
}

describe.each(loadFamily('backfill-accounting'))('group-p backfill-accounting/$name', (vector) => {
  test(`${vector.source} matches the Python oracle`, () => {
    expect(accountingVector(vector)).toEqual(
      toPlainJson(valueAt(vector.expect, 'value') as JsonValue),
    );
  });
});

describe('line maths', () => {
  test('lineCount keeps the CRLF carriage return and empty lines', () => {
    expect(lineCount(new Uint8Array())).toBe(0);
    expect(lineCount(new Uint8Array([0x0a]))).toBe(1);
    expect(lineCount(Buffer.from('a\r\nb'))).toBe(2);
    expect(lineCount(Buffer.from('a\n\n'))).toBe(2);
  });

  test('lineRanges coalesces sorted duplicates only', () => {
    expect(lineRanges([3, 1, 2, 5])).toEqual([
      [1, 3],
      [5, 5],
    ]);
    expect(lineRanges([])).toEqual([]);
  });

  test('factInt distinguishes int from float and boolean', () => {
    expect(factInt(JsonNumber.int(1))).toBe(true);
    expect(factInt(JsonNumber.float(1))).toBe(false);
    expect(factInt(json(true))).toBe(false);
    expect(factInt(json(1), 2)).toBe(false);
  });
});

describe('blame rows', () => {
  test('a header, filename and tab-prefixed content make one row', () => {
    const raw = Buffer.from(
      `${'a'.repeat(40)} 1 1 2\n` +
        'author fixture\n' +
        'filename src/a.ts\n' +
        '\tfirst line\n' +
        `${'b'.repeat(40)} 2 2\n` +
        'filename src/a.ts\n' +
        '\tsecond line\n',
    );
    const rows = parseBlame(new Uint8Array(raw));
    expect(rows).toHaveLength(2);
    expect(rows[0]?.origin).toBe('a'.repeat(40));
    expect(rows[0]?.originalLine).toBe(1);
    expect(Buffer.from(rows[0]?.filename ?? []).toString()).toBe('src/a.ts');
    expect(Buffer.from(rows[0]?.content ?? []).toString()).toBe('first line');
    expect(rows[1]?.originalLine).toBe(2);
  });

  test('a 64-hex origin and an optional group count are accepted', () => {
    const raw = Buffer.from(`${'c'.repeat(64)} 7 7 3\nfilename f\n\tx\n`);
    expect(parseBlame(new Uint8Array(raw))[0]?.origin).toBe('c'.repeat(64));
  });

  test('the cache fact round-trips bytes losslessly', () => {
    const rows = [
      {
        origin: 'a'.repeat(40),
        originalLine: 3,
        filename: new Uint8Array([0xff, 0x00]),
        content: new Uint8Array([0x09, 0x0a]),
      },
    ];
    const fact = json(blameFact(rows));
    const restored = blameFromFact(fact);
    expect(restored).not.toBeNull();
    expect(restored?.[0]?.filename).toEqual(new Uint8Array([0xff, 0x00]));
    expect(restored?.[0]?.content).toEqual(new Uint8Array([0x09, 0x0a]));
    expect(blameFromFact(json([['origin', '1', 'zz', '']]))).toBeNull();
  });
});

describe('name-status lineage steps', () => {
  test('rename and copy consume a destination field', () => {
    const raw = Buffer.from('R100\0old.py\0new.py\0D\0gone.py\0C75\0a\0b\0M\0x\0');
    expect(parseNameStatus(new Uint8Array(raw))).toEqual([
      ['R100', 'old.py', 'new.py'],
      ['D', 'gone.py', null],
      ['C75', 'a', 'b'],
      ['M', 'x', null],
    ]);
  });

  test('splitNul keeps the trailing empty field', () => {
    expect(
      splitNul(new Uint8Array(Buffer.from('a\0b\0'))).map((f) => Buffer.from(f).toString()),
    ).toEqual(['a', 'b', '']);
  });

  test('pythonSplitLines honours CR, LF and CRLF only', () => {
    expect(
      pythonSplitLines(new Uint8Array(Buffer.from('a\rb\r\nc\nd'))).map((line) =>
        Buffer.from(line).toString(),
      ),
    ).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('changed intervals', () => {
  test('a forged patch body cannot invent a file or context credit', () => {
    const patch = [
      'diff --git a/a b/a',
      '--- a/a',
      '+++ b/a',
      '@@ -1 +1 @@',
      '-first',
      '+++ b/other',
      '+second',
    ].join('\n');
    const intervals = parseChangedIntervals(new Uint8Array(Buffer.from(patch)));
    expect([...(intervals.get('a') ?? [])]).toEqual([1]);
    expect(intervals.has('other')).toBe(false);
  });

  test('multiple hunks and no final newline credit head-side ranges', () => {
    const patch = [
      '--- a/a',
      '+++ b/a',
      '@@ -1 +1 @@',
      '-one',
      '+ONE',
      '@@ -5 +5 @@',
      '-five',
      '+FIVE',
      '\\ No newline at end of file',
    ].join('\n');
    expect([...(parseChangedIntervals(new Uint8Array(Buffer.from(patch))).get('a') ?? [])]).toEqual(
      [1, 5],
    );
  });

  test('a quoted path falls back to no tracked file', () => {
    const patch = ['--- a/a', '+++ "b/\\303\\251"', '@@ -1 +1 @@', '-one', '+two'].join('\n');
    expect(parseChangedIntervals(new Uint8Array(Buffer.from(patch))).size).toBe(0);
  });

  test('malformed and truncated hunks refuse with the oracle text', () => {
    for (const [patch, message] of [
      ['+++ b/a\n@@ -1 +1 @@\n-x\n?y\n', 'malformed diff hunk'],
      ['+++ b/a\n@@ nope\n', 'malformed diff hunk header'],
      ['+++ b/a\n@@ -1,3 +1,3 @@\n-a', 'truncated diff hunk'],
    ] as const) {
      expect(() => parseChangedIntervals(new Uint8Array(Buffer.from(patch)))).toThrowError(
        new BackfillAccountingError(message),
      );
    }
  });
});

describe('carry matching', () => {
  const row = (origin: string, line: number, content: string) => ({
    origin,
    originalLine: line,
    filename: new Uint8Array(Buffer.from('a')),
    content: new Uint8Array(Buffer.from(content)),
  });

  test('only unique signatures on both sides match', () => {
    const oldBlame = [row('a', 1, 'one'), row('c', 3, 'dup'), row('c', 3, 'dup')];
    const newBlame = [row('a', 1, 'one'), row('c', 3, 'dup'), row('c', 3, 'dup')];
    const { matches, maximum } = carryMatches(oldBlame, newBlame);
    expect(maximum).toBe(3);
    expect([...matches.entries()]).toEqual([[1, 1]]);
  });

  test('Python list-index semantics: 0 is the last line, negative counts back', () => {
    const matches = new Map([
      [1, 10],
      [3, 30],
      [4, 40],
    ]);
    expect([...carrySelection('a', matches, 4, [1, 0]).mapped]).toEqual([10, 40]);
    expect([...carrySelection('a', matches, 4, [-1]).mapped]).toEqual([30]);
    expect(carrySelection('a', matches, 4, [5, 9]).mapped.size).toBe(0);
    expect(() => carrySelection('a', matches, 4, [-4])).toThrowError(BackfillAccountingIndexError);
  });

  test('a cached carry fact decodes only the persisted shape', () => {
    const fact = json({ path: 'b', matches: [[1, 2]], old_lines: 3 });
    expect(carryFromFact(fact)).toEqual({
      path: 'b',
      matches: new Map([[1, 2]]),
      oldLines: 3,
    });
    expect(carryFromFact(json({ path: 'b', matches: [[4, 2]], old_lines: 3 }))).toBeNull();
  });

  test('a verified-review fact is coalesced intervals', () => {
    expect(verifiedFact(new Map([['a', new Set([1, 2, 3])]]))).toEqual({
      a: [[1, 3]],
    });
  });
});

describe('prototype-safe fact encoding', () => {
  test('a __proto__ path is an own JSON property, not the prototype', () => {
    const verified = verifiedFact(new Map([['__proto__', new Set([1, 2])]]));
    expect(Object.prototype.hasOwnProperty.call(verified, '__proto__')).toBe(true);
    expect(Buffer.from(ledgerJsonBytes(verified)).toString()).toBe('{"__proto__":[[1,2]]}');
    const coverage = coverageFact(
      new Map([['__proto__', new Set([3])]]),
      new Map([['__proto__', ['finding-1']]]),
    );
    expect(Buffer.from(ledgerJsonBytes(coverage)).toString()).toBe(
      '{"covered":{"__proto__":[[3,3]]},"evidence":{"__proto__":["finding-1"]}}',
    );
  });
});

describe('fact shapes', () => {
  test('unknown extra keys are rejected entry by entry', () => {
    expect(FACT_SHAPES.lineage(json({ path: 'a', extra: 1 }))).toBe(false);
    expect(FACT_SHAPES.lineage_step(json({ parent: 'x', changes: [], extra: 1 }))).toBe(false);
  });

  test('an integral float is not an int in a cached row', () => {
    const floatRow: JsonValue = ['origin', JsonNumber.float(1), '', ''];
    expect(FACT_SHAPES.blame([floatRow])).toBe(false);
    expect(FACT_SHAPES.blame(json([['origin', 1, '', '']]))).toBe(true);
  });

  test('JsonObject keys are shape-checked without KeyErrors', () => {
    expect(FACT_SHAPES.carry(new JsonObject([['path', null]]))).toBe(false);
    expect(FACT_SHAPES.coverage(new JsonObject([]))).toBe(false);
  });
});
