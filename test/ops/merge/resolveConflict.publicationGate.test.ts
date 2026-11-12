// Review P1 on PR #1628 (issue #1193's publication gate) and its round-3
// redesign: the endpoint diff baseline..resolution proves the payload ONLY
// for two publication shapes — (A) exactly one commit on the prepared
// baseline, or (B) the PROMPT'S OWN FLOW (fetch the base, merge
// FETCH_HEAD, one normal merge commit): a two-parent merge with
// parent[0] === baseline whose second parent is PUBLIC base history (the
// forge-read base tip, or an ancestor of it for the older-base race).
// This file drives the REAL op over REAL git (bare origin + clone + the
// family's real worktree lifecycle); the "worker" is a fixture Driver that
// executes git inside the invocation's workspace — exactly where the real
// agent works — and reports acted. readBaseRef is stubbed to answer from
// the fixture's bare origin (the fixture IS the forge); isAncestor runs
// for real. Temporary repos are created per test in mkdtemp dirs and
// removed in finally.
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, test } from 'vitest';
import type { ResolvedDriver } from '../../../src/driver/factory.js';
import type { Driver, OpInvocation, WorkerResult } from '../../../src/driver/types.js';
import type { MergeEffects } from '../../../src/adapters/forge-github/mergeEffects.js';
import { realMergeEffects } from '../../../src/adapters/forge-github/mergeEffects.js';
import { makeResolveConflictOp } from '../../../src/ops/merge/resolveConflict.js';
import { scanComponents } from '../../../src/ops/dev/denylist.js';
import type { DiffSecretScanner } from '../../../src/ops/dev/denylist.js';
import { MODEL_SPEC, fakeLoadPrompt, recordingScan, scanClean } from './resolveConflict.helpers.js';

const git = promisify(execFile);
const gitIn = async (cwd: string, ...args: string[]): Promise<string> =>
  (await git('git', args, { cwd })).stdout.trim();

interface FixtureCtx {
  origin: string;
  repoRoot: string;
}

/** A fixture worker: runs the scripted git steps INSIDE the prepared
 * worktree (the invocation's workspace binding), with the fixture's
 * origin/repoRoot in context, then reports the scripted decision. */
class GitWorkerDriver implements Driver {
  readonly invocations: OpInvocation[] = [];

  constructor(
    private readonly ctx: FixtureCtx,
    private readonly steps: (worktree: string, ctx: FixtureCtx) => Promise<void>,
    private readonly decision: 'acted' | 'escalate' = 'acted',
  ) {}

  async run(invocation: OpInvocation): Promise<WorkerResult> {
    this.invocations.push(invocation);
    const worktree = invocation.workspace?.path;
    if (worktree === undefined) throw new Error('fixture worker: no workspace binding');
    await this.steps(worktree, this.ctx);
    return {
      model: invocation.modelSpec.model,
      structuredOutput: { decision: this.decision, summary: 'fixture worker' },
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      denials: [],
      stopReason: 'complete',
    };
  }
}

/** One commit in the worktree: stage everything, commit, return the sha. */
const commitAll = async (worktree: string, message: string): Promise<string> => {
  await gitIn(worktree, 'add', '-A');
  await gitIn(worktree, 'commit', '--quiet', '-m', message);
  return gitIn(worktree, 'rev-parse', 'HEAD');
};

/** The exact prompt flow (steps 1 of conflict.default.md): refresh the
 * base, merge FETCH_HEAD. */
const promptMerge = async (worktree: string): Promise<void> => {
  await gitIn(worktree, 'fetch', 'origin', 'main');
  await gitIn(worktree, 'merge', '--no-edit', 'FETCH_HEAD');
};

/** A bare origin + a clone (the repoRoot): one baseline commit pushed to
 * refs/pull/44/head, then main advanced one commit on the forge (the
 * diverged base every merge resolution merges), plus an unpushed stray
 * commit the wrong-parent scenario can stack on. The effects are the REAL
 * merge effects over the clone — isAncestor and diffPatch run for real —
 * with pushRef/diffPatch wrapped in recording spies and readBaseRef
 * answered from the bare origin (the fixture IS the forge). */
