// Split provenance: test/ops/sweep/planSweep.test.ts was split into
// planSweep.{selector,selection,ledger,jobs,legacy-scheme,signature,subprocess}.test.ts
// plus planSweep.helpers.ts (shared fixtures). This file carries the
// dispatch-ready job contract (JSON shape, op, stable sanitized ids).
import { describe, expect, test } from 'vitest';
import { makePlanSweep, SWEEP_UNIT_OP } from '../../../src/ops/sweep/planSweep.js';
import { baseInput, changed, makePlanner, okPlan } from './planSweep.helpers.js';

// ---------------------------------------------------------------------------
// 4. Dispatch-ready jobs
// ---------------------------------------------------------------------------

describe('planSweep jobs are dispatch-ready', () => {
  test('the report is JSON-serializable; every job references SWEEP_UNIT_OP with empty dependsOn', async () => {
    const report = await okPlan(
      makePlanSweep({
        // The changed-vs-base selector needs a changed file that actually
        // maps — the default empty listing would plan ZERO jobs and the
        // dispatch-behavior loop below would pass vacuously.
        changedFiles: async () => changed('packages/core/src/a.ts'),
      }),
      baseInput({
        fixers: ['lint'],
        selector: { mode: 'changed-vs-base', base: 'main' },
        packageFiles: { core: ['a.ts'] },
      }),
    );
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
    expect(report.jobs.length).toBeGreaterThanOrEqual(1);
    for (const job of report.jobs) {
      expect(job.op).toBe(SWEEP_UNIT_OP);
      expect(job.dependsOn).toEqual([]);
      expect(report.units).toContainEqual(job.input);
    }
  });

  test('job ids are the stable sanitized sweep-<package>-<fixer>', async () => {
    const report = await okPlan(
      makePlanner(),
      baseInput({
        packages: [
          { name: 'pkg with spaces/x', path: 'p' },
          { name: 'plain', path: 'q' },
        ],
        fixers: ['type check'],
      }),
    );
    expect(report.jobs.map((j) => j.id)).toEqual([
      'sweep-pkg-with-spaces-x-type-check',
      'sweep-plain-type-check',
    ]);
  });

  test('sanitized-id collisions disambiguate deterministically', async () => {
    const input = baseInput({
      packages: [
        { name: 'a/b', path: 'p1' },
        { name: 'a', path: 'p2' },
      ],
      fixers: ['c', 'b/c'],
    });
    const first = await okPlan(makePlanner(), input);
    const second = await okPlan(makePlanner(), input);
    const ids = first.jobs.map((j) => j.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('sweep-a-b-c');
    expect(ids).toContain('sweep-a-b-c-2');
    expect(second.jobs.map((j) => j.id)).toEqual(ids);
  });
});
