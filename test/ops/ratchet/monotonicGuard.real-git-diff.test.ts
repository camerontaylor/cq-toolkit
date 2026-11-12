// Split out of the pre-split monotonicGuard.test.ts so review tooling can
// see below the 256 KiB single-file cap; describe wrappers are reproduced
// verbatim so every test's full title path stays byte-identical.

import { describe, expect, test } from 'vitest';
import { checkDiffMonotonicity } from '../../../src/ops/ratchet/monotonicGuard.js';
import { METRIC, TARGET, body, realGitDiffCases } from './monotonicGuard.helpers.js';

describe('real git diff fixtures (literal git output from one temp repo)', () => {
  test('escaped context key with changed colon is rejected in a real staged diff', async () => {
    const before = body('higher-is-better', 80).replace(
      '"value": 80,',
      '"value": 80,\n  "val\\u0075e"\n  : 90,',
    );
    const after = before.replace('"value": 80,', '"value": 81,').replace(': 90,', ': 50,');
    expect((JSON.parse(before) as { value: number }).value).toBe(90);
    expect((JSON.parse(after) as { value: number }).value).toBe(50);
    const diff = (await realGitDiffCases({ escaped: { before, after } })).escaped ?? '';
    expect(diff).toContain('   "val\\u0075e"');
    expect(diff).toContain('-  : 90,');
    expect(diff).toContain('+  : 50,');
    expect(checkDiffMonotonicity(diff)).toMatchObject({ ok: false });
  });

  test(
    'all five real baseline cases stay live in one staged diff',
    { timeout: 20_000 },
    async () => {
      const sections = await realGitDiffCases();
      expect(Object.keys(sections).sort()).toEqual([
        'added',
        'clock-only',
        'deleted',
        'loosen',
        'tighten',
      ]);

      expect(checkDiffMonotonicity(sections.tighten ?? '')).toEqual({
        ok: true,
        violations: [],
        filesChecked: 1,
      });
      expect(checkDiffMonotonicity(sections.loosen ?? '')).toEqual({
        ok: false,
        violations: [
          {
            path: 'baselines/loosen.json',
            target: TARGET,
            metric: METRIC,
            oldValue: 2,
            newValue: 3,
            why: 'loosened',
          },
        ],
        filesChecked: 1,
      });
      expect(checkDiffMonotonicity(sections['clock-only'] ?? '')).toEqual({
        ok: true,
        violations: [],
        filesChecked: 1,
      });
      expect(checkDiffMonotonicity(sections.added ?? '')).toEqual({
        ok: true,
        violations: [],
        filesChecked: 1,
      });
      expect(checkDiffMonotonicity(sections.deleted ?? '')).toEqual({
        ok: false,
        violations: [
          {
            path: 'baselines/deleted.json',
            target: TARGET,
            metric: METRIC,
            oldValue: 3,
            why: 'deleted without replacement',
          },
        ],
        filesChecked: 1,
      });

      // The whole literal diff is also judged once, proving the five real
      // sections coexist rather than being independent hand-built strings.
      expect(checkDiffMonotonicity(Object.values(sections).join(''))).toEqual({
        ok: false,
        violations: [
          {
            path: 'baselines/loosen.json',
            target: TARGET,
            metric: METRIC,
            oldValue: 2,
            newValue: 3,
            why: 'loosened',
          },
        ],
        filesChecked: 5,
      });
    },
  );
});
