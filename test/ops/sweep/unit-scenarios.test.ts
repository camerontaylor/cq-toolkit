// In-process sweep.unit decision coverage. Plan-level rescue, assembly, prep,
// and fleet decisions live in the production composition
// (src/plans/sweep-run.ts) and are pinned in test/plans/sweep-run.test.ts;
// the real-git/real-driver contracts stay in test/e2e/sweep/sweep.e2e.test.ts.
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { Driver, WorkerResult } from '../../../src/driver/types.js';
import { DEFAULT_TEST_FILE_PATTERNS } from '../../../src/ops/gates/hackDetector.js';
import type { RunCheck } from '../../../src/ops/gates/checkRunner.js';
import {
  makeSweepUnitOp,
  readCommittedMarkers,
  SWEEP_RUN_STATE_BASELINE_DIR,
  SWEEP_RUN_STATE_SCANNED_DIR,
} from '../../../src/ops/sweep/unit.js';
import type { SweepUnitBindings } from '../../../src/ops/sweep/unit.js';
import type { WorkUnit } from '../../../src/ops/sweep/planSweep.js';
import type { WorktreeEffects } from '../../../src/ops/sweep/worktreeFor.js';
import type { GhFn } from '../../../src/ops/review/gh.js';
import { makeSalvage } from '../../../src/ops/sweep/salvage.js';
import { unitStagePathAllowlist } from '../../../src/plans/sweep.js';

interface CheckOutput {
  failing: boolean;
  message?: string;
}

interface FakeWorld {
  root: string;
  effectsFactory: () => WorktreeEffects;
  gitFactory: () => GhFn;
  runCheckFactory: () => RunCheck;
  driverFactory: () => Driver;
  gitCalls: string[][];
  checks: string[];
  pushCalls: Array<{ repoRoot: string; branch: string }>;
  worktreePath: string;
  /** The `git diff --cached --name-status -z` output the allowlist parses. */
  staged: { nameStatus: string };
  worktreeState: Array<{ path: string; branch: string }>;
  dirty: { value: boolean };
}

function vitestOutput(failing: boolean, message = 'failure'): string {
  return JSON.stringify({
    success: !failing,
    numTotalTests: 1,
    testResults: [
      {
        name: 'suite.test.js',
        status: failing ? 'failed' : 'passed',
        assertionResults: failing
          ? [
              {
                fullName: message,
                status: 'failed',
                failureMessages: [message],
              },
            ]
          : [{ fullName: 'passes', status: 'passed' }],
      },
    ],
  });
}

