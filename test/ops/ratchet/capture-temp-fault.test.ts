import { match } from '../../helpers/matchers.js';
// review-debt #69 — the temp-publish OWNERSHIP window: writeFile(flag 'wx')
// marked the temp owned only AFTER the bytes landed, so a fault mid-write
// (ENOSPC, EIO) left the just-created ZERO-LENGTH temp behind as debris.
// The open-handle sequence owns the file the moment the exclusive open
// succeeds. Real mid-write fs faults are not producible portably, so this
// file injects one at the node:fs/promises seam: `open` returns a real
// handle whose writeFile always faults — the op must land `indeterminate`,
// the cleanup unlink MUST run (the pre-fix code skipped it: ownership was
// still false at the throw), and no .tmp debris may remain.
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { createCaptureBaseline } from '../../../src/ops/ratchet/captureBaseline.js';
import type { SourceCatalog } from '../../../src/ops/ratchet/captureBaseline.js';
import { registerAdapter } from '../../../src/ops/ratchet/metricRegistry.js';

// Hoisted holders: the mock factory runs before module-scope declarations,
// so the spies live here (vi.hoisted lifts this above the vi.mock call).
const holders = vi.hoisted(() => ({
  actual: undefined as typeof import('node:fs/promises') | undefined,
  openMock: undefined as
    | ReturnType<typeof vi.fn<typeof import('node:fs/promises').open>>
    | undefined,
  unlinkMock: undefined as
    | ReturnType<typeof vi.fn<typeof import('node:fs/promises').unlink>>
    | undefined,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  holders.actual = actual;
  holders.openMock = vi.fn(actual.open);
  holders.unlinkMock = vi.fn(actual.unlink);
  return { ...actual, open: holders.openMock, unlink: holders.unlinkMock };
});

const METRIC = 'temp-fault-metric';

beforeAll(() => {
  registerAdapter({
    id: METRIC,
    direction: 'lower-is-better',
    extract: () => ({ value: 7, unit: 'errors' }),
  });
});

let ws: string;
const sources: SourceCatalog = new Map([[METRIC, async () => ({ count: 7 })]]);
const capture = createCaptureBaseline(sources);

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'cq-capfault-'));
});

afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
  holders.openMock!.mockReset();
  holders.openMock!.mockImplementation(holders.actual!.open);
  holders.unlinkMock!.mockReset();
  holders.unlinkMock!.mockImplementation(holders.actual!.unlink);
});

describe('captureBaseline temp ownership under a mid-write fault (review-debt #69)', () => {
  test('a faulting writeFile still unlinks the created temp — no zero-length debris, verdict indeterminate', async () => {
    const { actual, openMock, unlinkMock } = holders;
    if (actual === undefined || openMock === undefined || unlinkMock === undefined) {
      throw new Error('mock harness not installed');
    }
    openMock.mockImplementationOnce(async (path, flags) => {
      const handle = await actual.open(path, flags);
      // A real exclusive-open handle whose write always faults: the file
      // EXISTS (zero-length) from this moment — exactly the ownership
      // window the old writeFile('wx') path lost.
      const faulty = Object.create(handle) as typeof handle;
      faulty.writeFile = async () => {
        throw Object.assign(new Error('EIO: simulated mid-write fault'), { code: 'EIO' });
      };
      return faulty;
    });
    const result = await capture({
      ws,
      target: 'typecheck',
      metric: METRIC,
      sourceId: METRIC,
      capturedAt: '2026-09-16T00:00:00.000Z',
    });
    expect(result).toEqual({
      status: 'indeterminate',
      detail: match.stringMatching(/writing baseline.*failed.*EIO: simulated mid-write fault/s),
    });
    // The regression pin: cleanup RAN for the file this invocation created
    // (pre-fix, tempCreated was still false at the throw → unlink skipped).
    const unlinkedTemps = holders.unlinkMock!.mock.calls.filter(([path]) =>
      String(path).endsWith('.tmp'),
    );
    expect(unlinkedTemps.length).toBeGreaterThan(0);
    // And the debris is actually gone: no .tmp anywhere under the ws.
    const baselines = join(ws, 'baselines');
    const debris = (await readdir(baselines, { recursive: true })).filter((entry) =>
      String(entry).endsWith('.tmp'),
    );
    expect(debris).toEqual([]);
  });
});
