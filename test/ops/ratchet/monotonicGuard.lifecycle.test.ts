// Split out of the pre-split monotonicGuard.test.ts so review tooling can
// see below the 256 KiB single-file cap; describe wrappers are reproduced
// verbatim so every test's full title path stays byte-identical.

import { describe, expect, test } from 'vitest';
import { checkDiffMonotonicity } from '../../../src/ops/ratchet/monotonicGuard.js';
import { METRIC, REL, TARGET, body, bodyLines, modifiedSection } from './monotonicGuard.helpers.js';

describe('checkDiffMonotonicity', () => {
  test('an added baseline file is skipped (capture committing data), counted in filesChecked', () => {
    const diff = [
      `diff --git a/${REL} b/${REL}`,
      'new file mode 100644',
      'index 0000000..1111111',
      '--- /dev/null',
      `+++ b/${REL}`,
      '@@ -0,0 +1,7 @@',
      ...bodyLines(body('lower-is-better', 3)).map((l) => `+${l}`),
    ].join('\n');
    expect(checkDiffMonotonicity(diff)).toEqual({ ok: true, violations: [], filesChecked: 1 });
  });

  test('an UNREPLACED deleted baseline fails "deleted without replacement" (W1.7); path falls back to the diff --git b-side', () => {
    const diff = [
      `diff --git a/${REL} b/${REL}`,
      'deleted file mode 100644',
      'index 1111111..0000000',
      `--- a/${REL}`,
      '+++ /dev/null',
      '@@ -1,7 +0,0 @@',
      ...bodyLines(body('lower-is-better', 3)).map((l) => `-${l}`),
    ].join('\n');
    expect(checkDiffMonotonicity(diff)).toEqual({
      ok: false,
      violations: [
        {
          path: REL,
          target: TARGET,
          metric: METRIC,
          oldValue: 3,
          why: 'deleted without replacement',
        },
      ],
      filesChecked: 1,
    });
  });

  test('non-baseline file changes are ignored entirely (filesChecked 0)', () => {
    const diff = [
      'diff --git a/src/index.ts b/src/index.ts',
      'index 1111111..2222222 100644',
      '--- a/src/index.ts',
      '+++ b/src/index.ts',
      '@@ -1,1 +1,1 @@',
      '-export const a = 1;',
      '+export const a = 2;',
    ].join('\n');
    expect(checkDiffMonotonicity(diff)).toEqual({ ok: true, violations: [], filesChecked: 0 });
  });

  test('a plus-only section WITHOUT new-file metadata fails closed (Codex P1)', () => {
    // No `new file mode` / `--- /dev/null`: this is a modification of an
    // EXISTING baseline that only adds content — counting lines would let
    // it ride the added-file skip. Unjudgeable → non-passing evidence.
    const diff = modifiedSection(REL, [], ['  "value": 100,']);
    expect(checkDiffMonotonicity(diff)).toEqual({
      ok: false,
      violations: [{ path: REL, why: 'unparsable baseline diff' }],
      filesChecked: 1,
    });
  });

  test('a minus-only section WITHOUT deleted-file metadata fails closed (Codex P1)', () => {
    const diff = modifiedSection(REL, ['  "value": 3,'], []);
    expect(checkDiffMonotonicity(diff)).toEqual({
      ok: false,
      violations: [{ path: REL, why: 'unparsable baseline diff' }],
      filesChecked: 1,
    });
  });

  test('the duplicate-"value" insertion scenario fails closed, not ok (Codex P1)', () => {
    // The exact thread scenario: an existing baseline whose PR inserts a
    // second value line after the first — JSON.parse would honor the LATER
    // duplicate, silently raising the threshold from 3 to 100. Rendered as
    // a real -U1 hunk it is plus-only with no lifecycle metadata: it must
    // be a violation, never a skipped "added file".
    const diff = [
      `diff --git a/${REL} b/${REL}`,
      'index 1111111..2222222 100644',
      `--- a/${REL}`,
      `+++ b/${REL}`,
      '@@ -5,1 +5,2 @@',
      '  "value": 3,',
      '+  "value": 100,',
    ].join('\n');
    expect(checkDiffMonotonicity(diff)).toEqual({
      ok: false,
      violations: [{ path: REL, why: 'unparsable baseline diff' }],
      filesChecked: 1,
    });
  });

  test('a removed `-- /dev/null` line rendering as `--- /dev/null` inside a hunk does NOT flip lifecycle to deleted', () => {
    // The old body contained the literal line `-- /dev/null`; its removal
    // renders exactly as the deleted-file marker — but INSIDE the hunk that
    // is evidence movement, not file lifecycle. Before the header-region
    // fix this section rode the deleted-file skip to ok.
    const diff = modifiedSection(
      REL,
      ['  "direction": "lower-is-better",', '  "value": 2,', '-- /dev/null'],
      ['  "direction": "lower-is-better",', '  "value": 3,'],
    );
    expect(checkDiffMonotonicity(diff)).toEqual({
      ok: false,
      // The hand-built hunk carries no metric/target lines — both stay
      // undefined while the loosened values are named.
      violations: [{ path: REL, oldValue: 2, newValue: 3, why: 'loosened' }],
      filesChecked: 1,
    });
  });

  test('an added `++ /dev/null` line rendering as `+++ /dev/null` inside a hunk does NOT flip lifecycle to added', () => {
    const diff = modifiedSection(
      REL,
      ['  "direction": "lower-is-better",', '  "value": 2,'],
      ['  "direction": "lower-is-better",', '  "value": 3,', '++ /dev/null'],
    );
    expect(checkDiffMonotonicity(diff)).toEqual({
      ok: false,
      violations: [{ path: REL, oldValue: 2, newValue: 3, why: 'loosened' }],
      filesChecked: 1,
    });
  });
});
