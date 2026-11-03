// Split provenance: test/e2e/sweep/sweep.e2e.test.ts was split into the
// sweep.e2e.*.test.ts siblings in this directory; the shared fixtures live
// in sweep.e2e.helpers.ts and the original suite header sits there.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { makeSweepUnitOp, type SweepUnitDispatchInput } from '../../../src/ops/sweep/unit.js';
import type { SweepPlanConfig } from '../../../src/plans/sweep.js';
import { BETA_SOURCE } from '../../fixtures/scratch-repo/generate.js';
import type { RunReport } from '../../../src/kernel/types.js';
import { runSweepPlan } from './run-sweep.js';
import {
  assembleReport,
  expectTrackerFirstFleet,
  focusedUnitBindings,
  gitOut,
  optsFor,
  prompts,
  scenario,
  unitRow,
} from './sweep.e2e.helpers.js';

// ---------------------------------------------------------------------------
// 4. Scoped-package slugs (jTPa1) and rename-side scope (jVgCj)
// ---------------------------------------------------------------------------

describe('sweep e2e: scoped packages and rename-side scope', () => {
  test(
    '@scope/gamma derives the slug scope-gamma: the unit runs, commits, and pushes on the normalized branch',
    { timeout: 120_000 },
    async () => {
      const scene = await scenario('cq/e2e-scoped');
      // Seed ONE scoped package with alpha's failing production-module shape.
      const pkgDir = join(scene.repo, 'packages', '@scope', 'gamma');
      mkdirSync(join(pkgDir, 'src'), { recursive: true });
      writeFileSync(
        join(pkgDir, 'package.json'),
        `${JSON.stringify({ name: '@scope/gamma', version: '1.0.0', private: true }, null, 2)}\n`,
      );
      writeFileSync(
        join(pkgDir, 'src', 'calculation.js'),
        [
          "'use strict';",
          'const sum = (a, b) => a + b;',
          'const expected = 3;',
          'if (sum(1, 1) !== expected) {',
          "  throw new Error('expected ' + expected + ', got ' + sum(1, 1));",
          '}',
          '',
        ].join('\n'),
      );
      await gitOut(['-C', scene.repo, 'add', '-A'], scene.repo);
      await gitOut(['-C', scene.repo, 'commit', '-q', '-m', 'seed: @scope/gamma'], scene.repo);

      const GAMMA_FIX = {
        file: 'packages/@scope/gamma/src/calculation.js',
        oldText: 'const expected = 3;',
        newText: 'const expected = 2;',
      };
      const config: SweepPlanConfig = {
        ...scene.config,
        packages: [{ name: '@scope/gamma', path: 'packages/@scope/gamma' }],
        packageFiles: { '@scope/gamma': ['packages/@scope/gamma/src/calculation.js'] },
      };
      const outcome = await runSweepPlan(
        optsFor({ ...scene, config }, (unit) =>
          [
            `You are the ${unit.fixer} fixer for package ${unit.package}.`,
            'Apply exactly the edit in the instruction line, then report.',
            `@SWEEP-AGENT ${JSON.stringify({ edit: GAMMA_FIX })}`,
          ].join('\n'),
        ),
      );

      // The scoped unit RAN (the old fold derived the undeliverable
      // `-scope-gamma`, which SEGMENT_RE refuses): fixed, committed, pushed
      // on the normalized branch.
      const gamma = unitRow(outcome.run, '@scope/gamma');
      expect(gamma.status).toBe('ok');
      expect(gamma.report?.baseline.verdict).toBe('failing');
      expect(gamma.report?.committed).toBe(true);
      expect(gamma.report?.pushed).toBe(true);
      expect(gamma.report?.prBranch).toBe('cq/e2e-scoped/fix/scope-gamma');
      const originHeads = await gitOut(['ls-remote', '--heads', 'origin'], scene.repo);
      expect(originHeads).toContain('cq/e2e-scoped/fix/scope-gamma');
      // The marker-filtered assemble covers the scoped unit under its
      // normalized branch.
      expect(outcome.assembleRun).toBeDefined();
      const assembled = assembleReport(outcome.assembleRun as RunReport);
      expect(assembled.packages.map((row) => row.name)).toEqual(['@scope/gamma']);
      expectTrackerFirstFleet(
        scene,
        'cq/e2e-scoped',
        ['cq/e2e-scoped/fix/scope-gamma'],
        assembled.packages,
      );
    },
  );

  test(
    'a working-tree RENAME across an allowlist: the SOURCE path is flagged too',
    { timeout: 120_000 },
    async () => {
      const scene = await scenario('cq/e2e-rename');
      const result = await makeSweepUnitOp({
        ...focusedUnitBindings(scene, {
          run: async () => {
            const worktree = resolve(scene.repo, 'worktrees', 'test-fix', 'beta');
            mkdirSync(resolve(worktree, 'packages/beta/generated'), { recursive: true });
            writeFileSync(resolve(worktree, 'packages/beta/generated/calculation.js'), BETA_SOURCE);
            rmSync(resolve(worktree, 'packages/beta/src/calculation.js'), { force: true });
            return {
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              denials: [],
              stopReason: 'complete',
            };
          },
        }),
        stagePathAllowlist: { patterns: ['^packages/beta/generated/'] },
      })({ package: 'beta', fixer: 'test-fix', files: ['packages/beta/src/calculation.js'] });

      const betaPath = resolve(scene.repo, 'worktrees', 'test-fix', 'beta');
      const nameStatus = (
        await gitOut(
          // Force rename detection: an ambient diff.renames=false would
          // report D + A and hide the rename framing this test asserts.
          ['-C', betaPath, 'diff', '--cached', '--find-renames', '--name-status', '-z'],
          scene.repo,
        )
      )
        .split('\0')
        .filter((token) => token !== '');
      const renameIndex = nameStatus.findIndex((token) => token.startsWith('R'));
      expect(renameIndex).toBeGreaterThanOrEqual(0);
      expect(nameStatus.slice(renameIndex, renameIndex + 3)).toEqual([
        expect.stringMatching(/^R/),
        'packages/beta/src/calculation.js',
        'packages/beta/generated/calculation.js',
      ]);

      expect(result.status).toBe('failed');
      if (result.status === 'failed') {
        // The destination alone matches; the real git rename framing must
        // expose the production SOURCE to the allowlist.
        expect(result.error).toMatch(/outside the allowlist/);
        expect(result.error).toContain('packages/beta/src/calculation.js');
      }
      expect(scene.gh.created).toHaveLength(0);
    },
  );
});

test(
  'the default per-unit scope: an alpha worker editing beta fails naming the path (jZ59w)',
  { timeout: 120_000 },
  async () => {
    const scene = await scenario('cq/e2e-uniscope');
    const CROSS = {
      file: 'packages/beta/src/calculation.js',
      oldText: 'const expected = 4;',
      newText: 'const expected = 4; // touched by the alpha worker',
    };
    const outcome = await runSweepPlan(optsFor(scene, prompts({ edit: CROSS }, {})));
    const alphaInput = outcome.plan.jobs.find((job) => job.id === 'sweep-alpha-fix')
      ?.input as SweepUnitDispatchInput;
    expect(alphaInput.stagePathAllowlist?.patterns).toContain('^packages/alpha/');
    const alpha = unitRow(outcome.run, 'alpha');
    expect(alpha.status).toBe('failed');
    expect(alpha.error).toMatch(/outside the allowlist/);
    expect(alpha.error).toContain('packages/beta/src/calculation.js');
    expect(outcome.assembleRun).toBeUndefined();
    expect(scene.gh.created).toHaveLength(0);
  },
);
