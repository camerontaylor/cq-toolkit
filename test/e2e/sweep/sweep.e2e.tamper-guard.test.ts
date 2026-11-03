// Split provenance: test/e2e/sweep/sweep.e2e.test.ts was split into the
// sweep.e2e.*.test.ts siblings in this directory; the shared fixtures live
// in sweep.e2e.helpers.ts and the original suite header sits there.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { makeSubprocessWorktreeEffects } from '../../../src/adapters/git/worktreeFor.js';
import { makeSalvage, makeSubprocessSalvageEffects } from '../../../src/ops/sweep/salvage.js';
import { makeSweepUnitOp } from '../../../src/ops/sweep/unit.js';
import { ALPHA_FIX } from '../../fixtures/scratch-repo/generate.js';
import { runSweepPlan, type SweepRunOutcome } from './run-sweep.js';
import {
  focusedUnitBindings,
  gitOut,
  optsFor,
  prompts,
  scenario,
  unitRow,
} from './sweep.e2e.helpers.js';

// ---------------------------------------------------------------------------
// 3. The tamper guard, on NEW files: stage first, then scan the STAGED diff
// ---------------------------------------------------------------------------

describe('sweep e2e: tamper guard on new files', () => {
  test(
    'a fixer that ADDS a file with a suppression hack: the staged scan flags it, the unit fails uncommitted',
    { timeout: 120_000 },
    async () => {
      const scene = await scenario('cq/e2e-tamper');
      const HACKED = {
        file: 'packages/beta/src/added.js',
        text: '// eslint-disable-next-line no-undef\nglobalThis.hacked = true;\n',
      };
      const result = await makeSweepUnitOp(
        focusedUnitBindings(scene, {
          run: async () => {
            writeFileSync(
              resolve(scene.repo, 'worktrees', 'fix', 'beta', HACKED.file),
              HACKED.text,
            );
            return {
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              denials: [],
              stopReason: 'complete',
            };
          },
        }),
      )({ package: 'beta', fixer: 'fix', files: ['packages/beta/test/suite.test.js'] });
      expect(result.status).toBe('failed');
      if (result.status === 'failed') {
        expect(result.error).toMatch(/tamper findings/);
        expect(result.error).toMatch(/suppression/);
        expect(result.error).toMatch(/eslint-disable/);
        expect(result.error).toMatch(/added\.js/);
      }
      const betaPath = resolve(scene.repo, 'worktrees', 'fix', 'beta');
      expect(await makeSubprocessWorktreeEffects(scene.repo).isStrictClean(betaPath)).toBe(false);
      const betaCommits = await gitOut(
        ['rev-list', '--count', 'main..cq/e2e-focused/fix/beta'],
        scene.repo,
      );
      expect(betaCommits.trim()).toBe('0');
      const staged = await gitOut(['-C', betaPath, 'diff', '--cached', '--name-only'], scene.repo);
      expect(staged).toContain('packages/beta/src/added.js');
      const salvage = await makeSalvage(makeSubprocessSalvageEffects())({
        repoRoot: scene.repo,
        entries: [
          { path: betaPath, branch: 'cq/e2e-focused/fix/beta', journal: { allTerminal: false } },
        ],
      });
      expect(salvage.status).toBe('ok');
      if (salvage.status === 'ok') expect(salvage.value.rows[0]?.class).toBe('preserve');
    },
  );
});

// ---------------------------------------------------------------------------
// 3b. The strand-retry trust pin: a driver SELF-COMMIT is never pushed (#174)
// ---------------------------------------------------------------------------

describe('sweep e2e: driver self-commit vs the strand-retry trust pin (#174)', () => {
  test(
    'a driver that COMMITS the fix itself: the stage gates see nothing, and the strand-retry refuses to push the unscanned commit',
    { timeout: 120_000 },
    async () => {
      const scene = await scenario('cq/e2e-selfcommit');
      const outcome: SweepRunOutcome = await runSweepPlan(
        optsFor(
          scene,
          prompts(
            { edit: ALPHA_FIX },
            {
              write: { file: 'packages/beta/src/self.ts', text: 'export const self = 1;\n' },
              selfCommit: { message: 'beta driver self-commit' },
            },
          ),
        ),
      );

      const alpha = unitRow(outcome.run, 'alpha');
      expect(alpha.status).toBe('ok');
      expect(alpha.report?.committed).toBe(true);
      expect(alpha.report?.committedSha).toMatch(/^[0-9a-f]{40}$/);

      const beta = unitRow(outcome.run, 'beta');
      expect(beta.status).toBe('failed');
      expect(beta.error).toMatch(/worktree HEAD moved during the fixer run/);
      expect(beta.error).toMatch(/driver self-commit is not a supported mode/);
      expect(beta.error).toMatch(/needs-human evidence/);

      const localCommits = await gitOut(
        ['rev-list', '--count', 'main..cq/e2e-selfcommit/fix/beta'],
        scene.repo,
      );
      expect(localCommits.trim()).toBe('1');
      const originHeads = await gitOut(['ls-remote', '--heads', 'origin'], scene.repo);
      expect(originHeads).toContain('cq/e2e-selfcommit/fix/alpha');
      expect(originHeads).not.toContain('cq/e2e-selfcommit/fix/beta');
    },
  );
});
