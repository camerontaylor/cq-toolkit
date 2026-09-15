// Lane H slice 2 — tests for captureBaseline and pruneBaselines
// (src/ops/ratchet/captureBaseline.ts).
//
// Pinned here:
//   1. Capture lifecycle trio: 'created' on a fresh ws; 'updated' (previous
//      carried) when the value moves; 'unchanged' when the value is equal —
//      rewriting ONLY when the rendered bytes differ. The no-rewrite case is
//      pinned with a forced old mtime: an identical re-capture must not
//      touch the file.
//   2. Failure semantics: unknown metric → arg-style failure; a null source
//      or an unreadable raw → failure naming the metric and "no metrics
//      summary" (I5: never a pass, never a baseline); a corrupt existing
//      baseline → failure and the file is left untouched; an unreadable
//      existing path → indeterminate, never a verdict.
//   3. pruneBaselines: stale baselines deleted (relPath recorded), live
//      kept, unparseable skipped (never deleted), the rename drill
//      (capture a → capture b → prune live=[b] removes a) and the delete
//      drill (empty live removes every classifiable baseline).
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
import { captureBaseline, pruneBaselines } from '../../../src/ops/ratchet/captureBaseline.js';
import { baselineRelPath, parseBaseline, renderBaseline } from '../../../src/ops/ratchet/format.js';
import type { BaselineFile } from '../../../src/ops/ratchet/format.js';
import type { CaptureBaselineInput } from '../../../src/ops/ratchet/captureBaseline.js';
import { registerAdapter } from '../../../src/ops/ratchet/registry.js';

const CAPTURED_AT = '2026-09-15T00:00:00.000Z';
const CAPTURED_AT_2 = '2026-09-15T01:00:00.000Z';
const TARGET = 'typecheck';
const METRIC = 'typecheck-count';
const REL = baselineRelPath(TARGET, METRIC); // baselines/typecheck--typecheck-count.json

let ws: string;

beforeAll(() => {
  registerAdapter(typecheckCount);
});

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'cq-capture-'));
});

afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

function sourceReturning(raw: unknown): CaptureBaselineInput['source'] {
  return async () => raw;
}

function captureInput(overrides: Partial<CaptureBaselineInput> = {}): CaptureBaselineInput {
  return {
    ws,
    target: TARGET,
    metric: METRIC,
    source: sourceReturning({ count: 3 }),
    capturedAt: CAPTURED_AT,
    ...overrides,
  };
}

