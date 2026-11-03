// Split provenance: test/e2e/sweep/sweep.e2e.test.ts was split into the
// sweep.e2e.*.test.ts siblings in this directory; the shared fixtures live
// in sweep.e2e.helpers.ts and the original suite header sits there.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { candidateRunsForPlan, openRunLog } from '../../../src/kernel/journal.js';
import { SWEEP_RUN_STATE_BASELINE_DIR } from '../../../src/ops/sweep/unit.js';
import { SWEEP_PLAN_ID } from '../../../src/plans/sweep.js';
import type { SweepPlanConfig } from '../../../src/plans/sweep.js';
import { TEST_FIX_PLAN_ID } from '../../../src/plans/test-fix.js';
import { ALPHA_FIX } from '../../fixtures/scratch-repo/generate.js';
import type { RunReport } from '../../../src/kernel/types.js';
import {
  runEventsAt,
  runSweepPlan,
  salvageInterruptedRun,
  type SweepRunOutcome,
} from './run-sweep.js';
import {
  assembleReport,
  gitOut,
  optsFor,
  prompts,
  scenario,
  unitRow,
} from './sweep.e2e.helpers.js';

// ---------------------------------------------------------------------------
// 6. Rescue lane (arm-a §4.2 step 5) and prep mode (UC §1 row 3)
// ---------------------------------------------------------------------------

