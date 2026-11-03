// Split provenance: test/ops/ratchet/captureBaseline.test.ts was split into
// captureBaseline.{lifecycle,source-failures,adapter-containment,captured-at,publish,identity,symlink-containment,concurrency,prune}.test.ts
// plus captureBaseline.helpers.ts (shared fixtures and the original header).
import { mkdtemp, readFile, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createCaptureBaseline } from '../../../src/ops/ratchet/captureBaseline.js';
import type { CaptureBaselineInput } from '../../../src/ops/ratchet/captureBaseline.js';
import { parseBaseline, renderBaseline } from '../../../src/ops/ratchet/format.js';
import type { BaselineFile } from '../../../src/ops/ratchet/format.js';
import {
  CAPTURED_AT,
  CAPTURED_AT_2,
  TARGET,
  METRIC,
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
  test('the op input is plain data: structuredClone-safe (kernel makeManifest clones Job.input)', () => {
    expect(() => structuredClone(captureInput())).not.toThrow();
  });

  test('created: fresh ws writes the baseline and reports lifecycle created', async () => {
    sourceRaw = { count: 3 };
    await expect(capture(captureInput())).resolves.toEqual({
      status: 'ok',
      value: { path: REL, value: 3, previous: null, lifecycle: 'created' },
    });
    const expected: BaselineFile = {
      schemaVersion: 1,
      target: TARGET,
      metric: METRIC,
      direction: 'lower-is-better',
      value: 3,
      unit: 'errors',
      capturedAt: CAPTURED_AT,
    };
    expect(await readFile(join(ws, REL), 'utf8')).toBe(renderBaseline(expected));
    expect(parseBaseline(await readFile(join(ws, REL), 'utf8'))).toEqual(expected);
  });

  test('capturedAt defaults to the clock when not injected (parses as ISO-8601)', async () => {
    sourceRaw = { count: 1 };
    const input = captureInput();
    delete input.capturedAt;
    const result = await capture(input);
    expect(result.status).toBe('ok');
    const onDisk = parseBaseline(await readFile(join(ws, REL), 'utf8'));
    expect(Number.isNaN(Date.parse(onDisk.capturedAt))).toBe(false);
  });

  test('updated: a moved value carries previous and rewrites the file', async () => {
    sourceRaw = { count: 3 };
    await capture(captureInput());
    sourceRaw = { count: 5 };
    await expect(capture(captureInput({ capturedAt: CAPTURED_AT_2 }))).resolves.toEqual({
      status: 'ok',
      value: { path: REL, value: 5, previous: 3, lifecycle: 'updated' },
    });
    expect(parseBaseline(await readFile(join(ws, REL), 'utf8')).value).toBe(5);
  });

  test('unchanged: equal value, identical bytes → no rewrite (forced old mtime untouched)', async () => {
    sourceRaw = { count: 3 };
    await capture(captureInput());
    const abs = join(ws, REL);
    await utimes(abs, new Date(1000), new Date(1000));
    await expect(capture(captureInput())).resolves.toEqual({
      status: 'ok',
      value: { path: REL, value: 3, previous: 3, lifecycle: 'unchanged' },
    });
    expect((await stat(abs)).mtimeMs).toBe(1000);
  });

  test('unchanged: equal value but different bytes (new capturedAt) is rewritten in place', async () => {
    sourceRaw = { count: 3 };
    await capture(captureInput());
    await expect(capture(captureInput({ capturedAt: CAPTURED_AT_2 }))).resolves.toEqual({
      status: 'ok',
      value: { path: REL, value: 3, previous: 3, lifecycle: 'unchanged' },
    });
    expect(parseBaseline(await readFile(join(ws, REL), 'utf8')).capturedAt).toBe(CAPTURED_AT_2);
  });
});
