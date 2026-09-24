// In-process sweep.unit decision coverage. These scenarios exercise our
// orchestration over fresh injected effects; the real-git contracts remain in
// test/e2e/sweep/sweep.e2e.test.ts.
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { Driver, OpInvocation, WorkerResult } from '../../../src/driver/types.js';
import { JournalEventSchema } from '../../../src/kernel/schema.js';
import type { RunCheck } from '../../../src/ops/gates/checkRunner.js';
import {
  makeSweepUnitOp,
  RETRYABLE_FAULT_CLASSES,
  sweepUnitFaultClass,
} from '../../../src/ops/sweep/unit.js';
import type { SweepUnitBindings } from '../../../src/ops/sweep/unit.js';
import type { WorkUnit } from '../../../src/ops/sweep/planSweep.js';
import type { WorktreeEffects } from '../../../src/ops/sweep/worktreeFor.js';
import type { GhFn } from '../../../src/ops/review/gh.js';

interface FakeWorld {
  root: string;
  effects: WorktreeEffects;
  git: GhFn;
  gitCalls: string[][];
  checks: string[];
  driverCalls: OpInvocation[];
  runCheck: RunCheck;
  driver: Driver;
  worktreePath: string;
  clean: boolean;
  state: {
    staged: boolean;
    stagedDiff: string;
    stagedNameStatus: string;
    commitFault: boolean;
    committed: boolean;
  };
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

async function makeWorld(
  checkOutputs: Array<{ failing: boolean; message?: string }>,
): Promise<FakeWorld> {
  const root = await mkdtemp(join(tmpdir(), 'sweep-unit-scenarios-'));
  const worktreePath = join(root, 'worktrees', 'fix', 'alpha');
  const gitCalls: string[][] = [];
  const checks: string[] = [];
  const driverCalls: OpInvocation[] = [];
  const state = { clean: true, worktreePath };
  const dirty = { value: false };
  const worktreeState: Array<{ path: string; branch: string }> = [];
  const effects: WorktreeEffects = {
    listWorktrees: async () => worktreeState.map((entry) => ({ ...entry })),
    listBranches: async () => [],
    listRemoteBranches: async () => [],
    remoteGetUrl: async () => null,
    pathExists: async () => false,
    trackedFilesUnder: async () => [],
    isStrictClean: async () => !dirty.value,
    worktreeAdd: async ({ path, branch }) => {
      state.worktreePath = path;
      state.clean = true;
      worktreeState.push({ path, branch });
    },
    worktreePrune: async () => undefined,
    rmDir: async () => undefined,
  };

  const gitState = {
    staged: true,
    stagedDiff: 'diff --git a/src/a.js b/src/a.js\n',
    stagedNameStatus: '',
    commitFault: false,
    committed: false,
  };
  const git: GhFn = async (args) => {
    gitCalls.push(args);
    if (args.includes('rev-list')) return { code: 0, stdout: '0\n', stderr: '' };
    if (args.includes('--quiet')) return { code: gitState.staged ? 1 : 0, stdout: '', stderr: '' };
    if (args.includes('--name-status')) {
      return { code: 0, stdout: gitState.stagedNameStatus, stderr: '' };
    }
    if (args.includes('diff') && args.includes('--cached')) {
      return { code: 0, stdout: gitState.stagedDiff, stderr: '' };
    }
    if (args.includes('commit') && gitState.commitFault) {
      return { code: 1, stdout: '', stderr: 'commit failed' };
    }
    if (args.includes('commit')) gitState.committed = true;
    return { code: 0, stdout: '', stderr: '' };
  };

  let checkIndex = 0;
  const runCheck: RunCheck = async (command) => {
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
  const driver: Driver = {
    run: async (invocation) => {
      driverCalls.push(invocation);
      return {
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        denials: [],
        stopReason: 'complete',
      } satisfies WorkerResult;
    },
  };
  return {
    root,
    effects,
    git,
    gitCalls,
    checks,
    driverCalls,
    runCheck,
    driver,
    worktreePath,
    clean: state.clean,
    state: gitState,
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
    worktreeEffects: world.effects,
    runCheck: world.runCheck,
    checkCommand: (unit, cwd) => ({ command: 'vitest', args: [unit.package], cwd }),
    driver: world.driver,
    modelSpec: { model: 'fake', provider: 'test' },
    sessionsDir: join(world.root, 'sessions'),
    prompt: () => 'fix it',
    git: world.git,
    ...extra,
  };
}

async function runUnit(world: FakeWorld, extra: Partial<SweepUnitBindings> = {}, unit = UNIT) {
  return makeSweepUnitOp(bindingsOf(world, extra))(unit);
}

describe('sweep unit in-process scenarios', () => {
  test('regression fails before commit and preserves a dirty worktree for salvage', async () => {
    const world = await makeWorld([
      { failing: true, message: 'baseline' },
      { failing: true, message: 'novel failure' },
    ]);
    try {
      const result = await runUnit(world);
      expect(result.status).toBe('failed');
      if (result.status === 'failed') {
        expect(result.error).toMatch(/REGRESSION/);
        expect(result.error).toContain('novel failure');
      }
      expect(world.gitCalls.some((args) => args.includes('commit'))).toBe(false);
      // The same worktree is now dirty; a later reuse must not silently clean it.
      world.dirty.value = true;
      world.worktreeState[0] = { path: world.worktreePath, branch: 'cq/unit/fix/alpha' };
      const later = await makeSweepUnitOp(bindingsOf(world))(UNIT);
      expect(later.status).toBe('failed');
      if (later.status === 'failed') expect(later.error).toMatch(/dirty .*refusing reuse/);
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  });

  test('ordinary stage-path allowlist rejection leaves the fix staged but uncommitted', async () => {
    const world = await makeWorld([{ failing: true }, { failing: false }]);
    try {
      world.state.stagedNameStatus = 'M\0packages/beta/index.js';
      const result = await runUnit(world, {
        stagePathAllowlist: { patterns: ['^src/'] },
      });
      expect(result.status).toBe('failed');
      if (result.status === 'failed') expect(result.error).toMatch(/outside the allowlist/);
      expect(world.gitCalls.some((args) => args.includes('commit'))).toBe(false);
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  });

  test('scoped package names normalize to a safe branch segment', async () => {
    const world = await makeWorld([{ failing: true }, { failing: false }]);
    try {
      const result = await runUnit(
        world,
        { segments: { kind: 'fix', slug: 'scope-gamma', branch: 'cq/unit/fix/scope-gamma' } },
        {
          ...UNIT,
          package: '@scope/gamma',
        },
      );
      expect(result.status).toBe('ok');
      if (result.status === 'ok') expect(result.value.prBranch).toBe('cq/unit/fix/scope-gamma');
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  });

  test('all-no-op assembly has no commit, marker, or assemble leg input', async () => {
    const world = await makeWorld([{ failing: false }, { failing: false }]);
    try {
      world.state.staged = false;
      const result = await runUnit(world);
      expect(result.status).toBe('ok');
      if (result.status === 'ok') {
        expect(result.value.committed).toBe(false);
        expect(result.value.pushed).toBe(false);
      }
      expect(world.gitCalls.some((args) => args.includes('commit'))).toBe(false);
      const marker = join(
        world.root,
        'worktrees',
        '.cq-state',
        'cq/unit',
        'committed',
        'fix',
        'alpha.json',
      );
      await expect(stat(marker)).rejects.toThrow();
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  });

  test('the default package scope rejects a cross-package staged path', async () => {
    const world = await makeWorld([{ failing: true }, { failing: false }]);
    try {
      world.state.stagedNameStatus = 'M\0packages/beta/test/suite.test.js';
      const result = await runUnit(world, {
        stagePathAllowlist: { patterns: ['^packages/alpha/', 'packages/alpha/test/suite.js'] },
      });
      expect(result.status).toBe('failed');
      if (result.status === 'failed') expect(result.error).toMatch(/outside the allowlist/);
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  });

  test('rescue policy retries only transient fault classes', async () => {
    const world = await makeWorld([{ failing: true }, { failing: false }]);
    try {
      const result = await runUnit(world, {
        driver: {
          run: async () =>
            ({
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              denials: [],
              stopReason: 'error',
            }) satisfies WorkerResult,
        },
      });
      expect(result.status).toBe('failed');
      if (result.status === 'failed') {
        expect(sweepUnitFaultClass(result.error)).toBe('infra');
        expect(RETRYABLE_FAULT_CLASSES).toContain('infra');
      }
      world.state.stagedDiff =
        'diff --git a/added.test.js b/added.test.js\nnew file mode 100644\n--- /dev/null\n+++ b/added.test.js\n@@ -0,0 +1 @@\n+it.skip("gaming the run", () => {});\n';
      const tamper = await runUnit(world);
      expect(tamper.status).toBe('failed');
      if (tamper.status === 'failed') {
        expect(sweepUnitFaultClass(tamper.error)).toBe('tamper');
        expect(RETRYABLE_FAULT_CLASSES).not.toContain('tamper');
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

  test('prep mode writes baseline evidence and stops before the fixer', async () => {
    const world = await makeWorld([{ failing: true }]);
    try {
      const result = await runUnit(world, { mode: 'prep' });
      expect(result.status).toBe('ok');
      if (result.status === 'ok') {
        expect(result.value.mode).toBe('prep');
        expect(result.value.baseline.verdict).toBe('failing');
        expect(result.value.final).toBeUndefined();
        expect(result.value.regression).toBeUndefined();
        expect(result.value.committed).toBeUndefined();
        expect(result.value.pushed).toBeUndefined();
      }
      expect(world.driverCalls).toHaveLength(0);
      expect(world.checks).toHaveLength(1);
      const snapshot = join(
        world.root,
        'worktrees',
        '.cq-state',
        'cq/unit',
        'baseline',
        'fix',
        'alpha.json',
      );
      expect(await readFile(snapshot, 'utf8')).toContain('"failures"');
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  });
});