async function publicationFixture(): Promise<{
  root: string;
  repoRoot: string;
  origin: string;
  baseline: string;
  baseTip: () => Promise<string>;
  pushes: string[];
  diffCalls: string[];
  effects: MergeEffects;
}> {
  const root = await mkdtemp(join(tmpdir(), 'resolve-pubgate-'));
  const origin = join(root, 'origin.git');
  await gitIn(root, 'init', '--bare', '--initial-branch=main', origin);
  const repoRoot = join(root, 'repo');
  await git('git', ['clone', '--quiet', origin, repoRoot]);
  await gitIn(repoRoot, 'config', 'user.email', 'fixture@localhost');
  await gitIn(repoRoot, 'config', 'user.name', 'fixture');
  // The bare origin commits too (the base-advance scenarios build the
  // newer tip with objects that exist ONLY here).
  await gitIn(origin, 'config', 'user.email', 'fixture@localhost');
  await gitIn(origin, 'config', 'user.name', 'fixture');
  // The COMMON ANCESTOR C on main.
  await writeFile(join(repoRoot, 'base.txt'), 'baseline\n');
  await gitIn(repoRoot, 'add', '-A');
  await gitIn(repoRoot, 'commit', '--quiet', '-m', 'common ancestor');
  const ancestor = await gitIn(repoRoot, 'rev-parse', 'HEAD');
  // The PR LINE: one PR commit P on top of C, pushed as the pull ref —
  // the pre-dispatch baseline the worktree prepares at.
  await writeFile(join(repoRoot, 'pr.txt'), 'pr work\n');
  await gitIn(repoRoot, 'add', 'pr.txt');
  const prTree = await gitIn(repoRoot, 'write-tree');
  const baseline = await gitIn(repoRoot, 'commit-tree', prTree, '-p', ancestor, '-m', 'pr work');
  await gitIn(repoRoot, 'update-ref', 'refs/heads/prline', baseline);
  await gitIn(repoRoot, 'push', '--quiet', 'origin', 'refs/heads/prline:refs/pull/44/head');
  // The BASE LINE: main advances one base-side commit M on the forge —
  // parented on C, so P and M have DIVERGED (a merge is non-ff).
  await writeFile(join(repoRoot, 'main-side.txt'), 'base work\n');
  await gitIn(repoRoot, 'add', 'main-side.txt');
  const baseTree = await gitIn(repoRoot, 'write-tree');
  const baseCommit = await gitIn(
    repoRoot,
    'commit-tree',
    baseTree,
    '-p',
    ancestor,
    '-m',
    'base-side work',
  );
  await gitIn(repoRoot, 'push', '--quiet', 'origin', `${baseCommit}:refs/heads/main`);

  const baseTip = async (): Promise<string> => gitIn(origin, 'rev-parse', 'refs/heads/main');

  const real = realMergeEffects({ repoRoot, protectedBranch: 'main' });
  const pushes: string[] = [];
  const diffCalls: string[] = [];
  const effects: MergeEffects = {
    ...real,
    pushRef: async (ref, fromPath) => {
      pushes.push(`${ref}@${fromPath}`);
      return { code: 0, stdout: '', stderr: '' };
    },
    diffPatch: async (from, to) => {
      diffCalls.push(`${from}..${to}`);
      return real.diffPatch(from, to);
    },
    readBaseRef: async (pr) => {
      // The fixture IS the forge: answer the base ref + its current tip
      // from the bare origin (the trusted read realMergeEffects performs
      // against gh in production).
      void pr;
      return { ok: true, baseRefName: 'main', baseTipSha: await baseTip() };
    },
  };
  return { root, repoRoot, origin, baseline, baseTip, pushes, diffCalls, effects };
}

/** A rules-based scanner over the SAME denylist engine: one unscoped
 * github-token rule — the scanner the message-scan scenarios assert
 * against (rule id is the evidence the gate must surface). */
