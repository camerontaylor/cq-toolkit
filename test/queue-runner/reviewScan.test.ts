import { describe, expect, it } from 'vitest';
import { scanReviewDiff, type ReviewScannerEffects } from '../../src/queue-runner/reviewScan.js';

const ids = [
  'class:token-ssh-plumbing',
  'class:route-key-material',
  'class:key-material-env',
  'class:inline-secret-assignments',
  'class:publish',
];
const patterns = `rules:\n${ids.map((id, i) => `  - id: '${id}'\n    description: 'fixture'\n    regex: '${i === 4 ? 'PUBLISH' : `MARK${i}`}'\n    sample: 'fixture'\n`).join('')}clean_probes:\n  - 'clean'\n`;
const diff = [
  'diff --git a/src/x b/src/x',
  '--- a/src/x',
  '+++ b/src/x',
  '@@ -1 +1 @@',
  '-MARK0 old',
  '+MARK1 new',
  'diff --git a/node_modules/x b/node_modules/x',
  '--- a/node_modules/x',
  '+++ b/node_modules/x',
  '@@ -1 +1 @@',
  '+MARK2',
  'diff --git a/src/é b/src/é',
  '--- a/src/é',
  '+++ b/src/é',
  '@@ -1 +1 @@',
  '+😀 PUBLISH',
  '',
].join('\n');
const input = {
  patternsText: patterns,
  diff,
  base: 'base',
  head: 'head',
  foreign: false,
  extraClasses: [] as string[],
  artifactPath: '/run/secret-scan.json',
};
function fixture() {
  let report = '';
  const effects: ReviewScannerEffects = {
    compile: (pattern) => (text) => text.includes(pattern),
    gitleaks: async () => ({ kind: 'not-run' }),
    writeReport: async (text) => {
      report = text;
    },
  };
  return { effects, report: () => report };
}
describe('review scan evidence', () => {
  it('records added and removed hits, skips allowlisted paths and never records matched content', async () => {
    const f = fixture();
    const result = await scanReviewDiff(input, f.effects);
    expect(result).toMatchObject({ clean: false, denylistHits: 3, gitleaksHits: 0 });
    const report: unknown = JSON.parse(f.report());
    expect(report).toMatchObject({
      base: 'base',
      head: 'head',
      denylist_rules: 5,
      denylist_hits: [
        { rule: ids[0], file: 'src/x', diff_line: 5 },
        { rule: ids[1], file: 'src/x', diff_line: 6 },
        { rule: ids[4], file: 'src/é', diff_line: 16 },
      ],
      gitleaks: 'not-run',
      diff_bytes: Array.from(diff).length,
    });
    expect(f.report()).not.toContain('MARK0 old');
    expect(f.report()).not.toContain('PUBLISH');
  });
  it('filters foreign rules and fails closed for unknown classes', async () => {
    const f = fixture();
    const result = await scanReviewDiff({ ...input, foreign: true }, f.effects);
    expect(result.denylistHits).toBe(2);
    expect(JSON.parse(f.report())).toMatchObject({ denylist_rules: 4 });
    await expect(
      scanReviewDiff({ ...input, foreign: true, extraClasses: ['class:missing'] }, f.effects),
    ).rejects.toThrow('unknown scan class');
  });
  it('emits redacted gitleaks hits or an error hit, refusing an absent report', async () => {
    const f = fixture();
    f.effects.gitleaks = async () => ({
      kind: 'exit',
      code: 0,
      hits: [{ rule: 'fixture', diffLine: 8 }],
    });
    expect((await scanReviewDiff({ ...input, diff: '' }, f.effects)).gitleaksHits).toBe(1);
    expect(JSON.parse(f.report())).toMatchObject({
      gitleaks: 'exit 0',
      gitleaks_hits: [{ rule: 'fixture', diff_line: 8 }],
    });
    f.effects.gitleaks = async () => ({ kind: 'exit', code: 2, hits: null });
    expect((await scanReviewDiff({ ...input, diff: '' }, f.effects)).gitleaksHits).toBe(1);
    expect(JSON.parse(f.report())).toMatchObject({
      gitleaks_hits: [{ rule: 'gitleaks-error', diff_line: null }],
    });
    f.effects.gitleaks = async () => ({ kind: 'exit', code: 0, hits: null });
    await expect(scanReviewDiff(input, f.effects)).rejects.toThrow('report unavailable');
  });
  it('refuses unavailable matchers and scanner effects', async () => {
    const f = fixture();
    f.effects.compile = () => {
      throw new Error('unavailable');
    };
    await expect(scanReviewDiff(input, f.effects)).rejects.toThrow('matcher unavailable');
    expect(f.report()).toBe('');
  });
  it('uses Python splitlines and the injected Unicode matcher', async () => {
    const f = fixture();
    f.effects.compile = (pattern) => (text) =>
      pattern === 'MARK0' ? /(?<![\p{L}\p{N}_])MARK0/u.test(text) : text.includes(pattern);
    const text = 'diff --git a/x b/x\r--- a/x\r+++ b/x\r@@ -1 +1 @@\r+λMARK0\u2028+ MARK0\r';
    const result = await scanReviewDiff({ ...input, diff: text }, f.effects);
    expect(result.denylistHits).toBe(1);
    expect(JSON.parse(f.report())).toMatchObject({
      denylist_hits: [{ rule: ids[0], file: 'x', diff_line: 6 }],
      diff_bytes: Array.from(text).length,
    });
  });
});
