// Split out of the pre-split monotonicGuard.test.ts so review tooling can
// see below the 256 KiB single-file cap; describe wrappers are reproduced
// verbatim so every test's full title path stays byte-identical.

import { describe, expect, test } from 'vitest';
import { checkDiffMonotonicity } from '../../../src/ops/ratchet/monotonicGuard.js';
import { METRIC, REL, TARGET, body, bodyLines, fullRewrite } from './monotonicGuard.helpers.js';

describe('checkDiffMonotonicity', () => {
  test.each(['b/', 'a/', 'i/', 'w/', 'c/', 'o/', ''])(
    'dialect prefix %s on the +++ line is attributed and judged',
    (prefix) => {
      const diff = [
        `diff --git a/${REL} b/${REL}`,
        'index 1111111..2222222 100644',
        `--- a/${REL}`,
        `+++ ${prefix}${REL}`,
        '@@ -1,4 +1,4 @@',
        '-  "direction": "lower-is-better",',
        '-  "value": 3,',
        '+  "direction": "lower-is-better",',
        '+  "value": 2,',
      ].join('\n');
      expect(checkDiffMonotonicity(diff)).toEqual({ ok: true, violations: [], filesChecked: 1 });
    },
  );

  test('a noprefix dialect (no a//b/ markers anywhere) is attributed via the printed-identical header pair', () => {
    const diff = [
      `diff --git ${REL} ${REL}`,
      'index 1111111..2222222 100644',
      `--- ${REL}`,
      `+++ ${REL}`,
      '@@ -1,4 +1,4 @@',
      '-  "direction": "lower-is-better",',
      '-  "value": 3,',
      '+  "direction": "lower-is-better",',
      '+  "value": 2,',
    ].join('\n');
    expect(checkDiffMonotonicity(diff)).toEqual({ ok: true, violations: [], filesChecked: 1 });
  });

  test('a section with no +++ line falls back to the diff --git b-side path and is judged', () => {
    const diff = [
      `diff --git a/${REL} b/${REL}`,
      'index 1111111..2222222 100644',
      `--- a/${REL}`,
      '@@ -1,4 +1,4 @@',
      '-  "direction": "lower-is-better",',
      '-  "value": 3,',
      '+  "direction": "lower-is-better",',
      '+  "value": 2,',
    ].join('\n');
    expect(checkDiffMonotonicity(diff)).toEqual({ ok: true, violations: [], filesChecked: 1 });
  });

  test('a content section with no extractable path fails closed, naming the raw header (unknown dialect)', () => {
    const diff = [
      'diff --git mangled-nonstandard-output',
      '@@ -1,4 +1,4 @@',
      '-  "direction": "lower-is-better",',
      '-  "value": 3,',
      '+  "direction": "lower-is-better",',
      '+  "value": 2,',
    ].join('\n');
    expect(checkDiffMonotonicity(diff)).toEqual({
      ok: false,
      violations: [
        { path: 'diff --git mangled-nonstandard-output', why: 'unparsable baseline diff' },
      ],
      filesChecked: 0,
    });
  });

  test('a pathless section with NO content lines stays ignored (true non-file noise)', () => {
    const diff = ['diff --git noise-entry', 'index abc..def 100644'].join('\n');
    expect(checkDiffMonotonicity(diff)).toEqual({ ok: true, violations: [], filesChecked: 0 });
  });

  test('a CRLF-normalized loosening diff still fires (extracted paths survive \\r\\n)', () => {
    // Literal git output on CRLF checkouts: every line carries a trailing
    // \r, which would survive into the extracted path and fail the
    // $-anchored baseline regex — silently skipping EVERY section.
    const diff = fullRewrite(REL, body('lower-is-better', 2), body('lower-is-better', 3))
      .split('\n')
      .join('\r\n');
    expect(checkDiffMonotonicity(diff)).toEqual({
      ok: false,
      violations: [
        { path: REL, target: TARGET, metric: METRIC, oldValue: 2, newValue: 3, why: 'loosened' },
      ],
      filesChecked: 1,
    });
  });
});

test('a noprefix DELETED baseline is attributed via the header fallback and judged as an unreplaced lifecycle delete', () => {
  const diff = [
    `diff --git ${REL} ${REL}`,
    'deleted file mode 100644',
    'index 1111111..0000000',
    `--- ${REL}`,
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
