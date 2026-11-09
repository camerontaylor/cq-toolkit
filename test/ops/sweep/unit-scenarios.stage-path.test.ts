// Split provenance: test/ops/sweep/unit-scenarios.test.ts was split into
// unit-scenarios.*.test.ts siblings (shared fixtures in unit-scenarios.helpers.ts).
// In-process sweep.unit decision coverage. Plan-level rescue, assembly, prep,
// and fleet claims remain in the real runSweepPlan contracts because those
// decisions live in the e2e composition helper rather than production.
import { rm } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { DEFAULT_TEST_FILE_PATTERNS } from '../../../src/ops/gates/hackDetector.js';
import { unitStagePathAllowlist } from '../../../src/plans/sweep.js';
import { stagedPathsOf } from '../../../src/ops/sweep/stagePaths.js';
import { UNIT, makeWorld, runUnit } from './unit-scenarios.helpers.js';

describe('sweep unit in-process scenarios', () => {
  test('name-status parsing preserves both rename/copy paths and unusual filenames', () => {
    expect(stagedPathsOf('')).toEqual([]);
    expect(
      stagedPathsOf(
        'M\0src/with\nnewline.ts\0R100\0src/old.ts\0src/new.ts\0C75\0src/a.ts\0src/b.ts\0',
      ),
    ).toEqual(['src/with\nnewline.ts', 'src/old.ts', 'src/new.ts', 'src/a.ts', 'src/b.ts']);
  });

  test.each([
    'M',
    'R100\0src/old.ts\0',
    'C75\0src/old.ts',
    'M\0\0M\0src/a.ts\0',
    'unexpected\0src/a.ts\0',
  ])('malformed name-status evidence fails closed: %j', async (capture) => {
    expect(() => stagedPathsOf(capture)).toThrow(/malformed name-status capture/);
    const world = await makeWorld([{ failing: true }, { failing: false }]);
    try {
      world.staged.nameStatus = capture;
      const result = await runUnit(world, { stagePathAllowlist: { patterns: ['^src/'] } });
      expect(result.status).toBe('failed');
      expect(world.gitCalls.some((args) => args.includes('commit'))).toBe(false);
      expect(world.pushCalls).toEqual([]);
      expect(world.checks).toHaveLength(1);
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  });

  test('malformed committed-path evidence refuses the push with a typed failure', async () => {
    const world = await makeWorld([{ failing: true }, { failing: false }]);
    const underlying = world.gitFactory();
    try {
      const result = await runUnit(world, {
        git: async (args) =>
          args.includes('--name-status') && args.includes('HEAD^')
            ? { code: 0, stdout: 'R100\0src/old.ts\0', stderr: '' }
            : underlying(args),
      });
      expect(result.status).toBe('failed');
      if (result.status === 'failed') expect(result.error).toMatch(/malformed name-status capture/);
      expect(world.pushCalls).toEqual([]);
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  });

  test('ordinary stage-path allowlist rejection names the exact offending path', async () => {
    const world = await makeWorld([{ failing: true }, { failing: false }]);
    try {
      world.staged.nameStatus = 'M\0packages/beta/index.js';
      const result = await runUnit(world, {
        stagePathAllowlist: { patterns: ['^src/'] },
      });
      expect(result.status).toBe('failed');
      if (result.status === 'failed') {
        expect(result.error).toMatch(/outside the allowlist/);
        expect(result.error).toContain('packages/beta/index.js');
      }
      expect(world.gitCalls.some((args) => args.includes('commit'))).toBe(false);
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  });

  test('a protected test-file edit routes to human review before any probe, commit, or push', async () => {
    const world = await makeWorld([{ failing: true }, { failing: false }]);
    try {
      world.staged.nameStatus = 'M\0packages/alpha/test/suite.test.js';
      const result = await runUnit(world, {
        stagePathAllowlist: { patterns: [...DEFAULT_TEST_FILE_PATTERNS] },
      });
      expect(result.status).toBe('needs-human');
      expect(world.gitCalls.some((args) => args.includes('commit'))).toBe(false);
      expect(world.pushCalls).toEqual([]);
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  });

  test('a valid in-scope production edit is accepted, committed, and pushed', async () => {
    const world = await makeWorld([{ failing: true }, { failing: false }]);
    try {
      world.staged.nameStatus = 'M\0packages/alpha/src/calculation.js';
      const result = await runUnit(world, {
        stagePathAllowlist: { patterns: ['^packages/alpha/'] },
      });
      expect(result.status).toBe('ok');
      if (result.status === 'ok') {
        expect(result.value).toMatchObject({ committed: true, pushed: true });
      }
      expect(world.checks).toHaveLength(2); // fresh baseline and final probes
      expect(world.gitCalls.some((args) => args.includes('commit'))).toBe(true);
      expect(world.pushCalls.map((push) => push.branch)).toEqual(['cq/unit/fix/alpha']);
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  });

  test('the default package scope names the exact cross-package path', async () => {
    const world = await makeWorld([{ failing: true }, { failing: false }]);
    try {
      world.staged.nameStatus = 'M\0packages/beta/src/calculation.js';
      // The production default (jZ59w), derived exactly as buildSweepPlan does.
      const scope = unitStagePathAllowlist(
        {
          repoRoot: world.root,
          worktreesDir: 'worktrees',
          runPrefix: 'cq/unit',
          base: 'main',
          packages: [{ name: 'alpha', path: 'packages/alpha' }],
          selector: { mode: 'workspace-all' },
          fixers: ['fix'],
        },
        UNIT,
      );
      if (scope === undefined) throw new Error('alpha must derive a default scope');
      expect(scope.patterns).toContain('^packages/alpha/');
      const result = await runUnit(world, { stagePathAllowlist: scope });
      expect(result.status).toBe('failed');
      if (result.status === 'failed') {
        expect(result.error).toMatch(/outside the allowlist/);
        expect(result.error).toContain('packages/beta/src/calculation.js');
      }
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  });
});
