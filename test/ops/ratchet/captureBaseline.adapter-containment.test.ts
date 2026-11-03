// Split provenance: test/ops/ratchet/captureBaseline.test.ts was split into
// captureBaseline.{lifecycle,source-failures,adapter-containment,captured-at,publish,identity,symlink-containment,concurrency,prune}.test.ts
// plus captureBaseline.helpers.ts (shared fixtures and the original header).
import { match } from '../../helpers/matchers.js';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createCaptureBaseline } from '../../../src/ops/ratchet/captureBaseline.js';
import type { CaptureBaselineInput } from '../../../src/ops/ratchet/captureBaseline.js';
import {
  THROWING_METRIC,
  OBJECT_THROWING_METRIC,
  CRAFTED_INFINITE_METRIC,
  NULL_UNIT_METRIC,
  BAD_DIRECTION_METRIC,
  BIGINT_UNIT_METRIC,
  UNDEFINED_READING_METRIC,
  THROWING_VALUE_GETTER_METRIC,
  THROWING_DIRECTION_GETTER_METRIC,
  THROWING_MESSAGE_GETTER_METRIC,
  THROWING_UNIT_GETTER_METRIC,
  registerCaptureAdapters,
  createSourceCatalog,
  captureInputFor,
} from './captureBaseline.helpers.js';

let ws: string;

beforeAll(() => {
  registerCaptureAdapters();
});

const capture = createCaptureBaseline(createSourceCatalog(() => undefined));

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'cq-capture-'));
});

afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

function captureInput(overrides: Partial<CaptureBaselineInput> = {}): CaptureBaselineInput {
  return captureInputFor(ws, overrides);
}

describe('captureBaseline', () => {
  test('a THROWING direction getter fails the capture inside the snapshot containment (review-debt #72)', async () => {
    await expect(
      capture(
        captureInput({
          metric: THROWING_DIRECTION_GETTER_METRIC,
          sourceId: THROWING_DIRECTION_GETTER_METRIC,
        }),
      ),
    ).resolves.toEqual({
      status: 'failed',
      error: match.stringMatching(
        /metric 'throwing-direction-getter' adapter produced an unusable reading.*direction getter exploded/s,
      ),
    });
    await expect(stat(join(ws, 'baselines'))).rejects.toThrow();
  });

  test('a thrown value whose MESSAGE getter throws maps to unknown error (review-debt #72)', async () => {
    await expect(
      capture(
        captureInput({
          metric: THROWING_MESSAGE_GETTER_METRIC,
          sourceId: THROWING_MESSAGE_GETTER_METRIC,
        }),
      ),
    ).resolves.toEqual({
      status: 'failed',
      error: match.stringMatching(
        /metric 'throwing-message-getter' adapter failed.*unknown error/s,
      ),
    });
    await expect(stat(join(ws, 'baselines'))).rejects.toThrow();
  });

  test('a throwing adapter fails the capture; no throw crosses the op seam', async () => {
    await expect(
      capture(captureInput({ metric: THROWING_METRIC, sourceId: THROWING_METRIC })),
    ).resolves.toEqual({
      status: 'failed',
      error: match.stringMatching(/metric 'throwing-adapter' adapter failed.*exploded/s),
    });
    await expect(stat(join(ws, 'baselines'))).rejects.toThrow();
  });

  test('a type-violating adapter returning undefined fails as no-summary (no throw)', async () => {
    await expect(
      capture(
        captureInput({ metric: UNDEFINED_READING_METRIC, sourceId: UNDEFINED_READING_METRIC }),
      ),
    ).resolves.toEqual({
      status: 'failed',
      error: match.stringMatching(
        /metric 'undefined-reading' has no metrics summary.*never a pass/s,
      ),
    });
    // The failure fabricated no evidence — nothing was written.
    await expect(stat(join(ws, 'baselines'))).rejects.toThrow();
  });

  test('a throwing value getter fails as an unusable reading (no rejection, no file)', async () => {
    await expect(
      capture(
        captureInput({
          metric: THROWING_VALUE_GETTER_METRIC,
          sourceId: THROWING_VALUE_GETTER_METRIC,
        }),
      ),
    ).resolves.toEqual({
      status: 'failed',
      error: match.stringMatching(
        /metric 'throwing-value-getter' adapter produced an unusable reading.*value getter exploded/s,
      ),
    });
    await expect(stat(join(ws, 'baselines'))).rejects.toThrow();
  });

  test('a throwing unit getter fails as an unusable reading (no rejection, no file)', async () => {
    await expect(
      capture(
        captureInput({
          metric: THROWING_UNIT_GETTER_METRIC,
          sourceId: THROWING_UNIT_GETTER_METRIC,
        }),
      ),
    ).resolves.toEqual({
      status: 'failed',
      error: match.stringMatching(
        /metric 'throwing-unit-getter' adapter produced an unusable reading.*unit getter exploded/s,
      ),
    });
    await expect(stat(join(ws, 'baselines'))).rejects.toThrow();
  });

  test('an adapter throwing a plain object fails with its message, not a TypeError', async () => {
    await expect(
      capture(captureInput({ metric: OBJECT_THROWING_METRIC, sourceId: OBJECT_THROWING_METRIC })),
    ).resolves.toEqual({
      status: 'failed',
      error: match.stringMatching(/adapter failed.*plain boom/s),
    });
  });

  test('a non-finite reading fails at the write path and writes nothing', async () => {
    await expect(
      capture(captureInput({ metric: CRAFTED_INFINITE_METRIC, sourceId: CRAFTED_INFINITE_METRIC })),
    ).resolves.toEqual({
      status: 'failed',
      error: match.stringMatching(/metric 'crafted-infinite'.*unusable reading/s),
    });
    await expect(stat(join(ws, 'baselines'))).rejects.toThrow();
  });

  test('a probe adapter returning unit null fails the publish self-check (no file)', async () => {
    await expect(
      capture(captureInput({ metric: NULL_UNIT_METRIC, sourceId: NULL_UNIT_METRIC })),
    ).resolves.toEqual({
      status: 'failed',
      error: match.stringMatching(
        /metric 'null-unit' produced an unparsable baseline — refusing to publish.*unit/s,
      ),
    });
    await expect(stat(join(ws, 'baselines'))).rejects.toThrow();
  });

  test('a probe adapter with a bogus direction fails at the snapshot boundary (no file)', async () => {
    // review-debt #72: the direction is materialized with the reading
    // snapshot and validated against the two literals THERE — earlier and
    // clearer than the old render/parse-back self-check, and a throwing
    // direction getter can no longer escape the op seam either.
    await expect(
      capture(captureInput({ metric: BAD_DIRECTION_METRIC, sourceId: BAD_DIRECTION_METRIC })),
    ).resolves.toEqual({
      status: 'failed',
      error: match.stringMatching(
        /metric 'bad-direction' adapter produced an unusable direction \(sideways\) — baseline not captured/s,
      ),
    });
    await expect(stat(join(ws, 'baselines'))).rejects.toThrow();
  });

  test('a probe adapter returning a BigInt unit fails the render containment (no throw, no file)', async () => {
    await expect(
      capture(captureInput({ metric: BIGINT_UNIT_METRIC, sourceId: BIGINT_UNIT_METRIC })),
    ).resolves.toEqual({
      status: 'failed',
      error: match.stringMatching(
        /metric 'bigint-unit' produced an unparsable baseline — refusing to publish/s,
      ),
    });
    await expect(stat(join(ws, 'baselines'))).rejects.toThrow();
  });
});
