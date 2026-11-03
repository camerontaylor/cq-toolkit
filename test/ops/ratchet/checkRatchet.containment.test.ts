// Split provenance: test/ops/ratchet/checkRatchet.test.ts was split into
// checkRatchet.helpers.ts (shared fixtures) and six subject files; this file
// carries the containment subject — throwing sources, adapters and
// adapter-owned getters, plus the baselines-dir escape refusal.
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { match } from '../../helpers/matchers.js';
import { describe, expect, test } from 'vitest';
import { baselineRelPath } from '../../../src/ops/ratchet/format.js';
import {
  check,
  checkInput,
  DIRECTIONS,
  METRIC,
  plantBaseline,
  raws,
  REL,
  TARGET,
  THROWING_DIRECTION_GETTER_METRIC,
  THROWING_MESSAGE_GETTER_METRIC,
  THROWING_METRIC,
  THROWING_VALUE_GETTER_METRIC,
  ws,
} from './checkRatchet.helpers.js';

describe('checkRatchet', () => {
  test.each([
    ['an Error rejection', 'exploding-source', /source failed.*boom/s],
    ['a null rejection', 'rejecting-null', /source failed.*unknown error/s],
    ['a string rejection', 'rejecting-string', /source failed.*boom-string/s],
  ])(
    'a throwing source (%s) is contained: fail with the mapped message, no throw crosses the seam',
    async (_kind, sourceId, pattern) => {
      await plantBaseline(DIRECTIONS[0], 3);
      await expect(check(checkInput({ sourceId }))).resolves.toEqual({
        status: 'ok',
        value: {
          path: REL,
          verdict: 'fail',
          baselineValue: null,
          currentValue: null,
          reason: match.stringMatching(pattern),
        },
      });
    },
  );

  test('a THROWING direction getter is contained by the snapshot (review-debt #72): fail, never a throw', async () => {
    // `direction` was read AFTER the guarded value/unit snapshot — at the
    // identity check, the comparison, and the fail reason — so a hostile
    // getter escaped the op seam. The snapshot now materializes it inside
    // the same containment.
    await expect(
      check(
        checkInput({
          metric: THROWING_DIRECTION_GETTER_METRIC,
          sourceId: THROWING_DIRECTION_GETTER_METRIC,
        }),
      ),
    ).resolves.toEqual({
      status: 'ok',
      value: {
        path: baselineRelPath(TARGET, THROWING_DIRECTION_GETTER_METRIC),
        verdict: 'fail',
        baselineValue: null,
        currentValue: null,
        reason: match.stringMatching(
          /metric 'throwing-direction-getter' adapter produced an unusable reading.*direction getter exploded/s,
        ),
      },
    });
  });

  test('a thrown value whose MESSAGE getter throws is contained (review-debt #72): unknown error, never a second throw', async () => {
    await expect(
      check(
        checkInput({
          metric: THROWING_MESSAGE_GETTER_METRIC,
          sourceId: THROWING_MESSAGE_GETTER_METRIC,
        }),
      ),
    ).resolves.toEqual({
      status: 'ok',
      value: {
        path: baselineRelPath(TARGET, THROWING_MESSAGE_GETTER_METRIC),
        verdict: 'fail',
        baselineValue: null,
        currentValue: null,
        reason: match.stringMatching(
          /metric 'throwing-message-getter' adapter failed.*unknown error/s,
        ),
      },
    });
  });

  test('a throwing adapter is contained: fail with the mapped message', async () => {
    await expect(
      check(checkInput({ metric: THROWING_METRIC, sourceId: THROWING_METRIC })),
    ).resolves.toEqual({
      status: 'ok',
      value: {
        path: baselineRelPath(TARGET, THROWING_METRIC),
        verdict: 'fail',
        baselineValue: null,
        currentValue: null,
        reason: match.stringMatching(/metric 'throwing-adapter' adapter failed.*exploded/s),
      },
    });
  });

  test('a throwing reading-getter is contained: fail as an unusable reading (no rejection)', async () => {
    await expect(
      check(
        checkInput({
          metric: THROWING_VALUE_GETTER_METRIC,
          sourceId: THROWING_VALUE_GETTER_METRIC,
        }),
      ),
    ).resolves.toEqual({
      status: 'ok',
      value: {
        path: baselineRelPath(TARGET, THROWING_VALUE_GETTER_METRIC),
        verdict: 'fail',
        baselineValue: null,
        currentValue: null,
        reason: match.stringMatching(
          /metric 'throwing-value-getter' adapter produced an unusable reading.*value getter exploded/s,
        ),
      },
    });
  });

  test('a baselines dir symlinked outside the ws fails (P1 containment on reads too)', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'cq-check-outside-'));
    try {
      await symlink(outside, join(ws, 'baselines'), 'dir');
      raws[METRIC] = { count: 2 };
      await expect(check(checkInput())).resolves.toEqual({
        status: 'ok',
        value: {
          path: REL,
          verdict: 'fail',
          baselineValue: null,
          currentValue: null,
          reason: match.stringMatching(/does not resolve to a strict descendant of the workspace/),
        },
      });
      // Nothing outside was read as evidence and nothing was written there.
      await expect(readFile(join(outside, 'anything.json'), 'utf8')).rejects.toThrow();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
