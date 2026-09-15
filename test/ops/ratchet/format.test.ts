// Lane H slice 1 (+ round-1 fix) — tests for the baseline file format
// (src/ops/ratchet/format.ts).
//
// Pinned here:
//   1. render/parse round-trip and BYTE-DETERMINISM: the render is
//      independent of the caller's key insertion order (schema order is
//      imposed), 2-space indented, and ends with exactly one trailing
//      newline, so JSON.parse → render reproduces byte-identical text.
//   2. parseBaseline is loud on garbage: unparsable JSON, wrong
//      schemaVersion, missing/typed-wrong keys, unknown direction, extra
//      keys (strict schema), NON-FINITE values (JSON 1e999 parses to
//      Infinity), and capturedAt that is not a STRICT ISO-8601 instant
//      (locale date strings, calendar rollovers) all throw a plain Error
//      with a clear message.
//   3. baselineRelPath: sanitization (lowercase, runs of non-[a-z0-9]
//      collapse to a single '-', leading/trailing '-' stripped) PLUS a
//      12-hex (48-bit) sha256 disambiguator over the RAW pair, so originals
//      that sanitize identically ('src/kernel' vs 'src-kernel') stay
//      collision-RESISTANT with distinct, deterministic paths.
//   4. tightens/loosens are pure comparators for both directions; equal
//      values are neither.
//
// Determinism: fixed ISO timestamps, no Date.now(), no Math.random().
import { describe, expect, test } from 'vitest';
import {
  baselineRelPath,
  loosens,
  parseBaseline,
  renderBaseline,
  tightens,
} from '../../../src/ops/ratchet/format.js';
import type { BaselineFile, Direction } from '../../../src/ops/ratchet/format.js';

const CAPTURED_AT = '2026-09-15T00:00:00.000Z';

function baseline(overrides: Partial<BaselineFile> = {}): BaselineFile {
  return {
    schemaVersion: 1,
    target: 'typecheck',
    metric: 'typecheck-count',
    direction: 'lower-is-better',
    value: 3,
    capturedAt: CAPTURED_AT,
    ...overrides,
  };
}

// Same logical baseline as baseline(), keys deliberately scrambled.
function baselineScrambledKeys(): BaselineFile {
  return {
    capturedAt: CAPTURED_AT,
    unit: 'errors',
    value: 3,
    direction: 'lower-is-better',
    metric: 'typecheck-count',
    target: 'typecheck',
    schemaVersion: 1,
  };
}

describe('renderBaseline / parseBaseline', () => {
  test('parse inverts render (round-trip, unit included)', () => {
    const b = baseline({ unit: 'errors' });
    expect(parseBaseline(renderBaseline(b))).toEqual(b);
  });

  test('parse inverts render (round-trip, unit omitted)', () => {
    const b = baseline();
    const rendered = renderBaseline(b);
    expect(rendered).not.toContain('unit');
    expect(parseBaseline(rendered)).toEqual(b);
  });

  test('render is byte-identical across a JSON.parse cycle', () => {
    const once = renderBaseline(baseline({ unit: 'errors' }));
    const twice = renderBaseline(parseBaseline(once));
    expect(twice).toBe(once);
  });

  test('render imposes schema key order regardless of input insertion order', () => {
    expect(renderBaseline(baselineScrambledKeys())).toBe(
      renderBaseline(baseline({ unit: 'errors' })),
    );
  });

  test('render is exactly 2-space JSON with one trailing newline', () => {
    expect(renderBaseline(baseline({ unit: 'errors' }))).toBe(
      [
        '{',
        '  "schemaVersion": 1,',
        '  "target": "typecheck",',
        '  "metric": "typecheck-count",',
        '  "direction": "lower-is-better",',
        '  "value": 3,',
        '  "unit": "errors",',
        '  "capturedAt": "2026-09-15T00:00:00.000Z"',
        '}',
        '',
      ].join('\n'),
    );
  });
});

describe('parseBaseline rejections', () => {
  const RAW_BASE = {
    schemaVersion: 1,
    target: 'typecheck',
    metric: 'typecheck-count',
    direction: 'lower-is-better',
    value: 3,
    capturedAt: CAPTURED_AT,
  };

  test.each([
    ['unparsable JSON', 'not json at all'],
    ['empty text', ''],
    ['a JSON array', '[1,2,3]'],
    ['a JSON scalar', '42'],
    ['wrong schemaVersion', JSON.stringify({ ...RAW_BASE, schemaVersion: 2 })],
    ['missing required value', JSON.stringify({ ...RAW_BASE, value: undefined })],
    ['non-numeric value', JSON.stringify({ ...RAW_BASE, value: 'three' })],
    ['a non-finite value (JSON 1e999 parses to Infinity)', JSON.stringify(RAW_BASE).replace('"value":3', '"value":1e999')],
    ['unknown direction', JSON.stringify({ ...RAW_BASE, direction: 'sideways' })],
    ['an unparseable capturedAt', JSON.stringify({ ...RAW_BASE, capturedAt: 'not a timestamp' })],
    ['a non-ISO date-string capturedAt', JSON.stringify({ ...RAW_BASE, capturedAt: 'September 15, 2026' })],
    ['a calendar-rollover capturedAt (Feb 30)', JSON.stringify({ ...RAW_BASE, capturedAt: '2026-02-30T00:00:00Z' })],
    ['an extra key (strict schema)', JSON.stringify({ ...RAW_BASE, extra: true })],
  ])('%s throws a clear Error', (_label, text) => {
    expect(() => parseBaseline(text)).toThrow(/^baseline: /);
  });

  test('the two failure classes are distinguishable in the message', () => {
    expect(() => parseBaseline('nope')).toThrow(/not valid JSON/);
    expect(() => parseBaseline(JSON.stringify({ ...RAW_BASE, direction: 'sideways' }))).toThrow(
      /schema violation.*direction/,
    );
  });

  test('a valid capturedAt with a timezone offset still parses', () => {
    expect(() =>
      parseBaseline(JSON.stringify({ ...RAW_BASE, capturedAt: '2026-09-15T02:00:00+02:00' })),
    ).not.toThrow();
  });

  test('a nanosecond-precision capturedAt parses (truncated to milliseconds)', () => {
    expect(() =>
      parseBaseline(JSON.stringify({ ...RAW_BASE, capturedAt: '2026-09-15T10:00:00.123456789Z' })),
    ).not.toThrow();
  });
});

