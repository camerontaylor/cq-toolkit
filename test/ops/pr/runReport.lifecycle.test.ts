// Split provenance: moved verbatim from test/ops/pr/runReport.test.ts (shared
// fixtures in runReport.helpers.ts, which carries the suite header).
import { describe, expect, test } from 'vitest';
import { makeRunReport } from '../../../src/ops/pr/runReport.js';
import { type FakeGh, makeReportHarness } from './runReport.helpers.js';

const { fakeGh, inputOf, okReport } = makeReportHarness();

// ---------------------------------------------------------------------------
// Lifecycle + mergeability dominance (PR-165 r3, codex jMJpD): the fold
// reads meta FIRST — unmergeable PRs are blocked on green evidence
// ---------------------------------------------------------------------------

describe('lifecycle and mergeability dominate the fold', () => {
  const greenSeed: Partial<FakeGh> = {
    checks: new Map([[11, { state: 'pass' }]]),
    reviews: new Map([[11, { state: 'approved' }]]),
  };

  test('a CLOSED PR with green checks and approval → blocked, reason state: closed', async () => {
    const fake = fakeGh({ ...greenSeed, metas: new Map([[11, 'closed']]) });
    const report = await okReport(
      makeRunReport(fake.gh),
      inputOf({ packages: [{ name: 'core', number: 11 }] }),
    );
    expect(report.rows[0]).toMatchObject({
      readiness: 'blocked',
      checks: 'pass',
      review: 'approved',
      reason: 'state: closed',
    });
  });

  test('a MERGED PR → blocked, reason state: merged', async () => {
    const fake = fakeGh({ ...greenSeed, metas: new Map([[11, 'merged']]) });
    const report = await okReport(
      makeRunReport(fake.gh),
      inputOf({ packages: [{ name: 'core', number: 11 }] }),
    );
    expect(report.rows[0]).toMatchObject({ readiness: 'blocked', reason: 'state: merged' });
  });

  test('an UNKNOWN PR state FAILS CLOSED → unknown, not a fabricated block (final jONi0)', async () => {
    // An undetermined lifecycle state is unreadable evidence, not a hard
    // verdict either way — `unknown`, never `blocked`, never `ready`.
    const fake = fakeGh({ ...greenSeed, metas: new Map([[11, 'unknown']]) });
    const report = await okReport(
      makeRunReport(fake.gh),
      inputOf({ packages: [{ name: 'core', number: 11 }] }),
    );
    expect(report.rows[0]).toMatchObject({
      readiness: 'unknown',
      checks: 'pass',
      review: 'approved',
      reason: 'PR state not determined by GitHub',
    });
    expect(report.counts).toEqual({ ready: 0, blocked: 0, unknown: 1 });
  });

  test('merge CONFLICTS with green checks and approval → blocked, reason merge conflicts', async () => {
    const fake = fakeGh({ ...greenSeed, mergeables: new Map([[11, 'conflicting']]) });
    const report = await okReport(
      makeRunReport(fake.gh),
      inputOf({ packages: [{ name: 'core', number: 11 }] }),
    );
    expect(report.rows[0]).toMatchObject({
      readiness: 'blocked',
      checks: 'pass',
      review: 'approved',
      reason: 'merge conflicts',
    });
    expect(report.counts).toEqual({ ready: 0, blocked: 1, unknown: 0 });
  });

  test('an UNKNOWN mergeable word FAILS CLOSED → unknown, reason naming the uncomputed mergeability (jNf_h)', async () => {
    // GitHub has not computed mergeability yet — green evidence cannot
    // make that `ready` (ready would be a verdict ahead of evidence).
    const fake = fakeGh({ ...greenSeed, mergeables: new Map([[11, 'unknown']]) });
    const report = await okReport(
      makeRunReport(fake.gh),
      inputOf({ packages: [{ name: 'core', number: 11 }] }),
    );
    expect(report.rows[0]).toMatchObject({
      readiness: 'unknown',
      checks: 'pass',
      review: 'approved',
      reason: 'mergeability not yet computed by GitHub',
    });
    expect(report.counts).toEqual({ ready: 0, blocked: 0, unknown: 1 });
  });

  test('merge state BLOCKED → blocked, reason naming the branch protection requirement (final jNTyP)', async () => {
    const fake = fakeGh({ ...greenSeed, statuses: new Map([[11, 'blocked']]) });
    const report = await okReport(
      makeRunReport(fake.gh),
      inputOf({ packages: [{ name: 'core', number: 11 }] }),
    );
    expect(report.rows[0]).toMatchObject({
      readiness: 'blocked',
      checks: 'pass',
      review: 'approved',
      reason: 'merge state: blocked — branch protection requirement',
    });
  });

  test('merge state BEHIND → blocked (final jNTyP)', async () => {
    const fake = fakeGh({ ...greenSeed, statuses: new Map([[11, 'behind']]) });
    const report = await okReport(
      makeRunReport(fake.gh),
      inputOf({ packages: [{ name: 'core', number: 11 }] }),
    );
    expect(report.rows[0]).toMatchObject({
      readiness: 'blocked',
      reason: 'merge state: behind — branch protection requirement',
    });
  });

  test('merge state CLEAN → the halves decide: green evidence reports ready (final jNTyP)', async () => {
    const fake = fakeGh({ ...greenSeed, statuses: new Map([[11, 'clean']]) });
    const report = await okReport(
      makeRunReport(fake.gh),
      inputOf({ packages: [{ name: 'core', number: 11 }] }),
    );
    expect(report.rows[0]).toMatchObject({ readiness: 'ready' });
  });

  test('an UNKNOWN merge state FAILS CLOSED → unknown, reason naming the undetermined state (jOEDe)', async () => {
    // Same doctrine as mergeable-unknown (jNf_h): GitHub's undetermined
    // merge state cannot support a merge-ready verdict, green evidence or
    // not.
    const fake = fakeGh({ ...greenSeed, statuses: new Map([[11, 'unknown']]) });
    const report = await okReport(
      makeRunReport(fake.gh),
      inputOf({ packages: [{ name: 'core', number: 11 }] }),
    );
    expect(report.rows[0]).toMatchObject({
      readiness: 'unknown',
      checks: 'pass',
      review: 'approved',
      reason: 'merge state not yet determined by GitHub',
    });
    expect(report.counts).toEqual({ ready: 0, blocked: 0, unknown: 1 });
  });
});
