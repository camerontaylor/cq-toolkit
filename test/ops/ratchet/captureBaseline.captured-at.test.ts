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
  test('an unparseable capturedAt fails with arg-error semantics', async () => {
    sourceRaw = { count: 1 };
    await expect(capture(captureInput({ capturedAt: 'not-a-date' }))).resolves.toEqual({
      status: 'failed',
      error: match.stringMatching(/invalid capturedAt 'not-a-date'/),
    });
    await expect(stat(join(ws, 'baselines'))).rejects.toThrow();
  });

  test('non-ISO and calendar-rollover capturedAt fail the strict instant check', async () => {
    sourceRaw = { count: 1 };
    for (const bad of ['September 15, 2026', '2026-02-30T00:00:00Z']) {
      await expect(capture(captureInput({ capturedAt: bad }))).resolves.toEqual({
        status: 'failed',
        error: match.stringMatching(/invalid capturedAt.*strict ISO-8601/s),
      });
    }
    await expect(stat(join(ws, 'baselines'))).rejects.toThrow();
  });

  test('strict-but-legitimate capturedAt forms are accepted (numeric offset, nanoseconds)', async () => {
    sourceRaw = { count: 1 };
    await expect(
      capture(captureInput({ capturedAt: '2026-09-15T12:00:00+02:00' })),
    ).resolves.toMatchObject({ status: 'ok' });
    sourceRaw = { count: 2 };
    await expect(
      capture(
        captureInput({ target: 'typecheck-nanos', capturedAt: '2026-09-15T10:00:00.123456789Z' }),
      ),
    ).resolves.toMatchObject({ status: 'ok' });
  });
});
