// Split provenance: test/ops/ratchet/checkRatchet.test.ts was split into
// checkRatchet.helpers.ts (shared fixtures) and six subject files; this file
// carries the direction-matrix subject — tighten/equal/loosen in BOTH
// directions, driven by the real production adapters.
import { match } from '../../helpers/matchers.js';
import { describe, expect, test } from 'vitest';
import {
  check,
  checkInput,
  DIRECTIONS,
  plantBaseline,
  rawFor,
  raws,
  relFor,
} from './checkRatchet.helpers.js';

describe('checkRatchet', () => {
  test.each(DIRECTIONS)(
    'tighten passes ($label): the value improves on the baseline',
    async (dir) => {
      await plantBaseline(dir, dir.baseline);
      raws[dir.metric] = rawFor(dir, dir.tighten);
      await expect(
        check(checkInput({ metric: dir.metric, sourceId: dir.metric })),
      ).resolves.toEqual({
        status: 'ok',
        value: {
          path: relFor(dir),
          verdict: 'pass',
          baselineValue: dir.baseline,
          currentValue: dir.tighten,
        },
      });
    },
  );

  test.each(DIRECTIONS)('equal passes ($label): an unchanged metric never blocks', async (dir) => {
    await plantBaseline(dir, dir.baseline);
    raws[dir.metric] = rawFor(dir, dir.baseline);
    // toEqual with no `reason` key pins its absence: a pass carries no
    // excuse, and undefined extras are ignored by toEqual while a string
    // reason would fail the match.
    await expect(check(checkInput({ metric: dir.metric, sourceId: dir.metric }))).resolves.toEqual({
      status: 'ok',
      value: {
        path: relFor(dir),
        verdict: 'pass',
        baselineValue: dir.baseline,
        currentValue: dir.baseline,
      },
    });
  });

  test.each(DIRECTIONS)(
    'loosen fails ($label) with expected vs actual in the reason',
    async (dir) => {
      await plantBaseline(dir, dir.baseline);
      raws[dir.metric] = rawFor(dir, dir.loosen);
      await expect(
        check(checkInput({ metric: dir.metric, sourceId: dir.metric })),
      ).resolves.toEqual({
        status: 'ok',
        value: {
          path: relFor(dir),
          verdict: 'fail',
          baselineValue: dir.baseline,
          currentValue: dir.loosen,
          reason: match.stringMatching(
            new RegExp(
              `metric '${dir.metric}' loosened: baseline ${dir.baseline} → ` +
                `current ${dir.loosen} \\(${dir.label}\\) — only tightening passes`,
            ),
          ),
        },
      });
    },
  );
});
