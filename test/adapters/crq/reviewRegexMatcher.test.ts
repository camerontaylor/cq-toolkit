import { describe, expect, it } from 'vitest';
import { matchReviewRegexBatch } from '../../../dist/adapters/crq/reviewRegexMatcher.js';
import { scanReviewDiff } from '../../../dist/queue-runner/reviewScan.js';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import type { ReviewRegexBatch } from '../../../src/adapters/crq/reviewRegexMatcher.js';

describe('built inactive review matcher', () => {
  it('feeds ordered worker matches into the redacted scan report', async () => {
    let report = '';
    const result = await scanReviewDiff(
      {
        patternsText: readFileSync(
          new URL('../../../policy/denylist/patterns.yml', import.meta.url),
          'utf8',
        ),
        diff: 'diff --git a/a.env b/a.env\n--- a/a.env\n+++ b/a.env\n@@ -1 +1 @@\n+abc\n',
        base: 'a',
        head: 'b',
        foreign: true,
        extraClasses: [],
        artifactPath: 'secret-scan.json',
      },
      {
        match: matchReviewRegexBatch,
        gitleaks: async () => ({ kind: 'not-run' }),
        writeReport: async (text) => {
          report = text;
        },
      },
    );
    expect(result.clean).toBe(false);
    expect(JSON.parse(report)).toMatchObject({
      denylist_hits: [{ rule: 'class:key-material-env', file: 'a.env', diff_line: 5 }],
    });
    expect(report).not.toContain('+abc');
  });
  it('runs the packaged worker and returns ordered rule and line indices', async () => {
    const input: ReviewRegexBatch = {
      rules: [
        { regex: '\\bkey', path: '\\.env' },
        { regex: 'secret', path: null },
      ],
      lines: [
        { path: 'a.env', text: ' key secret' },
        { path: 'x', text: 'key secret' },
      ],
    };
    const hits = await matchReviewRegexBatch(input);
    expect(hits).toEqual([
      [0, 0],
      [0, 1],
      [1, 1],
    ]);
  });
  it('refuses unsupported rules even for empty input', async () => {
    await expect(
      matchReviewRegexBatch({ rules: [{ regex: '(?i)secret', path: null }], lines: [] }),
    ).rejects.toThrow('review matcher unavailable');
  });
  it('terminates pathological worker searches at a bounded deadline', async () => {
    await expect(
      matchReviewRegexBatch(
        {
          rules: [{ regex: '(a+)+$', path: null }],
          lines: [{ path: 'a', text: `${'a'.repeat(20000)}!` }],
        },
        50,
      ),
    ).rejects.toThrow('review matcher unavailable');
  });
  it('terminates a busy worker rather than leaving its host process alive', () => {
    const moduleUrl = new URL('../../../dist/adapters/crq/reviewRegexMatcher.js', import.meta.url)
      .href;
    const script = `import(${JSON.stringify(moduleUrl)}).then(async ({ matchReviewRegexBatch }) => {
      const started = Date.now();
      try {
        await matchReviewRegexBatch({ rules: [{ regex: '(a+)+$', path: null }], lines: [{ path: 'a', text: 'a'.repeat(20000) + '!' }] }, 300);
        process.exitCode = 1;
      } catch { if (Date.now() - started < 250) process.exitCode = 2; else console.log('deadline'); }
    });`;
    const child = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      timeout: 5000,
      killSignal: 'SIGKILL',
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(child.stdout).toContain('deadline');
  });
  it('rejects excessive requests before worker transfer', async () => {
    await expect(
      matchReviewRegexBatch({
        rules: Array.from({ length: 101 }, () => ({ regex: 'a', path: null })),
        lines: [],
      }),
    ).rejects.toThrow('input exceeds limits');
  });
});
