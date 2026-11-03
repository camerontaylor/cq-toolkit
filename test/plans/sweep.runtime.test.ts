// Split provenance: test/plans/sweep.test.ts was split by subject; this file
// keeps the runtime pins (the floor through the real runner, the unit
// composition's bindings, and the governed-cancellation mapping). Shared
// fixtures live in ./sweep.helpers.ts and the original suite header sits
// there.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { Driver, OpInvocation } from '../../src/driver/types.js';
import { runPlan, type OpRegistryView } from '../../src/kernel/runner.js';
import type { OpRegistryEntry, Plan } from '../../src/kernel/types.js';
import { registry as prRegistry } from '../../src/ops/pr/registry.js';
import type { WorkUnit } from '../../src/ops/sweep/planSweep.js';
import { registry as sweepRegistry } from '../../src/ops/sweep/registry.js';
import { makeSweepUnitOp } from '../../src/ops/sweep/unit.js';
import { SWEEP_PLAN_ID } from '../../src/plans/sweep.js';
import { getPlan } from '../../src/plans/registry.js';
import { generateScratchRepo } from '../fixtures/scratch-repo/generate.js';

describe('sweep + test-fix smoke: discovery and shape (ws-i item 2)', () => {
  test('the sweep floor runs through the real runner as a harmless pass', async () => {
    const plan: Plan = (await (await getPlan(SWEEP_PLAN_ID))?.importer()) as Plan;
    // The real sweep registry entry (real subprocess planner deps) — the
    // empty manifest selects nothing and consults nothing.
    const entryByName = new Map<string, OpRegistryEntry<never, never>>(
      // The bottom-instantiation cast (the review-loop precedent: unknown
      // does not widen down to never, so the view cast goes through here).
      [...sweepRegistry, ...prRegistry].map((entry) => [
        entry.name,
        entry as unknown as OpRegistryEntry<never, never>,
      ]),
    );
    const view: OpRegistryView = { get: (name) => entryByName.get(name) };
    const report = await runPlan(plan, { concurrency: 1, stopOnError: true }, view);
    expect(report.counts).toMatchObject({ done: 1, failed: 0, blocked: 0 });
    expect(report.jobs[0]?.result.status).toBe('ok');
  });

  test(
    'the unit composition binds a required budget and defaults sandboxPolicy to workspace-write',
    { timeout: 120_000 },
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'd4-unit-bindings-'));
      try {
        const repo = join(root, 'repo');
        const worktree = join(repo, 'worktrees', 'fix', 'alpha');
        mkdirSync(repo, { recursive: true });
        mkdirSync(worktree, { recursive: true });
        const captured: OpInvocation[] = [];
        // A capturing fake driver: records the invocation, then stops the
        // pipeline. S4b-B2 (ADR-0002 §2.9): an unclassified driver throw is
        // a pre-dispatch failure the human arranges — the op folds it into a
        // `needs-human` result (the capture is the point).
        const driver: Driver = {
          run: async (invocation) => {
            captured.push(invocation);
            throw new Error('captured — stopping the pipeline here');
          },
        };
        const base = {
          repoRoot: repo,
          worktreesDir: 'worktrees',
          runPrefix: 'cq/unit-bind',
          base: 'main',
          adapter: 'tsc-lines' as const,
          worktreeEffects: {
            listWorktrees: async () => [{ path: worktree, branch: 'cq/unit-bind/fix/alpha' }],
            listBranches: async () => [],
            listRemoteBranches: async () => [],
            pathExists: async () => false,
            trackedFilesUnder: async () => [],
            isStrictClean: async () => true,
            revParse: async () => '0'.repeat(40),
            worktreeAdd: async () => undefined,
            worktreePrune: async () => undefined,
            rmDir: async () => undefined,
          },
          // A clean probe — no subprocess needed for this pin.
          runCheck: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
          checkCommand: (unit: WorkUnit, worktreePath: string) => ({
            command: process.execPath,
            args: ['scripts/check.js', unit.package],
            cwd: worktreePath,
            timeoutMs: 30_000,
          }),
          driver,
          modelSpec: { model: 'sweep-fake', provider: 'cq-d4-e2e' },
          budget: { wallClockMs: 600_000, maxUsd: 1 },
          prompt: () => 'capture me',
          git: async () => ({ code: 0, stdout: '', stderr: '' }),
        };
        const unit: WorkUnit = { package: 'alpha', fixer: 'fix', files: [] };
        // The SDK requires a cap before the unit can run.
        expect(() => makeSweepUnitOp({ ...base, budget: {} })).toThrow(/wallClockMs is required/);
        expect(() => makeSweepUnitOp({ ...base, budget: undefined } as never)).toThrow(
          /wallClockMs is required/,
        );
        // A post-run landing gate alone is not a spend bound (PR #246 review).
        expect(() => makeSweepUnitOp({ ...base, budget: { maxTokens: 1000 } })).toThrow(
          /wallClockMs is required/,
        );
        // DEFAULT: workspace-write.
        const refused = await makeSweepUnitOp(base)(unit);
        expect(refused.status).toBe('needs-human'); // the capture's deliberate stop
        expect(captured[0]?.sandboxPolicy).toEqual({
          level: 'workspace-write',
        });
        expect(captured[0]?.budget).toEqual({ wallClockMs: 600_000, maxUsd: 1 });
        // WORKSPACE BINDING (ADR-0002 §2.4): the worktree rides the
        // invocation as its workspace — no pre-created session record, no
        // sessionRef — and the invocation carries the bindings' (resolved)
        // modelSpec verbatim.
        expect(captured[0]?.workspace).toBeDefined();
        expect(captured[0]?.workspace?.path).toContain(join(repo, 'worktrees'));
        expect(captured[0]?.sessionRef).toBeUndefined();
        expect(captured[0]?.modelSpec).toEqual({
          model: 'sweep-fake',
          provider: 'cq-d4-e2e',
        });
        // OVERRIDE: the binding rides verbatim into the OpInvocation.
        const hardened: WorkUnit = {
          package: 'alpha',
          fixer: 'hardened',
          files: [],
        };
        await makeSweepUnitOp({
          ...base,
          sandboxPolicy: { level: 'workspace-write' },
        })(hardened);
        expect(captured[1]?.sandboxPolicy).toEqual({
          level: 'workspace-write',
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test(
    'a RESOLVED governed cancellation (stopReason aborted) is indeterminate, never failed (I8; PR #238 P1)',
    { timeout: 120_000 },
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'd4-unit-abort-'));
      try {
        const repo = join(root, 'repo');
        await generateScratchRepo(repo);
        // The conforming cancellation settle: the governor's signal fired
        // and the driver RESOLVES with stopReason 'aborted' (§2.1) — no
        // throw for the catch's thrown-abort path to see.
        const base = {
          repoRoot: repo,
          worktreesDir: 'worktrees',
          runPrefix: 'cq/unit-abort',
          base: 'main',
          adapter: 'tsc-lines' as const,
          runCheck: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
          checkCommand: (unit: WorkUnit, worktreePath: string) => ({
            command: process.execPath,
            args: ['scripts/check.js', unit.package],
            cwd: worktreePath,
            timeoutMs: 30_000,
          }),
          driver: {
            run: async () => ({
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              denials: [],
              stopReason: 'aborted' as const,
              sessionId: 'unit-aborted-s1',
            }),
          },
          modelSpec: { model: 'sweep-fake', provider: 'cq-d4-e2e' },
          budget: { wallClockMs: 600_000, maxUsd: 1 },
          prompt: () => 'cancelled mid-run',
          git: async () => ({ code: 0, stdout: '', stderr: '' }),
        };
        const unit: WorkUnit = { package: 'alpha', fixer: 'fix', files: [] };
        const cancelled = await makeSweepUnitOp(base)(unit);
        // No verdict on potentially partial work — indeterminate (the job
        // can resume), never 'failed' (which would claim the fixer ran and
        // broke on work it never finished).
        expect(cancelled.status).toBe('indeterminate');
        if (cancelled.status === 'indeterminate') {
          expect(cancelled.detail).toContain('cancelled');
          expect(cancelled.detail).toContain("stopReason 'aborted'");
          expect(cancelled.detail).toContain('unit-aborted-s1');
        }
        // The mapping rides the stopReason exactly: a resolved provider
        // failure still fails — the P1 never widens to every non-complete.
        const failed = await makeSweepUnitOp({
          ...base,
          driver: {
            run: async () => ({
              usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
              denials: [],
              stopReason: 'error' as const,
              error: 'the vendor 500ed',
              errorClass: 'provider-error' as const,
            }),
          },
        })(unit);
        expect(failed.status).toBe('failed');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
