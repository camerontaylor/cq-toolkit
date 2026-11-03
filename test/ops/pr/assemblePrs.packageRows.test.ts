// Split provenance: test/ops/pr/assemblePrs.test.ts was split by subject;
// this file holds the per-package row outcome tests: row isolation, refusal
// to adopt a non-open package PR, and refusal to adopt a foreign fork PR.
// Shared fixtures live in assemblePrs.helpers.ts.
import { afterAll, describe, expect, test } from 'vitest';
import {
  PKG_CORE,
  PKG_UTIL,
  TRACKER_BRANCH,
  cleanupRepoRoot,
  failedAt,
  fakeGh,
  inputOf,
  makeAssemblePrs,
  okReport,
} from './assemblePrs.helpers.js';

afterAll(cleanupRepoRoot);

// ---------------------------------------------------------------------------
// Per-row isolation
// ---------------------------------------------------------------------------

describe('per-package rows isolate their outcomes', () => {
  test('an existing per-package PR is reused (no duplicate create), others are created', async () => {
    const fake = fakeGh({
      prsByHead: new Map([[PKG_CORE, { number: 55 }]]),
    });
    const result = await okReport(makeAssemblePrs(fake.gh), inputOf());
    // The tracker create consumed 101; util's fresh PR is 102.
    expect(result.packages).toEqual([
      { name: 'core', number: 55, created: false },
      { name: 'util', number: 102, created: true, url: 'https://github.test/owner/repo/pull/102' },
    ]);
    expect(fake.calls).not.toContain(`create:${PKG_CORE}`);
    expect(fake.calls).toContain(`create:${PKG_UTIL}`);
  });

  test('a per-package create fault lands on its row alone; the other package still assembles', async () => {
    const fake = fakeGh({ createFaultOnHead: PKG_UTIL });
    const result = await okReport(makeAssemblePrs(fake.gh), inputOf());
    // The tracker created first (#101); core's fresh PR is #102.
    expect(result.packages[0]).toEqual({
      name: 'core',
      number: 102,
      created: true,
      url: 'https://github.test/owner/repo/pull/102',
    });
    expect(result.packages[1]).toMatchObject({
      name: 'util',
      created: false,
      fault: 'gh refused the create for cq/09-16a/fix/util',
    });
    expect(result.packages[1]?.number).toBeUndefined();
    // The fault is visible in the refreshed tracker manifest.
    expect(fake.edits.get(101)).toContain('FAULT: gh refused the create');
  });

  test('a per-package search fault isolates to its row too', async () => {
    const fake = fakeGh();
    const baseSearch = fake.gh.searchPrByHead;
    fake.gh.searchPrByHead = async (head, base) => {
      if (head === PKG_CORE) throw new Error('search timed out');
      return baseSearch(head, base);
    };
    const result = await okReport(makeAssemblePrs(fake.gh), inputOf());
    expect(result.packages[0]).toMatchObject({
      name: 'core',
      created: false,
      fault: 'search timed out',
    });
    expect(result.packages[1]).toMatchObject({ name: 'util', created: true });
  });
});

// ---------------------------------------------------------------------------
// State-aware per-package adoption (PR-165 r2#1)
// ---------------------------------------------------------------------------

describe('a non-open package PR is refused as a ROW fault, never adopted', () => {
  test('a MERGED package PR → its row faults, the op stays ok, the sibling still assembles', async () => {
    const fake = fakeGh({
      prsByHead: new Map([[PKG_CORE, { number: 55, state: 'merged' }]]),
    });
    const result = await okReport(makeAssemblePrs(fake.gh), inputOf());
    expect(result.packages[0]).toMatchObject({ name: 'core', created: false });
    expect(result.packages[0]?.fault).toContain("is in state 'merged'");
    expect(result.packages[0]?.number).toBeUndefined();
    expect(result.packages[1]).toMatchObject({ name: 'util', created: true });
    expect(fake.calls).not.toContain(`create:${PKG_CORE}`);
  });

  test('the adoption refusal shows in the tracker manifest', async () => {
    const fake = fakeGh({
      prsByHead: new Map([[PKG_CORE, { number: 55, state: 'closed' }]]),
    });
    const result = await okReport(makeAssemblePrs(fake.gh), inputOf());
    const manifest = fake.edits.get(result.tracker.number);
    expect(manifest).toContain('FAULT:');
    expect(manifest).toContain("is in state 'closed'");
  });

  test('an OPEN package PR is still adopted in place (the positive pole)', async () => {
    const fake = fakeGh({
      prsByHead: new Map([[PKG_CORE, { number: 55, state: 'open' }]]),
    });
    const result = await okReport(makeAssemblePrs(fake.gh), inputOf());
    expect(result.packages[0]).toEqual({ name: 'core', number: 55, created: false });
  });
});

// ---------------------------------------------------------------------------
// Cross-repository adoption refusal (final jNTyU)
// ---------------------------------------------------------------------------

describe('a FOREIGN fork PR is never adopted', () => {
  test('a cross-repository package PR → row fault naming the foreign head; sibling still assembles', async () => {
    const fake = fakeGh({
      prsByHead: new Map([[PKG_CORE, { number: 55, state: 'open', isCrossRepository: true }]]),
    });
    const result = await okReport(makeAssemblePrs(fake.gh), inputOf());
    expect(result.packages[0]).toMatchObject({ name: 'core', created: false });
    expect(result.packages[0]?.fault).toContain('FOREIGN fork (cross-repository)');
    expect(result.packages[0]?.fault).toContain('#55');
    expect(result.packages[0]?.number).toBeUndefined();
    expect(result.packages[1]).toMatchObject({ name: 'util', created: true });
  });

  test('a cross-repository TRACKER → whole-op failed before any package PR', async () => {
    const fake = fakeGh({
      prsByHead: new Map([[TRACKER_BRANCH, { number: 7, state: 'open', isCrossRepository: true }]]),
    });
    const error = await failedAt(makeAssemblePrs(fake.gh), inputOf());
    expect(error).toContain('FOREIGN fork');
    expect(error).toContain('#7');
    expect(fake.calls).toEqual([`search:${TRACKER_BRANCH}`]);
  });
});
