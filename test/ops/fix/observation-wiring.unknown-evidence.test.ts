// T30 — unknown evidence: an unreturned kernel run stays unlinked. The stream
// still observes its own boundaries, but the kernel-run link names only the run
// the composition actually RETURNED (never a guessed id), a thrown runPlan
// records no links at all, and a non-UUID directory never fails the scan.
// Split provenance: test/ops/fix/observation-wiring.test.ts was split into
// observation-wiring.round-trip.test.ts,
// observation-wiring.unknown-evidence.test.ts (this file),
// observation-wiring.failure-boundary.test.ts and
// observation-wiring.attempt-evidence.test.ts.
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readObservations } from '../../../src/kernel/observation.js';
import * as runnerModule from '../../../src/kernel/runner.js';
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

describe('T30 unknown evidence: unreturned kernel runs stay unlinked', () => {
  test('a returned run requiring human review links its actual kernel run id', async () => {
    const f = await fixture();
    try {
      // The unit requires human review, but the kernel run still returns.
      const failingUnit = {
        ...fixedUnitReport(),
        budgetStopped: true,
      };
      const result = await makeFixRun({
        drivers: fixingDrivers(),
        registry: { get: stubSweepRegistries(failingUnit) },
      })(input(f));
      expect(result.status).not.toBe('ok');
      const report = reportOf(result);
      // The stream still observed its boundaries — but the kernel-run link
      // names only the run the composition actually RETURNED.
      const streams = await readObservations(f.journalDir);
      const links = streams.flatMap((stream) =>
        stream.events.filter((event) => event.type === 'kernel-run-linked'),
      );
      expect(links).toHaveLength(1);
      for (const link of links) {
        if (link.type !== 'kernel-run-linked') continue;
        // Never a guessed link: the linked id is the actual returned run's.
        expect(link.payload.kernelRunId).toBe(report.run?.runId);
      }
    } finally {
      await rm(f.root, { recursive: true, force: true });
      roots = roots.filter((root) => root !== f.root);
    }
  });

  test('a thrown runPlan records no kernel-run links', async () => {
    const f = await fixture();
    vi.spyOn(runnerModule, 'runPlan').mockRejectedValueOnce(new Error('kernel run failed'));
    const result = await makeFixRun()(input(f));
    expect(result.status).toBe('failed');
    expect(reportOf(result).run).toBeUndefined();
    const streams = await readObservations(f.journalDir);
    expect(streams).toHaveLength(1);
    expect(streams[0]?.events[0]?.type).toBe('composition-started');
    expect(
      streams.flatMap((stream) =>
        stream.events.filter((event) => event.type === 'kernel-run-linked'),
      ),
    ).toEqual([]);
    expect(reportOf(result).observation?.kernelRuns).toEqual([]);
  });

  test('readObservations ignores non-UUID directories instead of failing the scan', async () => {
    const f = await fixture();
    try {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(join(f.journalDir, 'observations', 'not-a-uuid'), { recursive: true });
      expect(await readObservations(f.journalDir)).toHaveLength(0);
    } finally {
      await rm(f.root, { recursive: true, force: true });
      roots = roots.filter((root) => root !== f.root);
    }
  });
});