describe('baselineRelPath', () => {
  test.each([
    ['typecheck', 'typecheck-count', 'baselines/typecheck--typecheck-count--f818e46f24dc.json'],
    ['Src/Kernel', 'Typecheck Count', 'baselines/src-kernel--typecheck-count--ca5599f16a99.json'],
    ['  spaced  target  ', 'metric!!', 'baselines/spaced-target--metric--e720baedc948.json'],
    ['A//B', 'C--D', 'baselines/a-b--c-d--63e50bf9095e.json'],
    ['---lead---', '___trail___', 'baselines/lead--trail--ce9c228bc566.json'],
    ['Ünicode Târget', 'métric', 'baselines/nicode-t-rget--m-tric--d5aaf618a6b2.json'],
  ])('target %j + metric %j → %j', (target, metric, expected) => {
    expect(baselineRelPath(target, metric)).toBe(expected);
  });

  test('is deterministic: same inputs, same path', () => {
    expect(baselineRelPath('a b', 'c d')).toBe(baselineRelPath('a b', 'c d'));
  });

  test('sanitization collisions stay distinct: the disambiguator hashes the RAW pair', () => {
    // Both sanitize to src-kernel / m, but the raw pairs differ.
    expect(baselineRelPath('src/kernel', 'm')).toBe('baselines/src-kernel--m--1f3222c9fccf.json');
    expect(baselineRelPath('src-kernel', 'm')).toBe('baselines/src-kernel--m--8007c124e9e7.json');
    expect(baselineRelPath('src/kernel', 'm')).not.toBe(baselineRelPath('src-kernel', 'm'));
    expect(baselineRelPath('src/a.ts', 'm')).toBe('baselines/src-a-ts--m--1876373ace6e.json');
    expect(baselineRelPath('src-a.ts', 'm')).toBe('baselines/src-a-ts--m--2194db1df002.json');
    expect(baselineRelPath('src/a.ts', 'm')).not.toBe(baselineRelPath('src-a.ts', 'm'));
  });

  const LONG_PATH_TARGET = `src/${'a/b/'.repeat(99)}deep.ts`; // 411 chars of deep nesting
  const LONG_WORD_TARGET = 'w'.repeat(200); // single 200-char word

  test('very long targets stay within filesystem component limits', () => {
    for (const target of [LONG_PATH_TARGET, LONG_WORD_TARGET]) {
      const path = baselineRelPath(target, 'typecheck-count');
      expect(path.length).toBeLessThanOrEqual(255);
      for (const segment of path.split('/')) {
        expect(segment.length).toBeLessThanOrEqual(255);
      }
      // The human-readable part is truncated; the digest still differs from
      // the short-prefix world.
      expect(path.startsWith('baselines/')).toBe(true);
    }
  });

  test('two distinct 200-char targets differing only past char 80 keep distinct paths', () => {
    const a = `${'x'.repeat(199)}a`;
    const b = `${'x'.repeat(199)}b`;
    const pathA = baselineRelPath(a, 'm');
    const pathB = baselineRelPath(b, 'm');
    // Same truncated human-readable prefix (first 80 sanitized chars)...
    expect(pathA.slice(0, 'baselines/'.length + 80)).toBe(pathB.slice(0, 'baselines/'.length + 80));
    // ...but the digests hash the UNtruncated raw pair, so paths stay distinct.
    expect(pathA).not.toBe(pathB);
  });
});

describe('tightens / loosens', () => {
  const cases: Array<[Direction, number, number, boolean, boolean]> = [
    // [direction, prev, next, tightens?, loosens?]
    ['lower-is-better', 5, 3, true, false],
    ['lower-is-better', 3, 5, false, true],
    ['lower-is-better', 3, 3, false, false],
    ['higher-is-better', 40, 60, true, false],
    ['higher-is-better', 60, 40, false, true],
    ['higher-is-better', 40, 40, false, false],
    ['lower-is-better', 0, 0, false, false],
    ['higher-is-better', 0, 0, false, false],
  ];

  test.each(cases)('%s: %j → %j (tightens=%j, loosens=%j)', (d, prev, next, t, l) => {
    expect(tightens(prev, next, d)).toBe(t);
    expect(loosens(prev, next, d)).toBe(l);
  });
});
