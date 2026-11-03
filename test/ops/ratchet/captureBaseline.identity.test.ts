// Split provenance: test/ops/ratchet/captureBaseline.test.ts was split into
// captureBaseline.{lifecycle,source-failures,adapter-containment,captured-at,publish,identity,symlink-containment,concurrency,prune}.test.ts
// plus captureBaseline.helpers.ts (shared fixtures and the original header).
import { match } from '../../helpers/matchers.js';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createCaptureBaseline } from '../../../src/ops/ratchet/captureBaseline.js';
import type { CaptureBaselineInput } from '../../../src/ops/ratchet/captureBaseline.js';
import { baselineRelPath, parseBaseline, renderBaseline } from '../../../src/ops/ratchet/format.js';
import type { BaselineFile } from '../../../src/ops/ratchet/format.js';
import {
  CAPTURED_AT,
  TARGET,
  METRIC,
  UNIT_SHIFTING_METRIC,
  REL,
  registerCaptureAdapters,
  createSourceCatalog,
  captureInputFor,
} from './captureBaseline.helpers.js';

let ws: string;
// The raw data the catalog's sources hand to the adapters; set per test.
let sourceRaw: unknown;

beforeAll(() => {
  registerCaptureAdapters();
});

const capture = createCaptureBaseline(createSourceCatalog(() => sourceRaw));

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'cq-capture-'));
  sourceRaw = undefined;
});

afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

function captureInput(overrides: Partial<CaptureBaselineInput> = {}): CaptureBaselineInput {
  return captureInputFor(ws, overrides);
}

describe('captureBaseline', () => {
  test('a valid baseline for ANOTHER target at the expected path fails the identity check, untouched', async () => {
    // Mistaken move: a fully valid baseline whose (target, metric, direction)
    // identity disagrees with this capture sits at the expected path.
    const foreign: BaselineFile = {
      schemaVersion: 1,
      target: 'elsewhere',
      metric: METRIC,
      direction: 'lower-is-better',
      value: 9,
      capturedAt: CAPTURED_AT,
    };
    await mkdir(join(ws, 'baselines'), { recursive: true });
    const foreignBytes = renderBaseline(foreign);
    await writeFile(join(ws, REL), foreignBytes, 'utf8');
    sourceRaw = { count: 3 };
    await expect(capture(captureInput())).resolves.toEqual({
      status: 'failed',
      // The foreign baseline differs in target AND unit (it carries none) —
      // the message lists every disagreeing field.
      error: match.stringMatching(
        /disagrees on target 'elsewhere' → 'typecheck'; unit undefined → 'errors' — incomparable scale — refusing to overwrite/s,
      ),
    });
    expect(await readFile(join(ws, REL), 'utf8')).toBe(foreignBytes);
  });

  test('a unit change fails the identity check as incomparable scale, untouched', async () => {
    const input = captureInput({
      target: 'unit-a',
      metric: UNIT_SHIFTING_METRIC,
      sourceId: UNIT_SHIFTING_METRIC,
    });
    sourceRaw = { count: 3, unit: 'errors' };
    await expect(capture(input)).resolves.toMatchObject({ status: 'ok' });
    sourceRaw = { count: 5 }; // reading now carries NO unit
    await expect(capture(input)).resolves.toEqual({
      status: 'failed',
      error: match.stringMatching(
        /for metric 'unit-shifting' disagrees on unit 'errors' → undefined — incomparable scale — refusing to overwrite/,
      ),
    });
    expect(
      parseBaseline(
        await readFile(join(ws, baselineRelPath('unit-a', UNIT_SHIFTING_METRIC)), 'utf8'),
      ).unit,
    ).toBe('errors');
  });

  test('the unit mismatch is symmetric (none → defined also fails)', async () => {
    const input = captureInput({
      target: 'unit-b',
      metric: UNIT_SHIFTING_METRIC,
      sourceId: UNIT_SHIFTING_METRIC,
    });
    sourceRaw = { count: 3 }; // no unit
    await expect(capture(input)).resolves.toMatchObject({ status: 'ok' });
    sourceRaw = { count: 5, unit: 'errors' };
    await expect(capture(input)).resolves.toEqual({
      status: 'failed',
      error: match.stringMatching(/disagrees on unit undefined → 'errors' — incomparable scale/),
    });
  });

  test('a unit rename (errors → failures) fails the identity check', async () => {
    const input = captureInput({
      target: 'unit-c',
      metric: UNIT_SHIFTING_METRIC,
      sourceId: UNIT_SHIFTING_METRIC,
    });
    sourceRaw = { count: 3, unit: 'errors' };
    await expect(capture(input)).resolves.toMatchObject({ status: 'ok' });
    sourceRaw = { count: 3, unit: 'failures' };
    await expect(capture(input)).resolves.toEqual({
      status: 'failed',
      error: match.stringMatching(/disagrees on unit 'errors' → 'failures' — incomparable scale/),
    });
  });

  test('a metric-field disagreement fails the identity check, untouched', async () => {
    // Planted at the expected path: a fully valid baseline whose metric
    // field names some other metric.
    const foreign = renderBaseline({
      schemaVersion: 1,
      target: TARGET,
      metric: 'other-metric',
      direction: 'lower-is-better',
      value: 4,
      unit: 'errors',
      capturedAt: CAPTURED_AT,
    });
    await mkdir(join(ws, 'baselines'), { recursive: true });
    await writeFile(join(ws, REL), foreign, 'utf8');
    sourceRaw = { count: 3 };
    await expect(capture(captureInput())).resolves.toEqual({
      status: 'failed',
      error: match.stringMatching(
        /disagrees on metric 'other-metric' → 'typecheck-count' — incomparable scale/,
      ),
    });
    expect(await readFile(join(ws, REL), 'utf8')).toBe(foreign);
  });

  test('a direction disagreement fails the identity check, untouched', async () => {
    // Adapter direction flipped vs the existing baseline: same target,
    // metric, and unit — only the direction disagrees.
    const flipped = renderBaseline({
      schemaVersion: 1,
      target: TARGET,
      metric: METRIC,
      direction: 'higher-is-better',
      value: 4,
      unit: 'errors',
      capturedAt: CAPTURED_AT,
    });
    await mkdir(join(ws, 'baselines'), { recursive: true });
    await writeFile(join(ws, REL), flipped, 'utf8');
    sourceRaw = { count: 3 };
    await expect(capture(captureInput())).resolves.toEqual({
      status: 'failed',
      error: match.stringMatching(
        /disagrees on direction 'higher-is-better' → 'lower-is-better' — incomparable scale/,
      ),
    });
    expect(await readFile(join(ws, REL), 'utf8')).toBe(flipped);
  });
});
