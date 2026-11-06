// Split provenance: test/ops/ratchet/captureBaseline.test.ts was split into
// captureBaseline.{lifecycle,source-failures,adapter-containment,captured-at,publish,identity,symlink-containment,concurrency,prune}.test.ts
// plus captureBaseline.helpers.ts (shared fixtures and the original header).
import { chmod, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createCaptureBaseline } from '../../../src/ops/ratchet/captureBaseline.js';
import type { CaptureBaselineInput } from '../../../src/ops/ratchet/captureBaseline.js';
import { parseBaseline } from '../../../src/ops/ratchet/format.js';
import {
  CAPTURED_AT,
  CAPTURED_AT_2,
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
  test('two CONCURRENT captures of one (target, metric) serialize (review-debt #68): created + unchanged, evidence consistent', async () => {
    // The kernel runner executes a wave of dependency-free jobs
    // concurrently: without the per-path lock both captures read "no
    // existing file", both publish, and the last rename wins — both report
    // 'created' while one reported result disagrees with the persisted
    // evidence. With the lock, the second capture sees the first's file.
    sourceRaw = { count: 3 };
    const results = await Promise.all([
      capture(captureInput({ capturedAt: CAPTURED_AT })),
      capture(captureInput({ capturedAt: CAPTURED_AT })),
    ]);
    const lifecycles = results
      .map((r) => (r.status === 'ok' ? r.value.lifecycle : `not-ok:${r.status}`))
      .sort();
    expect(lifecycles).toEqual(['created', 'unchanged']);
    // The persisted evidence parses and matches BOTH reports' value; the
    // 'unchanged' one carried the first's value as `previous`.
    const persisted = parseBaseline(await readFile(join(ws, REL), 'utf8'));
    expect(persisted.value).toBe(3);
    const unchanged = results.find((r) => r.status === 'ok' && r.value.lifecycle === 'unchanged');
    expect(unchanged?.status === 'ok' && unchanged.value.previous).toBe(3);
    // No lock residue: the released lock dir left nothing behind.
    expect(await readdir(join(ws, 'baselines'))).toEqual([basename(REL)]);
  });

  // Root bypasses directory mode bits, and Windows does not enforce them on directories.
  test.skipIf(process.getuid?.() === 0 || process.platform === 'win32')(
    'a read-only baselines dir fails fast at the capture lock (indeterminate, no debris — review-debt #68)',
    async () => {
      sourceRaw = { count: 3 };
      await capture(captureInput());
      // Make the dir read-only: the per-path capture lock (review-debt #68)
      // is now the FIRST write attempted, so the failure surfaces at the
      // lock acquire — a fast indeterminate (the short backoff never burns
      // half a minute), never a mid-publish torn state. The temp-cleanup
      // path itself is pinned by the seam-injected mid-write fault test
      // (capture-temp-fault.test.ts).
      const baselinesDir = join(ws, 'baselines');
      await chmod(baselinesDir, 0o555);
      sourceRaw = { count: 5 };
      let result: Awaited<ReturnType<typeof capture>>;
      try {
        result = await capture(captureInput({ capturedAt: CAPTURED_AT_2 }));
      } finally {
        await chmod(baselinesDir, 0o755); // restore before cleanup assertions
      }
      expect(result.status).toBe('indeterminate');
      if (result.status === 'indeterminate') {
        expect(result.detail).toMatch(/could not acquire the capture lock/);
      }
      const names = await readdir(baselinesDir);
      expect(names).toEqual([basename(REL)]); // original baseline, no *.tmp debris, no *.lock residue
    },
  );
});
