// T13 — attempt observation evidence: a unit observation failure marks the
// composition observation indeterminate, never the run. The task loop could not
// BUILD an attempt event, so it never reached the writer; the unit report
// carries the failure and the composition folds it into its observation status
// while the unit (and the run) keeps its verdict. The fold is not only a row
// concern: a terminal exit that throws after a unit was collected (so the unit
// rows are never assembled) must still close the stream indeterminate.
// Split provenance: test/ops/fix/observation-wiring.test.ts was split into
// observation-wiring.round-trip.test.ts,
// observation-wiring.unknown-evidence.test.ts,
// observation-wiring.failure-boundary.test.ts and
// observation-wiring.attempt-evidence.test.ts (this file).
import { rm } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as runnerModule from '../../../src/kernel/runner.js';
import { makeFixRun } from '../../../src/ops/fix/runFix.js';
import * as unitModule from '../../../src/ops/sweep/unit.js';
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

describe('T13 attempt observation evidence', () => {
  test('a unit observation failure marks the composition observation indeterminate, not the run', async () => {
    const f = await fixture();
    try {
      const unit = fixedUnitReport();
      // The task loop could not BUILD an attempt event (strict-schema
      // rejection), so it never reached the writer; the unit report carries
      // the failure and the composition folds it into its observation status.
      unit.observationFailures = ['attempt observation failed: invalid attempt payload'];
      const result = await makeFixRun({
        drivers: fixingDrivers(),
        registry: { get: stubSweepRegistries(unit) },
      })(input(f));
      const report = reportOf(result);
      // The unit (and therefore the run) keeps its verdict.
      expect(result.status).toBe('ok');
      expect(report.units[0]?.report?.indeterminate).toBeUndefined();
      expect(report.observation?.status).toBe('indeterminate');
      expect(report.observation?.failure).toContain('attempt observation failed');
    } finally {
      await rm(f.root, { recursive: true, force: true });
      roots = roots.filter((root) => root !== f.root);
    }
  });

  test('an exit that throws after the unit was collected still folds its failures before close', async () => {
    const f = await fixture();
    try {
      const unit = fixedUnitReport();
      unit.observationFailures = ['attempt observation failed: invalid attempt payload'];
      // The composition's own unit seam dispatches (so the unit is COLLECTED
      // with its attempt-observation failure), then the kernel leg throws
      // before `report.units` is assembled. That exit never reaches the
      // row-assembly fold, so only a fold before `closeObservation()` can
      // keep the stream from closing as `durable` over incomplete evidence.
      vi.spyOn(unitModule, 'makeSweepUnitOp').mockImplementation(() => async () => ({
        status: 'ok',
        value: unit,
      }));
      const runPlan = runnerModule.runPlan;
      vi.spyOn(runnerModule, 'runPlan').mockImplementationOnce(
        async (plan, opts, registry, governance) => {
          await runPlan(plan, opts, registry, governance);
          throw new Error('kernel leg failed after unit dispatch');
        },
      );
      // Only the planner is stubbed: `sweep.unit` must resolve to the
      // composition's own seam for a collected unit to exist.
      const sweep = stubSweepRegistries(unit);
      const result = await makeFixRun({
        drivers: fixingDrivers(),
        registry: { get: (name) => (name === 'sweep.unit' ? undefined : sweep(name)) },
      })(input(f));
      const report = reportOf(result);
      expect(result.status).toBe('failed');
      expect(report.observation?.status).toBe('indeterminate');
      expect(report.observation?.failure).toContain('attempt observation failed');
    } finally {
      await rm(f.root, { recursive: true, force: true });
      roots = roots.filter((root) => root !== f.root);
    }
  });
});
