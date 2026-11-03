// Split provenance: test/ops/ratchet/captureBaseline.test.ts was split into
// captureBaseline.{lifecycle,source-failures,adapter-containment,captured-at,publish,identity,symlink-containment,concurrency,prune}.test.ts
// plus captureBaseline.helpers.ts (shared fixtures and the original header).
import { match } from '../../helpers/matchers.js';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createCaptureBaseline } from '../../../src/ops/ratchet/captureBaseline.js';
import type { CaptureBaselineInput } from '../../../src/ops/ratchet/captureBaseline.js';
import {
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
  test('unknown metric fails with an arg-style error', async () => {
    await expect(capture(captureInput({ metric: 'no-such-metric' }))).resolves.toEqual({
      status: 'failed',
      error: match.stringMatching(/unknown metric 'no-such-metric'/),
    });
  });

  test('unknown sourceId fails naming the source', async () => {
    await expect(capture(captureInput({ sourceId: 'no-such-source' }))).resolves.toEqual({
      status: 'failed',
      error: match.stringMatching(/unknown source 'no-such-source' for metric 'typecheck-count'/),
    });
  });

  test('null source fails naming the metric and "no metrics summary" — and fabricates no evidence', async () => {
    sourceRaw = null;
    await expect(capture(captureInput())).resolves.toEqual({
      status: 'failed',
      error: match.stringMatching(/metric 'typecheck-count'.*no metrics summary/s),
    });
    // I5 evidence pin: a failed capture must not even create the baselines dir.
    await expect(stat(join(ws, 'baselines'))).rejects.toThrow();
  });

  test('a failed capture leaves a pre-existing baseline byte-for-byte intact (I5)', async () => {
    sourceRaw = { count: 3 };
    await capture(captureInput());
    const before = await readFile(join(ws, REL), 'utf8');
    sourceRaw = null;
    await expect(capture(captureInput())).resolves.toMatchObject({ status: 'failed' });
    expect(await readFile(join(ws, REL), 'utf8')).toBe(before);
  });

  test('unusable raw fails with the same no-summary failure and writes nothing', async () => {
    sourceRaw = 'definitely not a compiler log';
    await expect(capture(captureInput())).resolves.toEqual({
      status: 'failed',
      error: match.stringMatching(/no metrics summary/s),
    });
    await expect(readFile(join(ws, REL), 'utf8')).rejects.toThrow();
  });

  test('a throwing source fails instead of crashing the op', async () => {
    await expect(capture(captureInput({ sourceId: 'exploding-source' }))).resolves.toEqual({
      status: 'failed',
      error: match.stringMatching(/source failed.*boom/s),
    });
    await expect(stat(join(ws, 'baselines'))).rejects.toThrow();
  });

  test('a null rejection fails with the fallback message, never a TypeError', async () => {
    await expect(capture(captureInput({ sourceId: 'rejecting-null' }))).resolves.toEqual({
      status: 'failed',
      error: match.stringMatching(/source failed.*unknown error/s),
    });
  });

  test('a string rejection carries that string', async () => {
    await expect(capture(captureInput({ sourceId: 'rejecting-string' }))).resolves.toEqual({
      status: 'failed',
      error: match.stringMatching(/source failed.*boom-string/s),
    });
  });
});
