/**
 * Replays `apps/crq-python/fixtures/crq-review-scan/cases.json`, emitted by
 * `review_scan_vectors.py` from the PRODUCTION `crq.secret_scan_diff`, against
 * `scanReviewDiff`. The cases are patch text, so header shapes real git only writes
 * under repository config the hardened git runner pins away (a literal U+2028 in a
 * filename) are replayed too. The compared datum is the exact report bytes.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { matchReviewRegexBatch } from '../../dist/adapters/crq/reviewRegexMatcher.js';
import { loadScanExemptions } from '../../src/queue-runner/scanExemptions.js';
import { scanReviewDiff } from '../../src/queue-runner/reviewScan.js';

interface Case {
  name: string;
  diff: string;
  exemptions: string | null;
  expected: { error: string | null; ok?: boolean; artifact?: string };
}
const root = new URL('../../apps/crq-python/', import.meta.url);
const fixture = JSON.parse(
  readFileSync(new URL('fixtures/crq-review-scan/cases.json', root), 'utf8'),
) as { schema: string; cases: Case[] };
const corpus = readFileSync(new URL('../../policy/denylist/patterns.yml', root), 'utf8').trim();

describe('review scan header parsing against the Python oracle', () => {
  it('pins the fixture schema and a non-trivial corpus', () => {
    expect(fixture.schema).toBe('cq.crq-review-scan-vector/v1');
    expect(fixture.cases.length).toBeGreaterThan(50);
  });
  const scan = async (c: Case) => {
    let report = '';
    const loaded = c.exemptions === null ? null : loadScanExemptions(c.exemptions);
    const decision = await scanReviewDiff(
      {
        patternsText: corpus,
        diff: c.diff,
        base: 'base',
        head: 'head',
        foreign: false,
        extraClasses: [],
        artifactPath: '/run/secret-scan.json',
        ...(loaded ? { exemptions: loaded.entries, exemptionError: loaded.error } : {}),
      },
      {
        match: matchReviewRegexBatch,
        gitleaks: async () => ({ kind: 'not-run' }),
        writeReport: async (text) => {
          report = text;
        },
      },
    );
    return { decision, report };
  };
  for (const c of fixture.cases) {
    it(c.name, async () => {
      const { decision, report } = await scan(c);
      expect(c.expected.error).toBeNull();
      expect(decision.clean).toBe(c.expected.ok);
      expect(report).toBe(c.expected.artifact);
    });
  }

  // The pre-#2385 TS guarded this (a logical fragment of hunk content is not a header);
  // Python does not, so the fixture records a CLEAN result: Python's fail-open weakness,
  // copied for parity and tracked in #2389. Fix both engines before any routing.
  it('copies the Python U+2028/U+0085 fake-header fail-open the old TS guard blocked (#2389)', async () => {
    const cases = fixture.cases.filter((x) =>
      x.name.includes('fake header and hides the next added line'),
    );
    expect(cases.map((x) => x.name).length).toBe(2);
    for (const c of cases) {
      expect(c.diff).toMatch(/\u2028|\u0085/u);
      const { decision } = await scan(c);
      // The secret on the line after the fragment is NOT reported: Python's weakness, kept for parity.
      expect(decision.clean).toBe(true);
      expect(c.expected.ok).toBe(true);
    }
  });
});
