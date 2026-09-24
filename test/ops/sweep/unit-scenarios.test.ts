// In-process sweep.unit decision coverage. Plan-level rescue, assembly, prep,
// and fleet claims remain in the real runSweepPlan contracts because those
// decisions live in the e2e composition helper rather than production.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { Driver, OpInvocation, WorkerResult } from '../../../src/driver/types.js';
import { JournalEventSchema } from '../../../src/kernel/schema.js';
import { DEFAULT_TEST_FILE_PATTERNS } from '../../../src/ops/gates/hackDetector.js';
import type { RunCheck } from '../../../src/ops/gates/checkRunner.js';
import { makeSweepUnitOp } from '../../../src/ops/sweep/unit.js';
import type { SweepUnitBindings } from '../../../src/ops/sweep/unit.js';
import type { WorkUnit } from '../../../src/ops/sweep/planSweep.js';
import type { WorktreeEffects } from '../../../src/ops/sweep/worktreeFor.js';
import type { GhFn } from '../../../src/ops/review/gh.js';
import { makeSalvage } from '../../../src/ops/sweep/salvage.js';

interface CheckOutput {
  failing: boolean;
  message?: string;
}

interface GitState {
  staged: boolean;
  stagedDiff: string;
  stagedNameStatus: string;
  commitFault: boolean;
  committed: boolean;
}

interface FakeWorld {
  root: string;
  effectsFactory: () => WorktreeEffects;
  gitFactory: () => GhFn;
  runCheckFactory: () => RunCheck;
  driverFactory: () => Driver;
  gitCalls: string[][];
  checks: string[];
  driverCalls: OpInvocation[];
  pushCalls: Array<{ repoRoot: string; branch: string }>;
  worktreePath: string;
  state: GitState;
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
  const driverCalls: OpInvocation[] = [];
  const pushCalls: Array<{ repoRoot: string; branch: string }> = [];
  const worktreeState: Array<{ path: string; branch: string }> = [];
  const dirty = { value: false };
  const state: GitState = {
    staged: true,
    stagedDiff: 'diff --git a/src/a.js b/src/a.js\n',
    stagedNameStatus: '',
    commitFault: false,
    committed: false,
  };

  const effectsFactory = (): WorktreeEffects => ({
    listWorktrees: async () => worktreeState.map((entry) => ({ ...entry })),
    listBranches: async () => [],
    listRemoteBranches: async () => [],
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
    if (args.includes('--quiet')) return { code: state.staged ? 1 : 0, stdout: '', stderr: '' };
    if (args.includes('--name-status'))
      return { code: 0, stdout: state.stagedNameStatus, stderr: '' };
    if (args.includes('diff') && args.includes('--cached')) {
      return { code: 0, stdout: state.stagedDiff, stderr: '' };
    }
    if (args.includes('commit') && state.commitFault) {
      return { code: 1, stdout: '', stderr: 'commit failed' };
    }
    if (args.includes('commit')) state.committed = true;
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
    run: async (invocation: OpInvocation): Promise<WorkerResult> => {
      driverCalls.push(invocation);
      return {
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        denials: [],
        stopReason: 'complete',
      };
    },
  });

  return {
    root,
    effectsFactory,
    gitFactory,
    runCheckFactory,
    driverFactory,
    gitCalls,
    checks,
    driverCalls,
    pushCalls,
    worktreePath,
    state,
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
    driver: extra.driver ?? world.driverFactory(),
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

async function runUnit(world: FakeWorld, extra: Partial<SweepUnitBindings> = {}, unit = UNIT) {
  return makeSweepUnitOp(bindingsOf(world, extra))(unit);
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
      const salvage = makeSalvage({
        pathExists: async () => true,
        isStrictClean: async () => false,
        canonicalize: async (path) => path,
      });
      const preserved = await salvage({
        repoRoot: world.root,
        entries: [{ path: world.worktreePath, journal: { allTerminal: false } }],
      });
      expect(preserved.status).toBe('ok');
      if (preserved.status === 'ok') expect(preserved.value.rows[0]?.class).toBe('preserve');
      const later = await makeSweepUnitOp(bindingsOf(world))(UNIT);
      expect(later.status).toBe('failed');
      if (later.status === 'failed') expect(later.error).toMatch(/dirty .*refusing reuse/);
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  });

  test('ordinary stage-path allowlist rejection names the exact offending path', async () => {
    const world = await makeWorld([{ failing: true }, { failing: false }]);
    try {
      world.state.stagedNameStatus = 'M\0packages/beta/index.js';
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
      world.state.stagedNameStatus = 'M\0packages/alpha/test/suite.test.js';
      const result = await runUnit(world, {
        stagePathAllowlist: { patterns: [...DEFAULT_TEST_FILE_PATTERNS] },
      });
      expect(result.status).toBe('ok');
      if (result.status === 'ok') {
        expect(result.value).toMatchObject({ committed: true, pushed: true });
      }
      expect(world.gitCalls.some((args) => args.includes('commit'))).toBe(true);
      expect(world.pushCalls.map((push) => push.branch)).toEqual(['cq/unit/fix/alpha']);
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  });

  test('the default package scope names the exact cross-package path', async () => {
    const world = await makeWorld([{ failing: true }, { failing: false }]);
    try {
      world.state.stagedNameStatus = 'M\0packages/beta/test/suite.test.js';
      const result = await runUnit(world, {
        stagePathAllowlist: { patterns: ['^packages/alpha/', 'packages/alpha/test/suite.js'] },
      });
      expect(result.status).toBe('failed');
      if (result.status === 'failed') {
        expect(result.error).toMatch(/outside the allowlist/);
        expect(result.error).toContain('packages/beta/test/suite.test.js');
      }
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  });

  test('journal lifecycle frames satisfy the frozen journal schema', () => {
    const at = new Date(1_700_000_000_000).toISOString();
    const events = [
      { type: 'run-started', runId: 'r', at, planId: 'sweep' },
      {
        type: 'job-started',
        runId: 'r',
        at,
        jobId: 'sweep-alpha-fix',
        op: 'sweep.unit',
        attempt: 1,
      },
      {
        type: 'job-finished',
        runId: 'r',
        at,
        jobId: 'sweep-alpha-fix',
        opId: 'sweep.unit',
        inputsHash: 'h',
        result: { status: 'ok', value: {} },
      },
      { type: 'run-finished', runId: 'r', at, stoppedEarly: false },
    ];
    expect(events.map((event) => JournalEventSchema.safeParse(event).success)).toEqual([
      true,
      true,
      true,
      true,
    ]);
  });
});
