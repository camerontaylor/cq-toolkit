// Slice 1 (goal T4.1) — tests for the self-hosting defaults
// (src/selfhost/config.ts).
//
// Pinned here:
//   1. IMMUTABILITY BY CONSTRUCTION: SelfhostDefaults is deep-frozen — a
//      root OR nested write throws (the deepFreeze contract: a mutation
//      must fail loudly, never silently poison the shared default).
//   2. The recorded VALUES: the I9 scheduled-run cap (maxUsd 1), the merge
//      path's wall-clock ladder arming (perJobWallClockMs 300000 =
//      5 min/job, review-debt #137), and the SERVED model id
//      (ai-sdk/glm-5.3-flash — the conductor decision; anything else trips
//      the served-model-mismatch guard), plus the branch conventions
//      (merge-queue queue branch; main protected).
//   3. parseSelfhostArgs overrides are honored and never touch the frozen
//      defaults (parse returns fresh plain data).
import { describe, expect, test } from 'vitest';
import { parseSelfhostArgs, SelfhostDefaults } from '../../src/selfhost/config.js';

describe('SelfhostDefaults', () => {
  test('deep-frozen: a root write throws', () => {
    expect(Object.isFrozen(SelfhostDefaults)).toBe(true);
    expect(() => {
      SelfhostDefaults.maxUsd = 999;
    }).toThrow();
  });

  test('deep-frozen: a nested write throws (the deepFreeze contract reaches the leaves)', () => {
    expect(Object.isFrozen(SelfhostDefaults.driver)).toBe(true);
    expect(() => {
      SelfhostDefaults.driver.model = 'glm-4.6';
    }).toThrow();
    expect(() => {
      (SelfhostDefaults.driver as unknown as Record<string, unknown>).injected = true;
    }).toThrow();
  });

  test('the recorded values: I9 cap, wall-clock ladder, served model id, branches', () => {
    // I9 — the scheduled runs' honest-stop USD cap (the --max-usd default).
    expect(SelfhostDefaults.maxUsd).toBe(1);
    // The governor wall-clock ladder on the merge dispatch paths (#137).
    expect(SelfhostDefaults.perJobWallClockMs).toBe(300_000);
    // The SERVED id per the recorded conductor decision — requesting any
    // other id is rejected by the served-model-mismatch guard.
    expect(SelfhostDefaults.driver).toEqual({ provider: 'ai-sdk', model: 'glm-5.3-flash' });
    // The repo's own merge conventions.
    expect(SelfhostDefaults.baseBranch).toBe('merge-queue');
    expect(SelfhostDefaults.protectedBranch).toBe('main');
  });
});

describe('parseSelfhostArgs overrides', () => {
  test('overrides are honored and defaults remain absent-but-declared', () => {
    const parsed = parseSelfhostArgs([
      '--max-usd',
      '0.5',
      '--journal-root',
      '/var/cq/j',
      '--dry-run',
    ]);
    expect(parsed.maxUsd).toBe(0.5);
    expect(parsed.journalRoot).toBe('/var/cq/j');
    expect(parsed.dryRun).toBe(true);

    const untouched = parseSelfhostArgs([]);
    expect(untouched.maxUsd).toBeUndefined();
    expect(untouched.journalRoot).toBeUndefined();
    expect(untouched.dryRun).toBe(false);
  });

  test('parsing never mutates the frozen defaults', () => {
    parseSelfhostArgs(['--max-usd', '2']);
    expect(SelfhostDefaults.maxUsd).toBe(1);
  });
});
