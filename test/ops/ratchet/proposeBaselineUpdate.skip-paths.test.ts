// The skip paths (I5 — never fabricate): not-a-tightening, no usable
// baseline (missing, corrupt, non-regular), and identity disagreement
// — each skipped with a reason while remaining usable improvements
// still propose.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { match } from '../../helpers/matchers.js';
import { describe, expect, test } from 'vitest';
import { renderBaseline } from '../../../src/ops/ratchet/format.js';
import { createProposeBaselineUpdate } from '../../../src/ops/ratchet/proposeBaselineUpdate.js';
import {
  BASELINE_CAPTURED_AT,
  makeFakeEffects,
  METRIC,
  proposeInput,
  REL,
  seedBaseline,
  TARGET,
  ws,
} from './proposeBaselineUpdate.helpers.js';

describe('proposeBaselineUpdate', () => {
  test('looser or equal improvements propose NOTHING and never call the effects seam', async () => {
    await seedBaseline(TARGET, METRIC, 10);
    for (const value of [12, 10]) {
      // looser (12) and equal (10) are each judged on their own run.
      const effects = makeFakeEffects();
      await expect(
        createProposeBaselineUpdate(effects)(
          proposeInput({ improvements: [{ target: TARGET, metric: METRIC, value }] }),
        ),
      ).resolves.toEqual({
        status: 'ok',
        value: {
          proposal: 'none',
          prNumber: null,
          prUrl: null,
          head: null,
          applied: [],
          skipped: [
            {
              target: TARGET,
              metric: METRIC,
              reason: match.stringMatching(
                new RegExp(`10 → ${value} is not a tightening \\(lower-is-better\\)`),
              ),
            },
          ],
        },
      });
      expect(effects.findCalls()).toBe(0);
      expect(effects.upsertCalls()).toBe(0);
    }
  });

  test('the tighten direction comes from the COMMITTED baseline, not the caller', async () => {
    // higher-is-better baseline: 5 → 10 tightens, 10 → 5 loosens.
    await seedBaseline(TARGET, METRIC, 5, 'higher-is-better');
    const effects = makeFakeEffects();
    const propose = createProposeBaselineUpdate(effects);
    await expect(
      propose(proposeInput({ improvements: [{ target: TARGET, metric: METRIC, value: 10 }] })),
    ).resolves.toMatchObject({
      status: 'ok',
      value: { proposal: 'created', applied: [{ oldValue: 5, newValue: 10 }] },
    });
    const content = effects.prs.values().next().value?.files[0]?.content ?? '';
    expect((JSON.parse(content) as { direction?: string }).direction).toBe('higher-is-better');
    const effects2 = makeFakeEffects();
    await expect(
      createProposeBaselineUpdate(effects2)(
        proposeInput({ improvements: [{ target: TARGET, metric: METRIC, value: 3 }] }),
      ),
    ).resolves.toMatchObject({
      status: 'ok',
      value: {
        proposal: 'none',
        skipped: [match.objectContaining({ reason: match.stringMatching(/not a tightening/) })],
      },
    });
    expect(effects2.findCalls()).toBe(0);
  });

  test('a missing baseline skips with the I5 wording while a remaining improvement still proposes', async () => {
    const goodRel = await seedBaseline('other-target', METRIC, 9);
    const effects = makeFakeEffects();
    const propose = createProposeBaselineUpdate(effects);
    const result = await propose(
      proposeInput({
        improvements: [
          { target: TARGET, metric: METRIC, value: 7 }, // no baseline seeded
          { target: 'other-target', metric: METRIC, value: 5 },
        ],
      }),
    );
    expect(result).toMatchObject({
      status: 'ok',
      value: {
        proposal: 'created',
        applied: [{ path: goodRel, oldValue: 9, newValue: 5 }],
        skipped: [
          {
            target: TARGET,
            metric: METRIC,
            reason: match.stringMatching(
              /no usable baseline — refusing to propose from nothing \(I5\)/,
            ),
          },
        ],
      },
    });
    expect(effects.prs.size).toBe(1);
  });

  test('a corrupt baseline skips with the I5 wording, untouched, remaining improvements still propose', async () => {
    const goodRel = await seedBaseline('other-target', METRIC, 9);
    await mkdir(join(ws, 'baselines'), { recursive: true });
    const corrupt = '{"schemaVersion": 999}\n';
    await writeFile(join(ws, REL), corrupt, 'utf8');
    const effects = makeFakeEffects();
    const result = await createProposeBaselineUpdate(effects)(
      proposeInput({
        improvements: [
          { target: TARGET, metric: METRIC, value: 7 },
          { target: 'other-target', metric: METRIC, value: 5 },
        ],
      }),
    );
    expect(result).toMatchObject({
      status: 'ok',
      value: {
        proposal: 'created',
        applied: [{ path: goodRel }],
        skipped: [
          {
            target: TARGET,
            metric: METRIC,
            reason: match.stringMatching(
              /is corrupt — no usable baseline — refusing to propose from nothing \(I5\)/,
            ),
          },
        ],
      },
    });
    expect(await readFile(join(ws, REL), 'utf8')).toBe(corrupt);
  });

  test('a baseline whose identity disagrees with the improvement is skipped (incomparable evidence)', async () => {
    await mkdir(join(ws, 'baselines'), { recursive: true });
    // A valid baseline for ANOTHER target sitting at the expected path.
    await writeFile(
      join(ws, REL),
      renderBaseline({
        schemaVersion: 1,
        target: 'elsewhere',
        metric: METRIC,
        direction: 'lower-is-better',
        value: 4,
        capturedAt: BASELINE_CAPTURED_AT,
      }),
      'utf8',
    );
    const effects = makeFakeEffects();
    await expect(
      createProposeBaselineUpdate(effects)(
        proposeInput({ improvements: [{ target: TARGET, metric: METRIC, value: 3 }] }),
      ),
    ).resolves.toMatchObject({
      status: 'ok',
      value: {
        proposal: 'none',
        skipped: [
          {
            target: TARGET,
            metric: METRIC,
            reason: match.stringMatching(/disagrees on target 'elsewhere' → 'typecheck'/),
          },
        ],
      },
    });
    expect(effects.findCalls()).toBe(0);
  });
});
