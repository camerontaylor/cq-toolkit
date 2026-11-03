// Split provenance: test/ops/ratchet/captureBaseline.test.ts was split into
// captureBaseline.{lifecycle,source-failures,adapter-containment,captured-at,publish,identity,symlink-containment,concurrency,prune}.test.ts
// plus captureBaseline.helpers.ts (shared fixtures and the original header).
import { match } from '../../helpers/matchers.js';
import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createCaptureBaseline, pruneBaselines } from '../../../src/ops/ratchet/captureBaseline.js';
import type { CaptureBaselineInput } from '../../../src/ops/ratchet/captureBaseline.js';
import { renderBaseline } from '../../../src/ops/ratchet/format.js';
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

describe('captureBaseline', () => {
  test('a symlinked baselines dir pointing outside ws fails capture (nothing written outside)', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'cq-outside-'));
    try {
      await symlink(outside, join(ws, 'baselines'), 'dir');
      sourceRaw = { count: 3 };
      await expect(capture(captureInput())).resolves.toEqual({
        status: 'failed',
        error: match.stringMatching(
          /does not resolve to a strict descendant of the workspace \('.*cq-outside-[^']*'\) — refusing/s,
        ),
      });
      await expect(readdir(outside)).resolves.toEqual([]); // nothing written outside
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test('even a byte-identical baseline outside a symlinked baselines dir fails (no ok/unchanged)', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'cq-outside-'));
    try {
      // The EXACT bytes this capture would write, planted in the outside
      // dir: through the symlink the op would see its own output and take
      // the unchanged fast path — containment must fire first.
      const bytes = renderBaseline({
        schemaVersion: 1,
        target: TARGET,
        metric: METRIC,
        direction: 'lower-is-better',
        value: 3,
        unit: 'errors',
        capturedAt: CAPTURED_AT,
      });
      await writeFile(join(outside, basename(REL)), bytes, 'utf8');
      await symlink(outside, join(ws, 'baselines'), 'dir');
      sourceRaw = { count: 3 };
      const result = await capture(captureInput());
      expect(result.status).toBe('failed');
      await expect(capture(captureInput())).resolves.toEqual({
        status: 'failed',
        error: match.stringMatching(/does not resolve to a strict descendant of the workspace/),
      });
      expect(await readFile(join(outside, basename(REL)), 'utf8')).toBe(bytes); // untouched
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test('a symlinked baselines dir pointing outside ws: prune reports the fault, deletes nothing', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'cq-outside-'));
    try {
      await writeFile(join(outside, 'stale.json'), 'precious', 'utf8');
      await symlink(outside, join(ws, 'baselines'), 'dir');
      await expect(pruneBaselines({ ws, live: [] })).resolves.toEqual({
        deleted: [],
        kept: 0,
        skipped: [],
        unreadable: [],
        error: match.stringMatching(
          /does not resolve to a strict descendant of the workspace \('.*cq-outside-[^']*'\)/,
        ),
      });
      expect(await readFile(join(outside, 'stale.json'), 'utf8')).toBe('precious');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test('baselines symlinked to the ws itself fails capture (strict-descendant containment)', async () => {
    await symlink(ws, join(ws, 'baselines'), 'dir');
    sourceRaw = { count: 3 };
    await expect(capture(captureInput())).resolves.toEqual({
      status: 'failed',
      error: match.stringMatching(/does not resolve to a strict descendant of the workspace/),
    });
    // The ws root is untouched — no baseline landed at its top level.
    await expect(readdir(ws)).resolves.toEqual(['baselines']);
  });

  test('baselines symlinked to the ws itself: prune reports the fault, scans nothing', async () => {
    await symlink(ws, join(ws, 'baselines'), 'dir');
    await expect(pruneBaselines({ ws, live: [] })).resolves.toEqual({
      deleted: [],
      kept: 0,
      skipped: [],
      unreadable: [],
      error: match.stringMatching(/does not resolve to a strict descendant of the workspace/),
    });
    // The ws root was never scanned (a *.json there would have been
    // classified for deletion) — nothing changed.
    await expect(readdir(ws)).resolves.toEqual(['baselines']);
  });
});