async function makeWorld(checkOutputs: CheckOutput[]): Promise<FakeWorld> {
  const root = await mkdtemp(join(tmpdir(), 'sweep-unit-scenarios-'));
  const worktreePath = join(root, 'worktrees', 'fix', 'alpha');
  const gitCalls: string[][] = [];
  const checks: string[] = [];
  const pushCalls: Array<{ repoRoot: string; branch: string }> = [];
  const worktreeState: Array<{ path: string; branch: string }> = [];
  const dirty = { value: false };
  const staged = { nameStatus: '' };

  const effectsFactory = (): WorktreeEffects => ({
    listWorktrees: async () => worktreeState.map((entry) => ({ ...entry })),
    listBranches: async () => [],
    listRemoteBranches: async () => [],
    revParse: async () => 'fake-head',
    remoteGetUrl: async () => null,
    pathExists: async () => false,
    trackedFilesUnder: async () => [],
    isStrictClean: async () => !dirty.value,
    worktreeAdd: async ({ path, branch }) => {
      worktreeState.push({ path, branch });
    },
    worktreePrune: async () => undefined,
    rmDir: async () => undefined,
  });

  const gitFactory = (): GhFn => async (args) => {
    gitCalls.push(args);
    if (args.includes('rev-list')) return { code: 0, stdout: '0\n', stderr: '' };
    // The worker always leaves a staged change: `diff --cached --quiet` exits 1.
    if (args.includes('--quiet')) return { code: 1, stdout: '', stderr: '' };
    if (args.includes('--name-status')) return { code: 0, stdout: staged.nameStatus, stderr: '' };
    if (args.includes('diff') && args.includes('--cached')) {
      return { code: 0, stdout: 'diff --git a/src/a.js b/src/a.js\n', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };

  const runCheckFactory = (): RunCheck => {
    let checkIndex = 0;
    return async (command) => {
      checks.push(command.cwd ?? '');
      const output = checkOutputs[Math.min(checkIndex, checkOutputs.length - 1)];
      checkIndex += 1;
      if (output === undefined) throw new Error('missing fake probe output');
      return {
        stdout: vitestOutput(output.failing, output.message),
        stderr: '',
        exitCode: output.failing ? 1 : 0,
      };
    };
  };

  const driverFactory = (): Driver => ({
    run: async (): Promise<WorkerResult> => ({
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      denials: [],
      stopReason: 'complete',
    }),
  });

  return {
    root,
    effectsFactory,
    gitFactory,
    runCheckFactory,
    driverFactory,
    gitCalls,
    checks,
    pushCalls,
    worktreePath,
    staged,
    worktreeState,
    dirty,
  };
}

const UNIT: WorkUnit = { package: 'alpha', fixer: 'fix', files: ['src/a.js'] };

function bindingsOf(world: FakeWorld, extra: Partial<SweepUnitBindings> = {}): SweepUnitBindings {
  return {
    repoRoot: world.root,
    worktreesDir: 'worktrees',
    runPrefix: 'cq/unit',
    base: 'main',
    adapter: 'vitest-json',
    // These are fresh adapter objects for this unit invocation. Only the
    // explicit repository state above is shared between invocations (I6).
    worktreeEffects: world.effectsFactory(),
    runCheck: world.runCheckFactory(),
    checkCommand: (unit, cwd) => ({ command: 'vitest', args: [unit.package], cwd }),
    driver: world.driverFactory(),
    modelSpec: { model: 'fake', provider: 'test' },
    sessionsDir: join(world.root, 'sessions'),
    prompt: () => 'fix it',
    git: world.gitFactory(),
    pushBranch: async (repoRoot, branch) => {
      world.pushCalls.push({ repoRoot, branch });
    },
    ...extra,
  };
}

async function runUnit(world: FakeWorld, extra: Partial<SweepUnitBindings> = {}) {
  return makeSweepUnitOp(bindingsOf(world, extra))(UNIT);
}

describe('sweep unit in-process scenarios', () => {
  test('regression fails before commit and preserves its own dirty worktree for salvage', async () => {
    const world = await makeWorld([
      { failing: true, message: 'baseline' },
      { failing: true, message: 'novel failure' },
    ]);
    try {
      const result = await runUnit(world, {
        driver: {
          run: async () => {
            world.dirty.value = true;
            return {
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              denials: [],
              stopReason: 'complete',
            } satisfies WorkerResult;
          },
        },
      });
      expect(result.status).toBe('failed');
      if (result.status === 'failed') {
        expect(result.error).toMatch(/REGRESSION/);
        expect(result.error).toContain('novel failure');
      }
      expect(world.gitCalls.some((args) => args.includes('commit'))).toBe(false);
      expect(world.dirty.value).toBe(true);
      // Salvage reads the state the unit LEFT: the tree it created and its
      // cleanliness — never a stub that answers 'dirty' regardless.
      expect(world.worktreeState.map((entry) => entry.path)).toEqual([world.worktreePath]);
      const salvage = makeSalvage({
        pathExists: async (path) => world.worktreeState.some((entry) => entry.path === path),
        isStrictClean: async () => !world.dirty.value,
        canonicalize: async (path) => path,
      });
      const preserved = await salvage({
        repoRoot: world.root,
        entries: [{ path: world.worktreePath, journal: { allTerminal: false } }],
      });
      expect(preserved.status).toBe('ok');
      if (preserved.status === 'ok') expect(preserved.value.rows[0]?.class).toBe('preserve');
      const later = await runUnit(world);
      expect(later.status).toBe('failed');
      if (later.status === 'failed') expect(later.error).toMatch(/dirty .*refusing reuse/);
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

  test('a valid in-scope test-file edit is accepted, committed, and pushed', async () => {
    const world = await makeWorld([{ failing: true }, { failing: false }]);
    try {
      world.staged.nameStatus = 'M\0packages/alpha/test/suite.test.js';
      const result = await runUnit(world, {
        stagePathAllowlist: { patterns: [...DEFAULT_TEST_FILE_PATTERNS] },
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
      world.staged.nameStatus = 'M\0packages/beta/test/suite.test.js';
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
        expect(result.error).toContain('packages/beta/test/suite.test.js');
      }
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Commit-trust decisions (review-debt #174), scoped branches, and prep mode —
// over a git fake that models HEAD, its parent, the base tip, the
// ahead-of-base count, and whether anything is staged.
// ---------------------------------------------------------------------------

interface ScriptedGit {
  head: string;
  parent: string;
  base: string;
  ahead: number;
  /** true when `git diff --cached --quiet` reports staged changes. */
  staged: boolean;
}

function scriptedGit(world: FakeWorld, state: ScriptedGit): GhFn {
  return async (args) => {
    world.gitCalls.push(args);
    const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
    if (args.includes('rev-parse')) {
      const ref = args.at(-1);
      if (ref === 'HEAD') return ok(`${state.head}\n`);
      if (ref === 'HEAD^') return ok(`${state.parent}\n`);
      return ok(`${state.base}\n`);
    }
    if (args.includes('rev-list')) return ok(`${String(state.ahead)}\n`);
    if (args.includes('--quiet')) return { code: state.staged ? 1 : 0, stdout: '', stderr: '' };
    if (args.includes('--name-status')) return ok(world.staged.nameStatus);
    if (args.includes('commit')) {
      state.parent = state.head;
      state.head = `${state.head}-next`;
      state.ahead += 1;
      state.staged = false;
      return ok();
    }
    if (args.includes('diff')) return ok('diff --git a/src/a.js b/src/a.js\n');
    return ok();
  };
}

const STRAND_BASE = 'b'.repeat(40);
const STRANDED = 'c'.repeat(40);

/** A tree whose fixer no-ops on top of ONE stranded ahead-of-base commit. */
function strandedGit(world: FakeWorld): GhFn {
  return scriptedGit(world, {
    head: STRANDED,
    parent: STRAND_BASE,
    base: STRAND_BASE,
    ahead: 1,
    staged: false,
  });
}

async function recordScanned(runStateDir: string, sha: string): Promise<void> {
  await mkdir(join(runStateDir, SWEEP_RUN_STATE_SCANNED_DIR, 'fix'), { recursive: true });
  await writeFile(
    join(runStateDir, SWEEP_RUN_STATE_SCANNED_DIR, 'fix', 'alpha.json'),
    `${JSON.stringify({ sha })}\n`,
  );
}

describe('sweep unit in-process scenarios: commit trust, scoped branches, prep', () => {
  test('a driver SELF-COMMIT moves HEAD: TAMPER needs-human, nothing staged, committed, or pushed (#174)', async () => {
    const world = await makeWorld([{ failing: true }, { failing: false }]);
    try {
      const state: ScriptedGit = {
        head: 'a'.repeat(40),
        parent: STRAND_BASE,
        base: STRAND_BASE,
        ahead: 0,
        staged: false,
      };
      const result = await runUnit(world, {
        git: scriptedGit(world, state),
        driver: {
          run: async () => {
            // The driver commits the fix itself: HEAD moves under the op.
            state.parent = state.head;
            state.head = 'd'.repeat(40);
            state.ahead = 1;
            return {
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              denials: [],
              stopReason: 'complete',
            } satisfies WorkerResult;
          },
        },
      });
      expect(result.status).toBe('failed');
      if (result.status === 'failed') {
        expect(result.error).toMatch(/^\[TAMPER\]/);
        expect(result.error).toMatch(/worktree HEAD moved during the fixer run/);
        expect(result.error).toMatch(/driver self-commit is not a supported mode/);
        expect(result.error).toMatch(/needs-human evidence/);
      }
      expect(world.gitCalls.some((args) => args.includes('add'))).toBe(false);
      expect(world.gitCalls.some((args) => args.includes('commit'))).toBe(false);
      expect(world.pushCalls).toEqual([]);
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  });

  test('strand-retry REFUSES without a caller-vouched runStateDir: the ahead-of-base branch is never pushed (#174)', async () => {
    const world = await makeWorld([{ failing: false }, { failing: false }]);
    try {
      const result = await runUnit(world, { git: strandedGit(world) });
      expect(result.status).toBe('failed');
      if (result.status === 'failed') {
        expect(result.error).toMatch(/^\[TAMPER\]/);
        expect(result.error).toMatch(
          /stranded pushes require an explicit caller-supplied runStateDir/,
        );
        expect(result.error).toMatch(/needs-human evidence/);
      }
      expect(world.pushCalls).toEqual([]);
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  });

  test('strand-retry REFUSES a missing (stripped) scanned-commit record (#174)', async () => {
    const world = await makeWorld([{ failing: false }, { failing: false }]);
    try {
      const result = await runUnit(world, {
        git: strandedGit(world),
        runStateDir: join(world.root, 'run-state'),
      });
      expect(result.status).toBe('failed');
      if (result.status === 'failed') {
        expect(result.error).toMatch(/no scanned-commit record exists for this unit/);
        expect(result.error).toMatch(/unscanned commit must not be pushed/);
      }
      expect(world.pushCalls).toEqual([]);
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  });

  test('strand-retry REFUSES a divergent tip: the recorded sha must still be HEAD (#174)', async () => {
    const world = await makeWorld([{ failing: false }, { failing: false }]);
    try {
      const runStateDir = join(world.root, 'run-state');
      await recordScanned(runStateDir, 'e'.repeat(40));
      const result = await runUnit(world, { git: strandedGit(world), runStateDir });
      expect(result.status).toBe('failed');
      if (result.status === 'failed') {
        expect(result.error).toMatch(/diverges from the recorded scanned sha/);
      }
      expect(world.pushCalls).toEqual([]);
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  });

  test('strand-retry PUSHES the recorded scanned tip and writes the committed marker', async () => {
    const world = await makeWorld([{ failing: false }, { failing: false }]);
    try {
      const runStateDir = join(world.root, 'run-state');
      await recordScanned(runStateDir, STRANDED);
      const result = await runUnit(world, { git: strandedGit(world), runStateDir });
      expect(result.status).toBe('ok');
      if (result.status === 'ok') {
        expect(result.value).toMatchObject({
          committed: false,
          pushed: true,
          committedSha: STRANDED,
        });
      }
      expect(world.pushCalls.map((push) => push.branch)).toEqual(['cq/unit/fix/alpha']);
      expect(await readCommittedMarkers(world.root, 'worktrees', 'cq/unit', runStateDir)).toEqual([
        { package: 'alpha', fixer: 'fix', branch: 'cq/unit/fix/alpha' },
      ]);
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  });

  test('a scoped package commits and pushes on its NORMALIZED branch, and its marker names the scoped package', async () => {
    const world = await makeWorld([{ failing: true }, { failing: false }]);
    try {
      const runStateDir = join(world.root, 'run-state');
      const scoped: WorkUnit = { package: '@scope/gamma', fixer: 'fix', files: [] };
      const result = await makeSweepUnitOp(
        bindingsOf(world, {
          runStateDir,
          git: scriptedGit(world, {
            head: 'a'.repeat(40),
            parent: STRAND_BASE,
            base: STRAND_BASE,
            ahead: 0,
            staged: true,
          }),
        }),
      )(scoped);
      expect(result.status).toBe('ok');
      if (result.status === 'ok') {
        expect(result.value).toMatchObject({
          committed: true,
          pushed: true,
          prBranch: 'cq/unit/fix/scope-gamma',
        });
      }
      expect(world.worktreeState.map((entry) => entry.branch)).toEqual(['cq/unit/fix/scope-gamma']);
      expect(world.pushCalls.map((push) => push.branch)).toEqual(['cq/unit/fix/scope-gamma']);
      expect(await readCommittedMarkers(world.root, 'worktrees', 'cq/unit', runStateDir)).toEqual([
        { package: '@scope/gamma', fixer: 'fix', branch: 'cq/unit/fix/scope-gamma' },
      ]);
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  });

  test('prep mode probes only: baseline evidence and snapshot, zero fixer runs, zero commits, zero pushes', async () => {
    const world = await makeWorld([{ failing: true, message: 'seeded failure' }]);
    try {
      const runStateDir = join(world.root, 'run-state');
      let driverRuns = 0;
      const result = await runUnit(world, {
        mode: 'prep',
        runStateDir,
        driver: {
          run: async () => {
            driverRuns += 1;
            throw new Error('prep must never run the fixer');
          },
        },
      });
      expect(result.status).toBe('ok');
      if (result.status === 'ok') {
        expect(result.value.mode).toBe('prep');
        expect(result.value.baseline.verdict).toBe('failing');
        expect(result.value.baseline.failureSet).toBeDefined();
        expect(result.value.final).toBeUndefined();
        expect(result.value.regression).toBeUndefined();
        expect(result.value.committed).toBeUndefined();
        expect(result.value.pushed).toBeUndefined();
      }
      expect(driverRuns).toBe(0);
      expect(world.checks).toHaveLength(1); // the baseline probe only
      expect(world.gitCalls.some((args) => args.includes('commit'))).toBe(false);
      expect(world.pushCalls).toEqual([]);
      expect(existsSync(join(runStateDir, SWEEP_RUN_STATE_BASELINE_DIR, 'fix', 'alpha.json'))).toBe(
        true,
      );
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  });
});