const tokenScanner: DiffSecretScanner = (components) =>
  scanComponents(components, [
    {
      id: 'github-pat',
      description: 'github personal access token',
      regex: 'ghp_[A-Za-z0-9]{16,}',
    },
  ]);

/** Advance the origin's main by one commit from a SECOND clone: the newer
 * forge tip's objects exist on the forge and in the advancer — but NOT in
 * repoRoot, which is what the scenario needs ("the base advanced and the
 * gate's repo has not fetched it"). Returns the new tip. */
const advanceOriginMain = async (origin: string, root: string): Promise<string> => {
  const advancer = join(root, 'advancer');
  await git('git', ['clone', '--quiet', origin, advancer]);
  await gitIn(advancer, 'config', 'user.email', 'fixture@localhost');
  await gitIn(advancer, 'config', 'user.name', 'fixture');
  await writeFile(join(advancer, 'later.txt'), 'later base work\n');
  await gitIn(advancer, 'add', '-A');
  await gitIn(advancer, 'commit', '--quiet', '-m', 'later base-side work');
  await gitIn(advancer, 'push', '--quiet', 'origin', 'HEAD:refs/heads/main');
  return gitIn(origin, 'rev-parse', 'refs/heads/main');
};

const fixtureOp = (effects: MergeEffects, driver: Driver) =>
  makeResolveConflictOp({
    effects,
    drivers: {
      resolve: (): ResolvedDriver => ({ driver, lane: 'ai-sdk', modelSpec: MODEL_SPEC }),
    },
    loadPrompt: fakeLoadPrompt,
    scan: scanClean,
  });

const run = (
  f: Awaited<ReturnType<typeof publicationFixture>>,
  op: ReturnType<typeof makeResolveConflictOp>,
): ReturnType<ReturnType<typeof makeResolveConflictOp>> =>
  op({
    pr: 44,
    repoRoot: f.repoRoot,
    headBranch: 'feat/topic',
    baseBranch: 'main',
    modelSpec: MODEL_SPEC,
  });

