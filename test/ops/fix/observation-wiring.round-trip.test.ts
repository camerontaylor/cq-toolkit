// T30 — writer injection and the durable round-trip: makeRegistry wraps the
// existing exported const registry array and injects the observation writer
// through the sweep.unit importer's RESOLVED RUNTIME BINDINGS (the serialized
// dispatch input carries no writer/callback, and the exported default registry
// is unchanged); makeFixRun then opens one composition stream, writes its
// composition-started header, links the RETURNED kernel run explicitly
// (kernel-run-linked), and persists it under journalDir.
// Split provenance: test/ops/fix/observation-wiring.test.ts was split into
// observation-wiring.round-trip.test.ts (this file),
// observation-wiring.unknown-evidence.test.ts,
// observation-wiring.failure-boundary.test.ts and
// observation-wiring.attempt-evidence.test.ts.
import { rm } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readObservations } from '../../../src/kernel/observation.js';
import { ReportV2Schema } from '../../../src/kernel/schema.js';
import { makeRegistry, registry } from '../../../src/ops/sweep/registry.js';
import { makeFixRun } from '../../../src/ops/fix/runFix.js';
import {
  fixedUnitReport,
  fixingDrivers,
  fixtureIn,
  input,
  reportOf,
  stubSweepRegistries,
} from './observation-wiring.helpers.js';

let roots: string[] = [];
beforeEach(() => {
  roots = [];
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const fixture = () => fixtureIn(roots);

describe('T30 makeRegistry wraps the exported array', () => {
  test('the default exported registry is unchanged by makeRegistry options', () => {
    const built = makeRegistry();
    expect(built.map((entry) => entry.name)).toEqual(registry.map((entry) => entry.name));
    expect(makeRegistry({}).map((e) => e.name)).toEqual(registry.map((e) => e.name));
  });

  test('the sweep.unit importer is a distinct function; no writer in any schema', () => {
    const observed = makeRegistry({});
    const unitDefault = registry.find((entry) => entry.name === 'sweep.unit');
    const unitObserved = observed.find((entry) => entry.name === 'sweep.unit');
    expect(unitDefault?.importer).not.toBe(unitObserved?.importer);
    // A writer/callback is runtime-only: strict schemas refuse an extra key,
    // so a writer serialized into plan JSON cannot even validate.
    const probe = unitDefault?.inputSchema.safeParse({
      package: 'p',
      fixer: 'f',
      files: [],
      repoRoot: '/r',
      runPrefix: 'cq/x',
      base: 'HEAD',
      observationWriter: () => {},
    });
    expect(probe?.success).toBe(false);
  });
});

describe('T30 round-trip through the fix composition', () => {
  test('header, runtime injection and explicit kernel-run link persist durably', async () => {
    const f = await fixture();
    const seen: { input?: unknown } = {};
    try {
      const result = await makeFixRun({
        drivers: fixingDrivers(),
        registry: { get: stubSweepRegistries(fixedUnitReport(), seen) },
      })(input(f));
      // The composition ran; the stream persisted under journalDir.
      expect(reportOf(result).observation).toBeDefined();
      expect(ReportV2Schema.safeParse(reportOf(result).reportV2).success).toBe(true);
      expect(reportOf(result).reportV2?.availability['']?.state).toBe('known');
      // No writer/callback ever reached the serialized dispatch input.
      expect(JSON.stringify(seen.input)).not.toContain('observationWriter');
      expect(JSON.stringify(seen.input)).not.toContain('append');
      const streams = await readObservations(f.journalDir);
      expect(streams).toHaveLength(1);
      const stream = streams[0];
      if (stream === undefined) throw new Error('stream missing');
      expect(stream.complete).toBe(true);
      expect(stream.events[0]?.type).toBe('composition-started');
      const header = stream.events[0];
      if (header?.type !== 'composition-started') throw new Error('header missing');
      // No raw remote ever persists: with no git remote, repoId is the
      // schema's null/unavailable (never the remote string); the hashed
      // digest form is exercised wherever a remote exists.
      const repoId = header.payload.provenance.repoId;
      expect(repoId === null || /^sha256:[0-9a-f]{64}$/.test(repoId)).toBe(true);
      expect(JSON.stringify(stream.events)).not.toContain('github.com');
      // Exactly one explicit kernel-run link, after the header.
      const links = stream.events.filter((event) => event.type === 'kernel-run-linked');
      expect(links).toHaveLength(1);
      expect(links[0]?.payload.kernelRunId).toBe(reportOf(result).run?.runId);
    } finally {
      await rm(f.root, { recursive: true, force: true });
      roots = roots.filter((root) => root !== f.root);
    }
  });

  test('memory-only mode builds the stream and declares persistence unavailable', async () => {
    const f = await fixture();
    try {
      const result = await makeFixRun({
        drivers: fixingDrivers(),
        registry: { get: stubSweepRegistries(fixedUnitReport()) },
      })({
        repoRoot: f.repo,
        source: 'tests' as const,
        selector: { mode: 'workspace-all' as const },
        runPrefix: 'cq/fixture',
      });
      const report = reportOf(result);
      expect(report.observation).toBeDefined();
      expect(ReportV2Schema.safeParse(report.reportV2).success).toBe(true);
      expect(report.observation?.persistence).toBe('unavailable');
      expect(report.observation?.kernelRuns).toEqual([]);
      // No durability claim: no stream file was created anywhere.
      const streams = await readObservations(f.journalDir);
      expect(streams).toHaveLength(0);
    } finally {
      await rm(f.root, { recursive: true, force: true });
      roots = roots.filter((root) => root !== f.root);
    }
  });
});
