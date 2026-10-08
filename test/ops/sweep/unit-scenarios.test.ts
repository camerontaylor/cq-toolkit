// In-process sweep.unit decision coverage. Plan-level rescue, assembly, prep,
// and fleet claims remain in the real runSweepPlan contracts because those
// decisions live in the e2e composition helper rather than production.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { Driver, WorkerResult } from '../../../src/driver/types.js';
import { DEFAULT_TEST_FILE_PATTERNS } from '../../../src/ops/gates/hackDetector.js';
import type { RunCheck } from '../../../src/ops/gates/checkRunner.js';
import { makeSweepUnitOp } from '../../../src/ops/sweep/unit.js';
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
  revParseByRef: Map<string, string>;
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
  const revParseByRef = new Map<string, string>([
    [`${worktreePath}:HEAD`, 'head-sha'],
    [`${worktreePath}:main`, 'base-sha'],
  ]);
  const dirty = { value: false };
  const staged = { nameStatus: '' };

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
    if (args.includes('commit')) {
      commits += 1;
      parent = head;
      head = String(commits).repeat(40).slice(0, 40);
      return ok();
    }
    // The worker always leaves a staged change: `diff --cached --quiet` exits 1.
    if (args.includes('--quiet')) return { code: 1, stdout: '', stderr: '' };
    if (args.includes('--name-status')) return ok(staged.nameStatus);
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
    budget: { maxTokens: 1_000_000 },
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
      expect(
        world.gitCalls.some((args) =>
          args.some((arg) => ['reset', 'checkout', 'clean', 'stash', 'restore'].includes(arg)),
        ),
      ).toBe(false);
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

  test('reuse reports ref-specific HEAD and base resolutions', async () => {
    const world = await makeWorld([{ failing: false }, { failing: false }]);
    try {
      const first = await runUnit(world);
      expect(first.status).toBe('ok');
      const reused = await runUnit(world);
      expect(reused.status).toBe('ok');
      if (reused.status === 'ok') {
        expect(reused.value.worktree).toMatchObject({
          reused: true,
          headSha: 'head-sha',
          baseSha: 'base-sha',
        });
      }
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

// PR #246 review (Codex P1): every budget cap sweep.unit ACCEPTS is a cap it
// ENFORCES, lane-neutrally — a breach fails the unit [INFRA] before anything
// is staged, committed, or pushed.
describe('sweep unit fixer budget enforcement', () => {
  const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  /** A fixer that settles complete with the given usage/cost. */
  function settled(usage: WorkerResult['usage'], costUSD?: number): Driver {
    return {
      run: async () =>
        ({
          usage,
          ...(costUSD !== undefined ? { costUSD, costBasis: 'modeled' as const } : {}),
          denials: [],
          stopReason: 'complete',
        }) satisfies WorkerResult,
    };
  }

  /** Assert a budget trip: failed [INFRA], naming the cap, nothing staged or pushed. */
  function expectBudgetTrip(
    world: FakeWorld,
    result: Awaited<ReturnType<typeof runUnit>>,
    detail: RegExp,
  ): void {
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toMatch(/^\[INFRA\] .*stopped with reason 'budget'/);
      expect(result.error).toMatch(detail);
    }
    expect(world.gitCalls.some((args) => args.includes('add'))).toBe(false);
    expect(world.gitCalls.some((args) => args.includes('commit'))).toBe(false);
    expect(world.pushCalls).toEqual([]);
  }

  test('maxTokens: a settled run at or above the cap trips, whatever the lane reported', async () => {
    const world = await makeWorld([{ failing: true }, { failing: false }]);
    try {
      const result = await runUnit(world, {
        budget: { maxTokens: 1000 },
        driver: settled({ input: 600, output: 400, cacheRead: 0, cacheWrite: 0 }),
      });
      expectBudgetTrip(world, result, /token total 1000 reached maxTokens 1000/);
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  });

  test('maxUsd: unpriced usage trips (DD-9 fail closed); a priced run is bound by the cap', async () => {
    const unpriced = await makeWorld([{ failing: true }, { failing: false }]);
    try {
      const result = await runUnit(unpriced, {
        budget: { maxUsd: 5 },
        driver: settled({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }),
      });
      expectBudgetTrip(unpriced, result, /unpriced usage .* under maxUsd 5/);
    } finally {
      await rm(unpriced.root, { recursive: true, force: true });
    }
    const over = await makeWorld([{ failing: true }, { failing: false }]);
    try {
      const result = await runUnit(over, {
        budget: { maxUsd: 5 },
        driver: settled({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, 6),
      });
      expectBudgetTrip(over, result, /cost 6 USD exceeded maxUsd 5/);
    } finally {
      await rm(over.root, { recursive: true, force: true });
    }
    const within = await makeWorld([{ failing: true }, { failing: false }]);
    try {
      const result = await runUnit(within, {
        budget: { maxUsd: 5 },
        driver: settled({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, 4),
      });
      expect(result.status).toBe('ok');
    } finally {
      await rm(within.root, { recursive: true, force: true });
    }
  });

  test('wallClockMs: the deadline aborts the fixer and reports a budget trip, not a cancellation', async () => {
    // Two conforming lane shapes on abort: settle 'aborted', or throw.
    const onAbort: Array<(signal: AbortSignal) => Promise<WorkerResult>> = [
      (signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () =>
            resolve({ usage: ZERO, denials: [], stopReason: 'aborted' }),
          );
        }),
      (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('lane aborted')));
        }),
    ];
    for (const settle of onAbort) {
      const world = await makeWorld([{ failing: true }, { failing: false }]);
      try {
        let received: AbortSignal | undefined;
        const result = await runUnit(world, {
          budget: { wallClockMs: 20 },
          driver: {
            run: async (_invocation, options) => {
              received = options?.signal;
              if (received === undefined) throw new Error('no deadline signal reached the lane');
              return settle(received);
            },
          },
        });
        expect(received?.aborted).toBe(true);
        expectBudgetTrip(world, result, /wallClockMs 20 elapsed/);
      } finally {
        await rm(world.root, { recursive: true, force: true });
      }
    }
  });

  test('maxAttempts is refused at construction — the op cannot enforce it per invocation', async () => {
    const world = await makeWorld([{ failing: true }, { failing: false }]);
    try {
      expect(() => makeSweepUnitOp(bindingsOf(world, { budget: { maxAttempts: 2 } }))).toThrow(
        /maxAttempts is not enforceable/,
      );
      expect(() =>
        makeSweepUnitOp(bindingsOf(world, { budget: { maxTokens: 10, maxAttempts: 2 } })),
      ).toThrow(/maxAttempts is not enforceable/);
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  });
});
