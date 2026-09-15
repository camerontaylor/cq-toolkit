// Lane H slice 1 — tests for the baseline file format
// (src/ops/ratchet/format.ts).
//
// Pinned here:
//   1. render/parse round-trip and BYTE-DETERMINISM: the render is
//      independent of the caller's key insertion order (schema order is
//      imposed), 2-space indented, and ends with exactly one trailing
//      newline, so JSON.parse → render reproduces byte-identical text.
//   2. parseBaseline is loud on garbage: unparsable JSON, wrong
//      schemaVersion, missing/typed-wrong keys, unknown direction, extra
//      keys (strict schema) all throw a plain Error with a clear message.
//   3. baselineRelPath sanitization: lowercase, runs of non-[a-z0-9] collapse
//      to a single '-', leading/trailing '-' stripped, '--' separating
//      target from metric.
//   4. tightens/loosens are pure comparators for both directions; equal
//      values are neither.
//
// Determinism: fixed ISO timestamp, no Date.now(), no Math.random().
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
    expect(renderBaseline(baselineScrambledKeys())).toBe(renderBaseline(baseline({ unit: 'errors' })));
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
    ['unknown direction', JSON.stringify({ ...RAW_BASE, direction: 'sideways' })],
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
});

describe('baselineRelPath', () => {
  test.each([
    ['typecheck', 'typecheck-count', 'baselines/typecheck--typecheck-count.json'],
    ['Src/Kernel', 'Typecheck Count', 'baselines/src-kernel--typecheck-count.json'],
    ['  spaced  target  ', 'metric!!', 'baselines/spaced-target--metric.json'],
    ['A//B', 'C--D', 'baselines/a-b--c-d.json'],
    ['---lead---', '___trail___', 'baselines/lead--trail.json'],
    ['Ünicode Târget', 'métric', 'baselines/nicode-t-rget--m-tric.json'],
  ])('target %j + metric %j → %j', (target, metric, expected) => {
    expect(baselineRelPath(target, metric)).toBe(expected);
  });

  test('is deterministic: same inputs, same path', () => {
    expect(baselineRelPath('a b', 'c d')).toBe(baselineRelPath('a b', 'c d'));
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
