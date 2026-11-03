// Split out of the pre-split monotonicGuard.test.ts so review tooling can
// see below the 256 KiB single-file cap; describe wrappers are reproduced
// verbatim so every test's full title path stays byte-identical.

import { describe, expect, test } from 'vitest';
import { baselineRelPath, normalizeBaselineDiffValues } from '../../../src/ops/ratchet/format.js';
import {
  checkDiffMonotonicity,
  formatViolations,
} from '../../../src/ops/ratchet/monotonicGuard.js';
import {
  COV_METRIC,
  COV_TARGET,
  METRIC,
  REL,
  REL_COV,
  REL_MOVED,
  REL_MOVED_2,
  REL_MOVED_3,
  TARGET,
  addedSection,
  body,
  covBody,
  deletedSection,
  fullRewrite,
  modifiedSection,
} from './monotonicGuard.helpers.js';

// ---------------------------------------------------------------------------
// W1.7 (ADR-0004 attack A5): delete/add PAIRING. The guard's diffs are
// `git diff --no-renames --src-prefix=a/ --dst-prefix=b/`, so a rename is
// always a delete section plus an add section; a delete is replaced iff
// exactly one add carries the same (target, metric), and the pair is judged
// like a modification.
// ---------------------------------------------------------------------------

describe('delete/add pairing (W1.7, ADR-0004 attack A5)', () => {
  test('coverage normalization keeps the deleted side across +++ /dev/null', () => {
    const moved = 'baselines/coverage--coverage--0123456789ab.json';
    const diff = deletedSection(REL_COV, covBody(93.44)) + addedSection(moved, covBody(93.4));
    expect(checkDiffMonotonicity(diff).ok).toBe(false);
    const normalized = normalizeBaselineDiffValues(
      diff,
      /^baselines\/[^/]*--coverage--[^/]*\.json$/,
    );
    expect(normalized).toContain('-  "value": 93.4,');
    expect(normalized).toContain('+  "value": 93.4,');
    expect(normalized).not.toContain('93.44');
    expect(checkDiffMonotonicity(normalized)).toEqual({
      ok: true,
      violations: [],
      filesChecked: 2,
    });
  });

  test('an unreplaced delete renders the definition-change one-liner', () => {
    const verdict = checkDiffMonotonicity(deletedSection(REL, body('lower-is-better', 3)));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(formatViolations(verdict.violations)).toEqual([
      `${REL}: baseline deleted without a replacement for typecheck/typecheck-count — a removed ratchet needs a definition change (ADR-0004 D-C)`,
    ]);
  });

  test('A5: renaming the ratchet target (cov deleted, cov2 added looser) fails on the unreplaced delete', () => {
    const renamedTarget = 'coverage2';
    const relCov2 = baselineRelPath(renamedTarget, COV_METRIC);
    const diff =
      deletedSection(REL_COV, covBody(85)) +
      addedSection(
        relCov2,
        body('higher-is-better', 50, { target: renamedTarget, metric: COV_METRIC, unit: 'pct' }),
      );
    expect(checkDiffMonotonicity(diff)).toEqual({
      ok: false,
      violations: [
        {
          path: REL_COV,
          target: COV_TARGET,
          metric: COV_METRIC,
          oldValue: 85,
          why: 'deleted without replacement',
        },
      ],
      filesChecked: 2,
    });
  });

  test.each([
    ['an equal value', 3, 3],
    ['a tighter value', 3, 2],
  ])(
    'same (target, metric) moved to a new path with %s passes (judged as a modification)',
    (_label, oldValue, newValue) => {
      const diff =
        deletedSection(REL, body('lower-is-better', oldValue)) +
        addedSection(REL_MOVED, body('lower-is-better', newValue));
      expect(checkDiffMonotonicity(diff)).toEqual({ ok: true, violations: [], filesChecked: 2 });
    },
  );

  test('a moved baseline with an equal value and a new capturedAt passes (same-value re-capture)', () => {
    const diff =
      deletedSection(REL, body('lower-is-better', 3)) +
      addedSection(
        REL_MOVED,
        body('lower-is-better', 3, { capturedAt: '2026-09-16T00:00:00.000Z' }),
      );
    expect(checkDiffMonotonicity(diff)).toEqual({ ok: true, violations: [], filesChecked: 2 });
  });

  test('a moved baseline with a LOOSER value fails "loosened", naming the added path', () => {
    const diff =
      deletedSection(REL, body('lower-is-better', 2)) +
      addedSection(REL_MOVED, body('lower-is-better', 3));
    expect(checkDiffMonotonicity(diff)).toEqual({
      ok: false,
      violations: [
        {
          path: REL_MOVED,
          target: TARGET,
          metric: METRIC,
          oldValue: 2,
          newValue: 3,
          why: 'loosened',
        },
      ],
      filesChecked: 2,
    });
  });

  test('pairing is order-independent: an add listed BEFORE its delete still replaces it', () => {
    const diff =
      addedSection(REL_MOVED, body('lower-is-better', 3)) +
      deletedSection(REL, body('lower-is-better', 2));
    expect(checkDiffMonotonicity(diff)).toEqual({
      ok: false,
      violations: [
        {
          path: REL_MOVED,
          target: TARGET,
          metric: METRIC,
          oldValue: 2,
          newValue: 3,
          why: 'loosened',
        },
      ],
      filesChecked: 2,
    });
  });

  test('a paired move that flips direction fails "direction changed"', () => {
    const diff =
      deletedSection(REL, body('lower-is-better', 3)) +
      addedSection(REL_MOVED, body('higher-is-better', 3));
    expect(checkDiffMonotonicity(diff)).toEqual({
      ok: false,
      violations: [
        {
          path: REL_MOVED,
          target: TARGET,
          metric: METRIC,
          oldValue: 3,
          newValue: 3,
          why: 'direction changed',
          oldDirection: 'lower-is-better',
          newDirection: 'higher-is-better',
        },
      ],
      filesChecked: 2,
    });
  });

  test('a paired move that changes the unit fails "unit changed" (terminal — no tighten reading)', () => {
    const diff =
      deletedSection(REL, body('lower-is-better', 3)) +
      addedSection(REL_MOVED, body('lower-is-better', 2, { unit: 'failures' }));
    expect(checkDiffMonotonicity(diff)).toEqual({
      ok: false,
      violations: [
        {
          path: REL_MOVED,
          target: TARGET,
          metric: METRIC,
          oldValue: 3,
          newValue: 2,
          why: 'unit changed',
          oldUnit: 'errors',
          newUnit: 'failures',
        },
      ],
      filesChecked: 2,
    });
  });

  test("two adds carrying one delete's (target, metric) are ambiguous → unparsable on every involved path", () => {
    const diff =
      deletedSection(REL, body('lower-is-better', 3)) +
      addedSection(REL_MOVED, body('lower-is-better', 2)) +
      addedSection(REL_MOVED_2, body('lower-is-better', 9));
    expect(checkDiffMonotonicity(diff)).toEqual({
      ok: false,
      violations: [
        { path: REL, why: 'unparsable baseline diff' },
        { path: REL_MOVED, why: 'unparsable baseline diff' },
        { path: REL_MOVED_2, why: 'unparsable baseline diff' },
      ],
      filesChecked: 3,
    });
  });

  test('two adds with the same identity and NO delete are ambiguous too', () => {
    const diff =
      addedSection(REL, body('lower-is-better', 3)) +
      addedSection(REL_MOVED, body('lower-is-better', 3));
    expect(checkDiffMonotonicity(diff)).toEqual({
      ok: false,
      violations: [
        { path: REL, why: 'unparsable baseline diff' },
        { path: REL_MOVED, why: 'unparsable baseline diff' },
      ],
      filesChecked: 2,
    });
  });

  test('two deletes claiming the same add are ambiguous → unparsable on all three paths', () => {
    const diff =
      deletedSection(REL, body('lower-is-better', 3)) +
      deletedSection(REL_MOVED, body('lower-is-better', 3)) +
      addedSection(REL_MOVED_3, body('lower-is-better', 3));
    expect(checkDiffMonotonicity(diff)).toEqual({
      ok: false,
      violations: [
        { path: REL, why: 'unparsable baseline diff' },
        { path: REL_MOVED, why: 'unparsable baseline diff' },
        { path: REL_MOVED_3, why: 'unparsable baseline diff' },
      ],
      filesChecked: 3,
    });
  });

  test('an unpaired add of a NEW identity passes (new baseline data; the verifier owns definitions)', () => {
    const diff =
      fullRewrite(REL, body('lower-is-better', 3), body('lower-is-better', 2)) +
      addedSection(REL_COV, covBody(80));
    expect(checkDiffMonotonicity(diff)).toEqual({ ok: true, violations: [], filesChecked: 2 });
  });

  test.each([
    [
      'a deleted section with no reconstructable metric',
      deletedSection(
        REL,
        body('lower-is-better', 3).replace('"metric": "typecheck-count"', '"metrik": "x"'),
      ),
    ],
    [
      'a deleted section with a DUPLICATE value line',
      deletedSection(
        REL,
        body('lower-is-better', 3).replace('"value": 3,', '"value": 3,\n  "value": 1,'),
      ),
    ],
    [
      'a deleted section whose value is non-finite (1e999)',
      deletedSection(REL, body('lower-is-better', 3).replace('"value": 3,', '"value": 1e999,')),
    ],
    [
      'a deleted section with a malformed unit escape',
      deletedSection(REL, body('lower-is-better', 3).replace('"unit": "errors"', '"unit": "e\\x"')),
    ],
    [
      'an added section with no reconstructable target',
      addedSection(
        REL,
        body('lower-is-better', 3).replace('"target": "typecheck"', '"targ": "typecheck"'),
      ),
    ],
    [
      'a deleted section that also ADDS content (wrong side)',
      deletedSection(REL, body('lower-is-better', 3)) + '+  "value": 1,\n',
    ],
  ])('%s fails closed as unparsable — never a skipped or unreplaced delete', (_label, diff) => {
    expect(checkDiffMonotonicity(diff)).toEqual({
      ok: false,
      violations: [{ path: REL, why: 'unparsable baseline diff' }],
      filesChecked: 1,
    });
  });

  test('baselines/ratchets.json edits are ignored by the guard (definition manifest, not counted)', () => {
    const manifest = 'baselines/ratchets.json';
    const modified = modifiedSection(
      manifest,
      ['{ "ratchets": ["typecheck"] }'],
      ['{ "ratchets": [] }'],
    );
    const deleted = [
      `diff --git a/${manifest} b/${manifest}`,
      'deleted file mode 100644',
      'index 1111111..0000000',
      `--- a/${manifest}`,
      '+++ /dev/null',
      '@@ -1,1 +0,0 @@',
      '-{ "ratchets": ["typecheck"] }',
    ].join('\n');
    expect(checkDiffMonotonicity(modified)).toEqual({ ok: true, violations: [], filesChecked: 0 });
    expect(checkDiffMonotonicity(deleted)).toEqual({ ok: true, violations: [], filesChecked: 0 });
    // Only the EXACT manifest path is excluded: a nested lookalike is still
    // judged (and fails closed — it carries no baseline body).
    const nested = modifiedSection(
      'baselines/sub/ratchets.json',
      ['{ "ratchets": ["typecheck"] }'],
      ['{ "ratchets": [] }'],
    );
    expect(checkDiffMonotonicity(nested)).toEqual({
      ok: false,
      violations: [{ path: 'baselines/sub/ratchets.json', why: 'unparsable baseline diff' }],
      filesChecked: 1,
    });
  });
});
