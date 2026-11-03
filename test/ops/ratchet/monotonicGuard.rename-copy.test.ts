// Split out of the pre-split monotonicGuard.test.ts so review tooling can
// see below the 256 KiB single-file cap; describe wrappers are reproduced
// verbatim so every test's full title path stays byte-identical.

import { describe, expect, test } from 'vitest';
import { checkDiffMonotonicity } from '../../../src/ops/ratchet/monotonicGuard.js';

describe('rename/copy-detected sections fail closed (W1.7: the guard needs --no-renames)', () => {
  const renamed = (from: string, to: string, kind: 'rename' | 'copy' = 'rename'): string =>
    [
      `diff --git a/${from} b/${to}`,
      'similarity index 100%',
      `${kind} from ${from}`,
      `${kind} to ${to}`,
      '',
    ].join('\n');

  test('a pure rename inside baselines/ is not skipped as index churn', () => {
    const verdict = checkDiffMonotonicity(
      renamed(
        'baselines/coverage--coverage--a8ceec8f7024.json',
        'baselines/cov2--coverage--x.json',
      ),
    );
    expect(verdict).toMatchObject({ ok: false, violations: [{ why: 'unparsable baseline diff' }] });
  });

  test('a baseline renamed OUT of baselines/ cannot vanish unjudged', () => {
    const verdict = checkDiffMonotonicity(
      renamed('baselines/coverage--coverage--a8ceec8f7024.json', 'attic/coverage.json'),
    );
    expect(verdict.ok).toBe(false);
  });

  test('a copy onto a baseline path fails closed too', () => {
    const verdict = checkDiffMonotonicity(
      renamed('attic/loose.json', 'baselines/coverage--coverage--a8ceec8f7024.json', 'copy'),
    );
    expect(verdict.ok).toBe(false);
  });

  test('renames outside baselines/ stay ignored', () => {
    expect(checkDiffMonotonicity(renamed('src/a.ts', 'src/b.ts'))).toEqual({
      ok: true,
      violations: [],
      filesChecked: 0,
    });
  });
});
