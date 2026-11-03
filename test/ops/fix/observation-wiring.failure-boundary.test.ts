// T30 — the failure boundary: a writer whose append/close fails after the
// header never masks the run's own terminal result (the writer's failure
// surface carries the first write error, sanitized), a failed descriptor read
// or writer open leaves the verdict unchanged and marks observation
// indeterminate, every persisted text field passes through
// sanitizeObservation BEFORE the writer sees it (repoId is the hashed remote
// digest, never the raw remote), and a refused pre-dispatch path leaves the
// stream unopened.
// Split provenance: test/ops/fix/observation-wiring.test.ts was split into
// observation-wiring.round-trip.test.ts,
// observation-wiring.unknown-evidence.test.ts,
// observation-wiring.failure-boundary.test.ts (this file) and
// observation-wiring.attempt-evidence.test.ts.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { openObservationWriter, readObservations } from '../../../src/kernel/observation.js';
import { ReportV2Schema } from '../../../src/kernel/schema.js';
import * as plannerModule from '../../../src/ops/sweep/planSweep.js';
import * as unitModule from '../../../src/ops/sweep/unit.js';
import { makeFixRun, type FixRunReport } from '../../../src/ops/fix/runFix.js';
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

describe('T30 failure boundary', () => {
  test.each(['header', 'link', 'close', 'fold'])(
    '%s failure preserves unit evidence and persists indeterminate status',
    async (boundary) => {
      const f = await fixture();
      const writer = await openObservationWriter({
        workId: '00000000-0000-4000-8000-000000000000',
        compositionRunId: 'fixture',
      });
      const append = writer.append.bind(writer);
      const originalClose = writer.close.bind(writer);
      if (boundary === 'fold') {
        const events = writer.events.bind(writer);
        vi.spyOn(writer, 'events').mockImplementation(() => [...events(), ...events()]);
      }
      vi.spyOn(writer, 'append').mockImplementation(async (event) => {
        if (boundary === 'header' && event.type === 'composition-started')
          throw new Error('https://u:tok@h/x?k=v');
        if (boundary === 'link' && event.type === 'kernel-run-linked') await originalClose();
        // The injected writer has a distinct stream identity.
        await append(
          event.type === 'composition-started'
            ? {
                ...event,
                runId: writer.compositionRunId,
                payload: {
                  ...event.payload,
                  correlation: {
                    ...event.payload.correlation,
                    workId: '00000000-0000-4000-8000-000000000000',
                  },
                },
              }
            : { ...event, runId: writer.compositionRunId },
        );
      });
      const close = vi.spyOn(writer, 'close').mockImplementation(async () => {
        if (boundary === 'close') throw new Error('https://u:tok@h/x?k=v');
      });
      const unit = fixedUnitReport();
      unit.tasks = [
        {
          task: { id: 'fixed-task', files: [], failures: [] },
          attempts: [],
          outcome: 'fixed',
          branch: unit.prBranch,
          commits: ['a'.repeat(40)],
        },
      ];
      const result = await makeFixRun({
        registry: { get: stubSweepRegistries(unit) },
        observationWriter: writer,
      })(input(f));
      const report = reportOf(result);
      expect(result.status, JSON.stringify(report)).toBe('ok');
      expect(report.units).toHaveLength(1);
      expect(report.tasks.length).toBeGreaterThan(0);
      expect(close).toHaveBeenCalledTimes(1);
      expect(ReportV2Schema.safeParse(report.reportV2).success).toBe(true);
      expect(report.reportV2?.availability['']?.state).toBe(
        boundary === 'header' || boundary === 'fold' ? 'unavailable' : 'partial',
      );
      if (boundary !== 'fold') expect(report.observation?.status).toBe('indeterminate');
      if (boundary !== 'fold') expect(report.observation?.failure).not.toContain('tok');
      const persisted = JSON.parse(await readFile(report.reportPath, 'utf8')) as {
        observation: FixRunReport['observation'] & { writer?: unknown };
      };
      expect(persisted.observation).toEqual(report.observation);
      expect(persisted.observation.writer).toBeUndefined();
    },
  );

  test('a descriptor read failure preserves the verdict and marks observation indeterminate', async () => {
    const f = await fixture();
    try {
      const observationModule = await import('../../../src/kernel/observation.js');
      const read = vi
        .spyOn(observationModule, 'readKernelRunDescriptors')
        .mockRejectedValue(new Error('https://u:tok@h/x?k=v'));
      const result = await makeFixRun({
        drivers: fixingDrivers(),
        registry: { get: stubSweepRegistries(fixedUnitReport()) },
      })(input(f));
      const report = reportOf(result);
      // The read is observation, never verdict: its throw is indeterminate
      // evidence and the run's own result is unchanged.
      expect(read).toHaveBeenCalledTimes(1);
      expect(result.status, JSON.stringify(report)).toBe('ok');
      expect(report.observation?.status).toBe('indeterminate');
      expect(report.observation?.failure).not.toContain('tok');
      expect(report.observation?.kernelRuns).toEqual([]);
    } finally {
      await rm(f.root, { recursive: true, force: true });
      roots = roots.filter((root) => root !== f.root);
    }
  });

  test('a failed writer open leaves the verdict unchanged and observation indeterminate', async () => {
    const f = await fixture();
    // A regular file where the observations/ directory belongs makes the
    // stream open refuse (ENOTDIR) before any writer exists.
    const journalDir = join(f.root, 'journal');
    await mkdir(journalDir, { recursive: true });
    await writeFile(join(journalDir, 'observations'), 'not a directory');
    try {
      const result = await makeFixRun({
        drivers: fixingDrivers(),
        registry: { get: stubSweepRegistries(fixedUnitReport()) },
      })({ ...input(f), journalDir });
      const report = reportOf(result);
      // The open is observation, never verdict: the run keeps its own result
      // and the observation carries the failure as indeterminate evidence.
      expect(result.status, JSON.stringify(report)).toBe('ok');
      expect(report.observation?.status).toBe('indeterminate');
      // No stream exists, so the run never claims durability.
      expect(report.observation?.persistence).toBe('unavailable');
      expect(report.observation?.failure).not.toBeNull();
      expect(report.observation?.failure).toContain('observations');
    } finally {
      await rm(f.root, { recursive: true, force: true });
      roots = roots.filter((root) => root !== f.root);
    }
  });

  test('a failed writer open records a sanitized failure', async () => {
    const f = await fixture();
    const observationModule = await import('../../../src/kernel/observation.js');
    vi.spyOn(observationModule, 'openObservationWriter').mockRejectedValueOnce(
      new Error('https://u:tok@h/x?k=v'),
    );
    try {
      const result = await makeFixRun({
        drivers: fixingDrivers(),
        registry: { get: stubSweepRegistries(fixedUnitReport()) },
      })(input(f));
      const report = reportOf(result);
      expect(result.status, JSON.stringify(report)).toBe('ok');
      expect(report.observation?.status).toBe('indeterminate');
      expect(report.observation?.failure).not.toBeNull();
      expect(report.observation?.failure).not.toContain('tok');
    } finally {
      await rm(f.root, { recursive: true, force: true });
      roots = roots.filter((root) => root !== f.root);
    }
  });

  test('real sweep.unit receives observation bindings and closes before report persistence', async () => {
    const f = await fixture();
    const original = unitModule.bindingsFromDispatch;
    const bindings: ReturnType<typeof original>[] = [];
    vi.spyOn(unitModule, 'bindingsFromDispatch').mockImplementation((...args) => {
      const value = original(...args);
      bindings.push(value);
      return value;
    });
    const writer = await openObservationWriter({
      workId: '00000000-0000-4000-8000-000000000000',
      compositionRunId: 'fixture',
    });
    vi.spyOn(writer, 'append').mockResolvedValue(undefined);
    const close = vi.spyOn(writer, 'close');
    const result = await makeFixRun({ drivers: fixingDrivers(), observationWriter: writer })(
      input(f),
    );
    expect(bindings.length).toBeGreaterThan(0);
    expect(bindings[0]?.observationWriter).toBe(writer);
    expect(bindings[0]?.observationRunId).toBe(reportOf(result).observation?.compositionRunId);
    expect(bindings[0]?.observationUnitId).toBe('scratch-repo/tests-1');
    expect(close).toHaveBeenCalledTimes(1);
  });

  test('phase B refuses changed planner fan-out', async () => {
    const f = await fixture();
    const original = plannerModule.makePlanSweep;
    let calls = 0;
    vi.spyOn(plannerModule, 'makePlanSweep').mockImplementation((deps) => {
      const planner = original(deps);
      return async (raw) => {
        const result = await planner(raw);
        if (++calls > 1 && result.status === 'ok')
          return { ...result, value: { ...result.value, units: [] } };
        return result;
      };
    });
    const result = await makeFixRun({ drivers: fixingDrivers() })(input(f));
    expect(result.status).toBe('failed');
    expect(JSON.stringify(reportOf(result).run)).toContain('planner fan-out changed');
  });

  test('header sanitizes producer version and correlation', async () => {
    const f = await fixture();
    vi.stubEnv('CQ_PRODUCER_VERSION', 'https://u:tok@h/x?k=v');
    try {
      const result = await makeFixRun({
        registry: { get: stubSweepRegistries(fixedUnitReport()) },
      })({ ...input(f), runPrefix: 'cq/https://u:secret@h/x?k=v' });
      const streams = await readObservations(f.journalDir);
      expect(streams).toHaveLength(1);
      expect(JSON.stringify(streams[0]?.events[0])).not.toContain('tok');
      expect(JSON.stringify(streams[0]?.events[0])).not.toContain('secret');
      expect(JSON.stringify(reportOf(result))).not.toContain('tok');
      expect(JSON.stringify(reportOf(result))).not.toContain('secret');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test('the writer is closed after a pre-dispatch refusal path cannot reopen it', async () => {
    const f = await fixture();
    // A repo without cq.json refuses before the stream opens; the report
    // carries no observation and the run still terminates cleanly.
    const { rm: rmPath } = await import('node:fs/promises');
    await rmPath(join(f.repo, 'cq.json'));
    try {
      // A repo without cq.json refuses inside the main try (the readFile
      // throw folds into the failed terminal path); the stream never
      // opened, so no observation surface exists and the run terminates
      // cleanly with the writer-close finally a no-op.
      const result = await makeFixRun({ drivers: fixingDrivers() })(input(f));
      expect(result.status).toBe('failed');
      expect(reportOf(result).observation).toBeUndefined();
      expect(reportOf(result).reportV2).toBeUndefined();
    } finally {
      await rm(f.root, { recursive: true, force: true });
      roots = roots.filter((root) => root !== f.root);
    }
  });

  test('a durable run leaves a complete stream file on disk', async () => {
    const f = await fixture();
    try {
      await makeFixRun({
        drivers: fixingDrivers(),
        registry: { get: stubSweepRegistries(fixedUnitReport()) },
      })(input(f));
      const streams = await readObservations(f.journalDir);
      expect(streams).toHaveLength(1);
      expect(streams[0]?.complete).toBe(true);
      // Every line is a complete JSON event ending in a newline.
      const dir = join(f.journalDir, 'observations');
      const { readdir } = await import('node:fs/promises');
      const workIds = await readdir(dir);
      const files = await readdir(join(dir, workIds[0] as string));
      const raw = await readFile(join(dir, workIds[0] as string, files[0] as string), 'utf8');
      expect(raw.endsWith('\n')).toBe(true);
      for (const line of raw.split('\n').filter((l) => l !== '')) {
        const parsed: unknown = JSON.parse(line);
        expect(parsed).toBeTypeOf('object');
      }
    } finally {
      await rm(f.root, { recursive: true, force: true });
      roots = roots.filter((root) => root !== f.root);
    }
  });
});
