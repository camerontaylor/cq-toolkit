// Split from self-review-loop.test.ts (pure move); shared fixtures in ./self-review-loop-fakes.js.
import { afterEach, describe, expect, test } from 'vitest';
import { buildSweepUsage, sweepUsageMarkdown } from '../../src/selfhost/self-review-loop.js';
import type { SweepUsagePrRow } from '../../src/selfhost/self-review-loop.js';
import { cleanupTempRoots } from './self-review-loop-fakes.js';

afterEach(cleanupTempRoots);

describe('sweep token-usage summary (D11b)', () => {
  test('buildSweepUsage totals the rows and derives remaining/exhausted from them', () => {
    expect(
      buildSweepUsage(2_000_000, [
        { pr: 7, tokens: 600_000 },
        { pr: 8, tokens: 300 },
      ]),
    ).toEqual({
      capTokens: 2_000_000,
      totalTokensUsed: 600_300,
      perPrTokens: [
        { pr: 7, tokens: 600_000 },
        { pr: 8, tokens: 300 },
      ],
      remainingTokens: 1_399_700,
      exhausted: false,
    });
  });

  test('buildSweepUsage flags exhausted exactly AT zero remaining, not only past it', () => {
    expect(buildSweepUsage(1000, [{ pr: 7, tokens: 1000 }]).exhausted).toBe(true);
    expect(buildSweepUsage(1000, [{ pr: 7, tokens: 1001 }]).exhausted).toBe(true);
    expect(buildSweepUsage(1000, [{ pr: 7, tokens: 999 }]).exhausted).toBe(false);
    expect(buildSweepUsage(1000, []).remainingTokens).toBe(1000);
    expect(buildSweepUsage(1000, []).exhausted).toBe(false);
  });

  test('buildSweepUsage copies the rows — the caller array cannot poison the report', () => {
    const rows: SweepUsagePrRow[] = [{ pr: 7, tokens: 5 }];
    const usage = buildSweepUsage(10, rows);
    rows.push({ pr: 8, tokens: 100 });
    expect(usage.perPrTokens).toEqual([{ pr: 7, tokens: 5 }]);
    expect(usage.totalTokensUsed).toBe(5);
    expect(usage.remainingTokens).toBe(5);
  });

  test('sweepUsageMarkdown renders the headline table with the yes/no exhausted flag and per-PR rows', () => {
    const markdown = sweepUsageMarkdown(
      buildSweepUsage(1000, [
        { pr: 7, tokens: 600 },
        { pr: 8, tokens: 500 },
      ]),
    );
    expect(markdown).toContain(
      '| cap (tokens) | consumed (tokens) | remaining (tokens) | exhausted |',
    );
    expect(markdown).toContain('| 1000 | 1100 | -100 | yes |');
    expect(markdown).toContain('| PR | tokens (accounted) |');
    expect(markdown).toContain('| #7 | 600 |');
    expect(markdown).toContain('| #8 | 500 |');
  });

  test('sweepUsageMarkdown omits the per-PR table when no PR looped (a dry run)', () => {
    const markdown = sweepUsageMarkdown(buildSweepUsage(2_000_000, []));
    expect(markdown).toContain('| 2000000 | 0 | 2000000 | no |');
    expect(markdown).not.toContain('| #');
    expect(markdown.endsWith('\n')).toBe(true);
  });
});
