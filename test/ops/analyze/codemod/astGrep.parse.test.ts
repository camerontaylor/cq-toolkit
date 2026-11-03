// Analyze lane G2 — test evidence for the ast-grep codemod path: the JSON
// wire parse (planned edits vs honestly-counted unfixed matches), the
// scan's verdict policy (a non-zero exit behind parsable JSON is the
// error-severity contract, not a failure; a lost exit is a fault naming the
// missing binary), the collision block, the exact splice semantics of the
// apply, the synthesized unified diffs (hunks, no-newline markers), and the
// op's approval gate — an apply without `approved: true` refuses before any
// I/O. All through INJECTED runners and stores: no ast-grep binary, no real
// fs.
//
// Split provenance: test/ops/analyze/codemod/astGrep.test.ts was split into
// astGrep.parse.test.ts, astGrep.scan.test.ts, astGrep.collision.test.ts,
// astGrep.diff.test.ts, astGrep.codemod-approval.test.ts,
// astGrep.codemod-plan.test.ts, astGrep.codemod-write-safety.test.ts and
// astGrep.codemod-target-policy.test.ts; shared fixtures live in
// astGrep.helpers.ts.
import { describe, expect, test } from 'vitest';
import { parseAstGrepJson } from '../../../../src/ops/analyze/codemod/astGrep.js';
import { matchOf } from './astGrep.helpers.js';

describe('parseAstGrepJson (the wire contract, strict where it matters)', () => {
  test('parses planned edits from replacement + replacementOffsets (byte ranges, documented)', () => {
    const result = parseAstGrepJson(
      JSON.stringify([matchOf('src/a.ts', 6, 13, 'fooBar'), matchOf('src/a.ts', 33, 40, 'fooBar')]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome.plannedEdits).toEqual([
      { file: 'src/a.ts', startByte: 6, endByte: 13, replacement: 'fooBar' },
      { file: 'src/a.ts', startByte: 33, endByte: 40, replacement: 'fooBar' },
    ]);
    expect(result.outcome.unfixedMatches).toBe(0);
  });

  test('a match without a replacement is an honest unfixed match, never a fake edit', () => {
    const result = parseAstGrepJson(
      JSON.stringify([
        { file: 'src/a.ts', range: {}, ruleId: 'no-fix-rule', severity: 'warning' },
        matchOf('src/a.ts', 0, 1, 'x'),
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome.plannedEdits).toHaveLength(1);
    expect(result.outcome.unfixedMatches).toBe(1);
  });

  test('an empty array parses to the honest empty outcome', () => {
    const result = parseAstGrepJson('[]');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toEqual({ plannedEdits: [], unfixedMatches: 0 });
  });

  test('unparsable output, non-arrays, and edits without ranges are faults', () => {
    expect(parseAstGrepJson('not json').ok).toBe(false);
    expect(parseAstGrepJson('{"file":"a"}').ok).toBe(false);
    expect(parseAstGrepJson('[null]').ok).toBe(false);
    expect(parseAstGrepJson('[{"replacement":"x"}]').ok).toBe(false);
    const noOffsets = parseAstGrepJson(JSON.stringify([{ file: 'src/a.ts', replacement: 'x' }]));
    expect(noOffsets.ok).toBe(false);
    if (noOffsets.ok) return;
    expect(noOffsets.fault).toContain('replacementOffsets');
    const badOffsets = parseAstGrepJson(
      JSON.stringify([
        { file: 'src/a.ts', replacement: 'x', replacementOffsets: { start: 5, end: 2 } },
      ]),
    );
    expect(badOffsets.ok).toBe(false);
  });
});
