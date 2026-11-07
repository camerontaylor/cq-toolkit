// Shared fixtures for the unit-scenarios.*.test.ts siblings, split from
// test/ops/sweep/unit-scenarios.test.ts.
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Driver, WorkerResult } from '../../../src/driver/types.js';
import type { RunCheck } from '../../../src/ops/gates/checkRunner.js';
import { makeSweepUnitOp } from '../../../src/ops/sweep/unit.js';
import type { SweepUnitBindings } from '../../../src/ops/sweep/unit.js';
import type { WorkUnit } from '../../../src/ops/sweep/planSweep.js';
import type { WorktreeEffects } from '../../../src/adapters/git/worktreeFor.js';
import type { GhFn } from '../../../src/adapters/forge-github/gh.js';

interface CheckOutput {
  failing: boolean;
  message?: string;
}

export interface FakeWorld {
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
  revParseByRef: Map<string, string>;
  dirty: { value: boolean };
}

export function vitestOutput(failing: boolean, message = 'failure'): string {
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

export async function makeWorld(checkOutputs: CheckOutput[]): Promise<FakeWorld> {
  const root = await mkdtemp(join(tmpdir(), 'sweep-unit-scenarios-'));
  const worktreePath = join(root, 'worktrees', 'fix', 'alpha');
  const gitCalls: string[][] = [];
  const checks: string[] = [];
  const pushCalls: Array<{ repoRoot: string; branch: string }> = [];
  const worktreeState: Array<{ path: string; branch: string }> = [];
  const revParseByRef = new Map<string, string>([
    [`${worktreePath}:HEAD`, 'head-sha'],
    [`${worktreePath}:main`, 'base-sha'],
  ]);
  const dirty = { value: false };
  const staged = { nameStatus: 'M\0src/a.js\0' };

  const effectsFactory = (): WorktreeEffects => ({
    listWorktrees: async () => worktreeState.map((entry) => ({ ...entry })),
    listBranches: async () => [],
    listRemoteBranches: async () => [],
    revParse: async (path, ref) => revParseByRef.get(`${path}:${ref}`) ?? `unresolved:${ref}`,
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

  // Deterministic object ids: the unit op pins the pre-driver HEAD, writes the
  // staged tree, parents a base-owned probe commit on that HEAD, and after the
  // commit verifies the tip, its parent and the committed tree.
  const BASE_HEAD = 'a'.repeat(40);
  const TREE = 'b'.repeat(40);
  const PROBE_COMMIT = 'c'.repeat(40);
  let head = BASE_HEAD;
  let parent = BASE_HEAD;
  let commits = 0;
  const ok = (stdout = ''): { code: number; stdout: string; stderr: string } => ({
    code: 0,
    stdout,
    stderr: '',
  });

  const gitFactory = (): GhFn => async (args) => {
    gitCalls.push(args);
    if (args.includes('rev-list')) return ok('0\n');
    if (args.includes('rev-parse')) {
      if (args.includes('HEAD^{tree}')) return ok(`${TREE}\n`);
      if (args.includes('HEAD^')) return ok(`${parent}\n`);
      return ok(`${head}\n`);
    }
    if (args.includes('write-tree')) return ok(`${TREE}\n`);
    if (args.includes('commit-tree')) return ok(`${PROBE_COMMIT}\n`);
    if (args.includes('cat-file') && args.includes('-s')) return ok('4\n');
    if (args.includes('show')) return ok('safe');
    if (args.includes('commit')) {
      commits += 1;
      parent = head;
      head = String(commits).repeat(40).slice(0, 40);
      return ok();
    }
    // The worker always leaves a staged change: `diff --cached --quiet` exits 1.
    if (args.includes('--quiet')) return { code: 1, stdout: '', stderr: '' };
    if (args.includes('--name-status')) return ok(staged.nameStatus);
    if (args.includes('--name-only')) return ok('src/a.js\0');
    if (args.includes('diff')) return ok('diff --git a/src/a.js b/src/a.js\n');
    return ok();
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
    revParseByRef,
    dirty,
  };
}

export const UNIT: WorkUnit = { package: 'alpha', fixer: 'fix', files: ['src/a.js'] };

export function bindingsOf(
  world: FakeWorld,
  extra: Partial<SweepUnitBindings> = {},
): SweepUnitBindings {
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
    budget: { wallClockMs: 600_000, maxTokens: 1_000_000 },
    prompt: () => 'fix it',
    scanPrompt: async () => {},
    git: world.gitFactory(),
    pushBranch: async (repoRoot, branch) => {
      world.pushCalls.push({ repoRoot, branch });
    },
    // The failed-attempt upload capability a dispatch grants through
    // `taskLoop.pushFailed` (unit.ts bindingsFromDispatch).
    publishFailedAttempts: true,
    ...extra,
  };
}

export async function runUnit(
  world: FakeWorld,
  extra: Partial<SweepUnitBindings> = {},
  unit: WorkUnit = UNIT,
) {
  return makeSweepUnitOp(bindingsOf(world, extra))(unit);
}
