// Lane H slice 2 (+ round-1 fix) — tests for captureBaseline and
// pruneBaselines (src/ops/ratchet/captureBaseline.ts).
//
// Pinned here:
//   1. Op-input serializability (Codex P1): the input is plain data
//      (structuredClone-safe — the kernel's makeManifest clones Job.input)
//      and references its runner by sourceId; the SourceCatalog is injected
//      at composition time and an unresolved sourceId fails naming it.
//   2. Capture lifecycle trio: 'created' on a fresh ws; 'updated' (previous
//      carried) when the value moves; 'unchanged' when the value is equal —
//      rewriting ONLY when the rendered bytes differ. The no-rewrite case is
//      pinned with a forced old mtime: an identical re-capture must not
//      touch the file.
//   3. Failure semantics — nothing crosses the op seam and I5 evidence is
//      never fabricated: unknown metric and unknown sourceId → failures
//      naming them; a null source or an unreadable raw → failure naming the
//      metric and "no metrics summary", with NOTHING written (no baselines
//      dir) and a pre-existing baseline surviving byte-for-byte; a throwing
//      source AND a throwing adapter → failures; a corrupt existing
//      baseline → failure, file untouched; an unreadable existing path →
//      indeterminate, never a verdict.
//   4. pruneBaselines: stale baselines deleted (relPath recorded), live
//      kept, unparseable content skipped, I/O-fault files unreadable, a
//      scan that cannot start returns the zero outcome with `error` (never
//      a throw), the rename drill (capture a → capture b → prune live=[b]
//      removes a) and the delete drill (empty live removes every
//      classifiable baseline).
//
// Determinism: capturedAt is pinned on every capture (no clock in
// assertions); temp dirs under os.tmpdir(), removed in afterEach. The real
// typecheck-count adapter is used so capture is exercised end-to-end with a
// production adapter.
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { typecheckCount } from '../../../src/ops/ratchet/adapters/typecheckCount.js';
import { createCaptureBaseline, pruneBaselines } from '../../../src/ops/ratchet/captureBaseline.js';
import type {
  CaptureBaselineInput,
  SourceCatalog,
} from '../../../src/ops/ratchet/captureBaseline.js';
import { baselineRelPath, parseBaseline, renderBaseline } from '../../../src/ops/ratchet/format.js';
import type { BaselineFile } from '../../../src/ops/ratchet/format.js';
import type { MetricSource } from '../../../src/ops/ratchet/registry.js';
import { registerAdapter } from '../../../src/ops/ratchet/registry.js';

const CAPTURED_AT = '2026-09-15T00:00:00.000Z';
const CAPTURED_AT_2 = '2026-09-15T01:00:00.000Z';
const TARGET = 'typecheck';
const METRIC = 'typecheck-count';
const THROWING_METRIC = 'throwing-adapter';
const REL = baselineRelPath(TARGET, METRIC);

let ws: string;
// The raw data the catalog's sources hand to the adapters; set per test.
let sourceRaw: unknown;

beforeAll(() => {
  registerAdapter(typecheckCount);
  registerAdapter({
    id: THROWING_METRIC,
    direction: 'lower-is-better',
    extract: () => {
      throw new Error('exploded');
    },
  });
});

// Sources are composition-time wiring (round-1 fix): they live in this
// catalog, never in the op input — the input only carries the sourceId.
const sources: SourceCatalog = new Map<string, MetricSource>([
  [METRIC, () => Promise.resolve(sourceRaw)],
  ['offline', () => Promise.resolve(null)],
  [THROWING_METRIC, () => Promise.resolve({ count: 1 })],
  ['exploding-source', () => Promise.reject(new Error('boom'))],
]);
const capture = createCaptureBaseline(sources);

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'cq-capture-'));
  sourceRaw = undefined;
});

afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

