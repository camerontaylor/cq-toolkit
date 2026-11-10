// Split provenance: test/plans/review-loop.helpers.ts was split by subject;
// this module carries the loop runner (fresh scratch, scripted driver, wired
// seams) and its scratch-dir cleanup.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import type { Driver, OpInvocation, WorkerResult } from '../../src/driver/types.js';
import type { OpRegistryView } from '../../src/kernel/runner.js';
import type { GovernanceOptIn, OpRegistryEntry } from '../../src/kernel/types.js';
import { makeFixReviewItem, type FixReviewItemInput } from '../../src/ops/review/fixReviewItem.js';
import { FixReviewItemInputSchema } from '../../src/ops/review/registry.js';
import type { GhFn } from '../../src/adapters/forge-github/gh.js';
import type { SlotWorktreeRegistry } from '../../src/adapters/git/slotWorktreeRegistry.js';
import type { SlotMetadata } from '../../src/adapters/lock/slotLock.js';
import { runReviewLoop, type ReviewLoopOutcome } from '../../src/plans/review-loop.js';
import { COORDS, HEAD_REF, NOW, SHA, type LoopWorld } from './review-loop.fixtures.js';
import { fakeGh } from './review-loop.gh-fake.js';
import { fakeGit } from './review-loop.git-fake.js';

/** An unsynchronized in-memory WorktreeRegistry (single-threaded tests). */
const memoryRegistry = (): SlotWorktreeRegistry => {
  const map = new Map<number, SlotMetadata>();
  return {
    read: async (pr) => map.get(pr),
    update: async (pr, entry) => {
      map.set(pr, entry);
    },
    withPrLock: async (_pr, action) => action(),
  };
};

