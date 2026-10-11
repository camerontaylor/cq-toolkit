// Slice 1 (goal T4.1) — tests for the self-hosting defaults
// (src/selfhost/config.ts).
//
// Pinned here:
//   1. IMMUTABILITY BY CONSTRUCTION: SelfhostDefaults is deep-frozen — a
//      root OR nested write throws (the deepFreeze contract: a mutation
//      must fail loudly, never silently poison the shared default).
//   2. The recorded VALUES: the I9 scheduled-run cap (maxTokens 2_000_000;
//      no USD default — the served model is unpriced), the merge
//      path's wall-clock ladder arming (perJobWallClockMs 300000 =
//      5 min/job, review-debt #137), and the SERVED model id
//      (ai-sdk/glm-5.3-flash — the conductor decision; anything else trips
//      the served-model-mismatch guard), plus the branch conventions
//      (merge-queue queue branch; main protected).
//   3. The PEAK-AWARE switch (owner directive 2026-10-12): the frozen
//      SelfhostPeak window (06:00–10:00 UTC Mon–Fri) + peak driver, the
//      pure isSelfhostPeak/resolveSelfhostDriver clock decision at every
//      boundary, and driverKeyEnv's provider → key-env map.
//   4. parseSelfhostArgs overrides are honored and never touch the frozen
//      defaults (parse returns fresh plain data).
import { describe, expect, test } from 'vitest';
import {
  driverKeyEnv,
  isSelfhostPeak,
  parseSelfhostArgs,
  resolveSelfhostDriver,
  SelfhostDefaults,
  SelfhostPeak,
} from '../../src/selfhost/config.js';

describe('SelfhostDefaults', () => {
  test('deep-frozen: a root write throws', () => {
    expect(Object.isFrozen(SelfhostDefaults)).toBe(true);
    expect(() => {
      SelfhostDefaults.maxTokens = 999;
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
    // I9 — the scheduled runs' honest-stop TOKEN cap. The served model is
    // unpriced, so a USD default would trip the governor's DD-9
    // unpriced-usage fail-loud; --max-usd stays an explicit opt-in.
    expect(SelfhostDefaults.maxTokens).toBe(2_000_000);
    expect('maxUsd' in SelfhostDefaults).toBe(false);
    // The governor wall-clock ladder on the merge dispatch paths (#137).
    expect(SelfhostDefaults.perJobWallClockMs).toBe(300_000);
    // The SERVED id per the recorded conductor decision — requesting any
    // other id is rejected by the served-model-mismatch guard. The provider
    // handle is the normalised 'zai' (the deprecated 'ai-sdk' alias stays
    // out of shipped config).
    expect(SelfhostDefaults.driver).toEqual({ provider: 'zai', model: 'glm-5.3-flash' });
    // The repo's own merge conventions.
    expect(SelfhostDefaults.baseBranch).toBe('merge-queue');
    expect(SelfhostDefaults.protectedBranch).toBe('main');
  });
});

describe('SelfhostPeak + the peak-aware driver resolution', () => {
  test('deep-frozen: the window and the peak driver cannot be re-pointed at runtime', () => {
    expect(Object.isFrozen(SelfhostPeak)).toBe(true);
    expect(Object.isFrozen(SelfhostPeak.window)).toBe(true);
    expect(Object.isFrozen(SelfhostPeak.driver)).toBe(true);
    expect(() => {
      SelfhostPeak.driver.model = 'glm-4.6';
    }).toThrow();
    expect(() => {
      (SelfhostPeak.window.utcWeekdays as unknown as number[]).push(6);
    }).toThrow();
  });

  test('the recorded values: weekday 06:00–10:00 UTC and the deepseek flash driver', () => {
    expect(SelfhostPeak.window).toEqual({
      utcWeekdays: [1, 2, 3, 4, 5],
      startMinute: 360,
      endMinute: 600,
    });
    // The SERVED id the DeepSeek endpoint echoes; requesting the
    // `deepseek-chat` alias is served AS `deepseek-flash` and would trip the
    // served-model identity guard.
    expect(SelfhostPeak.driver).toEqual({ provider: 'deepseek', model: 'deepseek-flash' });
    expect(SelfhostPeak.driver.model).not.toBe('deepseek-chat');
  });

  test('isSelfhostPeak: inclusive start, exclusive end, weekdays only (UTC)', () => {
    const at = (iso: string): number => Date.parse(iso);
    // 2026-10-12 is a Monday, 2026-10-16 a Friday, 17/18 the weekend.
    expect(isSelfhostPeak(at('2026-10-12T05:59:59Z'))).toBe(false);
    expect(isSelfhostPeak(at('2026-10-12T06:00:00Z'))).toBe(true);
    expect(isSelfhostPeak(at('2026-10-12T09:59:59Z'))).toBe(true);
    expect(isSelfhostPeak(at('2026-10-12T10:00:00Z'))).toBe(false);
    expect(isSelfhostPeak(at('2026-10-16T07:00:00Z'))).toBe(true);
    expect(isSelfhostPeak(at('2026-10-17T07:00:00Z'))).toBe(false);
    expect(isSelfhostPeak(at('2026-10-18T07:00:00Z'))).toBe(false);
  });

  test('resolveSelfhostDriver: peak switches provider, outside it the frozen default', () => {
    expect(resolveSelfhostDriver(Date.parse('2026-10-12T07:00:00Z'))).toEqual(SelfhostPeak.driver);
    expect(resolveSelfhostDriver(Date.parse('2026-10-12T12:00:00Z'))).toEqual(
      SelfhostDefaults.driver,
    );
    expect(resolveSelfhostDriver(Date.parse('2026-10-17T07:00:00Z'))).toEqual(
      SelfhostDefaults.driver,
    );
    // The entry tests' fixture clock (Tue 2023-11-14T22:13:20Z) is off-peak.
    expect(resolveSelfhostDriver(1_700_000_000_000)).toEqual(SelfhostDefaults.driver);
  });

  test('driverKeyEnv: each provider handle maps to the env the ai-sdk lane reads', () => {
    expect(driverKeyEnv({ provider: 'zai', model: 'glm-5.3-flash' })).toBe('ZAI_API_KEY');
    expect(driverKeyEnv({ provider: 'ai-sdk', model: 'glm-5.3-flash' })).toBe('ZAI_API_KEY');
    expect(driverKeyEnv({ provider: 'deepseek', model: 'deepseek-flash' })).toBe(
      'DEEPSEEK_API_KEY',
    );
    // An unknown provider cannot be credential-checked: the caller must read
    // undefined as "cannot vouch", never as "no key needed".
    expect(driverKeyEnv({ provider: 'mystery', model: 'x' })).toBeUndefined();
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
    expect(SelfhostDefaults.maxTokens).toBe(2_000_000);
  });
});