function captureInput(overrides: Partial<CaptureBaselineInput> = {}): CaptureBaselineInput {
  return {
    ws,
    target: TARGET,
    metric: METRIC,
    sourceId: METRIC,
    capturedAt: CAPTURED_AT,
    ...overrides,
  };
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
    const result = await capture(captureInput({ capturedAt: undefined }));
    expect(result.status).toBe('ok');
    const onDisk = parseBaseline(await readFile(join(ws, REL), 'utf8'));
    expect(Number.isNaN(Date.parse(onDisk.capturedAt))).toBe(false);
  });

  test('updated: a moved value carries previous and rewrites the file', async () => {
    sourceRaw = { count: 3 };
    await capture(captureInput());
    sourceRaw = { count: 5 };
    await expect(
      capture(captureInput({ capturedAt: CAPTURED_AT_2 })),
    ).resolves.toEqual({
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

  test('unknown metric fails with an arg-style error', async () => {
    await expect(capture(captureInput({ metric: 'no-such-metric' }))).resolves.toEqual({
      status: 'failed',
      error: expect.stringMatching(/unknown metric 'no-such-metric'/),
    });
  });

  test('unknown sourceId fails naming the source', async () => {
    await expect(capture(captureInput({ sourceId: 'no-such-source' }))).resolves.toEqual({
      status: 'failed',
      error: expect.stringMatching(/unknown source 'no-such-source' for metric 'typecheck-count'/),
    });
  });

  test('null source fails naming the metric and "no metrics summary" — and fabricates no evidence', async () => {
    sourceRaw = null;
    await expect(capture(captureInput())).resolves.toEqual({
      status: 'failed',
      error: expect.stringMatching(/metric 'typecheck-count'.*no metrics summary/s),
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
      error: expect.stringMatching(/no metrics summary/s),
    });
    await expect(readFile(join(ws, REL), 'utf8')).rejects.toThrow();
  });

  test('a throwing source fails instead of crashing the op', async () => {
    await expect(capture(captureInput({ sourceId: 'exploding-source' }))).resolves.toEqual({
      status: 'failed',
      error: expect.stringMatching(/source failed.*boom/s),
    });
    await expect(stat(join(ws, 'baselines'))).rejects.toThrow();
  });

  test('a throwing adapter fails the capture; no throw crosses the op seam', async () => {
    await expect(
      capture(captureInput({ metric: THROWING_METRIC, sourceId: THROWING_METRIC })),
    ).resolves.toEqual({
      status: 'failed',
      error: expect.stringMatching(/metric 'throwing-adapter' adapter failed.*exploded/s),
    });
    await expect(stat(join(ws, 'baselines'))).rejects.toThrow();
  });

  test('corrupt existing baseline fails and is left untouched', async () => {
    sourceRaw = { count: 3 };
    await mkdir(join(ws, 'baselines'), { recursive: true });
    const corrupt = '{"schemaVersion": 999}\n';
    await writeFile(join(ws, REL), corrupt, 'utf8');
    await expect(capture(captureInput())).resolves.toEqual({
      status: 'failed',
      error: expect.stringMatching(/corrupt and was not overwritten/s),
    });
    expect(await readFile(join(ws, REL), 'utf8')).toBe(corrupt);
  });

  test('unreadable existing baseline path → indeterminate, never a verdict', async () => {
    sourceRaw = { count: 3 };
    // A DIRECTORY squatting where the file belongs: unreadable as a baseline,
    // and not ENOENT, so capture must refuse to claim any verdict.
    await mkdir(join(ws, REL), { recursive: true });
    await expect(capture(captureInput())).resolves.toEqual({
      status: 'indeterminate',
      detail: expect.stringMatching(/could not read existing baseline/s),
    });
  });
});

describe('pruneBaselines', () => {
  async function captureBaselineFor(target: string, value: number): Promise<void> {
    sourceRaw = { count: value };
    await expect(capture(captureInput({ target }))).resolves.toMatchObject({ status: 'ok' });
  }

  test('stale baselines are deleted (relPath recorded) and live ones kept', async () => {
    await captureBaselineFor('old-target', 1);
    await captureBaselineFor(TARGET, 2);
    await expect(
      pruneBaselines({ ws, live: [{ target: TARGET, metric: METRIC }] }),
    ).resolves.toEqual({
      deleted: [baselineRelPath('old-target', METRIC)],
      kept: 1,
      skipped: [],
      unreadable: [],
    });
    await expect(readFile(join(ws, baselineRelPath('old-target', METRIC)), 'utf8')).rejects.toThrow();
    await expect(readFile(join(ws, REL), 'utf8')).resolves.toBeTruthy();
  });

  test('unparseable content is skipped (never deleted); non-.json files are ignored', async () => {
    await captureBaselineFor(TARGET, 2);
    await mkdir(join(ws, 'baselines'), { recursive: true });
    await writeFile(join(ws, 'baselines', 'garbage.json'), 'not json', 'utf8');
    await writeFile(join(ws, 'baselines', 'notes.txt'), 'keep me', 'utf8');
    await expect(
      pruneBaselines({ ws, live: [{ target: TARGET, metric: METRIC }] }),
    ).resolves.toEqual({
      deleted: [],
      kept: 1,
      skipped: ['baselines/garbage.json'],
      unreadable: [],
    });
    expect(await readFile(join(ws, 'baselines', 'garbage.json'), 'utf8')).toBe('not json');
    expect(await readFile(join(ws, 'baselines', 'notes.txt'), 'utf8')).toBe('keep me');
  });

  test('an unreadable file (I/O fault) is reported unreadable, distinct from skipped', async () => {
    await captureBaselineFor(TARGET, 2);
    // A directory named *.json: exists, but readFile fails (EISDIR) — an I/O
    // fault, not unparseable content.
    await mkdir(join(ws, 'baselines', 'weird.json'), { recursive: true });
    await expect(
      pruneBaselines({ ws, live: [{ target: TARGET, metric: METRIC }] }),
    ).resolves.toEqual({
      deleted: [],
      kept: 1,
      skipped: [],
      unreadable: ['baselines/weird.json'],
    });
    // The unreadable entry is left untouched.
    await expect(stat(join(ws, 'baselines', 'weird.json'))).resolves.toBeTruthy();
  });

  test('a scan that cannot start returns the zero outcome with an error, never a throw', async () => {
    // <ws>/baselines exists as a FILE → readdir fails with ENOTDIR, not ENOENT.
    await writeFile(join(ws, 'baselines'), 'i am not a directory', 'utf8');
    await expect(pruneBaselines({ ws, live: [] })).resolves.toEqual({
      deleted: [],
      kept: 0,
      skipped: [],
      unreadable: [],
      error: expect.stringMatching(/could not scan/),
    });
  });

  test('rename drill: capture a, capture b, prune live=[b] removes a', async () => {
    await captureBaselineFor(TARGET, 2);
    await captureBaselineFor('typecheck-v2', 2);
    await expect(
      pruneBaselines({ ws, live: [{ target: 'typecheck-v2', metric: METRIC }] }),
    ).resolves.toEqual({
      deleted: [REL],
      kept: 1,
      skipped: [],
      unreadable: [],
    });
    await expect(readFile(join(ws, REL), 'utf8')).rejects.toThrow();
    await expect(readFile(join(ws, baselineRelPath('typecheck-v2', METRIC)), 'utf8')).resolves.toBeTruthy();
  });

  test('delete drill: an empty live list removes every classifiable baseline', async () => {
    await captureBaselineFor(TARGET, 2);
    await captureBaselineFor('typecheck-v2', 3);
    await expect(pruneBaselines({ ws, live: [] })).resolves.toEqual({
      deleted: [REL, baselineRelPath('typecheck-v2', METRIC)],
      kept: 0,
      skipped: [],
      unreadable: [],
    });
  });

  test('a ws with no baselines dir prunes to nothing', async () => {
    await expect(pruneBaselines({ ws, live: [] })).resolves.toEqual({
      deleted: [],
      kept: 0,
      skipped: [],
      unreadable: [],
    });
  });
});
