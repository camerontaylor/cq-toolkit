// Split provenance: test/ops/ratchet/captureBaseline.test.ts was split into
// captureBaseline.{lifecycle,source-failures,adapter-containment,captured-at,publish,identity,symlink-containment,concurrency,prune}.test.ts
// plus captureBaseline.helpers.ts (shared fixtures and the original header).
import { match } from '../../helpers/matchers.js';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { typecheckCount } from '../../../src/ops/ratchet/adapters/typecheckCount.js';
import { createCaptureBaseline } from '../../../src/ops/ratchet/captureBaseline.js';
import type { CaptureBaselineInput } from '../../../src/ops/ratchet/captureBaseline.js';
import { baselineRelPath, renderBaseline } from '../../../src/ops/ratchet/format.js';
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
  test('the publish is atomic: no temp files linger after captures', async () => {
    sourceRaw = { count: 3 };
    await capture(captureInput());
    sourceRaw = { count: 5 };
    await capture(captureInput({ capturedAt: CAPTURED_AT_2 }));
    const names = await readdir(join(ws, 'baselines'));
    expect(names).toEqual([basename(REL)]);
  });

  test('a 400+ char deep-nested target captures cleanly (truncated segments, no ENAMETOOLONG)', async () => {
    sourceRaw = { count: 1 };
    const deepTarget = `src/${'a/b/'.repeat(99)}deep.ts`; // 411 chars
    const result = await capture(captureInput({ target: deepTarget }));
    expect(result.status).toBe('ok');
    const relPath = baselineRelPath(deepTarget, METRIC);
    expect(relPath.length).toBeLessThanOrEqual(255);
    for (const segment of relPath.split('/')) {
      expect(segment.length).toBeLessThanOrEqual(255);
    }
    // The write itself succeeded — no ENAMETOOLONG — and the file is readable.
    await expect(readFile(join(ws, relPath), 'utf8')).resolves.toContain('"target"');
  });

  test('corrupt existing baseline fails and is left untouched', async () => {
    sourceRaw = { count: 3 };
    await mkdir(join(ws, 'baselines'), { recursive: true });
    const corrupt = '{"schemaVersion": 999}\n';
    await writeFile(join(ws, REL), corrupt, 'utf8');
    await expect(capture(captureInput())).resolves.toEqual({
      status: 'failed',
      error: match.stringMatching(/corrupt and was not overwritten/s),
    });
    expect(await readFile(join(ws, REL), 'utf8')).toBe(corrupt);
  });

  test('a directory squatting at the baseline path fails the leaf check (not a regular file)', async () => {
    sourceRaw = { count: 3 };
    // A DIRECTORY where the file belongs: lstat sees it before any read —
    // not a regular file, so capture refuses outright.
    await mkdir(join(ws, REL), { recursive: true });
    await expect(capture(captureInput())).resolves.toEqual({
      status: 'failed',
      error: match.stringMatching(/not a regular file — refusing/),
    });
  });

  test('a symlinked baseline leaf with byte-identical outside content fails the leaf check', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'cq-outside-'));
    try {
      await mkdir(join(ws, 'baselines'), { recursive: true });
      const bytes = renderBaseline({
        schemaVersion: 1,
        target: TARGET,
        metric: METRIC,
        direction: 'lower-is-better',
        value: 3,
        unit: 'errors',
        capturedAt: CAPTURED_AT,
      });
      const outsideFile = join(outside, 'elsewhere-baseline.json');
      await writeFile(outsideFile, bytes, 'utf8');
      await symlink(outsideFile, join(ws, REL));
      sourceRaw = { count: 3 };
      // The leaf is a symlink to a byte-identical file: without the lstat
      // check the read would follow it and return ok/unchanged.
      await expect(capture(captureInput())).resolves.toEqual({
        status: 'failed',
        error: match.stringMatching(/not a regular file — refusing/),
      });
      expect(await readFile(outsideFile, 'utf8')).toBe(bytes); // outside untouched
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test('a pre-planted temp-name symlink does not truncate the outside target', async () => {
    // A fresh module instance starts its temp counter at 0, making the
    // EXACT next temp name predictable (...1.tmp).
    vi.resetModules();
    try {
      const captureMod = await import('../../../src/ops/ratchet/captureBaseline.js');
      const registryMod = await import('../../../src/ops/ratchet/metricRegistry.js');
      registryMod.registerAdapter(typecheckCount);
      const captureFresh = captureMod.createCaptureBaseline(
        new Map([[METRIC, () => Promise.resolve(sourceRaw)]]),
      );

      const outside = await mkdtemp(join(tmpdir(), 'cq-outside-'));
      try {
        await mkdir(join(ws, 'baselines'), { recursive: true });
        const outsideFile = join(outside, 'precious.txt');
        await writeFile(outsideFile, 'precious — must not be truncated', 'utf8');
        const planted = join(ws, 'baselines', `.${basename(REL)}.${process.pid}.1.tmp`);
        await symlink(outsideFile, planted);

        sourceRaw = { count: 3 };
        await expect(captureFresh(captureInput())).resolves.toEqual({
          status: 'ok',
          value: { path: REL, value: 3, previous: null, lifecycle: 'created' },
        });
        expect(await readFile(join(ws, REL), 'utf8')).toContain('"value": 3');
        expect(await readFile(outsideFile, 'utf8')).toBe('precious — must not be truncated');

        // Exhaustion: plant EVERY remaining temp name — the bounded retries
        // give up as indeterminate, and the colliding entries stay untouched
        // (cleanup only removes a temp this invocation created).
        for (let c = 3; c <= 7; c++) {
          await symlink(
            outsideFile,
            join(ws, 'baselines', `.${basename(REL)}.${process.pid}.${c}.tmp`),
          );
        }
        sourceRaw = { count: 9 };
        await expect(captureFresh(captureInput({ capturedAt: CAPTURED_AT_2 }))).resolves.toEqual({
          status: 'indeterminate',
          detail: match.stringMatching(/writing baseline.*failed/s),
        });
        const tempDebris = (await readdir(join(ws, 'baselines')))
          .filter((n) => n.endsWith('.tmp'))
          .sort();
        // Leg 1's planted .1 link and leg 2's planted .3–.7 links: ALL still
        // there — none of them was created by this invocation.
        expect(tempDebris).toEqual(
          [1, 3, 4, 5, 6, 7].map((c) => `.${basename(REL)}.${process.pid}.${c}.tmp`),
        );
        expect(await readFile(outsideFile, 'utf8')).toBe('precious — must not be truncated');
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    } finally {
      vi.resetModules(); // later tests keep using the static module bindings
    }
  });

  test('planting ALL five temp names exhausts the retries — indeterminate, all untouched', async () => {
    // A fresh module instance starts its temp counter at 0, so the five
    // candidates are exactly counters 1..5 — plant every one of them.
    vi.resetModules();
    try {
      const captureMod = await import('../../../src/ops/ratchet/captureBaseline.js');
      const registryMod = await import('../../../src/ops/ratchet/metricRegistry.js');
      registryMod.registerAdapter(typecheckCount);
      const captureFresh = captureMod.createCaptureBaseline(
        new Map([[METRIC, () => Promise.resolve(sourceRaw)]]),
      );

      const outside = await mkdtemp(join(tmpdir(), 'cq-outside-'));
      try {
        await mkdir(join(ws, 'baselines'), { recursive: true });
        const outsideFile = join(outside, 'precious.txt');
        await writeFile(outsideFile, 'precious — must not be truncated', 'utf8');
        const plantedNames = [1, 2, 3, 4, 5].map(
          (c) => `.${basename(REL)}.${process.pid}.${c}.tmp`,
        );
        for (const name of plantedNames) {
          await symlink(outsideFile, join(ws, 'baselines', name));
        }
        sourceRaw = { count: 3 };
        await expect(captureFresh(captureInput())).resolves.toEqual({
          status: 'indeterminate',
          detail: match.stringMatching(/writing baseline.*failed/s),
        });
        // Every colliding entry is untouched — cleanup never deletes a temp
        // this invocation did not create.
        expect((await readdir(join(ws, 'baselines'))).sort()).toEqual([...plantedNames].sort());
        expect(await readFile(outsideFile, 'utf8')).toBe('precious — must not be truncated');
        // And no baseline was published anywhere.
        await expect(stat(join(ws, REL))).rejects.toThrow();
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    } finally {
      vi.resetModules(); // later tests keep using the static module bindings
    }
  });
});
