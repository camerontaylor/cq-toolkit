// Baselines leaf and dir filesystem safety: non-regular leaves
// (including symlinks), the missing baselines dir, and containment of
// the baselines dir inside the workspace.
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
  test('a non-regular baseline leaf is skipped (mirror of checkRatchet); remaining improvements still propose', async () => {
    const goodRel = await seedBaseline('other-target', METRIC, 9);
    // A DIRECTORY squatting at the expected baseline path: lstat sees it
    // before any read — not a regular file, so it is refused as evidence.
    await mkdir(join(ws, REL), { recursive: true });
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
            reason: match.stringMatching(/is not a regular file — refusing to read as evidence/),
          },
        ],
      },
    });
  });

  test('a MISSING baselines dir skips every improvement with the I5 wording (containment.missing all-skip — review-debt #87)', async () => {
    // The ordinary no-baseline-yet ws: the dir was never created. Every
    // judged improvement skips with the no-usable-baseline reason, the
    // proposal is 'none', and no effects are ever consulted.
    const effects = makeFakeEffects();
    await expect(
      createProposeBaselineUpdate(effects)(
        proposeInput({
          improvements: [
            { target: TARGET, metric: METRIC, value: 7 },
            { target: 'other-target', metric: METRIC, value: 5 },
          ],
        }),
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
              /not found — no usable baseline — refusing to propose from nothing \(I5\)/,
            ),
          },
          {
            target: 'other-target',
            metric: METRIC,
            reason: match.stringMatching(
              /not found — no usable baseline — refusing to propose from nothing \(I5\)/,
            ),
          },
        ],
      },
    });
    expect(effects.findCalls()).toBe(0);
    expect(effects.upsertCalls()).toBe(0);
  });

  test('a SYMLINK at the baseline leaf is skipped as non-regular even though its target parses (review-debt #87)', async () => {
    // The leaf-symlink variant of the non-regular pin: the link points at a
    // REAL, PARSEABLE baseline file elsewhere — lstat (not stat) sees the
    // link itself, and evidence through a replaceable leaf is refused even
    // when the bytes would have parsed.
    const outside = await mkdtemp(join(tmpdir(), 'cq-outside-'));
    try {
      const real = join(outside, 'real-baseline.json');
      await writeFile(
        real,
        renderBaseline({
          schemaVersion: 1,
          target: TARGET,
          metric: METRIC,
          direction: 'lower-is-better',
          value: 9,
          unit: 'errors',
          capturedAt: BASELINE_CAPTURED_AT,
        }),
        'utf8',
      );
      await mkdir(join(ws, 'baselines'), { recursive: true });
      await symlink(real, join(ws, REL));
      const effects = makeFakeEffects();
      const result = await createProposeBaselineUpdate(effects)(
        proposeInput({ improvements: [{ target: TARGET, metric: METRIC, value: 7 }] }),
      );
      expect(result).toMatchObject({
        status: 'ok',
        value: {
          proposal: 'none',
          applied: [],
          skipped: [
            {
              target: TARGET,
              metric: METRIC,
              reason: match.stringMatching(/is not a regular file — refusing to read as evidence/),
            },
          ],
        },
      });
      expect(effects.upsertCalls()).toBe(0);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test('a baselines dir escaping the ws skips EVERY improvement and calls no effects', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'cq-outside-'));
    try {
      await symlink(outside, join(ws, 'baselines'), 'dir');
      const effects = makeFakeEffects();
      await expect(
        createProposeBaselineUpdate(effects)(
          proposeInput({
            improvements: [
              { target: TARGET, metric: METRIC, value: 7 },
              { target: 'other-target', metric: METRIC, value: 5 },
            ],
          }),
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
                /does not resolve to a strict descendant of the workspace/,
              ),
            },
            {
              target: 'other-target',
              metric: METRIC,
              reason: match.stringMatching(
                /does not resolve to a strict descendant of the workspace/,
              ),
            },
          ],
        },
      });
      expect(effects.findCalls()).toBe(0);
      expect(effects.upsertCalls()).toBe(0);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
