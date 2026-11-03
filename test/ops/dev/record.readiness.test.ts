// record.ts unit tests — the readiness assembly matrix (the dev.ready /
// pr.open shared core): the anchor cycle, check evidence, blocking findings and
// untracked files. The no-fresh reuse resolution lives in
// record.readiness-reuse.test.ts.
// Split provenance: test/ops/dev/record.test.ts was split into record.format.test.ts,
// record.finding-schema.test.ts, record.branch-path.test.ts, record.store.test.ts,
// record.readiness.test.ts, record.reuse-selector.test.ts and
// record.readiness-reuse.test.ts.
import { describe, expect, test } from 'vitest';
import { assembleReadiness, DEV_LEDGER_VERSION } from '../../../src/ops/dev/record.js';
import { BASE, BRANCH, HEAD, checkRecord, cycleRecord, dispositionRecord } from './fakes.js';
import { assemble } from './record.helpers.js';

describe('assembleReadiness', () => {
  test('ready: ONE terminal full-scope cycle (D-J) + green check at the current identity', () => {
    const result = assemble([cycleRecord(), checkRecord()]);
    expect(result.ready).toBe(true);
    if (result.ready) {
      expect(result.record).toMatchObject({
        ready: true,
        evidenceClass: 'author',
        branch: BRANCH,
        cycleId: 'c001-aaaaaaaa',
        checkId: 'k001-aaaaaaaa',
        base: BASE,
        head: HEAD,
        dirtySha256: 'dirty',
      });
      expect(result.record.caveat).toContain('not verification');
      expect(result.record.caveat).toContain('candidate SHA');
    }
  });

  test('the anchor is the LATEST terminal full-scope cycle: an older match never rescues it', () => {
    const result = assemble([
      cycleRecord(),
      cycleRecord({ cycleId: 'c002-bbbbbbbb', head: 'newer-head' }),
      checkRecord(),
    ]);
    expect(result.ready).toBe(false);
    if (!result.ready) {
      expect(result.gaps.map((gap) => gap.field)).toEqual(['stale-review-identity']);
      expect(result.gaps[0]?.detail).toContain('c002-bbbbbbbb');
    }
  });

  test('no records: both gaps named', () => {
    const result = assemble([]);
    expect(result.ready).toBe(false);
    if (!result.ready) {
      const fields = result.gaps.map((gap) => gap.field);
      expect(fields).toContain('terminal-review-cycle');
      expect(fields).toContain('green-check');
    }
  });

  test('uncommitted checks cannot replace full check evidence', () => {
    expect(assemble([cycleRecord(), checkRecord({ scope: 'uncommitted' })]).ready).toBe(false);
    expect(
      assemble([cycleRecord(), checkRecord(), checkRecord({ scope: 'uncommitted', passed: false })])
        .ready,
    ).toBe(true);
    expect(
      assemble([
        cycleRecord(),
        checkRecord({ passed: false }),
        checkRecord({ scope: 'uncommitted' }),
      ]).ready,
    ).toBe(false);
  });

  test('an uncommitted-scope terminal cycle never satisfies readiness', () => {
    const result = assemble([cycleRecord({ scope: 'uncommitted' }), checkRecord()]);
    expect(result.ready).toBe(false);
    if (!result.ready) {
      const gap = result.gaps.find((entry) => entry.field === 'terminal-review-cycle');
      expect(gap?.detail).toContain('uncommitted-scope');
    }
  });

  test('a blocked cycle never counts as the terminal cycle', () => {
    const result = assemble([
      cycleRecord({ completion: { kind: 'blocked', reason: 'cli exit 1' } }),
      checkRecord(),
    ]);
    expect(result.ready).toBe(false);
    if (!result.ready) expect(result.gaps.map((g) => g.field)).toContain('terminal-review-cycle');
  });

  test('a stale cycle identity is named field by field', () => {
    const result = assemble([
      cycleRecord({ head: 'older', dirtySha256: 'older-dirty' }),
      checkRecord(),
    ]);
    expect(result.ready).toBe(false);
    if (!result.ready) {
      const stale = result.gaps.find((gap) => gap.field === 'stale-review-identity');
      expect(stale?.detail).toContain('head');
      expect(stale?.detail).toContain('working-tree diff changed');
    }
  });

  test('a blocking finding is open until fixed/rejected; deferred does NOT close it', () => {
    const cycle = cycleRecord({
      findings: [
        { id: 'c001-aaaaaaaa#f1', severity: 'critical' },
        { id: 'c001-aaaaaaaa#f2', severity: 'major', fileName: 'a.ts' },
        { id: 'c001-aaaaaaaa#f3', severity: 'minor' },
      ],
    });
    // Deferred f1, nothing for f2, fixed f3: f1 and f2 stay open.
    const result = assemble([
      cycle,
      checkRecord(),
      dispositionRecord({ findingId: 'c001-aaaaaaaa#f1', action: 'deferred' }),
      dispositionRecord({ findingId: 'c001-aaaaaaaa#f3', action: 'fixed' }),
    ]);
    expect(result.ready).toBe(false);
    if (!result.ready) {
      const open = result.gaps.find((gap) => gap.field === 'open-blocking-findings');
      expect(open?.detail).toContain('#f1');
      expect(open?.detail).toContain('#f2');
      expect(open?.detail).not.toContain('#f3');
    }
  });

  test.each(['', undefined, 'a.ts'])(
    'open empty-file readiness names the nondispatchable reason without changing other paths: %j',
    (fileName) => {
      const result = assemble([
        cycleRecord({
          findings: [
            {
              id: 'empty-path',
              severity: 'major',
              ...(fileName === undefined ? {} : { fileName }),
            },
          ],
        }),
        checkRecord(),
      ]);
      expect(result.ready).toBe(false);
      if (result.ready) return;
      const detail = result.gaps.find((gap) => gap.field === 'open-blocking-findings')?.detail;
      expect(detail).toContain('empty-path');
      if (fileName === '') expect(detail).toContain('unresolved: finding has no file path');
      else expect(detail).not.toContain('unresolved: finding has no file path');
    },
  );

  test('fixed and rejected dispositions close blocking findings; minor never blocks', () => {
    const cycle = cycleRecord({
      findings: [
        { id: 'c001-aaaaaaaa#f1', severity: 'critical' },
        { id: 'c001-aaaaaaaa#f2', severity: 'major' },
        { id: 'c001-aaaaaaaa#f3', severity: 'trivial' },
      ],
    });
    const result = assemble([
      cycleRecord({ cycleId: 'c000-aaaaaaaa' }),
      cycle,
      checkRecord(),
      dispositionRecord({ findingId: 'c001-aaaaaaaa#f1', action: 'fixed' }),
      dispositionRecord({
        findingId: 'c001-aaaaaaaa#f2',
        action: 'rejected',
        why: 'false positive: mechanism cited',
      }),
    ]);
    expect(result.ready).toBe(true);
  });

  test('a red check is no check; a stale check identity is a gap', () => {
    const redOnly = assemble([cycleRecord(), checkRecord({ passed: false })]);
    expect(redOnly.ready).toBe(false);
    const stale = assemble([cycleRecord(), checkRecord({ base: 'older-base' })]);
    expect(stale.ready).toBe(false);
    if (!stale.ready) expect(stale.gaps.map((g) => g.field)).toContain('stale-check-identity');
  });

  test('a green check followed by a RED check at the same identity is NOT ready', () => {
    const result = assemble([
      cycleRecord(),
      checkRecord(),
      checkRecord({ checkId: 'k002-aaaaaaaa', passed: false }),
    ]);
    expect(result.ready).toBe(false);
    if (!result.ready) {
      const gap = result.gaps.find((entry) => entry.field === 'red-check');
      expect(gap?.detail).toContain('k002-aaaaaaaa');
      expect(gap?.detail).toContain('RED');
    }
  });

  test("an uncommitted-scope cycle's blocking finding also requires a disposition", () => {
    const uncommitted = cycleRecord({
      scope: 'uncommitted',
      findings: [{ id: 'c001-aaaaaaaa#f1', severity: 'critical' }],
    });
    const result = assemble([uncommitted, cycleRecord(), checkRecord()]);
    expect(result.ready).toBe(false);
    if (!result.ready) {
      const gap = result.gaps.find((entry) => entry.field === 'open-blocking-findings');
      expect(gap?.detail).toContain('c001-aaaaaaaa#f1');
    }
    const closed = assemble([
      uncommitted,
      cycleRecord({ cycleId: 'c000-aaaaaaaa' }),
      cycleRecord(),
      checkRecord(),
      dispositionRecord({ findingId: 'c001-aaaaaaaa#f1', action: 'fixed' }),
    ]);
    expect(closed.ready).toBe(true);
  });

  test('a later BLOCKED attempt invalidates readiness over an older terminal cycle', () => {
    const result = assemble([
      cycleRecord(),
      cycleRecord({
        cycleId: 'c002-aaaaaaaa',
        completion: { kind: 'blocked', reason: 'cli exit 1' },
      }),
      checkRecord(),
    ]);
    expect(result.ready).toBe(false);
    if (!result.ready) {
      const gap = result.gaps.find((entry) => entry.field === 'latest-review-blocked');
      expect(gap?.detail).toContain('c002-aaaaaaaa');
      expect(gap?.detail).toContain('cli exit 1');
    }
  });

  test("an older cycle's open blocking finding stays open despite a clean newer cycle", () => {
    const older = cycleRecord({
      cycleId: 'c001-aaaaaaaa',
      findings: [{ id: 'c001-aaaaaaaa#f1', severity: 'major', fileName: 'a.ts' }],
    });
    const newer = cycleRecord({
      cycleId: 'c002-aaaaaaaa',
      findings: [], // the newer cycle reports nothing — it does not adjudicate the past
    });
    const result = assemble([older, newer, checkRecord()]);
    expect(result.ready).toBe(false);
    if (!result.ready) {
      const gap = result.gaps.find((entry) => entry.field === 'open-blocking-findings');
      expect(gap?.detail).toContain('c001-aaaaaaaa#f1');
      expect(gap?.detail).toContain('earlier cycle');
    }
    // Recording the disposition closes it.
    const closed = assemble([
      older,
      newer,
      checkRecord(),
      dispositionRecord({ findingId: 'c001-aaaaaaaa#f1', action: 'fixed' }),
    ]);
    expect(closed.ready).toBe(true);
  });

  test('findings from a reviewer removed from cq.json still require disposition', () => {
    const removedReviewer = cycleRecord({
      cycleId: 'c000-aaaaaaaa',
      reviewer: 'agent:reviewer',
      findings: [{ id: 'c000-aaaaaaaa#f1', severity: 'critical' }],
    });
    const currentReviewer = cycleRecord({ findings: [] });
    const result = assembleReadiness({
      branch: BRANCH,
      target: 'main',
      identity: { base: BASE, head: HEAD, dirtySha256: 'dirty' },
      ledger: {
        version: DEV_LEDGER_VERSION,
        branch: BRANCH,
        records: [removedReviewer, currentReviewer, checkRecord()],
      },
      untracked: [],
      configuredReviewers: ['coderabbit'],
      nowIso: '2026-10-17T01:00:00.000Z',
    });
    expect(result.ready).toBe(false);
    if (!result.ready) {
      const gap = result.gaps.find((entry) => entry.field === 'open-blocking-findings');
      expect(gap?.detail).toContain('c000-aaaaaaaa#f1');
    }
  });

  test('untracked files are a gap with the names listed', () => {
    const result = assemble([cycleRecord(), checkRecord()], ['scratch/new.ts']);
    expect(result.ready).toBe(false);
    if (!result.ready) {
      const gap = result.gaps.find((entry) => entry.field === 'untracked-files');
      expect(gap?.detail).toContain('scratch/new.ts');
    }
  });
});

test('a blocked attempt keeps its major findings open after a later terminal cycle', () => {
  const blocked = cycleRecord({
    cycleId: 'c000-aaaaaaaa',
    completion: { kind: 'blocked', reason: 'CLI error' },
    findings: [{ id: 'c000-aaaaaaaa#f1', severity: 'major' }],
  });
  const records = [blocked, cycleRecord(), checkRecord()];
  const open = assemble(records);
  expect(open.ready).toBe(false);
  if (!open.ready)
    expect(
      open.gaps.some(
        (gap) => gap.field === 'open-blocking-findings' && gap.detail.includes('c000-aaaaaaaa#f1'),
      ),
    ).toBe(true);
  expect(assemble([...records, dispositionRecord({ findingId: 'c000-aaaaaaaa#f1' })]).ready).toBe(
    true,
  );
});