describe('the publication gate topology proof (real git, review P1 rounds 2-3)', () => {
  test('(a) the EXACT PROMPT SHAPE — fetch a diverged base, merge FETCH_HEAD, two-parent merge [baseline, baseTip] — is ACCEPTED, scanned, pushed', async () => {
    const f = await publicationFixture();
    try {
      const driver = new GitWorkerDriver({ origin: f.origin, repoRoot: f.repoRoot }, (worktree) =>
        promptMerge(worktree),
      );
      const { scanner, lastComponents } = recordingScan(scanClean);
      const op = makeResolveConflictOp({
        effects: f.effects,
        drivers: {
          resolve: (): ResolvedDriver => ({ driver, lane: 'ai-sdk', modelSpec: MODEL_SPEC }),
        },
        loadPrompt: fakeLoadPrompt,
        scan: scanner,
      });
      const result = await run(f, op);
      expect(result.status, JSON.stringify(result, null, 2)).toBe('ok');
      if (result.status === 'ok') expect(result.value.decision).toBe('acted');
      // The merge parent was verified against the forge tip; the payload
      // was read and scanned; exactly one publication push happened.
      const resolution = await gitIn(f.repoRoot, 'rev-parse', 'refs/heads/cq-merge/pr-44');
      expect(f.diffCalls).toEqual([`${f.baseline}..${resolution}`]);
      expect(lastComponents()).toBeDefined();
      expect(f.pushes).toHaveLength(1);
      expect(f.pushes[0]).toContain(`${resolution}:refs/heads/feat/topic`);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  test('(b) a two-commit resolution (secret added then removed) REFUSES — the endpoint diff is clean but the history is not; NOTHING pushed, scan never ran', async () => {
    const f = await publicationFixture();
    try {
      const driver = new GitWorkerDriver(
        { origin: f.origin, repoRoot: f.repoRoot },
        async (worktree) => {
          // Commit 1 carries the credential; commit 2 removes it. The
          // baseline..tip endpoint diff is EMPTY — the evasion the
          // topology rung exists for (parent[0] is the intermediate
          // commit, not the baseline).
          await writeFile(
            join(worktree, 'base.txt'),
            'baseline\nconst token = "sk-live-hidden";\n',
          );
          await commitAll(worktree, 'add credential');
          await writeFile(join(worktree, 'base.txt'), 'baseline\n');
          await commitAll(worktree, 'remove credential');
        },
      );
      const { scanner, lastComponents } = recordingScan(scanClean);
      const op = makeResolveConflictOp({
        effects: f.effects,
        drivers: {
          resolve: (): ResolvedDriver => ({ driver, lane: 'ai-sdk', modelSpec: MODEL_SPEC }),
        },
        loadPrompt: fakeLoadPrompt,
        scan: scanner,
      });
      const result = await run(f, op);
      expect(result.status).toBe('needs-human');
      if (result.status === 'needs-human') {
        expect(result.reason).toContain('resolution topology is not publishable');
        expect(result.reason).toContain('refusing to publish unscanned history');
        expect(result.reason).toContain('NOTHING was pushed');
      }
      expect(f.pushes).toEqual([]);
      // The topology rung precedes the payload scan: the endpoint diff
      // was never even read (it would have been clean — that is the
      // evasion).
      expect(f.diffCalls).toEqual([]);
      expect(lastComponents()).toBeUndefined();
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  test('(c) a merge whose second parent is NOT public (a local secret-bearing commit) refuses — even with a clean endpoint diff', async () => {
    const f = await publicationFixture();
    try {
      const driver = new GitWorkerDriver(
        { origin: f.origin, repoRoot: f.repoRoot },
        async (worktree) => {
          // Forge a LOCAL base-side commit carrying a secret: parented on
          // the baseline, never pushed, invisible to the forge.
          await writeFile(
            join(worktree, 'secret-side.txt'),
            'const token = "sk-live-local-base";\n',
          );
          await gitIn(worktree, 'add', '-A');
          const secretTree = await gitIn(worktree, 'write-tree');
          const secret = await gitIn(
            worktree,
            'commit-tree',
            secretTree,
            '-p',
            f.baseline,
            '-m',
            'local base commit with a secret',
          );
          // Then merge it into the resolution: parents [baseline, secret].
          await writeFile(join(worktree, 'base.txt'), 'baseline\nresolved cleanly\n');
          await gitIn(worktree, 'add', '-A');
          const resolvedTree = await gitIn(worktree, 'write-tree');
          const merge = await gitIn(
            worktree,
            'commit-tree',
            resolvedTree,
            '-p',
            f.baseline,
            '-p',
            secret,
            '-m',
            'merge the local base',
          );
          await gitIn(worktree, 'update-ref', 'refs/heads/cq-merge/pr-44', merge);
        },
      );
      const { scanner, lastComponents } = recordingScan(scanClean);
      const op = makeResolveConflictOp({
        effects: f.effects,
        drivers: {
          resolve: (): ResolvedDriver => ({ driver, lane: 'ai-sdk', modelSpec: MODEL_SPEC }),
        },
        loadPrompt: fakeLoadPrompt,
        scan: scanner,
      });
      const result = await run(f, op);
      expect(result.status).toBe('needs-human');
      if (result.status === 'needs-human') {
        expect(result.reason).toContain('is not public base history');
        expect(result.reason).toContain('NOTHING was pushed');
      }
      expect(f.pushes).toEqual([]);
      expect(f.diffCalls).toEqual([]);
      expect(lastComponents()).toBeUndefined();
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  test('(d) a SINGLE commit on the prepared baseline with a clean diff still publishes (behavior preserved)', async () => {
    const f = await publicationFixture();
    try {
      const driver = new GitWorkerDriver(
        { origin: f.origin, repoRoot: f.repoRoot },
        async (worktree) => {
          await writeFile(join(worktree, 'base.txt'), 'baseline\nresolved cleanly\n');
          await commitAll(worktree, 'resolve');
        },
      );
      const op = fixtureOp(f.effects, driver);
      const result = await run(f, op);
      expect(result.status).toBe('ok');
      if (result.status === 'ok') expect(result.value.decision).toBe('acted');
      // The op pushed exactly once, to the head branch, the resolution
      // sha it validated.
      const resolution = await gitIn(f.repoRoot, 'rev-parse', 'refs/heads/cq-merge/pr-44');
      expect(f.pushes).toHaveLength(1);
      expect(f.pushes[0]).toContain(`${resolution}:refs/heads/feat/topic`);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  test('(e) a merge with an OLDER public base tip (ancestor of the current forge tip) is ACCEPTED', async () => {
    const f = await publicationFixture();
    try {
      const driver = new GitWorkerDriver(
        { origin: f.origin, repoRoot: f.repoRoot },
        async (worktree, ctx) => {
          // The worker fetched the base and merged it — while the base
          // was at its then-current tip.
          await promptMerge(worktree);
          // The base then ADVANCED on the forge (built on the CURRENT
          // forge tip via plumbing, so the ancestry relation is real and
          // both tips stay local to repoRoot for the real ancestry read):
          // the worker's merge parent is now one BEHIND the forge.
          await gitIn(ctx.repoRoot, 'fetch', 'origin', 'main');
          const currentTip = await gitIn(ctx.repoRoot, 'rev-parse', 'FETCH_HEAD');
          await writeFile(join(ctx.repoRoot, 'later.txt'), 'later base work\n');
          await gitIn(ctx.repoRoot, 'add', 'later.txt');
          const laterTree = await gitIn(ctx.repoRoot, 'write-tree');
          const later = await gitIn(
            ctx.repoRoot,
            'commit-tree',
            laterTree,
            '-p',
            currentTip,
            '-m',
            'later base-side work',
          );
          await gitIn(ctx.repoRoot, 'push', '--quiet', 'origin', `${later}:refs/heads/main`);
        },
      );
      const op = fixtureOp(f.effects, driver);
      const result = await run(f, op);
      // The older tip is public history (an ancestor of the forge tip):
      // accepted.
      expect(result.status, JSON.stringify(result, null, 2)).toBe('ok');
      expect(f.pushes).toHaveLength(1);
      expect(f.pushes[0]).toContain(':refs/heads/feat/topic');
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});
describe('the publication gate message scan and locality fetch (review P2 ntJt/ntJj)', () => {
  // The FAKE token is constructed at runtime from fragments — a matching
  // literal in the source (or any commit message) would trip the repo's
  // own denylist scan (generic-api-key), which is the very check this
  // gate mirrors. Fragmented like denylist.test.ts's corpus.
  const fakeToken = ['ghp', '0123456789abcdef'].join('_');
  test('(f) a credential in the commit SUBJECT refuses — rule named, token never quoted, pushRef never called', async () => {
    const f = await publicationFixture();
    try {
      const driver = new GitWorkerDriver(
        { origin: f.origin, repoRoot: f.repoRoot },
        async (worktree) => {
          await writeFile(join(worktree, 'base.txt'), 'baseline\nresolved cleanly\n');
          await gitIn(worktree, 'add', '-A');
          await gitIn(
            worktree,
            'commit',
            '--quiet',
            '-m',
            `resolve: set GITHUB_TOKEN=${fakeToken} for deploy`,
          );
        },
      );
      const { scanner, lastComponents } = recordingScan(tokenScanner);
      const op = makeResolveConflictOp({
        effects: f.effects,
        drivers: {
          resolve: (): ResolvedDriver => ({ driver, lane: 'ai-sdk', modelSpec: MODEL_SPEC }),
        },
        loadPrompt: fakeLoadPrompt,
        scan: scanner,
      });
      const result = await run(f, op);
      expect(result.status, JSON.stringify(result, null, 2)).toBe('needs-human');
      if (result.status === 'needs-human') {
        expect(result.reason).toContain('github-pat');
        expect(result.reason).toContain('commit message');
        expect(result.reason).not.toContain(fakeToken);
      }
      expect(f.pushes).toEqual([]);
      expect(lastComponents()).toBeDefined(); // the scan ran (and flagged)
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  test('(g) a credential in the commit BODY refuses the same way', async () => {
    const f = await publicationFixture();
    try {
      const driver = new GitWorkerDriver(
        { origin: f.origin, repoRoot: f.repoRoot },
        async (worktree) => {
          await writeFile(join(worktree, 'base.txt'), 'baseline\nresolved cleanly\n');
          await gitIn(worktree, 'add', '-A');
          await gitIn(
            worktree,
            'commit',
            '--quiet',
            '-m',
            'resolve cleanly',
            '-m',
            `rotated key: GITHUB_TOKEN=${fakeToken}`,
          );
        },
      );
      const { scanner } = recordingScan(tokenScanner);
      const op = makeResolveConflictOp({
        effects: f.effects,
        drivers: {
          resolve: (): ResolvedDriver => ({ driver, lane: 'ai-sdk', modelSpec: MODEL_SPEC }),
        },
        loadPrompt: fakeLoadPrompt,
        scan: scanner,
      });
      const result = await run(f, op);
      expect(result.status).toBe('needs-human');
      if (result.status === 'needs-human') {
        expect(result.reason).toContain('github-pat');
        expect(result.reason).not.toContain(fakeToken);
      }
      expect(f.pushes).toEqual([]);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  test('(h) an UNREADABLE commit message fails closed — failed, never pushed', async () => {
    const f = await publicationFixture();
    try {
      const driver = new GitWorkerDriver(
        { origin: f.origin, repoRoot: f.repoRoot },
        async (worktree) => {
          await writeFile(join(worktree, 'base.txt'), 'baseline\nresolved cleanly\n');
          await commitAll(worktree, 'resolve');
        },
      );
      const effects: MergeEffects = {
        ...f.effects,
        readCommitMessage: async () => ({ code: 1, stdout: '', stderr: 'fatal: bad object' }),
      };
      const op = fixtureOp(effects, driver);
      const result = await run(f, op);
      expect(result.status).toBe('failed');
      if (result.status === 'failed') {
        expect(result.error).toContain('unreadable');
        expect(result.error).toContain('unscannable commit message');
      }
      expect(f.pushes).toEqual([]);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  test('(i) the base advances with the newer tip NOT local — the gate fetches the base branch and ACCEPTS', async () => {
    const f = await publicationFixture();
    try {
      const driver = new GitWorkerDriver(
        { origin: f.origin, repoRoot: f.repoRoot },
        async (worktree) => {
          await promptMerge(worktree);
          // The base advances on the forge AFTER the worker's fetch, with
          // the newer tip's objects existing everywhere but repoRoot.
          await advanceOriginMain(f.origin, f.root);
        },
      );
      const op = fixtureOp(f.effects, driver);
      const result = await run(f, op);
      // Fail-closed, not false-refusing: the gate fetched the base
      // branch, verified the ancestry, and published.
      expect(result.status, JSON.stringify(result, null, 2)).toBe('ok');
      expect(f.pushes).toHaveLength(1);
      expect(f.pushes[0]).toContain(':refs/heads/feat/topic');
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  test('(j) a base tip that stays unavailable locally refuses with the retryable reason — never a bare failed', async () => {
    const f = await publicationFixture();
    try {
      const driver = new GitWorkerDriver(
        { origin: f.origin, repoRoot: f.repoRoot },
        async (worktree) => {
          await promptMerge(worktree);
          await advanceOriginMain(f.origin, f.root);
        },
      );
      // The base fetch itself fails (forge unreachable).
      const effects: MergeEffects = {
        ...f.effects,
        fetchBaseBranch: async () => ({ code: 1, stdout: '', stderr: 'connection lost' }),
      };
      const op = fixtureOp(effects, driver);
      const result = await run(f, op);
      expect(result.status, JSON.stringify(result, null, 2)).toBe('needs-human');
      if (result.status === 'needs-human') {
        expect(result.reason).toContain('base tip not available locally; refetch and retry');
        expect(result.reason).toContain('NOTHING was pushed');
      }
      expect(f.pushes).toEqual([]);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});
