// Split provenance: test/e2e/sweep/sweep.e2e.test.ts was split into the
// sweep.e2e.*.test.ts siblings in this directory; the shared fixtures live
// in sweep.e2e.helpers.ts and the original suite header sits there.
import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  ALPHA_FIX,
  SCRATCH_PACKAGE_FILES,
  SCRATCH_PACKAGES,
} from '../../fixtures/scratch-repo/generate.js';
import type { RunReport } from '../../../src/kernel/types.js';
import { runSweepPlan } from './run-sweep.js';
import {
  assembleReport,
  gitOut,
  optsFor,
  prompts,
  scenario,
  strandAlpha,
  unitRow,
} from './sweep.e2e.helpers.js';

// ---------------------------------------------------------------------------
// 5. Assemble-empty guard and stranded-commit retry
// ---------------------------------------------------------------------------

describe('sweep e2e: assemble guard', () => {
  test(
    'an all-no-op fleet (nothing commits) dispatches NO assemble: zero gh calls',
    { timeout: 120_000 },
    async () => {
      const scene = await scenario('cq/e2e-clean');
      const outcome = await runSweepPlan(optsFor(scene, prompts({}, {})));
      const alpha = unitRow(outcome.run, 'alpha');
      const beta = unitRow(outcome.run, 'beta');
      expect(alpha.status).toBe('ok');
      expect(alpha.report?.committed).toBe(false);
      expect(beta.status).toBe('ok');
      expect(beta.report?.committed).toBe(false);
      expect(outcome.assembleRun).toBeUndefined();
      expect(scene.gh.calls).toHaveLength(0);
      expect(outcome.output).toContain('0 failing unit(s) of 2');
    },
  );
});

describe('sweep e2e: stranded commit retry', () => {
  test(
    'a run-1 push fault strands the commit; run 2 retries the push and the marker exists (resume completeness)',
    { timeout: 180_000 },
    async () => {
      const scene = await scenario('cq/e2e-stranded');
      const oneUnit = {
        ...scene,
        config: {
          ...scene.config,
          packages: [SCRATCH_PACKAGES[0] as { name: string; path: string }],
          packageFiles: { alpha: SCRATCH_PACKAGE_FILES['alpha'] ?? [] },
        },
      };
      // Run 1 with NO origin configured: alpha commits, then the push fails —
      // the unit fails and its verified fix is stranded locally.
      await gitOut(['-C', scene.repo, 'remote', 'remove', 'origin'], scene.repo);
      const first = await runSweepPlan(optsFor(oneUnit, prompts({ edit: ALPHA_FIX }, {})));
      const alphaFirst = unitRow(first.run, 'alpha');
      expect(alphaFirst.status).toBe('failed');
      expect(alphaFirst.error).toMatch(/git push of 'cq\/e2e-stranded\/fix\/alpha' failed/);
      expect(first.assembleRun).toBeUndefined();
      // The commit exists locally with no remote copy: the STRANDED state.
      const stranded = await gitOut(
        ['rev-list', '--count', 'main..cq/e2e-stranded/fix/alpha'],
        scene.repo,
      );
      expect(stranded.trim()).toBe('1');

      // Run 2 (origin restored): the fixer no-ops (the fix is already in the
      // tree) — the no-commit leg detects the branch is ahead of base and
      // RE-ATTEMPTS the push; the marker exists and the fleet assembles it.
      await gitOut(['-C', scene.repo, 'remote', 'add', 'origin', scene.origin], scene.repo);
      const second = await runSweepPlan(optsFor(oneUnit, prompts({ edit: ALPHA_FIX }, {})));
      const alphaSecond = unitRow(second.run, 'alpha');
      expect(alphaSecond.status).toBe('ok');
      expect(alphaSecond.report?.committed).toBe(false); // nothing NEW to commit
      expect(alphaSecond.report?.pushed).toBe(true); // ...but the stranded fix shipped
      const originHeads = await gitOut(['ls-remote', '--heads', 'origin'], scene.repo);
      expect(originHeads).toContain('cq/e2e-stranded/fix/alpha');
      expect(second.assembleRun).toBeDefined();
      const assembled = assembleReport(second.assembleRun as RunReport);
      expect(assembled.packages.map((row) => row.name)).toEqual(['alpha']);
      expect(second.output).toContain('0 failing unit(s) of 1');
    },
  );

  test(
    'strand-retry REFUSES with no caller-vouched runStateDir: an ahead-of-base branch is never pushed (no-vouch, #174)',
    { timeout: 600_000 },
    async () => {
      const scene = await scenario('cq/e2e-novouch');
      await strandAlpha(scene, 'cq/e2e-novouch');
      const second = await runSweepPlan(
        optsFor(scene, prompts({ edit: ALPHA_FIX }, {}), { runStateDir: null }),
      );
      const alpha = unitRow(second.run, 'alpha');
      expect(alpha.status).toBe('failed');
      expect(alpha.error).toMatch(
        /stranded pushes require an explicit caller-supplied runStateDir/,
      );
      expect(alpha.error).toMatch(/needs-human evidence/);
      const originHeads = await gitOut(['ls-remote', '--heads', 'origin'], scene.repo);
      expect(originHeads).not.toContain('cq/e2e-novouch/fix/alpha');
      expect(second.assembleRun).toBeUndefined();
    },
  );

  test(
    'strand-retry REFUSES a stripped scanned-commit record: a divergent tip is never pushed (#174)',
    { timeout: 600_000 },
    async () => {
      const scene = await scenario('cq/e2e-stripped');
      await strandAlpha(scene, 'cq/e2e-stripped');
      rmSync(join(scene.repo, 'cq-run-state', 'scanned', 'fix', 'alpha.json'));
      const second = await runSweepPlan(optsFor(scene, prompts({ edit: ALPHA_FIX }, {})));
      const alpha = unitRow(second.run, 'alpha');
      expect(alpha.status).toBe('failed');
      expect(alpha.error).toMatch(/no scanned-commit record exists for this unit/);
      expect(alpha.error).toMatch(/unscanned commit must not be pushed/);
      const originHeads = await gitOut(['ls-remote', '--heads', 'origin'], scene.repo);
      expect(originHeads).not.toContain('cq/e2e-stripped/fix/alpha');
    },
  );

  test(
    'strand-retry REFUSES a divergent tip: the recorded sha must still be HEAD (#174)',
    { timeout: 600_000 },
    async () => {
      const scene = await scenario('cq/e2e-divergent');
      await strandAlpha(scene, 'cq/e2e-divergent');
      const worktree = resolve(scene.repo, 'worktrees', 'fix', 'alpha');
      await gitOut(
        ['-C', worktree, 'commit', '--allow-empty', '-m', 'unscanned tip move'],
        scene.repo,
      );
      const second = await runSweepPlan(optsFor(scene, prompts({ edit: ALPHA_FIX }, {})));
      const alpha = unitRow(second.run, 'alpha');
      expect(alpha.status).toBe('failed');
      expect(alpha.error).toMatch(/diverges from the recorded scanned sha/);
      const originHeads = await gitOut(['ls-remote', '--heads', 'origin'], scene.repo);
      expect(originHeads).not.toContain('cq/e2e-divergent/fix/alpha');
    },
  );
});
