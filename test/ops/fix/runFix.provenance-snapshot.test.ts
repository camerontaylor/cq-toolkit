// Issue #1185: the fix composition's provenance parent must come from the
// ENTRY CqEnv snapshot. captureProvenance used to read CQ_WORK_ID /
// CQ_PARENT_WORK_ID through inboundParentWorkId(processEnv()), so an ambient
// identity change after entry could move the recorded parent. These tests
// drive the REAL composition with a hostile ambient identity and a
// memory-only observation writer, and assert the composition-started header.
// The explicit CQ_* tiers are snapshot-only; the foreign PASEO_AGENT_ID
// fallback stays a live read (pinned in the correlation-env unit tests).
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readCqEnv, type CqEnv } from '../../../src/config/env.js';
import { currentCqEnv } from '../../../src/config/run-env.js';
import { openObservationWriter, type ObservationWriter } from '../../../src/kernel/observation.js';
import type { OpRegistryEntry } from '../../../src/kernel/types.js';
import { makeFixRun, type FixRunDeps } from '../../../src/ops/fix/runFix.js';
import {
  fixedUnitReport,
  fixingDrivers,
  fixtureIn,
  input,
  reportOf,
  stubSweepRegistries,
} from './observation-wiring.helpers.js';

const ENTRY_PARENT = '11111111-1111-4111-8111-111111111111';
const PARENT_ONLY = '33333333-3333-4333-8333-333333333333';
const AMBIENT_PARENT = '22222222-2222-4222-8222-222222222222';

let roots: string[] = [];
beforeEach(() => {
  roots = [];
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const headerOf = (writer: ObservationWriter) => {
  const header = writer.events()[0];
  if (header?.type !== 'composition-started') throw new Error('composition header missing');
  return header;
};

const runComposition = async (
  deps: FixRunDeps,
  f: Awaited<ReturnType<typeof fixtureIn>>,
): Promise<{ writer: ObservationWriter; report: ReturnType<typeof reportOf> }> => {
  const writer = await openObservationWriter({
    workId: randomUUID(),
    compositionRunId: `probe-${randomUUID()}`,
  });
  const result = await makeFixRun({
    ...deps,
    drivers: fixingDrivers(),
    registry: { get: stubSweepRegistries(fixedUnitReport()) },
    observationWriter: writer,
  })(input(f));
  return { writer, report: reportOf(result) };
};

describe('fix composition provenance identity snapshot (issue #1185)', () => {
  test('captureProvenance reads the entry snapshot, not post-entry ambient identity', async () => {
    const f = await fixtureIn(roots);
    // Entry snapshot says ENTRY_PARENT; the ambient env is changed before the
    // composition body runs. The header must keep the entry identity.
    const cqEnv = readCqEnv({ CQ_WORK_ID: ENTRY_PARENT });
    vi.stubEnv('CQ_WORK_ID', AMBIENT_PARENT);
    vi.stubEnv('CQ_PARENT_WORK_ID', '');
    vi.stubEnv('PASEO_AGENT_ID', '');
    const { writer } = await runComposition({ cqEnv }, f);
    expect(headerOf(writer).payload.correlation.parentWorkId).toBe(ENTRY_PARENT);
  });

  test('the snapshot CQ_PARENT_WORK_ID tier wins over an ambient CQ_WORK_ID', async () => {
    const f = await fixtureIn(roots);
    const cqEnv = readCqEnv({ CQ_PARENT_WORK_ID: PARENT_ONLY });
    vi.stubEnv('CQ_WORK_ID', AMBIENT_PARENT);
    vi.stubEnv('CQ_PARENT_WORK_ID', '');
    vi.stubEnv('PASEO_AGENT_ID', '');
    const { writer } = await runComposition({ cqEnv }, f);
    expect(headerOf(writer).payload.correlation.parentWorkId).toBe(PARENT_ONLY);
  });

  test('a non-UUID snapshot identity is filtered to null, never replaced by ambient', async () => {
    const f = await fixtureIn(roots);
    // The snapshot's non-UUID work id would fail CorrelationRecordSchema, so
    // it persists as null; the ambient UUID must not rescue it.
    const cqEnv = readCqEnv({ CQ_WORK_ID: 'crq:r-1' });
    vi.stubEnv('CQ_WORK_ID', AMBIENT_PARENT);
    vi.stubEnv('CQ_PARENT_WORK_ID', '');
    vi.stubEnv('PASEO_AGENT_ID', '');
    const { writer } = await runComposition({ cqEnv }, f);
    expect(headerOf(writer).payload.correlation.parentWorkId).toBeNull();
  });

  test('a nested sweep op resolves the ENTRY snapshot, never an ambient re-read', async () => {
    const f = await fixtureIn(roots);
    const cqEnv = readCqEnv({ CQ_WORK_ID: ENTRY_PARENT });
    vi.stubEnv('CQ_WORK_ID', AMBIENT_PARENT);
    vi.stubEnv('CQ_PARENT_WORK_ID', '');
    vi.stubEnv('PASEO_AGENT_ID', '');
    // Wrap the stub sweep.unit so the op records the snapshot it actually
    // sees when the composition's nested runPlan dispatches it. A direct
    // library call with no enclosing run scope proves the option threading:
    // a bare nested runPlan would fresh-read the ambient here.
    const seen: { input?: unknown } = {};
    const base = stubSweepRegistries(fixedUnitReport(), seen);
    let nestedSnapshotWorkId: unknown;
    const view = (name: string): OpRegistryEntry<never, never> | undefined => {
      const entry = base(name);
      if (name !== 'sweep.unit' || entry === undefined) return entry;
      return {
        ...entry,
        importer: async (wiring?: { cqEnv?: CqEnv }) => {
          const op = await entry.importer(wiring);
          return async (raw: never) => {
            nestedSnapshotWorkId = currentCqEnv().values['CQ_WORK_ID'];
            return op(raw);
          };
        },
      } as unknown as OpRegistryEntry<never, never>;
    };
    const writer = await openObservationWriter({
      workId: randomUUID(),
      compositionRunId: `probe-${randomUUID()}`,
    });
    await makeFixRun({
      cqEnv,
      drivers: fixingDrivers(),
      registry: { get: view },
      observationWriter: writer,
    })(input(f));
    expect(nestedSnapshotWorkId).toBe(ENTRY_PARENT);
    expect(nestedSnapshotWorkId).not.toBe(AMBIENT_PARENT);
  });
});
