// Issue #1185: the fix composition's provenance parent must come from the
// ENTRY CqEnv snapshot. captureProvenance used to read CQ_WORK_ID /
// CQ_PARENT_WORK_ID through inboundParentWorkId(processEnv()), so an ambient
// identity change after entry could move the recorded parent. These tests
// drive the REAL composition with a hostile ambient identity and a
// memory-only observation writer, and assert the composition-started header.
// The explicit CQ_* tiers are snapshot-only; the foreign PASEO_AGENT_ID
// fallback stays a live read (pinned in the correlation-env unit tests).
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { readCqEnv, type CqEnv } from '../../../src/config/env.js';
import { currentCqEnv } from '../../../src/config/run-env.js';
import { openObservationWriter, type ObservationWriter } from '../../../src/kernel/observation.js';
import type { OpRegistryEntry } from '../../../src/kernel/types.js';
import { makeFixRun, type FixRunDeps } from '../../../src/ops/fix/runFix.js';
import { sweepUnitSegments } from '../../../src/ops/sweep/unit.js';
import { scrubbedGitEnv } from '../../helpers/git-env.js';
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

  test('the assembly nested runPlan inherits the ENTRY snapshot too', async () => {
    const f = await fixtureIn(roots);
    const cqEnv = readCqEnv({ CQ_WORK_ID: ENTRY_PARENT });
    vi.stubEnv('CQ_WORK_ID', AMBIENT_PARENT);
    vi.stubEnv('CQ_PARENT_WORK_ID', '');
    vi.stubEnv('PASEO_AGENT_ID', '');
    // A resolvable PR base without a remote: point origin/main at the seed
    // commit so resolveFixPrBase verifies refs/remotes/origin/main.
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    await promisify(execFile)(
      'git',
      ['-C', f.repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD'],
      { env: scrubbedGitEnv(), timeout: 10_000 },
    );
    // The committed marker (jTPa8) the reference wiring recomposes the
    // assemble dispatch from: package/fixer/branch matching the stub
    // fleet's resolved segments, under the composition's run-state dir.
    const segments = sweepUnitSegments('cq/fixture', { package: 'scratch-repo', fixer: 'tests-1' });
    await mkdir(join(f.journalDir, 'state', 'committed', 'fixed'), { recursive: true });
    await writeFile(
      join(f.journalDir, 'state', 'committed', 'fixed', 'scratch-repo.json'),
      JSON.stringify({ package: 'scratch-repo', fixer: 'tests-1', branch: segments.branch }),
    );
    const seen: { input?: unknown } = {};
    const base = stubSweepRegistries(fixedUnitReport(), seen);
    // Capture the snapshot each nested op actually sees: the sweep unit
    // inside the sweep runPlan, and BOTH assembly legs inside the assembly
    // runPlan.
    const snapshotWorkId: Record<string, unknown> = {};
    const captureEntry = (
      name: string,
      entry: OpRegistryEntry<never, never>,
    ): OpRegistryEntry<never, never> =>
      ({
        ...entry,
        importer: async (wiring?: { cqEnv?: CqEnv }) => {
          const op = await entry.importer(wiring);
          return async (raw: never) => {
            snapshotWorkId[name] = currentCqEnv().values['CQ_WORK_ID'];
            return op(raw);
          };
        },
      }) as unknown as OpRegistryEntry<never, never>;
    const stubEntry = (name: string, value: object): OpRegistryEntry<never, never> =>
      ({
        name,
        inputSchema: z.unknown(),
        importer: async () => async () => ({ status: 'ok' as const, value }),
      }) as unknown as OpRegistryEntry<never, never>;
    const view = (name: string): OpRegistryEntry<never, never> | undefined => {
      if (name === 'pr.ensureTrackerBranch')
        return captureEntry(name, stubEntry(name, { branch: segments.branch }));
      if (name === 'pr.assemblePrs')
        return captureEntry(name, stubEntry(name, { assembled: true }));
      const entry = base(name);
      return name === 'sweep.unit' && entry !== undefined ? captureEntry(name, entry) : entry;
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
      prBodyScanner: (components) => components.map((c) => ({ component: c.component, hits: [] })),
    })({ ...input(f), pr: true, base: 'main' });
    // Both nested runs ran inside the ENTRY snapshot; the ambient re-read a
    // bare nested runPlan would take (ambient stubbed to AMBIENT_PARENT
    // above) never appears. Dropping cqEnv from EITHER option object —
    // sweep (~973) or assembly (~1208) — fails this test.
    expect(snapshotWorkId['sweep.unit']).toBe(ENTRY_PARENT);
    expect(snapshotWorkId['pr.ensureTrackerBranch']).toBe(ENTRY_PARENT);
    expect(snapshotWorkId['pr.assemblePrs']).toBe(ENTRY_PARENT);
    expect(snapshotWorkId['pr.assemblePrs']).not.toBe(AMBIENT_PARENT);
  });
});