describe('sweep e2e: rescue lane and prep mode', () => {
  test(
    'a transient fault is rescued: the -r2 re-dispatch runs, the unit lands ok, and the fleet assembles',
    { timeout: 180_000 },
    async () => {
      const scene = await scenario('cq/e2e-rescue');
      // Attempt 1 faults (marker consumed); a re-dispatch proceeds to the fix.
      const faultMarker = join(scene.root, 'alpha-faulted');
      const outcome = await runSweepPlan(
        optsFor(
          { ...scene, config: { ...scene.config, rescue: { maxRedispatch: 1 } } },
          prompts(
            {
              edit: ALPHA_FIX,
              faultOnce: { marker: faultMarker, why: 'transient crash on alpha' },
            },
            {},
          ),
        ),
      );
      // Run 1: alpha FAILED (the transient fault); the RESCUE run re-dispatched
      // sweep-alpha-fix-r2 and it landed OK.
      const alpha = unitRow(outcome.run, 'alpha');
      expect(alpha.status).toBe('failed');
      expect(alpha.error).toMatch(
        /\[INFRA\] sweep.unit alpha: the fixer worker stopped with reason 'error'/,
      );
      expect(outcome.rescueRuns).toHaveLength(1);
      const rescueRow = outcome.rescueRuns?.[0]?.jobs[0];
      expect(rescueRow?.jobId).toBe('sweep-alpha-fix-r2');
      expect(rescueRow?.result.status).toBe('ok');
      // The fleet assembles the rescued unit.
      expect(outcome.assembleRun).toBeDefined();
      const assembled = assembleReport(outcome.assembleRun as RunReport);
      expect(assembled.packages.map((row) => row.name)).toEqual(['alpha']);
    },
  );

  test(
    'a test-fix rescue re-dispatch stays journaled under the test-fix plan id, never the sweep id',
    { timeout: 180_000 },
    async () => {
      const scene = await scenario('cq/e2e-test-fix-rescue');
      const faultMarker = join(scene.root, 'alpha-faulted');
      const outcome = await runSweepPlan(
        optsFor(
          {
            ...scene,
            config: {
              ...scene.config,
              fixers: ['test-fix'],
              rescue: { maxRedispatch: 1 },
            },
          },
          prompts(
            {
              edit: ALPHA_FIX,
              faultOnce: { marker: faultMarker, why: 'transient crash on alpha' },
            },
            {},
          ),
          { testFixPlan: true },
        ),
      );

      // Run 1: the transient fault fails alpha [INFRA] — retryable.
      const alpha = unitRow(outcome.run, 'alpha', 'test-fix');
      expect(alpha.status).toBe('failed');
      expect(alpha.error).toMatch(/^\[INFRA\]/);
      // The rescue re-dispatch runs the same test-fix unit job; under the
      // propose-only contract its repair lands in human review.
      expect(outcome.rescueRuns).toHaveLength(1);
      const rescueRow = outcome.rescueRuns?.[0]?.jobs[0];
      expect(rescueRow?.jobId).toBe('sweep-alpha-test-fix-r2');
      expect(rescueRow?.result.status).toBe('needs-human');

      // Journal: the units run and the rescue run are BOTH test-fix runs —
      // the rescue never falls back to the generic sweep plan id.
      const runIds = await openRunLog(scene.journalDir).runs();
      expect(candidateRunsForPlan(runIds, TEST_FIX_PLAN_ID)).toHaveLength(2);
      expect(candidateRunsForPlan(runIds, SWEEP_PLAN_ID)).toEqual([]);
      const rescueEvents = await runEventsAt(scene.journalDir, TEST_FIX_PLAN_ID, 1);
      expect(rescueEvents[0]).toMatchObject({ type: 'run-started', planId: TEST_FIX_PLAN_ID });
      expect(
        rescueEvents.some(
          (event) => event.type === 'job-started' && event.jobId === 'sweep-alpha-test-fix-r2',
        ),
      ).toBe(true);

      // Nothing committed, so no assemble leg is composed.
      expect(outcome.assembleRun).toBeUndefined();
      expect(scene.gh.created).toHaveLength(0);
    },
  );

  test(
    'a TAMPER fault is never re-dispatched: no rescue run, straight to preserve',
    { timeout: 120_000 },
    async () => {
      const scene = await scenario('cq/e2e-tamper-rescue');
      const config: SweepPlanConfig = { ...scene.config, rescue: { maxRedispatch: 1 } };
      const outcome: SweepRunOutcome = await runSweepPlan(
        optsFor(
          { ...scene, config },
          prompts(
            { edit: ALPHA_FIX },
            {
              write: {
                file: 'packages/beta/src/added.js',
                text: '// eslint-disable-next-line no-undef\nglobalThis.hacked = true;\n',
              },
            },
          ),
        ),
      );
      // Beta's unit failed with a TAMPER verdict: NOT retryable — no rescue
      // run exists for it.
      const beta = unitRow(outcome.run, 'beta');
      expect(beta.status).toBe('failed');
      expect(beta.error).toMatch(/\[TAMPER\]/);
      expect(outcome.output).toContain('FAIL beta/fix:');
      expect(outcome.output).toContain('1 failing unit(s) of 2');
      expect(outcome.rescueRuns).toBeUndefined();
      // And the tree state routes it to preserve.
      const salvaged = await salvageInterruptedRun({
        journalDir: scene.journalDir,
        planId: SWEEP_PLAN_ID,
        config: scene.config,
        planner: outcome.planner,
        enrichedJobs: outcome.plan.jobs,
        runIndex: 0,
      });
      expect(salvaged.rows.find((row) => row.path.endsWith('fix/beta'))?.class).toBe('preserve');
      // Alpha succeeded, but beta's tamper still blocks the whole fleet gate.
      expect(outcome.assembleRun).toBeUndefined();
      expect(scene.gh.calls).toHaveLength(0);
    },
  );

  test(
    'prep mode runs probes only: baseline evidence for both packages, zero agents, zero commits, zero PRs',
    { timeout: 120_000 },
    async () => {
      const scene = await scenario('cq/e2e-prep');
      const config: SweepPlanConfig = { ...scene.config, mode: 'prep' };
      const outcome = await runSweepPlan(
        optsFor({ ...scene, config }, prompts({ edit: ALPHA_FIX }, {})),
      );
      // Both prep units landed ok with probe evidence only.
      expect(outcome.run.counts).toMatchObject({ done: 3, failed: 0, blocked: 0 });
      for (const pkg of ['alpha', 'beta']) {
        const row = unitRow(outcome.run, pkg);
        expect(row.status).toBe('ok');
        expect(row.report?.mode).toBe('prep');
        expect(row.report?.baseline.failureSet).toBeDefined();
        expect(row.report?.final).toBeUndefined();
        expect(row.report?.regression).toBeUndefined();
        expect(row.report?.committed).toBeUndefined();
        expect(row.report?.pushed).toBeUndefined();
      }
      // Zero agent invocations: the sessions dir was never created.
      expect(existsSync(scene.sessionsDir)).toBe(false);
      // Zero commits pushed and zero PRs: prep's product is the evidence.
      const originHeads = await gitOut(['ls-remote', '--heads', 'origin'], scene.repo);
      expect(originHeads.trim()).toBe('');
      expect(scene.gh.calls).toHaveLength(0);
      expect(outcome.assembleRun).toBeUndefined();
      // The baseline snapshots exist for BOTH packages (run-state, namespaced).
      for (const pkg of ['alpha', 'beta']) {
        expect(
          existsSync(
            join(
              join(scene.repo, 'cq-run-state'),
              SWEEP_RUN_STATE_BASELINE_DIR,
              'fix',
              `${pkg}.json`,
            ),
          ),
        ).toBe(true);
      }
    },
  );
});
