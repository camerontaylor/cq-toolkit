// Split provenance: moved verbatim from test/ops/pr/runReport.test.ts (shared
// fixtures in runReport.helpers.ts, which carries the suite header).
import { describe, expect, test } from 'vitest';
import { READINESS_SECTION_MARKER } from '../../../src/ops/pr/assemblePrs.js';
import type { PrEffects } from '../../../src/ops/pr/assemblePrs.js';
import { makeSubprocessPrEffects } from '../../../src/adapters/forge-github/ghEffects.js';
import type { DiffSecretScanner } from '../../../src/ops/dev/denylist.js';
import { makeRunReport } from '../../../src/ops/pr/runReport.js';
import { cleanScanner, makeReportHarness } from './runReport.helpers.js';

const { fakeGh, inputOf, okReport } = makeReportHarness();

// ---------------------------------------------------------------------------
// Tracker update in place; never a merge, never a second PR
// ---------------------------------------------------------------------------

describe('the tracker is updated in place, and nothing ever merges', () => {
  test('with tracker present, the rows are written to THAT number; createPr is never called', async () => {
    const fake = fakeGh({
      checks: new Map([[11, { state: 'pass' }]]),
      reviews: new Map([[11, { state: 'approved' }]]),
    });
    const report = await okReport(
      makeRunReport(fake.gh, undefined, cleanScanner),
      inputOf({ tracker: { number: 7 } }),
    );
    expect(report.trackerUpdated).toBe(true);
    expect(fake.edits.get(7)).toContain('`core` — #11 — checks: pass; review: approved — READY');
    expect(fake.edits.get(7)).toContain('never auto-merges');
    expect(fake.creates).toBe(0);
  });

  test('without tracker, no edit runs and trackerUpdated is false', async () => {
    const fake = fakeGh();
    const report = await okReport(makeRunReport(fake.gh), inputOf());
    expect(report.trackerUpdated).toBe(false);
    expect(fake.edits.size).toBe(0);
  });

  test('a tracker edit fault fails the op AND carries the collected rows in the error (r1#5)', async () => {
    const fake = fakeGh({
      checks: new Map([
        [11, { state: 'pass' }],
        [12, { state: 'fail', failing: ['build'] }],
      ]),
      reviews: new Map([
        [11, { state: 'approved' }],
        [12, { state: 'none' }],
      ]),
    });
    fake.gh.editPrBody = async () => {
      throw new Error('edit refused');
    };
    const result = await makeRunReport(
      fake.gh,
      undefined,
      cleanScanner,
    )(inputOf({ tracker: { number: 7 } }));
    expect(result.status).toBe('failed');
    expect(result.status === 'failed' && result.error).toContain('tracker PR #7');
    // The progressNote pattern: the fleet's evidence rides the failure text.
    expect(result.status === 'failed' && result.error).toContain(
      'core #11 ready; util #12 blocked (checks failing (build))',
    );
  });

  test('a tracker write with no denylist scanner is refused before any read or write', async () => {
    const fake = fakeGh();
    const result = await makeRunReport(fake.gh)(inputOf({ tracker: { number: 7 } }));
    expect(result.status).toBe('failed');
    expect(result.status === 'failed' && result.error).toContain('no PR payload denylist scanner');
    expect(fake.edits.size).toBe(0);
  });

  test('a denylist hit in the composed section refuses the tracker edit', async () => {
    const fake = fakeGh();
    const hitScanner: DiffSecretScanner = (components) =>
      components.map(({ component }) => ({
        component,
        hits: [{ ruleId: 'test-rule', lines: [1] }],
      }));
    const result = await makeRunReport(
      fake.gh,
      undefined,
      hitScanner,
    )(inputOf({ tracker: { number: 7 } }));
    expect(result.status).toBe('failed');
    expect(result.status === 'failed' && result.error).toContain('refused by denylist scan');
    expect(fake.edits.size).toBe(0);
  });

  test('a NON-OPEN tracker number is refused before any write (r2#2), rows carried in the error', async () => {
    for (const trackerState of ['merged', 'closed', 'unknown'] as const) {
      const fake = fakeGh({ metas: new Map([[7, trackerState]]) });
      const result = await makeRunReport(
        fake.gh,
        undefined,
        cleanScanner,
      )(inputOf({ tracker: { number: 7 } }));
      expect(result.status).toBe('failed');
      expect(result.status === 'failed' && result.error).toContain(`is in state '${trackerState}'`);
      expect(result.status === 'failed' && result.error).toContain('core #11');
      expect(fake.edits.size).toBe(0);
    }
  });

  test('a tracker META-read fault fails the op with the rows (the lifecycle guard needs the read)', async () => {
    const fake = fakeGh({ readinessFaults: new Map([[7, 'meta read boom']]) });
    const result = await makeRunReport(
      fake.gh,
      undefined,
      cleanScanner,
    )(inputOf({ tracker: { number: 7 } }));
    expect(result.status).toBe('failed');
    expect(result.status === 'failed' && result.error).toContain('lifecycle state');
    expect(result.status === 'failed' && result.error).toContain('meta read boom');
    expect(fake.edits.size).toBe(0);
  });

  test('the report upsert preserves an existing manifest section verbatim (r2#4)', async () => {
    const manifestBody = [
      '<!-- cq:manifest -->',
      '<!-- cq-toolkit fleet-run manifest: runPrefix cq/09-16a (generated; updated in place, never duplicated) -->',
      '# Fleet run `cq/09-16a`',
      '',
      '- `core` — #11 (`cq/09-16a/fix/core`)',
      '<!-- /cq:manifest -->',
      '',
      'User prose below the manifest survives.',
      '',
    ].join('\n');
    const fake = fakeGh({
      checks: new Map([[11, { state: 'pass' }]]),
      reviews: new Map([[11, { state: 'approved' }]]),
      bodies: new Map([[7, manifestBody]]),
    });
    const report = await okReport(
      makeRunReport(fake.gh, undefined, cleanScanner),
      inputOf({ tracker: { number: 7 } }),
    );
    expect(report.trackerUpdated).toBe(true);
    const written = fake.edits.get(7);
    expect(written).toContain(READINESS_SECTION_MARKER);
    // The assembler's manifest survived BYTE-FOR-BYTE — prose below included.
    expect(written).toContain(manifestBody.trimEnd());
    expect(written).toContain('`core` — #11 — checks: pass; review: approved — READY');
  });

  test('markdown metacharacters in a row name cannot break the report bullets (r2#7 + final jN7cZ)', async () => {
    const fake = fakeGh({
      checks: new Map([[11, { state: 'pass' }]]),
      reviews: new Map([[11, { state: 'approved' }]]),
    });
    await okReport(
      makeRunReport(fake.gh, undefined, cleanScanner),
      inputOf({
        tracker: { number: 7 },
        packages: [{ name: 'co`re<b>', number: 11 }],
      }),
    );
    const written = fake.edits.get(7);
    // Backticks REPLACED with U+2019 (CommonMark ignores backslash escapes
    // inside code spans), angles stripped — the span cannot be closed.
    expect(written).toContain('`co’reb`');
    expect(written).not.toContain('co`');
    expect(written).not.toContain('\\`');
    expect(written).not.toContain('<b>');
  });

  test('TYPE + RUNTIME PIN: the PrEffects seam admits no merge-class member', async () => {
    // The record annotation below fails to COMPILE the moment a member is
    // added to (or removed from) PrEffects — the type-level pin that the
    // seam cannot grow a merge effect unnoticed. The runtime assertions
    // then prove no member name even CONTAINS a merge verb. getPrReadiness
    // is the ONE consolidated readiness read (final jNTyS) — the three
    // per-half reads it replaced are gone, no dead surface.
    const seamMembers: Record<keyof PrEffects, true> = {
      searchPrByHead: true,
      createPr: true,
      editPrBody: true,
      getPrBody: true,
      comment: true,
      getPrReadiness: true,
    };
    const names = Object.keys(seamMembers);
    expect(names).toHaveLength(6);
    expect(names.some((name) => /merge|rebase|squash|close/i.test(name))).toBe(false);
    // The production adapter is pinned to the same six — no merge effect by
    // construction there either.
    expect(Object.keys(makeSubprocessPrEffects('/repo')).sort()).toEqual(names.sort());
  });
});
