// Effect-fault containment: a find or upsert rejection resolves to a
// failed or indeterminate verdict — no throw crosses the op seam.
import { match } from '../../helpers/matchers.js';
import { describe, expect, test } from 'vitest';
import { createProposeBaselineUpdate } from '../../../src/ops/ratchet/proposeBaselineUpdate.js';
import type { BaselinePrEffects } from '../../../src/ops/ratchet/proposeBaselineUpdate.js';
import { METRIC, proposeInput, seedBaseline, TARGET } from './proposeBaselineUpdate.helpers.js';

describe('proposeBaselineUpdate', () => {
  test('a findOpenPrByHead rejection is a failed verdict — no throw crosses the op seam', async () => {
    await seedBaseline(TARGET, METRIC, 10);
    const effects: BaselinePrEffects = {
      async closeOpenPrByHead() {},
      findOpenPrByHead: () => Promise.reject(new Error('gh api exploded')),
      commitAndUpsertPr: () => Promise.reject(new Error('unreachable')),
    };
    await expect(
      createProposeBaselineUpdate(effects)(
        proposeInput({ improvements: [{ target: TARGET, metric: METRIC, value: 7 }] }),
      ),
    ).resolves.toEqual({
      status: 'failed',
      error: match.stringMatching(/could not look up an open proposal PR.*gh api exploded/s),
    });
  });

  test('a commitAndUpsertPr rejection is indeterminate — the commit may or may not have landed', async () => {
    await seedBaseline(TARGET, METRIC, 10);
    const effects: BaselinePrEffects = {
      async closeOpenPrByHead() {},
      findOpenPrByHead: () => Promise.resolve(null),
      commitAndUpsertPr: () => Promise.reject('network dropped'), // non-Error rejection
    };
    await expect(
      createProposeBaselineUpdate(effects)(
        proposeInput({ improvements: [{ target: TARGET, metric: METRIC, value: 7 }] }),
      ),
    ).resolves.toEqual({
      status: 'indeterminate',
      detail: match.stringMatching(/may or may not have landed.*network dropped/s),
    });
  });
});