describe('captureBaseline', () => {
  test('created: fresh ws writes the baseline and reports lifecycle created', async () => {
    await expect(captureBaseline(captureInput())).resolves.toEqual({
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
    const result = await captureBaseline({ ...captureInput(), capturedAt: undefined });
    expect(result.status).toBe('ok');
    const onDisk = parseBaseline(await readFile(join(ws, REL), 'utf8'));
    expect(Number.isNaN(Date.parse(onDisk.capturedAt))).toBe(false);
  });

  test('updated: a moved value carries previous and rewrites the file', async () => {
    await captureBaseline(captureInput());
    await expect(
      captureBaseline(captureInput({ source: sourceReturning({ count: 5 }), capturedAt: CAPTURED_AT_2 })),
    ).resolves.toEqual({
      status: 'ok',
      value: { path: REL, value: 5, previous: 3, lifecycle: 'updated' },
    });
    expect(parseBaseline(await readFile(join(ws, REL), 'utf8')).value).toBe(5);
  });

  test('unchanged: equal value, identical bytes → no rewrite (forced old mtime untouched)', async () => {
    await captureBaseline(captureInput());
    const abs = join(ws, REL);
    await utimes(abs, new Date(1000), new Date(1000));
    await expect(captureBaseline(captureInput())).resolves.toEqual({
      status: 'ok',
      value: { path: REL, value: 3, previous: 3, lifecycle: 'unchanged' },
    });
    expect((await stat(abs)).mtimeMs).toBe(1000);
  });

  test('unchanged: equal value but different bytes (new capturedAt) is rewritten in place', async () => {
    await captureBaseline(captureInput());
    await expect(
      captureBaseline(captureInput({ capturedAt: CAPTURED_AT_2 })),
    ).resolves.toEqual({
      status: 'ok',
      value: { path: REL, value: 3, previous: 3, lifecycle: 'unchanged' },
    });
    expect(parseBaseline(await readFile(join(ws, REL), 'utf8')).capturedAt).toBe(CAPTURED_AT_2);
  });

  test('unknown metric fails with an arg-style error', async () => {
    await expect(
      captureBaseline(captureInput({ metric: 'no-such-metric' })),
    ).resolves.toEqual({
      status: 'failed',
      error: expect.stringMatching(/unknown metric 'no-such-metric'/),
    });
  });

  test('null source fails naming the metric and "no metrics summary"', async () => {
    await expect(
      captureBaseline(captureInput({ source: sourceReturning(null) })),
    ).resolves.toEqual({
      status: 'failed',
      error: expect.stringMatching(/metric 'typecheck-count'.*no metrics summary/s),
    });
  });

  test('unusable raw fails with the same no-summary failure', async () => {
    await expect(
      captureBaseline(captureInput({ source: sourceReturning('definitely not a compiler log') })),
    ).resolves.toEqual({
      status: 'failed',
      error: expect.stringMatching(/no metrics summary/s),
    });
    // The failure left no baseline behind.
    await expect(readFile(join(ws, REL), 'utf8')).rejects.toThrow();
  });

  test('a throwing source fails instead of crashing the op', async () => {
    await expect(
      captureBaseline({
        ...captureInput(),
        source: async (): Promise<unknown | null> => {
          throw new Error('boom');
        },
      }),
    ).resolves.toEqual({
      status: 'failed',
      error: expect.stringMatching(/source failed.*boom/s),
    });
  });

  test('corrupt existing baseline fails and is left untouched', async () => {
    await mkdir(join(ws, 'baselines'), { recursive: true });
    const corrupt = '{"schemaVersion": 999}\n';
    await writeFile(join(ws, REL), corrupt, 'utf8');
    await expect(captureBaseline(captureInput())).resolves.toEqual({
      status: 'failed',
      error: expect.stringMatching(/corrupt and was not overwritten/s),
    });
    expect(await readFile(join(ws, REL), 'utf8')).toBe(corrupt);
  });

  test('unreadable existing baseline path → indeterminate, never a verdict', async () => {
    // A DIRECTORY squatting where the file belongs: unreadable as a baseline,
    // and not ENOENT, so capture must refuse to claim any verdict.
    await mkdir(join(ws, REL), { recursive: true });
    await expect(captureBaseline(captureInput())).resolves.toEqual({
      status: 'indeterminate',
      detail: expect.stringMatching(/could not read existing baseline/s),
    });
  });
});

describe('pruneBaselines', () => {
  async function capture(target: string, value: number): Promise<void> {
    await expect(
      captureBaseline({ ...captureInput(), target, source: sourceReturning({ count: value }) }),
    ).resolves.toMatchObject({ status: 'ok' });
  }

  test('stale baselines are deleted (relPath recorded) and live ones kept', async () => {
    await capture('old-target', 1);
    await capture(TARGET, 2);
    await expect(
      pruneBaselines({ ws, live: [{ target: TARGET, metric: METRIC }] }),
    ).resolves.toEqual({
      deleted: ['baselines/old-target--typecheck-count.json'],
      kept: 1,
      skipped: [],
    });
    await expect(
      readFile(join(ws, 'baselines/old-target--typecheck-count.json'), 'utf8'),
    ).rejects.toThrow();
    await expect(readFile(join(ws, REL), 'utf8')).resolves.toBeTruthy();
  });

  test('unparseable files are skipped (never deleted); non-.json files are ignored', async () => {
    await capture(TARGET, 2);
    await mkdir(join(ws, 'baselines'), { recursive: true });
    await writeFile(join(ws, 'baselines', 'garbage.json'), 'not json', 'utf8');
    await writeFile(join(ws, 'baselines', 'notes.txt'), 'keep me', 'utf8');
    await expect(
      pruneBaselines({ ws, live: [{ target: TARGET, metric: METRIC }] }),
    ).resolves.toEqual({
      deleted: [],
      kept: 1,
      skipped: ['baselines/garbage.json'],
    });
    expect(await readFile(join(ws, 'baselines', 'garbage.json'), 'utf8')).toBe('not json');
    expect(await readFile(join(ws, 'baselines', 'notes.txt'), 'utf8')).toBe('keep me');
  });

  test('rename drill: capture a, capture b, prune live=[b] removes a', async () => {
    await capture(TARGET, 2);
    await capture('typecheck-v2', 2);
    await expect(
      pruneBaselines({ ws, live: [{ target: 'typecheck-v2', metric: METRIC }] }),
    ).resolves.toEqual({
      deleted: ['baselines/typecheck--typecheck-count.json'],
      kept: 1,
      skipped: [],
    });
    await expect(readFile(join(ws, REL), 'utf8')).rejects.toThrow();
    await expect(
      readFile(join(ws, 'baselines/typecheck-v2--typecheck-count.json'), 'utf8'),
    ).resolves.toBeTruthy();
  });

  test('delete drill: an empty live list removes every classifiable baseline', async () => {
    await capture(TARGET, 2);
    await capture('typecheck-v2', 3);
    await expect(pruneBaselines({ ws, live: [] })).resolves.toEqual({
      deleted: [
        'baselines/typecheck--typecheck-count.json',
        'baselines/typecheck-v2--typecheck-count.json',
      ],
      kept: 0,
      skipped: [],
    });
  });

  test('a ws with no baselines dir prunes to nothing', async () => {
    await expect(pruneBaselines({ ws, live: [] })).resolves.toEqual({
      deleted: [],
      kept: 0,
      skipped: [],
    });
  });
});
