// In-process sweep.unit decision coverage. Plan-level rescue, assembly, prep,
// and fleet claims remain in the real runSweepPlan contracts because those
// decisions live in the e2e composition helper rather than production.
import { createEscalationState, nextEscalation } from '../../../src/ops/fix/escalation.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import type { Driver, WorkerResult } from '../../../src/driver/types.js';
import { DEFAULT_TEST_FILE_PATTERNS } from '../../../src/ops/gates/hackDetector.js';
import type { RunCheck } from '../../../src/ops/gates/checkRunner.js';
import { bindingsFromDispatch, makeSweepUnitOp } from '../../../src/ops/sweep/unit.js';
import type { SweepUnitBindings } from '../../../src/ops/sweep/unit.js';
import type { WorkUnit } from '../../../src/ops/sweep/planSweep.js';
import type { WorktreeEffects } from '../../../src/adapters/git/worktreeFor.js';
import type { GhFn } from '../../../src/adapters/forge-github/gh.js';
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
    budget: { wallClockMs: 600_000, maxTokens: 1_000_000 },
    prompt: () => 'fix it',
    scanPrompt: async () => {},
    git: world.gitFactory(),
    pushBranch: async (repoRoot, branch) => {
      world.pushCalls.push({ repoRoot, branch });
    },
    ...extra,
  };
}

async function runUnit(
  world: FakeWorld,
  extra: Partial<SweepUnitBindings> = {},
  unit: WorkUnit = UNIT,
) {
  return makeSweepUnitOp(bindingsOf(world, extra))(unit);
}

