import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { hackDetector } from '../../../src/ops/gates/hackDetector.js';
import { regressionGate } from '../../../src/ops/gates/regressionGate.js';
import { DEFAULT_PROTECTED_STAGE_PATTERNS } from '../../../src/ops/sweep/unit.js';

interface CorpusEntry {
  id: string;
  path: string;
  class: string;
  defaultDeny: string;
  baseOwned: string;
  modes: string[];
}
interface CorpusManifest {
  version: number;
  modes: string[];
  fixtures: CorpusEntry[];
}

const manifest = JSON.parse(
  readFileSync(new URL('../../fixtures/tamper-corpus/manifest.json', import.meta.url), 'utf8'),
) as CorpusManifest;

describe('RS-10 tamper corpus contract', () => {
  test('ships 29 additions and 10 inherited fixtures in both verdict modes', async () => {
    expect(manifest.version).toBe(1);
    expect(manifest.modes).toEqual(['default-deny', 'base-owned']);
    expect(manifest.fixtures).toHaveLength(39);
    expect(manifest.fixtures.filter((entry) => entry.id.startsWith('inherited-'))).toHaveLength(10);
    for (const entry of manifest.fixtures) {
      expect(entry.modes).toEqual(manifest.modes);
      expect(entry.defaultDeny).toBe('reject');
      expect(entry.baseOwned).toMatch(/^(review|needs-human)$/);
      const fixtureUrl = new URL(`../../fixtures/tamper-corpus/${entry.path}`, import.meta.url);
      expect(() => readFileSync(fixtureUrl, 'utf8')).not.toThrow();
      const diff = readFileSync(fixtureUrl, 'utf8');
      const targetPath = diff.match(/^\+\+\+ b\/(.+)$/m)?.[1];
      if (entry.class !== 'git-plumbing') {
        expect(targetPath, entry.id).toBeDefined();
        expect(
          DEFAULT_PROTECTED_STAGE_PATTERNS.some((pattern) => pattern.test(targetPath!)),
          entry.id,
        ).toBe(true);
      }
      const result = await hackDetector({ diff });
      expect(result.status).toBe('ok');
      if (
        ['static', 'suppression', 'removed'].includes(entry.class) &&
        entry.id !== 's22-title-mangle'
      ) {
        expect(result.status === 'ok' && result.value.length > 0, entry.id).toBe(true);
      }
      expect(['review', 'needs-human']).toContain(entry.baseOwned);
    }
  });

  test('the manifest classes cover the static and git-plumbing corpus contract', () => {
    expect(new Set(manifest.fixtures.map((entry) => entry.class))).toEqual(
      new Set(['git-plumbing', 'static', 'suppression', 'removed', 'config', 'path', 'totals']),
    );
  });
});

describe('RS-10 detector and totals regressions', () => {
  test.each([
    "test.todo('later', () => {});",
    "test.fails('known failure', () => {});",
    "test.concurrent('parallel', () => {});",
    "test.skipIf(process.env.WIP)('conditional', () => {});",
    "test.runIf(process.env.CI)('conditional', () => {});",
    "xit('alias', () => {});",
    "fit('focus alias', () => {});",
    "test('node option', { skip: true }, () => {});",
  ])('flags a skip/only/focus idiom: %s', async (line) => {
    const result = await hackDetector({
      diff: [
        'diff --git a/test/attack.test.ts b/test/attack.test.ts',
        '--- a/test/attack.test.ts',
        '+++ b/test/attack.test.ts',
        '@@ -1 +1,2 @@',
        ' context();',
        `+${line}`,
      ].join('\n'),
    });
    expect(result.status).toBe('ok');
    expect(
      result.status === 'ok' && result.value.some((finding) => finding.kind === 'new-skip-only'),
    ).toBe(true);
  });

  test('flags removed failing test declarations from a test hunk', async () => {
    const result = await hackDetector({
      diff: [
        'diff --git a/test/attack.test.ts b/test/attack.test.ts',
        '--- a/test/attack.test.ts',
        '+++ b/test/attack.test.ts',
        '@@ -1,2 +1 @@',
        "-it('fails today', () => {});",
      ].join('\n'),
    });
    expect(result.status).toBe('ok');
    expect(
      result.status === 'ok' && result.value.some((finding) => finding.kind === 'removed-test'),
    ).toBe(true);
  });

  test('a test-count drop and skipped rise are regressions even without novel failures', async () => {
    const result = await regressionGate({
      base: {
        tool: 'vitest',
        failures: [],
        exitCode: 0,
        numTotalTests: 4,
        numPassedTests: 4,
        numSkippedTests: 0,
      },
      final: {
        tool: 'vitest',
        failures: [],
        exitCode: 0,
        numTotalTests: 3,
        numPassedTests: 3,
        numSkippedTests: 1,
      },
    });
    expect(result.status).toBe('ok');
    expect(result.status === 'ok' && result.value.verdict).toBe('regression');
    expect(result.status === 'ok' && result.value.totalsRegression).toMatch(/count dropped/);
  });
});
