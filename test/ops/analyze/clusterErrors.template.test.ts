// Analyze lane G1 — test evidence for signature clustering: the exact
// normalization pipeline (what is abstracted, what is preserved, rule
// order), content-derived stable ids, the confidence decision table
// (high/low; v1 never merges, never emits 'medium'), the ledger noise seam
// (knownNoise excludes BY CLUSTER SIGNATURE — any other recorded form never
// matches), and a seeded PROPERTY test proving the acceptance constraint:
// the same failure set in any presentation order yields identical cluster
// ids, confidences, and membership. All pure — zero I/O.
//
// Split provenance: test/ops/analyze/clusterErrors.test.ts was split by
// subject into this file (the documented normalization pipeline) and the
// sibling clusterErrors.*.test.ts files plus clusterErrors.helpers.ts.
import { describe, expect, test } from 'vitest';
import { messageTemplate } from '../../../src/ops/analyze/clusterErrors.js';

describe('messageTemplate normalization pipeline (the documented contract)', () => {
  test('numbers abstract to <num>: counts, decimals, line refs, codes', () => {
    expect(messageTemplate('Expected 2 arguments, but got 3.')).toBe(
      'Expected <num> arguments, but got <num>.',
    );
    expect(messageTemplate('line 42 col 7.5')).toBe('line <num> col <num>');
    expect(messageTemplate('error TS2551 occurred')).toBe('error TS<num> occurred');
  });

  test('quoted spans abstract to <str> before any other rule (all three quote styles)', () => {
    expect(messageTemplate("'foo' is defined but never used")).toBe(
      '<str> is defined but never used',
    );
    expect(messageTemplate('Cannot find module "../utils/date"')).toBe('Cannot find module <str>');
    // The other two QUOTED_SPAN alternatives, each on a plain word span.
    expect(messageTemplate('"x" is not defined')).toBe('<str> is not defined');
    expect(messageTemplate('run `npm test` now')).toBe('run <str> now');
  });

  test('unquoted path-like runs abstract to <path>: posix, windows, URLs', () => {
    expect(messageTemplate('Cannot open file src/utils/date.ts for reading')).toBe(
      'Cannot open file <path> for reading',
    );
    expect(messageTemplate('no such directory C:\\work\\repo\\src')).toBe(
      'no such directory <path>',
    );
    expect(messageTemplate('fetch of https://example.test/api failed')).toBe(
      'fetch of <path> failed',
    );
  });

  test('rule order: a quoted path is <str>; a number inside a path stays inside <path>', () => {
    expect(messageTemplate("could not read 'C:\\data\\2024.json'")).toBe('could not read <str>');
    expect(messageTemplate('missing src/v2/config.json')).toBe('missing <path>');
  });

  test('whitespace runs collapse and trim; case is preserved', () => {
    expect(messageTemplate('  too   much\t\twhitespace\nhere  ')).toBe('too much whitespace here');
    expect(messageTemplate('Foo and foo differ')).toBe('Foo and foo differ');
  });

  test('the coarseness is deliberate: a slash in prose also abstracts (documented)', () => {
    expect(messageTemplate('true and/or false')).toBe('true <path> false');
  });
});
