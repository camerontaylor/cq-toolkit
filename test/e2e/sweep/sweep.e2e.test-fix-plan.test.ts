// Split provenance: test/e2e/sweep/sweep.e2e.test.ts was split into the
// sweep.e2e.*.test.ts siblings in this directory; the shared fixtures live
// in sweep.e2e.helpers.ts and the original suite header sits there.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { SweepPlanConfig } from '../../../src/plans/sweep.js';
import { TEST_FIX_PLAN_ID } from '../../../src/plans/test-fix.js';
import {
  ALPHA_FIX,
  BETA_SOURCE,
  SCRATCH_PACKAGE_FILES,
  SCRATCH_PACKAGES,
} from '../../fixtures/scratch-repo/generate.js';
import { runEventsAt, runSweepPlan, type SweepRunOutcome } from './run-sweep.js';
import { gitOut, optsFor, prompts, scenario, unitRow } from './sweep.e2e.helpers.js';

// ---------------------------------------------------------------------------
// 4b. The SHIPPED test-fix plan (buildTestFixPlan) through the real executor
// ---------------------------------------------------------------------------

describe('sweep e2e: the shipped test-fix plan through the real executor', () => {
  test(
    'buildTestFixPlan is propose-only: the repair and a production edit both route to human review, nothing commits',
    { timeout: 120_000 },
    async () => {
      const scene = await scenario('cq/e2e-test-fix');
      const outcome: SweepRunOutcome = await runSweepPlan(
        optsFor(
          { ...scene, config: { ...scene.config, fixers: ['test-fix'] } },
          prompts(
            { edit: ALPHA_FIX }, // the repair that would fix alpha's seeded failure
            { write: { file: 'packages/beta/index.js', text: "export const beta = 'prod';\n" } },
          ),
          { testFixPlan: true },
        ),
      );

      // The public factory's plan ran through runPlan under its OWN id.
      expect(outcome.plan.id).toBe(TEST_FIX_PLAN_ID);
      const unitEvents = await runEventsAt(scene.journalDir, TEST_FIX_PLAN_ID, 0);
      expect(unitEvents[0]).toMatchObject({ type: 'run-started', planId: TEST_FIX_PLAN_ID });

      // Alpha: the repair is staged for review, never probed or committed.
      const alpha = unitRow(outcome.run, 'alpha', 'test-fix');
      expect(alpha.status).toBe('needs-human');
      expect(alpha.reason).toMatch(/propose-only/);
      expect(alpha.reason).toContain(ALPHA_FIX.file);
      expect(
        readFileSync(resolve(scene.repo, 'worktrees', 'test-fix', 'alpha', ALPHA_FIX.file), 'utf8'),
      ).toContain(ALPHA_FIX.newText);

      // Beta: the production edit is routed the same way, naming the path.
      const beta = unitRow(outcome.run, 'beta', 'test-fix');
      expect(beta.status).toBe('needs-human');
      expect(beta.reason).toMatch(/propose-only/);
      expect(beta.reason).toContain('packages/beta/index.js');

      for (const pkg of ['alpha', 'beta']) {
        const commits = await gitOut(
          ['rev-list', '--count', `main..cq/e2e-test-fix/test-fix/${pkg}`],
          scene.repo,
        );
        expect(commits.trim()).toBe('0');
      }
      const originHeads = await gitOut(['ls-remote', '--heads', 'origin'], scene.repo);
      expect(originHeads).not.toContain('cq/e2e-test-fix/test-fix/');
      // No fleet assembles: nothing committed, so no tracker and no PR.
      expect(outcome.assembleRun).toBeUndefined();
      expect(scene.gh.created).toHaveLength(0);
    },
  );

  test(
    'a working-tree RENAME under the test-fix plan: the production SOURCE is named alongside the destination',
    { timeout: 120_000 },
    async () => {
      const scene = await scenario('cq/e2e-test-fix-rename');
      // Beta-only fleet: the rename is the unit's whole staged set.
      const config: SweepPlanConfig = {
        ...scene.config,
        fixers: ['test-fix'],
        packages: [SCRATCH_PACKAGES[1] as { name: string; path: string }],
        packageFiles: { beta: SCRATCH_PACKAGE_FILES['beta'] ?? [] },
      };
      const outcome: SweepRunOutcome = await runSweepPlan(
        optsFor(
          { ...scene, config },
          prompts(
            {},
            {
              // Same content at a new path + the original removed: a
              // working-tree rename whose SOURCE is production code.
              write: { file: 'packages/beta/generated/calculation.js', text: BETA_SOURCE },
              delete: 'packages/beta/src/calculation.js',
            },
          ),
          { testFixPlan: true },
        ),
      );

      const beta = unitRow(outcome.run, 'beta', 'test-fix');
      expect(beta.status).toBe('needs-human');
      expect(beta.reason).toMatch(/propose-only/);
      // The sweep diff flags disable rename detection, so the deleted source
      // is a staged path in its own right — never hidden behind the new one.
      expect(beta.reason).toContain('packages/beta/src/calculation.js');
      expect(beta.reason).toContain('packages/beta/generated/calculation.js');
      const commits = await gitOut(
        ['rev-list', '--count', 'main..cq/e2e-test-fix-rename/test-fix/beta'],
        scene.repo,
      );
      expect(commits.trim()).toBe('0');
      expect(scene.gh.created).toHaveLength(0);
    },
  );
});
