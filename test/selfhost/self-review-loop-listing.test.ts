// Split from self-review-loop.test.ts (pure move); shared fixtures in ./self-review-loop-fakes.js.
import { afterEach, describe, expect, test } from 'vitest';
import { runSelfReviewLoop } from '../../src/selfhost/self-review-loop.js';
import {
  type RecordedCall,
  baseCfg,
  baseDeps,
  cleanupTempRoots,
  fakeGh,
  fakeLoop,
  fakeOutcome,
} from './self-review-loop-fakes.js';

afterEach(cleanupTempRoots);

describe('runSelfReviewLoop — listing failures', () => {
  test('a failing listing call throws (never a fabricated empty run)', async () => {
    const calls: RecordedCall[] = [];
    const gh = fakeGh([], { failListing: true });
    await expect(
      runSelfReviewLoop(
        baseDeps(
          gh,
          fakeLoop(calls, async (pr) => fakeOutcome(pr)),
        ),
        baseCfg(),
      ),
    ).rejects.toThrow(/injected listing failure/);
    expect(calls).toHaveLength(0);
  });
});
