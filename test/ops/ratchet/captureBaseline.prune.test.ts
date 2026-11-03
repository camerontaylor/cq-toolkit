// Split provenance: test/ops/ratchet/captureBaseline.test.ts was split into
// captureBaseline.{lifecycle,source-failures,adapter-containment,captured-at,publish,identity,symlink-containment,concurrency,prune}.test.ts
// plus captureBaseline.helpers.ts (shared fixtures and the original header).
import { match } from '../../helpers/matchers.js';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createCaptureBaseline, pruneBaselines } from '../../../src/ops/ratchet/captureBaseline.js';
import type { CaptureBaselineInput } from '../../../src/ops/ratchet/captureBaseline.js';
import { baselineRelPath, renderBaseline } from '../../../src/ops/ratchet/format.js';
import {
  CAPTURED_AT,
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
    await expect(
      readFile(join(ws, baselineRelPath('old-target', METRIC)), 'utf8'),
    ).rejects.toThrow();
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

  test('a file whose name disagrees with its content is skipped, never deleted', async () => {
    await captureBaselineFor(TARGET, 2);
    // Valid baseline content for TARGET, stored under a foreign filename:
    // the content classifies to another file's path, so THIS file cannot
    // be classified — skipped, left untouched.
    const misnamed = join(ws, 'baselines', 'misnamed.json');
    await writeFile(
      misnamed,
      renderBaseline({
        schemaVersion: 1,
        target: TARGET,
        metric: METRIC,
        direction: 'lower-is-better',
        value: 9,
        capturedAt: CAPTURED_AT,
      }),
      'utf8',
    );
    await expect(
      pruneBaselines({ ws, live: [{ target: TARGET, metric: METRIC }] }),
    ).resolves.toEqual({
      deleted: [],
      kept: 1,
      skipped: ['baselines/misnamed.json'],
      unreadable: [],
    });
    expect(await readFile(misnamed, 'utf8')).toContain('"value": 9');
  });

  test('a directory entry is skipped (non-regular, never followed)', async () => {
    await captureBaselineFor(TARGET, 2);
    await mkdir(join(ws, 'baselines', 'weird.json'), { recursive: true });
    await expect(
      pruneBaselines({ ws, live: [{ target: TARGET, metric: METRIC }] }),
    ).resolves.toEqual({
      deleted: [],
      kept: 1,
      skipped: ['baselines/weird.json'],
      unreadable: [],
    });
    await expect(stat(join(ws, 'baselines', 'weird.json'))).resolves.toBeTruthy();
  });

  test('a symlinked entry is skipped even when its content matches live (never followed)', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'cq-outside-'));
    try {
      await mkdir(join(ws, 'baselines'), { recursive: true });
      const bytes = renderBaseline({
        schemaVersion: 1,
        target: TARGET,
        metric: METRIC,
        direction: 'lower-is-better',
        value: 7,
        unit: 'errors',
        capturedAt: CAPTURED_AT,
      });
      const outsideFile = join(outside, 'live-baseline.json');
      await writeFile(outsideFile, bytes, 'utf8');
      await symlink(outsideFile, join(ws, 'baselines', 'linked.json'));
      // Content matches live: without the lstat check the scan would follow
      // the link and count it kept — it must be skipped instead, and the
      // outside file never touched.
      await expect(
        pruneBaselines({ ws, live: [{ target: TARGET, metric: METRIC }] }),
      ).resolves.toEqual({
        deleted: [],
        kept: 0,
        skipped: ['baselines/linked.json'],
        unreadable: [],
      });
      expect(await readFile(outsideFile, 'utf8')).toBe(bytes);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test('a FIFO entry is skipped without blocking the scan', async () => {
    await mkdir(join(ws, 'baselines'), { recursive: true });
    const fifo = join(ws, 'baselines', 'pipe.json');
    // node:fs cannot create FIFOs; the POSIX mkfifo tool is the stand-in
    // (repo tests are POSIX-only by convention).
    const made = spawnSync('mkfifo', [fifo], { stdio: 'ignore' });
    expect(made.status).toBe(0);
    // The lstat leaf check classifies it before any readFile — the scan
    // completes instead of blocking on an open with no writer.
    await expect(pruneBaselines({ ws, live: [] })).resolves.toEqual({
      deleted: [],
      kept: 0,
      skipped: ['baselines/pipe.json'],
      unreadable: [],
    });
    await expect(stat(fifo)).resolves.toBeTruthy();
  });

  test('an unreadable regular file (I/O fault) is reported unreadable, distinct from skipped', async () => {
    await mkdir(join(ws, 'baselines'), { recursive: true });
    const locked = join(ws, 'baselines', 'locked.json');
    await writeFile(locked, 'locked content', 'utf8');
    await chmod(locked, 0o000);
    let outcome: Awaited<ReturnType<typeof pruneBaselines>>;
    try {
      outcome = await pruneBaselines({ ws, live: [] });
    } finally {
      await chmod(locked, 0o644);
    }
    expect(outcome).toEqual({
      deleted: [],
      kept: 0,
      skipped: [],
      unreadable: ['baselines/locked.json'],
    });
    await expect(readFile(locked, 'utf8')).resolves.toBe('locked content');
  });

  test('a scan that cannot start returns the zero outcome with an error, never a throw', async () => {
    // <ws>/baselines exists as a FILE → readdir fails with ENOTDIR, not ENOENT.
    await writeFile(join(ws, 'baselines'), 'i am not a directory', 'utf8');
    await expect(pruneBaselines({ ws, live: [] })).resolves.toEqual({
      deleted: [],
      kept: 0,
      skipped: [],
      unreadable: [],
      error: match.stringMatching(/could not scan/),
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
    await expect(
      readFile(join(ws, baselineRelPath('typecheck-v2', METRIC)), 'utf8'),
    ).resolves.toBeTruthy();
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
