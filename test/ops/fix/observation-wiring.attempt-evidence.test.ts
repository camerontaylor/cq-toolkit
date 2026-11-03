// T13 — attempt observation evidence: a unit observation failure marks the
// composition observation indeterminate, never the run. The task loop could not
// BUILD an attempt event, so it never reached the writer; the unit report
// carries the failure and the composition folds it into its observation status
// while the unit (and the run) keeps its verdict.
// Split provenance: test/ops/fix/observation-wiring.test.ts was split into
// observation-wiring.round-trip.test.ts,
// observation-wiring.unknown-evidence.test.ts,
// observation-wiring.failure-boundary.test.ts and
// observation-wiring.attempt-evidence.test.ts (this file).
import { rm } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
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
});