export const scratchDirs: string[] = [];
afterEach(async () => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

/** Run the loop over a world with a scripted driver; record every argv. */
export const runLoop = async (
  world: LoopWorld,
  o: {
    driverResults?: WorkerResult[];
    ghLog?: string[][];
    gitLog?: string[][];
    invocations?: OpInvocation[];
    headRepo?: string;
    expectedHead?: string;
    dispatchLogPath?: string;
    promptOverride?: string;
    /** Governor LIMITS half riding the loop opts (the review-path #137 arming). */
    limits?: { perJobWallClockMs?: number };
    /** RunOptions overlay for the fix run (journalDir is the ledger dir). */
    runOptions?: { journalDir?: string; maxUsd?: number; maxTokens?: number };
    /** Governance opt-ins for the fix run (the ledger-refusal resolutions). */
    governanceOptIn?: GovernanceOptIn[];
    /** Full driver.run override (the wall-clock test's cooperating wedge). */
    driverRun?: Driver['run'];
    signal?: AbortSignal;
    gitHook?: (args: string[], run: GhFn) => ReturnType<GhFn>;
    ghHook?: (args: string[], run: GhFn) => ReturnType<GhFn>;
    /** Propagated-spend observer (review-debt #186). */
    onSpend?: (usd: number) => void;
    /** The loop's own identity (the settle gate's resolve-carry authorization). */
    responderLogin?: string;
    engineObservedHead?: string;
    engineConcurrency?: number;
    /** Explicit publication opt-in (the composition passes `input.push === true`). */
    publish?: boolean;
  } = {},
): Promise<{
  outcome: ReviewLoopOutcome;
  ghLog: string[][];
  gitLog: string[][];
  worktreePath: string;
}> => {
  const scratch = await mkdtemp(join(tmpdir(), 'cq-review-loop-'));
  scratchDirs.push(scratch);
  const worktreePath = join(scratch, 'pr-7-pr-7-fix');
  await mkdir(join(worktreePath, '.git'), { recursive: true });
  const ghLog = o.ghLog ?? [];
  const gitLog = o.gitLog ?? [];
  world.executionHead ??= world.worktreeHead ?? (world.worktreeFollowsOrigin ? world.sha : SHA);
  const driver: Driver = {
    run:
      o.driverRun ??
      (async (invocation) => {
        o.invocations?.push(invocation);
        const next = o.driverResults?.shift();
        if (next === undefined) {
          throw new Error('scripted driver: no scripted result left');
        }
        if (
          world.worktreeAdvancesAt !== undefined &&
          String(next.structuredOutput).includes('"disposition":"fixed"')
        )
          world.executionHead = world.worktreeAdvancesTo ?? SHA;
        return next;
      }),
  };
  // The fix op dispatches through a registry view whose review.fixItem binds
  // a factory resolving to the scripted Driver (ADR-0002 §2.5) — the same
  // governed runPlan seam the CLI uses.
  const view: OpRegistryView = {
    get: (name) =>
      name === 'review.fixItem'
        ? ({
            name: 'review.fixItem',
            inputSchema: FixReviewItemInputSchema,
            importer: async () => {
              const op = makeFixReviewItem({
                drivers: {
                  resolve: (req) => ({ driver, lane: 'ai-sdk', modelSpec: req.modelSpec }),
                },
              });
              return async (input: FixReviewItemInput) => {
                const result = await op(input);
                return result.status === 'ok' && o.engineObservedHead !== undefined
                  ? { ...result, value: { ...result.value, observedHead: o.engineObservedHead } }
                  : result;
              };
            },
          } as unknown as OpRegistryEntry<never, never>)
        : undefined,
  };
  const gitRunner = fakeGit(world, gitLog, worktreePath, { ownershipIdentityReads: 2 });
  const ghRunner = fakeGh(world, ghLog);
  const outcome = await runReviewLoop({
    owner: COORDS.owner,
    repo: COORDS.repo,
    pr: COORDS.pr,
    headRefName: HEAD_REF,
    ...(o.headRepo !== undefined ? { headRepo: o.headRepo } : {}),
    repoRoot: '/fake/repo',
    ...(o.expectedHead ? { expectedHead: o.expectedHead } : {}),
    gh: o.ghHook ? (args) => o.ghHook!(args, ghRunner) : ghRunner,
    git: (args) =>
      args.slice(2).join(' ') === 'rev-parse --path-format=absolute --git-common-dir'
        ? Promise.resolve({ code: 0, stdout: `${scratch}\n`, stderr: '' })
        : o.gitHook
          ? o.gitHook(args, gitRunner)
          : gitRunner(args),
    ...(o.signal ? { signal: o.signal } : {}),
    registry: memoryRegistry(),
    driver: { model: 'test-model', provider: 'test-provider' },
    driverRegistryView: view,
    ...(o.engineConcurrency !== undefined || o.engineObservedHead !== undefined
      ? { engineOwnedConcurrency: o.engineConcurrency ?? 1 }
      : {}),
    // The A12c escape is EXPLICIT and defaults OFF (r1 M4): these tests
    // exercise dispatched fix runs, so they opt in — the shipped sweep does
    // the same (unattended by design), and the journal records
    // allowAdvisoryProvenance: 'product'.
    allowAdvisoryBudget: true,
    // Legacy tests rely on `publish` being ABSENT (the loop's historical
    // publishable default, `opts.publish !== false`); only an explicit
    // opt-in mirrors the composition's `input.push === true` shape.
    ...(o.publish !== undefined ? { publish: o.publish } : {}),
    nowMs: NOW,
    dispatchLogPath: o.dispatchLogPath ?? join(scratch, 'dispatch.jsonl'),
    worktreeRoot: scratch,
    ...(o.promptOverride !== undefined ? { promptOverride: o.promptOverride } : {}),
    ...(o.limits !== undefined ? { limits: o.limits } : {}),
    ...(o.runOptions !== undefined ? { runOptions: o.runOptions } : {}),
    ...(o.governanceOptIn !== undefined ? { governanceOptIn: o.governanceOptIn } : {}),
    ...(o.onSpend !== undefined ? { onSpend: o.onSpend } : {}),
    ...(o.responderLogin !== undefined ? { responderLogin: o.responderLogin } : {}),
  });
  return { outcome, ghLog, gitLog, worktreePath };
};
