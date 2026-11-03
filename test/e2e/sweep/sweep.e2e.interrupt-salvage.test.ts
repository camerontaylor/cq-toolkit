// Split provenance: test/e2e/sweep/sweep.e2e.test.ts was split into the
// sweep.e2e.*.test.ts siblings in this directory; the shared fixtures live
// in sweep.e2e.helpers.ts and the original suite header sits there.
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { openRunLog } from '../../../src/kernel/journal.js';
import { SWEEP_RUN_STATE_BASELINE_DIR } from '../../../src/ops/sweep/unit.js';
import { SWEEP_PLAN_ID } from '../../../src/plans/sweep.js';
import { ALPHA_FIX } from '../../fixtures/scratch-repo/generate.js';
import type { RunReport } from '../../../src/kernel/types.js';
import { runSweepPlan, salvageInterruptedRun } from './run-sweep.js';
import {
  assembleReport,
  expectCompleteJournal,
  expectTrackerFirstFleet,
  gitOut,
  optsFor,
  prompts,
  scenario,
  unitRow,
} from './sweep.e2e.helpers.js';

// ---------------------------------------------------------------------------
// 2. Interrupt → salvage → re-invoke (reuse + the I7 re-probe)
// ---------------------------------------------------------------------------

describe('sweep e2e: interrupt mid-run → salvage → re-invoke', () => {
  test(
    'beta faults after alpha completed: salvage says alpha reuse / beta resume; the re-invoke reuses both trees and re-probes both baselines (I7)',
    { timeout: 180_000 },
    async () => {
      const scene = await scenario('cq/e2e-interrupt');
      // The I7 re-probe observable: the run-state baseline snapshot is
      // rewritten exactly once per unit run (right after the baseline probe),
      // so a re-run's fresh mtime is the re-probe's evidence.
      const alphaSnapshot = join(
        join(scene.repo, 'cq-run-state'),
        SWEEP_RUN_STATE_BASELINE_DIR,
        'fix',
        'alpha.json',
      );

      // Run 1: alpha completes (fix committed + pushed); the fake agent
      // faults on beta (exit 1, no edit) — the mid-run interrupt.
      const first = await runSweepPlan(
        optsFor(scene, prompts({ edit: ALPHA_FIX }, { fault: 'simulated crash on beta' })),
      );
      const beta = unitRow(first.run, 'beta');
      expect(beta.status).toBe('failed');
      expect(beta.error).toMatch(/fixer worker stopped with reason 'error'/);
      // The fleet gate: one failed unit withholds the assemble dispatch.
      expect(first.assembleRun).toBeUndefined();
      expect(scene.gh.created).toHaveLength(0); // no PR without its full fleet
      // The push leg (jSKJL): alpha's committed branch is on the origin;
      // beta's is not (it never committed, so it never pushed).
      const originHeadsAfterRun1 = await gitOut(['ls-remote', '--heads', 'origin'], scene.repo);
      expect(originHeadsAfterRun1).toContain('cq/e2e-interrupt/fix/alpha');
      expect(originHeadsAfterRun1).not.toContain('cq/e2e-interrupt/fix/beta');

      // SALVAGE over run 1's journal tail: alpha clean+done → reuse;
      // beta clean but NOT done → resume. Both trees exist.
      const salvaged = await salvageInterruptedRun({
        journalDir: scene.journalDir,
        planId: SWEEP_PLAN_ID,
        config: scene.config,
        planner: first.planner,
        enrichedJobs: first.plan.jobs,
        runIndex: 0,
      });
      const alphaRow = salvaged.rows.find((row) => row.path.endsWith('fix/alpha'));
      const betaSalvageRow = salvaged.rows.find((row) => row.path.endsWith('fix/beta'));
      expect(alphaRow?.class).toBe('reuse');
      expect(betaSalvageRow?.class).toBe('resume');
      expect(salvaged.counts).toMatchObject({ reuse: 1, resume: 1, preserve: 0 });

      // RE-INVOKE (same plan id, same journalDir — a second run file; the
      // sweep-layer resume is salvage + reuse, not journal replay, so the
      // unit jobs re-execute and the reused trees must RE-PROBE, I7).
      const snapshotMtimeBefore = statSync(alphaSnapshot).mtimeMs;
      const second = await runSweepPlan(optsFor(scene, prompts({ edit: ALPHA_FIX }, {})));
      // The reused tree RE-PROBED its baseline: the snapshot was rewritten.
      expect(statSync(alphaSnapshot).mtimeMs).toBeGreaterThan(snapshotMtimeBefore);

      // Alpha's unit: REUSED tree — and the reuse is clean WITHOUT any cache
      // eviction, because the tree carries NO baseline state (the snapshot
      // lives in the run-state dir outside the worktree, I7). No second
      // commit either: the fixer no-oped on the already-fixed tree.
      const alphaSecond = unitRow(second.run, 'alpha');
      expect(alphaSecond.status).toBe('ok');
      expect(alphaSecond.report?.worktree.reused).toBe(true);
      expect(alphaSecond.report?.worktree.clearedBaselineCaches).toEqual([]);
      expect(alphaSecond.report?.committed).toBe(false);
      expect(unitRow(second.run, 'beta').report?.worktree.reused).toBe(true);
      // The tree itself: no '.cq' (or any baseline state) inside; the
      // snapshot is in the RUN-PREFIX-NAMESPACED run-state dir (jTPbC),
      // keyed kind/slug.
      expect(existsSync(resolve(scene.repo, 'worktrees', 'fix', 'alpha', '.cq'))).toBe(false);
      expect(
        existsSync(
          join(join(scene.repo, 'cq-run-state'), SWEEP_RUN_STATE_BASELINE_DIR, 'fix', 'alpha.json'),
        ),
      ).toBe(true);

      // The fleet assembles now — from the COMMITTED MARKERS (jTPa8): alpha
      // committed+pushed in run 1 (its marker survives); beta no-oped in run
      // 2 (no commit, no marker) → the assemble covers ALPHA ONLY: a
      // no-change unit never assembles an empty-diff PR.
      expect(second.assembleRun).toBeDefined();
      const assembled = assembleReport(second.assembleRun as RunReport);
      expect(assembled.tracker).toMatchObject({ number: 1, created: true });
      expect(assembled.packages.map((row) => row.name)).toEqual(['alpha']);
      expectTrackerFirstFleet(
        scene,
        'cq/e2e-interrupt',
        ['cq/e2e-interrupt/fix/alpha'],
        assembled.packages,
      );

      // Journaled runs: units 1 (0), the beta rescue re-dispatch (1), units
      // 2 (2), the marker-filtered assemble (3) — each complete with a
      // run-finished frame.
      const runIds = await openRunLog(scene.journalDir).runs();
      expect(runIds).toHaveLength(4);
      await expectCompleteJournal(
        scene.journalDir,
        [
          ['sweep-plan', 'sweep.planSweep'],
          ['sweep-alpha-fix', 'sweep.unit'],
          ['sweep-beta-fix', 'sweep.unit'],
        ],
        2,
      );
      await expectCompleteJournal(
        scene.journalDir,
        [
          ['sweep-tracker-branch', 'pr.ensureTrackerBranch'],
          ['sweep-assemble', 'pr.assemblePrs'],
        ],
        3,
      );

      // The re-invoke's output is failures-only clean as well.
      expect(second.output).toContain('0 failing unit(s) of 2');
    },
  );
});