describe('sweep unit in-process scenarios', () => {
  test('default unit worker can read before editing an existing file', async () => {
    const world = await makeWorld([{ failing: true }, { failing: false }]);
    const seen: unknown[] = [];
    try {
      await runUnit(world, {
        driver: {
          run: async (invocation) => {
            seen.push(invocation.toolPolicy);
            return {
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              denials: [],
              stopReason: 'complete',
            };
          },
        },
      });
      expect(seen).toEqual([{ allow: ['read', 'edit'], mode: 'allowlist' }]);
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  });
  test('failed publication pushes the scanned SHA even if its branch moves during scanning', async () => {
    const world = await makeWorld([{ failing: true }, { failing: true }]);
    const underlying = world.gitFactory();
    let branchTip = '';
    let branchRef = '';
    let pushedSha = '';
    const retargetedSha = 'e'.repeat(40);
    try {
      const result = await runUnit(world, {
        taskLoop: { pushFailed: true },
        stagePathAllowlist: { patterns: ['^src/'] },
        driver: {
          run: async () => ({
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            denials: [],
            stopReason: 'error',
          }),
        },
        scanPrompt: async (text) => {
          if (text.startsWith('Failed-attempt commit ')) branchTip = retargetedSha;
        },
        git: async (args) => {
          const updateRefIndex = args.indexOf('update-ref');
          if (updateRefIndex !== -1) {
            branchRef = String(args[updateRefIndex + 1]);
            branchTip = String(args[updateRefIndex + 2]);
          }
          const pushIndex = args.indexOf('push');
          if (pushIndex !== -1) {
            const refspec = String(args[pushIndex + 2]);
            const source = refspec.split(':')[0];
            pushedSha = source?.startsWith('refs/heads/') ? branchTip : String(source);
          }
          return underlying(args);
        },
      });
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;
      const failedAttempt = result.value.tasks?.[0]?.failedAttempt;
      expect(failedAttempt).toBeDefined();
      expect(branchTip).toBe(retargetedSha);
      expect(pushedSha).toBe(failedAttempt?.sha);
      expect(pushedSha).not.toBe(retargetedSha);
      expect(
        world.gitCalls.some(
          (args) => args.includes('push') && args.at(-1) === `${failedAttempt?.sha}:${branchRef}`,
        ),
      ).toBe(true);
      expect(result.value.tasks?.[0]?.failedAttemptPublished).toBe(true);
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  });

  test('an early worker stop cannot publish a failed attempt that adds a suppression', async () => {
    const world = await makeWorld([{ failing: true }, { failing: true }]);
    const underlying = world.gitFactory();
    const scanPrompt = vi.fn(async (_text: string) => {});
    const suppressionPatch = [
      'diff --git a/src/a.js b/src/a.js',
      'index 1111111..2222222 100644',
      '--- a/src/a.js',
      '+++ b/src/a.js',
      '@@ -1 +1,2 @@',
      ' safe',
      '+// @ts-nocheck',
      '',
    ].join('\n');
    try {
      const result = await runUnit(world, {
        taskLoop: { pushFailed: true },
        stagePathAllowlist: { patterns: ['^src/'] },
        driver: {
          run: async () => ({
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            denials: [],
            stopReason: 'error',
          }),
        },
        scanPrompt,
        git: async (args) =>
          args.includes('--binary') && args.includes('--full-index')
            ? { code: 0, stdout: suppressionPatch, stderr: '' }
            : underlying(args),
      });
      expect(result.status).toBe('ok');
      if (result.status === 'ok') {
        expect(result.value.tasks?.[0]?.failedAttempt).toBeDefined();
        expect(result.value.tasks?.[0]?.failedAttemptPublished).not.toBe(true);
        expect(result.value.indeterminate).toContain('failed-attempt publication refused');
        expect(JSON.stringify(result.value)).toContain('tamper gate refused publication');
      }
      expect(
        scanPrompt.mock.calls.some(([text]) => text.startsWith('Failed-attempt commit ')),
      ).toBe(false);
      expect(world.gitCalls.some((args) => args.includes('push'))).toBe(false);
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  });

  test.each(['tamper diff read error', 'indeterminate tamper diff'] as const)(
    'failed-attempt publication retains local evidence and refuses a %s',
    async (fault) => {
      const world = await makeWorld([{ failing: true }, { failing: true }]);
      const underlying = world.gitFactory();
      const scanPrompt = vi.fn(async (_text: string) => {});
      try {
        const result = await runUnit(world, {
          taskLoop: { pushFailed: true },
          stagePathAllowlist: { patterns: ['^src/'] },
          driver: {
            run: async () => ({
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              denials: [],
              stopReason: 'error',
            }),
          },
          scanPrompt,
          git: async (args) => {
            if (
              args.includes('diff') &&
              args.includes('--binary') &&
              args.includes('--full-index')
            ) {
              if (fault === 'tamper diff read error') throw new Error('synthetic diff read error');
              return { code: 0, stdout: 'synthetic malformed diff', stderr: '' };
            }
            return underlying(args);
          },
        });
        expect(result.status).toBe('ok');
        if (result.status === 'ok') {
          const failedAttempt = result.value.tasks?.[0]?.failedAttempt;
          expect(failedAttempt).toBeDefined();
          expect(result.value.tasks?.[0]?.failedAttemptPublished).not.toBe(true);
          expect(result.value.indeterminate).toContain('failed-attempt publication refused');
          expect(
            world.gitCalls.some(
              (args) =>
                args.includes('update-ref') &&
                args.includes(`refs/heads/${failedAttempt?.branch}`) &&
                args.includes(failedAttempt?.sha ?? ''),
            ),
          ).toBe(true);
          if (fault === 'tamper diff read error')
            expect(result.value.indeterminate).toContain('synthetic diff read error');
          else
            expect(result.value.indeterminate).toContain(
              'tamper scan could not complete: indeterminate',
            );
        }
        expect(
          scanPrompt.mock.calls.some(([text]) => text.startsWith('Failed-attempt commit ')),
        ).toBe(false);
        expect(world.gitCalls.some((args) => args.includes('push'))).toBe(false);
      } finally {
        await rm(world.root, { recursive: true, force: true });
      }
    },
  );

  test('parent cancellation during failed-attempt scan blocks off-machine publication', async () => {
    const world = await makeWorld([
      { failing: true, message: 'baseline' },
      { failing: true, message: 'related failure' },
    ]);
    const cancelled = { value: false };
    try {
      const result = await runUnit(world, {
        taskLoop: { pushFailed: true },
        cancelled: () => cancelled.value,
        scanPrompt: async (text) => {
          if (text.startsWith('Failed-attempt commit ')) cancelled.value = true;
        },
      });
      expect(result.status).toBe('ok');
      expect(world.gitCalls.some((args) => args.includes('push'))).toBe(false);
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  });

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

// PR #246 review (Codex P1): the fixer budget, lane-neutrally. wallClockMs is
// REQUIRED — the enforced in-flight spend bound; maxTokens/maxUsd are post-run
// landing gates. Any breach fails the unit [INFRA] before anything is staged,
// committed, or pushed.
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

  test('maxTokens landing gate: a settled run at or above the cap is refused, whatever the lane reported', async () => {
    const world = await makeWorld([{ failing: true }, { failing: false }]);
    try {
      const result = await runUnit(world, {
        budget: { wallClockMs: 600_000, maxTokens: 1000 },
        driver: settled({ input: 600, output: 400, cacheRead: 0, cacheWrite: 0 }),
      });
      expectBudgetTrip(world, result, /token total 1000 reached maxTokens 1000/);
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  });

  test('maxUsd landing gate: unpriced usage is refused (DD-9 fail closed); priced work lands only within the cap', async () => {
    const unpriced = await makeWorld([{ failing: true }, { failing: false }]);
    try {
      const result = await runUnit(unpriced, {
        budget: { wallClockMs: 600_000, maxUsd: 5 },
        driver: settled({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }),
      });
      expectBudgetTrip(unpriced, result, /unpriced usage .* under maxUsd 5/);
    } finally {
      await rm(unpriced.root, { recursive: true, force: true });
    }
    const over = await makeWorld([{ failing: true }, { failing: false }]);
    try {
      const result = await runUnit(over, {
        budget: { wallClockMs: 600_000, maxUsd: 5 },
        driver: settled({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, 6),
      });
      expectBudgetTrip(over, result, /cost 6 USD exceeded maxUsd 5/);
    } finally {
      await rm(over.root, { recursive: true, force: true });
    }
    const within = await makeWorld([{ failing: true }, { failing: false }]);
    try {
      const result = await runUnit(within, {
        budget: { wallClockMs: 600_000, maxUsd: 5 },
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

  test('a budget without wallClockMs, or with maxAttempts, is refused at construction', async () => {
    const world = await makeWorld([{ failing: true }, { failing: false }]);
    try {
      // A landing gate alone bounds no in-flight spend.
      for (const budget of [{ maxTokens: 1000 }, { maxUsd: 5 }]) {
        expect(() => makeSweepUnitOp(bindingsOf(world, { budget }))).toThrow(
          /wallClockMs is required/,
        );
      }
      expect(() => makeSweepUnitOp(bindingsOf(world, { budget: { maxAttempts: 2 } }))).toThrow(
        /maxAttempts is not enforceable/,
      );
      expect(() =>
        makeSweepUnitOp(bindingsOf(world, { budget: { wallClockMs: 600_000, maxAttempts: 2 } })),
      ).toThrow(/maxAttempts is not enforceable/);
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  });
});

describe('optional per-task loop', () => {
  test.each([false, true])(
    'propose-only retains a plain local attempt despite pushFailed=%s',
    async (pushFailed) => {
      const world = await makeWorld([{ failing: true }, { failing: false }]);
      const original = world.driverFactory();
      let invocations = 0;
      try {
        const result = await runUnit(world, {
          taskLoop: { pushFailed },
          proposeOnly: true,
          driver: {
            run: async (...args) => {
              invocations++;
              return original.run(...args);
            },
          },
        });
        expect(result.status).toBe('ok');
        if (result.status !== 'ok') return;
        const task = result.value.tasks?.[0];
        expect(task?.outcome).toBe('escalated-to-human');
        expect(task?.reason).toContain('propose-only worker produced');
        expect(task?.failedAttempt?.branch).toMatch(/^cq\/unit\/failed\//);
        expect(task?.rounds).toEqual([
          expect.objectContaining({
            gate: 'path-policy',
            outcome: 'escalated-to-human',
            failedAttempt: task?.failedAttempt,
          }),
        ]);
        expect(task?.failedAttemptPublished).not.toBe(true);
        expect(task?.commits).toEqual([]);
        expect(invocations).toBe(2);
        expect(world.checks).toHaveLength(2);
        expect(world.gitCalls.some((args) => args.includes('restore'))).toBe(true);
        expect(
          world.gitCalls.some((args) => args.includes('push') || args.includes('commit')),
        ).toBe(false);
        expect(world.pushCalls).toEqual([]);
      } finally {
        await rm(world.root, { recursive: true, force: true });
      }
    },
  );

  test.each([
    ['clean', undefined],
    ['moved-ref', 'no longer matches its recorded ordinal'],
    ['merge-parent', 'invalid parentage'],
    ['wrong-object', 'invalid parentage'],
    ['oversize-patch', 'patch exceeds the feedback cap'],
    ['scoped-secret', 'worker upload refused'],
  ] as const)(
    'rescue feedback preserves provenance and refuses %s evidence',
    async (fault, refusal) => {
      const world = await makeWorld([{ failing: true }, { failing: false }]);
      const underlying = world.gitFactory();
      const parent = 'a'.repeat(40);
      let recordedSha = '';
      let restores = 0;
      const prompts: string[] = [];
      const feedbackContents: Array<ReadonlyArray<{ text: string; path?: string }>> = [];
      const patch = 'diff --git a/src/a.js b/src/a.js\n-old value\n+rejected value\n';
      try {
        const result = await runUnit(world, {
          taskLoop: {},
          taskEscalation: {
            next: (_task, progress) =>
              progress.workerUsed === 0
                ? { tier: 'worker', attempt: 1, reason: 'initial task' }
                : progress.rescueUsed === 0
                  ? { tier: 'rescue', attempt: 1, reason: 'retry rejected edit' }
                  : { tier: 'human', attempt: 1, reason: 'rescue exhausted' },
            verified: () => {},
          },
          git: async (args) => {
            if (args.includes('restore')) restores++;
            if (args.includes('update-ref'))
              recordedSha = String(args[args.indexOf('update-ref') + 2]);
            if (args.includes('rev-parse') && args.some((arg) => arg.startsWith('refs/heads/')))
              return {
                code: 0,
                stdout: fault === 'moved-ref' ? 'e'.repeat(40) : recordedSha,
                stderr: '',
              };
            if (args.includes('rev-list') && args.includes('--parents'))
              return {
                code: 0,
                stdout: `${fault === 'wrong-object' ? 'e'.repeat(40) : recordedSha} ${parent}${fault === 'merge-parent' ? ` ${'d'.repeat(40)}` : ''}`,
                stderr: '',
              };
            if (args.includes('--name-status') && !args.includes('--cached'))
              return {
                code: 0,
                stdout: 'M\0src/a.js\0D\0src/deleted.js\0A\0src/new.js\0',
                stderr: '',
              };
            if (args.includes('show') && !args.includes('-s')) {
              const object = String(args.at(-1));
              return {
                code: 0,
                stdout: object.startsWith(parent) ? 'old value' : 'rejected value',
                stderr: '',
              };
            }
            if (args.includes('--binary'))
              return {
                code: 0,
                stdout: fault === 'oversize-patch' ? 'x'.repeat(32 * 1024 * 1024 + 1) : patch,
                stderr: '',
              };
            return underlying(args);
          },
          scanPrompt: async (text, contents) => {
            if (!text.includes('Prior failed-attempt patch')) return;
            feedbackContents.push(contents ?? []);
            if (
              fault === 'scoped-secret' &&
              contents?.some(({ path }) => path === 'src/deleted.js')
            )
              throw new Error('path-scoped rule rejects deleted preimage');
          },
          driver: {
            run: async (invocation) => {
              prompts.push(invocation.prompt);
              if (prompts.length === 1)
                return {
                  stopReason: 'error',
                  denials: [],
                  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
                };
              expect(restores).toBeGreaterThan(0);
              return {
                stopReason: 'complete',
                denials: [],
                usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
                structuredOutput: {
                  outcome: 'code-bug',
                  summary: 'repair source',
                  confidence: 0.9,
                },
              };
            },
          },
        });
        expect(result.status).toBe('ok');
        if (result.status !== 'ok') return;
        const task = result.value.tasks?.[0];
        expect(task?.rounds?.[0]?.failedAttempt?.sha).toBe(recordedSha);
        if (refusal === undefined) {
          expect(task?.outcome).toBe('fixed');
          expect(task?.commits).toHaveLength(1);
          expect(prompts).toHaveLength(3);
          expect(prompts[1]).toContain(patch.trim());
          expect(feedbackContents).toHaveLength(2);
          for (const contents of feedbackContents)
            expect(contents).toEqual([
              { path: 'src/a.js', text: 'old value' },
              { path: 'src/a.js', text: 'rejected value' },
              { path: 'src/deleted.js', text: 'old value' },
              { path: 'src/new.js', text: 'rejected value' },
            ]);
        } else {
          expect(task?.rounds?.[1]?.reason).toContain(refusal);
          expect(task?.outcome).toBe('escalated-to-human');
          expect(task?.commits).toEqual([]);
          expect(prompts).toHaveLength(1);
          expect(world.checks).toHaveLength(1);
          expect(world.pushCalls).toEqual([]);
        }
      } finally {
        await rm(world.root, { recursive: true, force: true });
      }
    },
  );

  test.each([
    {
      gate: 'tamper',
      pkg: 'alpha',
      diff: 'diff --git a/suite.test.js b/suite.test.js\n+++ b/suite.test.js\n@@ -0,0 +1 @@\n+test.skip("bad", () => {});\n',
    },
    { gate: 'commit', pkg: 'alpha)invalid', diff: undefined },
  ] as const)('records the $gate failed-attempt gate', async ({ gate, pkg, diff }) => {
    const world = await makeWorld([{ failing: true }, { failing: false }]);
    const underlying = world.gitFactory();
    try {
      const result = await runUnit(
        world,
        {
          taskLoop: {},
          driver: {
            run: async () => ({
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              denials: [],
              stopReason: 'complete',
              structuredOutput: { outcome: 'code-bug', summary: 'repair source', confidence: 0.9 },
            }),
          },
          git: async (args) =>
            diff !== undefined &&
            args.includes('diff') &&
            args.includes('--cached') &&
            !args.includes('--name-status')
              ? { code: 0, stdout: diff, stderr: '' }
              : underlying(args),
        },
        { ...UNIT, package: pkg },
      );
      expect(result.status).toBe('ok');
      if (result.status === 'ok')
        expect(result.value.tasks?.[0]?.rounds?.[0]).toMatchObject({ gate });
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  });

  test('binary failed-attempt content stays local and never reaches the scanner', async () => {
    const world = await makeWorld([{ failing: true }, { failing: true }]);
    const underlying = world.gitFactory();
    const scanPrompt = vi.fn(async (_text: string) => {});
    try {
      const result = await runUnit(world, {
        taskLoop: { pushFailed: true },
        driver: {
          run: async () => ({
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            denials: [],
            stopReason: 'complete',
            structuredOutput: { outcome: 'code-bug', summary: 'repair source', confidence: 0.9 },
          }),
        },
        scanPrompt,
        git: async (args) =>
          args.includes('show') && args.some((arg) => arg.includes(':src/a.js'))
            ? { code: 0, stdout: 'binary\0content', stderr: '' }
            : underlying(args),
      });
      expect(result.status).toBe('ok');
      if (result.status === 'ok')
        expect(result.value.indeterminate).toContain('failed-attempt publication refused');
      expect(
        scanPrompt.mock.calls.some(([text]) => text.startsWith('Failed-attempt commit ')),
      ).toBe(false);
      expect(world.gitCalls.some((args) => args.includes('push'))).toBe(false);
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  });

  test('failed-attempt scan refuses file content over its cap before scanning or pushing', async () => {
    const world = await makeWorld([{ failing: true }, { failing: true }]);
    const underlying = world.gitFactory();
    const scanPrompt = vi.fn(async (_text: string) => {});
    try {
      const result = await runUnit(world, {
        taskLoop: { pushFailed: true },
        driver: {
          run: async () => ({
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            denials: [],
            stopReason: 'complete',
            structuredOutput: { outcome: 'code-bug', summary: 'repair source', confidence: 0.9 },
          }),
        },
        scanPrompt,
        git: async (args) =>
          args.includes('cat-file') && args.includes('-s') && args.at(-1)?.endsWith(':src/a.js')
            ? { code: 0, stdout: String(4 * 1024 * 1024 + 1), stderr: '' }
            : underlying(args),
      });
      expect(result.status).toBe('ok');
      if (result.status === 'ok')
        expect(result.value.indeterminate).toContain('failed-attempt publication refused');
      expect(
        scanPrompt.mock.calls.some(([text]) => text.startsWith('Failed-attempt commit ')),
      ).toBe(false);
      expect(world.gitCalls.some((args) => args.includes('push'))).toBe(false);
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  });

  test.each([
    {
      refusal: 'unsupported rename record',
      expectedReason: 'invalid or unsupported path record',
      scanDiff: 'R100\0src/old.js\0src/new.js\0',
    },
    {
      refusal: 'truncated path record',
      expectedReason: 'invalid or unsupported path record',
      scanDiff: 'M\0',
    },
    {
      refusal: 'path traversal',
      expectedReason: 'path outside the repository',
      scanDiff: 'M\0../outside.js\0',
    },
    {
      refusal: 'invalid object size',
      expectedReason: 'cannot determine failed-attempt size',
      scanDiff: 'M\0src/a.js\0',
    },
    {
      refusal: 'aggregate content cap',
      expectedReason: 'contents exceed the total scan cap',
      scanDiff: Array.from({ length: 5 }, (_, i) => `M\0src/file-${i}.js\0`).join(''),
    },
  ])('keeps failed-attempt publication local on $refusal', async ({ expectedReason, scanDiff }) => {
    const world = await makeWorld([{ failing: true }, { failing: true }]);
    const underlying = world.gitFactory();
    const scanPrompt = vi.fn(async (_text: string) => {});
    try {
      const result = await runUnit(world, {
        taskLoop: { pushFailed: true },
        driver: {
          run: async () => ({
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            denials: [],
            stopReason: 'complete',
            structuredOutput: { outcome: 'code-bug', summary: 'repair source', confidence: 0.9 },
          }),
        },
        scanPrompt,
        git: async (args) => {
          if (args.includes('diff') && args.includes('--name-status') && !args.includes('--cached'))
            return { code: 0, stdout: scanDiff, stderr: '' };
          if (args.includes('cat-file') && args.includes('-s'))
            return {
              code: 0,
              stdout: expectedReason.includes('determine failed-attempt size')
                ? 'invalid-size'
                : String(4 * 1024 * 1024),
              stderr: '',
            };
          return underlying(args);
        },
      });
      expect(result.status).toBe('ok');
      if (result.status === 'ok') {
        expect(JSON.stringify(result.value)).toContain('failed-attempt publication refused');
        expect(JSON.stringify(result.value)).toContain(expectedReason);
      }
      expect(
        scanPrompt.mock.calls.some(([text]) => text.startsWith('Failed-attempt commit ')),
      ).toBe(false);
      expect(world.gitCalls.some((args) => args.includes('push'))).toBe(false);
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  });

  test('cleanup and publish failures retain task evidence as indeterminate unit reports', async () => {
    for (const fault of ['cleanup', 'publish']) {
      const world = await makeWorld([{ failing: true }, { failing: false }]);
      const underlying = world.gitFactory();
      try {
        const result = await runUnit(world, {
          taskLoop: {},
          git: async (args) =>
            args.includes('restore') && fault === 'cleanup'
              ? { code: 1, stdout: '', stderr: 'restore fault' }
              : underlying(args),
          driver:
            fault === 'cleanup'
              ? world.driverFactory()
              : {
                  run: async (invocation) => {
                    expect(invocation.toolPolicy.allow).not.toContain('run');
                    return {
                      stopReason: 'complete',
                      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
                      denials: [],
                      structuredOutput: {
                        outcome: 'code-bug',
                        summary: 'repair source',
                        confidence: 0.9,
                      },
                    };
                  },
                },
          pushBranch: async () => {
            throw new Error('offline push fault');
          },
        });
        expect(result.status).toBe('ok');
        if (result.status === 'ok') {
          expect(result.value.tasks).toHaveLength(1);
          expect(result.value.indeterminate).toContain(
            fault === 'cleanup' ? 'failed-task evidence recording failed' : 'publish failed',
          );
          expect(result.value.committed).toBe(fault === 'publish');
        }
      } finally {
        await rm(world.root, { recursive: true, force: true });
      }
    }
  });
  test('absolute runner paths become checkout-relative task files', async () => {
    const world = await makeWorld([{ failing: true }, { failing: false }]);
    const runCheck = world.runCheckFactory();
    try {
      const result = await runUnit(world, {
        taskLoop: {},
        runCheck: async (command) => {
          const output = await runCheck(command);
          return {
            ...output,
            stdout: output.stdout.replaceAll('suite.test.js', `${command.cwd}/suite.test.js`),
          };
        },
        deriveTasks: (baseline) => {
          expect(baseline.failures[0]?.file).toBe('suite.test.js');
          return [];
        },
      });
      expect(result.status).toBe('ok');
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  });
  test('stateless related feedback precedes detached broader gate and a verified task commit', async () => {
    const world = await makeWorld([{ failing: true }, { failing: false }]);
    const prompts: string[] = [];
    try {
      const result = await runUnit(world, {
        taskLoop: {},
        driver: {
          run: async (invocation) => {
            prompts.push(invocation.prompt);
            expect(invocation.sessionRef).toBeUndefined();
            return {
              usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
              denials: [],
              stopReason: 'complete',
              structuredOutput: { outcome: 'code-bug', summary: 'repair source', confidence: 0.9 },
            };
          },
        },
      });
      expect(result.status).toBe('ok');
      if (result.status === 'ok') {
        expect(result.value.tasks?.[0]?.outcome).toBe('fixed');
        expect(result.value.tasks?.[0]?.attempts).toHaveLength(2);
        expect(result.value.tasks?.[0]?.commits).toHaveLength(1);
      }
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toContain('Related check:');
      expect(world.checks.some((path) => path.includes('.cq-sweep-final-'))).toBe(true);
      expect(world.gitCalls.find((args) => args.includes('commit'))?.at(-1)).toContain(
        'Outcome: code-bug',
      );
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  });
  test('protectTests sends test edits to human and commits nothing', async () => {
    const world = await makeWorld([{ failing: true }, { failing: false }]);
    const underlying = world.gitFactory();
    try {
      const result = await runUnit(world, {
        taskLoop: { protectTests: true },
        git: async (args) =>
          args.includes('--name-status')
            ? { code: 0, stdout: 'M\0suite.test.js\0', stderr: '' }
            : underlying(args),
      });
      expect(result.status).toBe('ok');
      if (result.status === 'ok')
        expect(result.value.tasks?.[0]?.outcome).toBe('escalated-to-human');
      expect(world.gitCalls.some((args) => args.includes('commit'))).toBe(false);
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  });
});

test('failed task does not block a passing sibling task', async () => {
  const world = await makeWorld([
    { failing: true },
    { failing: true },
    { failing: true },
    { failing: false },
  ]);
  try {
    const result = await runUnit(world, {
      taskLoop: {},
      deriveTasks: (baseline) =>
        [0, 1].map((id) => ({
          id: String(id),
          files: ['suite.test.js'],
          failures: baseline.failures,
        })),
      driver: {
        run: async () => ({
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          denials: [],
          stopReason: 'complete',
          structuredOutput: { outcome: 'code-bug', summary: 'repair source', confidence: 0.9 },
        }),
      },
    });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.value.tasks?.map((task) => task.outcome)).toEqual(['unfixed', 'fixed']);
      expect(result.value.tasks?.[1]?.commits).toHaveLength(1);
    }
  } finally {
    await rm(world.root, { recursive: true, force: true });
  }
});

test.each(['budget', 'stopped', 'invalid-output', 'dirty', 'moved-head', 'unattributed'] as const)(
  'task-loop refusal retains evidence for %s',
  async (mode) => {
    const world = await makeWorld([{ failing: true }, { failing: false }]);
    const underlying = world.gitFactory();
    let invoked = false;
    try {
      const result = await runUnit(world, {
        taskLoop: {},
        deriveTasks: (baseline) =>
          [0, 1].map((id) => ({
            id: String(id),
            files: mode === 'unattributed' ? [] : ['suite.test.js'],
            failures: baseline.failures,
          })),
        git: async (args) => {
          if (
            mode === 'moved-head' &&
            invoked &&
            args.includes('rev-parse') &&
            args.includes('HEAD')
          )
            return { code: 0, stdout: 'd'.repeat(40), stderr: '' };
          if (mode === 'dirty' && args.includes('status'))
            return { code: 0, stdout: ' M src/a.js', stderr: '' };
          return underlying(args);
        },
        driver: {
          run: async () => {
            invoked = true;
            return {
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              denials: [],
              stopReason: mode === 'budget' ? 'budget' : mode === 'stopped' ? 'error' : 'complete',
            };
          },
        },
      });
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;
      expect(result.value.committed).toBe(false);
      expect(result.value.tasks).toHaveLength(2);
      if (mode === 'budget') {
        expect(result.value.budgetStopped).toBe(true);
        expect(result.value.tasks?.[1]?.attempts).toHaveLength(0);
      } else if (mode === 'moved-head') {
        expect(result.value.tasks?.[0]?.reason).toContain('HEAD changed');
        expect(result.value.tasks?.[1]?.reason).toContain('human review');
      } else if (mode === 'dirty') {
        expect(result.value.tasks?.[0]?.failedAttempt?.branch).toMatch(/^cq\/unit\/failed\//);
        expect(result.value.tasks?.[0]?.failedAttempt?.sha).toMatch(/^[0-9a-f]{40,64}$/);
        expect(world.gitCalls.some((args) => args.includes('restore'))).toBe(true);
      } else if (mode === 'unattributed') {
        expect(invoked).toBe(false);
        expect(result.value.tasks?.every((task) => task.outcome === 'escalated-to-human')).toBe(
          true,
        );
      } else expect(result.value.tasks?.[0]?.outcome).toBe('unfixed');
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  },
);

test.each(['edit', 'feedback'] as const)(
  'protected config edits from %s are refused before another check executes',
  async (phase) => {
    const world = await makeWorld([{ failing: true }, { failing: false }]);
    const underlying = world.gitFactory();
    let invocations = 0;
    try {
      const result = await runUnit(world, {
        taskLoop: {},
        git: async (args) =>
          args.includes('--name-status') && invocations >= (phase === 'edit' ? 1 : 2)
            ? { code: 0, stdout: 'M\0vitest.config.ts\0', stderr: '' }
            : underlying(args),
        driver: {
          run: async () => {
            invocations++;
            return {
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              denials: [],
              stopReason: 'complete',
              structuredOutput: { outcome: 'code-bug', summary: 'repair', confidence: 0.9 },
            };
          },
        },
      });
      expect(result.status).toBe('ok');
      if (result.status === 'ok')
        expect(result.value.tasks?.[0]?.outcome).toBe('escalated-to-human');
      expect(world.checks).toHaveLength(phase === 'edit' ? 1 : 2);
      expect(invocations).toBe(phase === 'edit' ? 1 : 2);
      expect(world.gitCalls.some((args) => args.includes('commit'))).toBe(false);
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  },
);
test.each(['none', 'edit-only'] as const)(
  'task-specific harness never widens explicit %s policy',
  async (mode) => {
    const world = await makeWorld([{ failing: true }, { failing: false }]);
    const seen: unknown[] = [];
    try {
      const driver: Driver = {
        run: async (invocation) => {
          seen.push(invocation.toolPolicy);
          return {
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            denials: [],
            stopReason: 'complete',
            structuredOutput: { outcome: 'code-bug', summary: 'repair', confidence: 0.9 },
          };
        },
      };
      await runUnit(world, {
        taskLoop: {},
        driver,
        taskWorker: () => ({ driver, modelSpec: { provider: 'test', model: 'fake' } }),
        toolPolicy:
          mode === 'none'
            ? { mode: 'none', allow: ['read', 'edit', 'run'] }
            : { mode: 'allowlist', allow: ['edit'] },
      });
      expect(seen).toHaveLength(2);
      expect(
        seen.every(
          (policy) =>
            JSON.stringify(policy) ===
            JSON.stringify(
              mode === 'none'
                ? { allow: [], mode: 'none' }
                : { allow: ['edit'], mode: 'allowlist' },
            ),
        ),
      ).toBe(true);
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  },
);
test.each([false, true])(
  'broader timeout uses remaining unit wall and bounds retries (bail=%s)',
  async (bail) => {
    const world = await makeWorld([{ failing: true }, { failing: false }]);
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const original = world.runCheckFactory();
    let broaderCalls = 0;
    try {
      const result = await runUnit(world, {
        taskLoop: { wallMs: 1000 },
        runCheck: async (command) => {
          if (command.cwd?.includes('.cq-sweep-final-')) {
            broaderCalls++;
            expect(command.timeoutMs).toBeGreaterThan(0);
            expect(command.timeoutMs).toBeLessThanOrEqual(200);
            if (bail) {
              now += 201;
              return { stdout: '', stderr: 'test run aborted', exitCode: null };
            }
          }
          return original(command);
        },
        driver: {
          run: async () => {
            now += 400;
            return {
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              denials: [],
              stopReason: 'complete',
              structuredOutput: { outcome: 'code-bug', summary: 'repair', confidence: 0.9 },
            };
          },
        },
      });
      expect(broaderCalls).toBe(1);
      expect(result.status).toBe('ok');
      if (result.status === 'ok')
        expect(result.value.tasks?.[0]?.outcome).toBe(bail ? 'unfixed' : 'fixed');
    } finally {
      clock.mockRestore();
      await rm(world.root, { recursive: true, force: true });
    }
  },
);
test('a sibling-resolved task consumes no worker invocation or duplicate commit', async () => {
  const world = await makeWorld([{ failing: true }, { failing: false }]);
  let invocations = 0;
  try {
    const result = await runUnit(world, {
      taskLoop: {},
      deriveTasks: (baseline) =>
        [0, 1].map((id) => ({
          id: String(id),
          files: ['suite.test.js'],
          failures: baseline.failures,
        })),
      driver: {
        run: async () => {
          invocations++;
          return {
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            denials: [],
            stopReason: 'complete',
            structuredOutput: { outcome: 'code-bug', summary: 'repair', confidence: 0.9 },
          };
        },
      },
    });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.value.tasks?.map((task) => task.outcome)).toEqual(['fixed', 'fixed']);
      expect(result.value.tasks?.[1]?.attempts).toEqual([]);
      expect(result.value.tasks?.[1]?.commits).toEqual([]);
    }
    expect(invocations).toBe(2);
  } finally {
    await rm(world.root, { recursive: true, force: true });
  }
});
test('task derivation throws become a failed OpResult', async () => {
  const world = await makeWorld([{ failing: true }]);
  try {
    const result = await runUnit(world, {
      taskLoop: {},
      deriveTasks: () => {
        throw new Error('bad task derivation');
      },
    });
    expect(result).toEqual({
      status: 'failed',
      error: '[INFRA] task loop failed: Error: bad task derivation',
    });
  } finally {
    await rm(world.root, { recursive: true, force: true });
  }
});

test('an unrecorded ahead commit cannot be republished on a no-task rerun', async () => {
  const world = await makeWorld([{ failing: false }]);
  const original = world.gitFactory();
  try {
    const result = await runUnit(world, {
      taskLoop: {},
      deriveTasks: () => [],
      runStateDir: join(world.root, 'state'),
      git: async (args) =>
        args.includes('rev-list') ? { code: 0, stdout: '1', stderr: '' } : original(args),
    });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.value.pushed).toBe(false);
      expect(result.value.indeterminate).toContain('no verified scanned commit');
    }
    expect(world.pushCalls).toEqual([]);
  } finally {
    await rm(world.root, { recursive: true, force: true });
  }
});

test.each(['missing', 'fault', 'initial-hit', 'prior-output', 'related-output'] as const)(
  'task upload gate refuses %s without sending tainted prompts',
  async (mode) => {
    const world = await makeWorld([
      { failing: true, message: mode === 'initial-hit' ? 'DO_NOT_UPLOAD' : 'failure' },
      { failing: true, message: mode === 'related-output' ? 'DO_NOT_UPLOAD' : 'failure' },
    ]);
    let calls = 0;
    try {
      const base = world.driverFactory();
      const bindings = bindingsOf(world, {
        taskLoop: {},
        scanPrompt: async (text) => {
          if (mode === 'fault' || text.includes('DO_NOT_UPLOAD')) throw new Error('scan refused');
        },
        driver: {
          run: async (...args) => {
            calls++;
            expect(args[0].prompt).not.toContain('DO_NOT_UPLOAD');
            const result = await base.run(...args);
            return mode === 'prior-output'
              ? { ...result, structuredOutput: { summary: 'DO_NOT_UPLOAD' } }
              : result;
          },
        },
      });
      if (mode === 'missing') delete bindings.scanPrompt;
      const result = await makeSweepUnitOp(bindings)(UNIT);
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;
      expect(result.value.tasks?.[0]?.outcome).toBe('escalated-to-human');
      expect(calls).toBe(['prior-output', 'related-output'].includes(mode) ? 1 : 0);
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  },
);

// Direct SDK callers bypass the registry schema: refuse escaping check roots before resolving a driver.
test.each(['/tmp/outside', '../outside', 'nested/../../outside', 'C:\\outside'])(
  'direct dispatch refuses escaping check.cwd %s',
  (cwd) => {
    const resolve = vi.fn(() => {
      throw new Error('driver must not resolve');
    });
    expect(() =>
      bindingsFromDispatch(
        {
          repoRoot: '/repo',
          runPrefix: 'fix',
          base: 'HEAD',
          package: 'alpha',
          fixer: 'fix',
          files: [],
          driver: { provider: 'test', model: 'test', budget: { wallClockMs: 1000 } },
          check: { adapter: 'vitest-json', command: 'node', args: [], cwd },
        },
        { resolve },
      ),
    ).toThrow('check.cwd must remain inside');
    expect(resolve).not.toHaveBeenCalled();
  },
);

test.each(['tokens', 'wall'] as const)(
  'shared run %s exhaustion refuses a new provider dispatch',
  async (cap) => {
    const world = await makeWorld([{ failing: true }, { failing: false }]);
    let calls = 0;
    try {
      const result = await runUnit(world, {
        taskLoop: {},
        taskRunBudget: {
          remainingTokens: () => (cap === 'tokens' ? 0 : 100),
          remainingWallMs: () => (cap === 'wall' ? 0 : 60_000),
          reportResult: () => {
            throw new Error('must not report an undispatched call');
          },
        },
        driver: {
          run: async () => {
            calls++;
            throw new Error('must not dispatch');
          },
        },
      });
      expect(calls).toBe(0);
      expect(result.status).toBe('ok');
      if (result.status === 'ok') {
        expect(result.value.budgetStopped).toBe(true);
        expect(result.value.tasks?.[0]?.attempts).toEqual([]);
        expect(result.value.tasks?.[0]?.commits).toEqual([]);
      }
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  },
);
test('task invocation cost preserves its basis and shared accounting observes both stateless calls', async () => {
  const world = await makeWorld([{ failing: true }, { failing: false }]);
  const accounted: WorkerResult[] = [];
  try {
    const result = await runUnit(world, {
      taskLoop: {},
      taskRunBudget: {
        remainingTokens: () => 100,
        remainingWallMs: () => 60_000,
        reportResult: (worker) => accounted.push(worker),
      },
      driver: {
        run: async () => ({
          stopReason: 'complete',
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          costUSD: 0.002,
          costBasis: 'modeled',
          denials: [],
          structuredOutput: { outcome: 'code-bug', summary: 'repair source', confidence: 0.9 },
        }),
      },
    });
    expect(result.status).toBe('ok');
    expect(accounted).toHaveLength(2);
    if (result.status === 'ok') {
      expect(result.value.tasks?.[0]?.attempts.map((a) => [a.costUSD, a.costBasis])).toEqual([
        [0.002, 'modeled'],
        [0.002, 'modeled'],
      ]);
      expect(result.value.tasks?.[0]?.rounds?.[0]?.validation?.verdict).toBe('pass');
    }
  } finally {
    await rm(world.root, { recursive: true, force: true });
  }
});

test.each(['probe-fault', 'no-progress'] as const)(
  'broader %s preserves the next configured worker round without consuming rescue',
  async (fault) => {
    const world = await makeWorld([{ failing: true }, { failing: false }]);
    const runCheck = world.runCheckFactory();
    const prompts: string[] = [];
    let probes = 0;
    let state = createEscalationState();
    try {
      const result = await runUnit(world, {
        taskLoop: {},
        taskEscalation: {
          next: (task, progress) => {
            const transition = nextEscalation(
              state,
              { workerAttempts: 2, rescueBase: 1, rescuePerFixed: 10, rescuePerPackageCap: 1 },
              { ...progress, package: 'alpha', task: task.id, canRescue: true },
            );
            state = transition.state;
            return transition.decision;
          },
          verified: () => {},
        },
        runCheck: async (command) => {
          if (command.cwd?.includes('.cq-sweep-final-') && probes++ === 0) {
            if (fault === 'probe-fault') throw new Error('temporary broader probe fault');
            return { stdout: vitestOutput(true), stderr: '', exitCode: 1 };
          }
          return runCheck(command);
        },
        driver: {
          run: async (invocation) => {
            prompts.push(invocation.prompt);
            return {
              stopReason: 'complete',
              denials: [],
              usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
              structuredOutput: { outcome: 'code-bug', summary: 'repair source', confidence: 0.9 },
            };
          },
        },
      });
      expect(result.status).toBe('ok');
      expect(state.perRunUsed).toBe(0);
      expect(prompts).toHaveLength(4);
      expect(prompts[2]).toContain('Tier: worker; attempt: 2');
      if (result.status === 'ok') {
        expect(result.value.tasks?.[0]?.outcome).toBe('fixed');
        expect(result.value.tasks?.[0]?.commits).toHaveLength(1);
        expect(result.value.tasks?.[0]?.rounds?.[0]?.validation?.regression).toBeUndefined();
      }
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  },
);
