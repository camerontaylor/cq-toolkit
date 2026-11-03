// Split provenance: test/ops/gates/hackDetector.test.ts was split by subject
// into sibling files; this file carries the tamper-toggle cases.
import { describe, expect, test } from 'vitest';
import { hackDetector } from '../../../src/ops/gates/hackDetector.js';
import { findingsOf, fixture } from './hackDetector.helpers.js';

describe('hackDetector: tamper toggles', () => {
  test('detectDeletedTests: false suppresses the deleted-test-file finding', async () => {
    const result = await hackDetector({
      diff: fixture('deleted-test.diff'),
      tamper: { detectDeletedTests: false },
    });
    expect(result).toEqual({ status: 'ok', value: [] });
  });

  test('invalid testFilePatterns remain an honest config failure (removed-test cannot be disabled)', async () => {
    const result = await hackDetector({
      diff: fixture('deleted-test.diff'),
      tamper: { testFilePatterns: ['('] },
    });
    expect(result.status).toBe('failed');
  });

  test('garbage skipOnlyPattern never compiles when the knob is off (lazy-compile symmetry)', async () => {
    const result = await hackDetector({
      diff: fixture('add-skip.diff'),
      tamper: { detectNewSkipOnly: false, skipOnlyPattern: '(' },
    });
    expect(result).toEqual({ status: 'ok', value: [] });
  });

  test('a "\\ No newline at end of file" marker is metadata, never content or a line slot', async () => {
    const diff = [
      'diff --git a/src/tail.ts b/src/tail.ts',
      'index 1111111..2222222 100644',
      '--- a/src/tail.ts',
      '+++ b/src/tail.ts',
      '@@ -1,2 +1,2 @@',
      ' const a = 1;',
      '-const b = 2;',
      '+// @ts-ignore',
      '\\ No newline at end of file',
    ].join('\n');
    expect(await findingsOf(diff)).toEqual([
      {
        kind: 'suppression',
        file: 'src/tail.ts',
        line: 2,
        pattern: '@ts-ignore',
        snippet: '// @ts-ignore',
        message: 'added suppression "@ts-ignore"',
      },
    ]);
  });

  test('an empty testFilePatterns list replaces the default shapes (no test-file match)', async () => {
    const result = await hackDetector({
      diff: fixture('deleted-test.diff'),
      tamper: { testFilePatterns: [] },
    });
    expect(result).toEqual({ status: 'ok', value: [] });
  });

  test('detectNewSkipOnly: false and detectTautologies: false mute their heuristics', async () => {
    const skipResult = await hackDetector({
      diff: fixture('add-skip.diff'),
      tamper: { detectNewSkipOnly: false },
    });
    expect(skipResult).toEqual({ status: 'ok', value: [] });
    const tautologyResult = await hackDetector({
      diff: fixture('tautology.diff'),
      tamper: { detectTautologies: false },
    });
    expect(tautologyResult).toEqual({ status: 'ok', value: [] });
  });
});
