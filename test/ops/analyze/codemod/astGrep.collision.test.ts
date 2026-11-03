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
import { applyEditsToBytes, findCollision } from '../../../../src/ops/analyze/codemod/astGrep.js';

describe('collision check + splice apply (the write-safety core)', () => {
  test('overlapping byte ranges in ONE file block the whole apply, naming both ranges', () => {
    const collision = findCollision([
      { file: 'src/a.ts', startByte: 0, endByte: 10, replacement: 'x' },
      { file: 'src/a.ts', startByte: 5, endByte: 20, replacement: 'y' },
    ]);
    expect(collision).toContain('collision');
    expect(collision).toContain("in 'src/a.ts'");
    expect(collision).toContain('[0, 10)');
    expect(collision).toContain('[5, 20)');
    expect(findCollision([])).toBeNull();
    // Disjoint edits and edits in DIFFERENT files never collide.
    expect(
      findCollision([
        { file: 'src/a.ts', startByte: 0, endByte: 10, replacement: 'x' },
        { file: 'src/a.ts', startByte: 10, endByte: 20, replacement: 'y' },
        { file: 'src/b.ts', startByte: 0, endByte: 5, replacement: 'z' },
      ]),
    ).toBeNull();
  });

  test('applyEditsToBytes splices disjoint edits in ascending order over the current bytes', () => {
    const content = Buffer.from('const foo_bar = 1;\nconst other = foo_bar;\n', 'utf8');
    const applied = applyEditsToBytes(content, [
      { file: 'a', startByte: 33, endByte: 40, replacement: 'fooBar' },
      { file: 'a', startByte: 6, endByte: 13, replacement: 'fooBar' },
    ]);
    expect(Buffer.from(applied).toString('utf8')).toBe(
      'const fooBar = 1;\nconst other = fooBar;\n',
    );
  });

  test('applyEditsToBytes refuses an out-of-bounds range (belt to the staleness braces)', () => {
    const content = Buffer.from('short', 'utf8');
    expect(() =>
      applyEditsToBytes(content, [{ file: 'a', startByte: 0, endByte: 99, replacement: 'x' }]),
    ).toThrow(/out of bounds/);
  });
});
