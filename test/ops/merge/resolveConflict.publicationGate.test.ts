// Review P1 round 2 on PR #1628 (issue #1193's publication gate): the
// endpoint diff baseline..resolution proves the payload ONLY IF the
// resolution is EXACTLY ONE commit whose sole parent is the baseline — a
// worker that commits a credential and then commits its removal, or
// resolves through a merge commit, pushes unscanned history behind a clean
// endpoint diff. This file drives the REAL op over REAL git (bare origin +
// clone + the family's real worktree lifecycle); the "worker" is a fixture
// Driver that executes git inside the invocation's workspace (exactly where
// the real agent works) and reports acted. Temporary repos are created per
// test in mkdtemp dirs and removed in finally.
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
import { MODEL_SPEC, fakeLoadPrompt, recordingScan, scanClean } from './resolveConflict.helpers.js';

const git = promisify(execFile);
const gitIn = async (cwd: string, ...args: string[]): Promise<string> =>
  (await git('git', args, { cwd })).stdout;

/** A fixture worker: runs the scripted git steps INSIDE the prepared
 * worktree (the invocation's workspace binding — where the real agent
 * works), then reports the scripted decision. */
class GitWorkerDriver implements Driver {
  readonly invocations: OpInvocation[] = [];

  constructor(
    private readonly steps: (worktree: string) => Promise<void>,
    private readonly decision: 'acted' | 'escalate' = 'acted',
  ) {}

  async run(invocation: OpInvocation): Promise<WorkerResult> {
    this.invocations.push(invocation);
    const worktree = invocation.workspace?.path;
    if (worktree === undefined) throw new Error('fixture worker: no workspace binding');
    await this.steps(worktree);
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
  return (await gitIn(worktree, 'rev-parse', 'HEAD')).trim();
};

/** A bare origin + a clone (the repoRoot) with one baseline commit pushed
 * to refs/pull/44/head. The effects are the REAL merge effects over the
 * clone, with pushRef and diffPatch wrapped in recording spies (the
 * publication verdicts are observed, not performed). */
async function publicationFixture(): Promise<{
  root: string;
  repoRoot: string;
  baseline: string;
  strayCommit: string;
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
  await writeFile(join(repoRoot, 'base.txt'), 'baseline\n');
  await gitIn(repoRoot, 'add', '-A');
  await gitIn(repoRoot, 'commit', '--quiet', '-m', 'baseline');
  const baseline = (await gitIn(repoRoot, 'rev-parse', 'HEAD')).trim();
  // The PR head truth on the forge.
  await gitIn(repoRoot, 'push', '--quiet', 'origin', `HEAD:refs/pull/44/head`);
  // An unrelated commit the wrong-parent scenario can stack on (never the
  // baseline).
  await writeFile(join(repoRoot, 'stray.txt'), 'unrelated\n');
  await gitIn(repoRoot, 'add', '-A');
  await gitIn(repoRoot, 'commit', '--quiet', '-m', 'stray upstream work');
  const strayCommit = (await gitIn(repoRoot, 'rev-parse', 'HEAD')).trim();

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
  };
  return { root, repoRoot, baseline, strayCommit, pushes, diffCalls, effects };
}

/** The op assembled over the fixture: real effects, the scripted worker,
 * the shipped prompt template stand-in, and a stub scanner (the topology
 * is what this file tests — the payload scan is the push-scan file's). */
const fixtureOp = (effects: MergeEffects, driver: Driver) =>
  makeResolveConflictOp({
    effects,
    drivers: {
      resolve: (): ResolvedDriver => ({
        driver,
        lane: 'ai-sdk',
        modelSpec: MODEL_SPEC,
      }),
    },
    loadPrompt: fakeLoadPrompt,
    scan: scanClean,
  });

describe('the publication gate topology proof (real git, review P1 round 2)', () => {
  test('(a) a two-commit resolution (secret added then removed) REFUSES — the endpoint diff is clean but the history is not; NOTHING pushed, scan never ran', async () => {
    const f = await publicationFixture();
    try {
      const driver = new GitWorkerDriver(async (worktree) => {
        // Commit 1 carries the credential; commit 2 removes it. The
        // baseline..tip endpoint diff is EMPTY — the exact evasion the
        // topology rung exists for.
        await writeFile(join(worktree, 'base.txt'), 'baseline\nconst token = "sk-live-hidden";\n');
        await commitAll(worktree, 'add credential');
        await writeFile(join(worktree, 'base.txt'), 'baseline\n');
        await commitAll(worktree, 'remove credential');
      });
      const { scanner, lastComponents } = recordingScan(scanClean);
      const op = makeResolveConflictOp({
        effects: f.effects,
        drivers: {
          resolve: (): ResolvedDriver => ({ driver, lane: 'ai-sdk', modelSpec: MODEL_SPEC }),
        },
        loadPrompt: fakeLoadPrompt,
        scan: scanner,
      });

      const result = await op({
        pr: 44,
        repoRoot: f.repoRoot,
        headBranch: 'feat/topic',
        baseBranch: 'main',
        modelSpec: MODEL_SPEC,
      });
      expect(result.status).toBe('needs-human');
      if (result.status === 'needs-human') {
        expect(result.reason).toContain('not a single commit on the prepared baseline');
        expect(result.reason).toContain('refusing to publish unscanned history');
        expect(result.reason).toContain('NOTHING was pushed');
      }
      expect(f.pushes).toEqual([]);
      // The topology rung precedes the payload scan: the endpoint diff was
      // never even read (it would have been clean — that is the evasion).
      expect(f.diffCalls).toEqual([]);
      expect(lastComponents()).toBeUndefined();
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  test('(b) a MERGE-COMMIT resolution refuses — two parents is unscannable history', async () => {
    const f = await publicationFixture();
    try {
      const driver = new GitWorkerDriver(async (worktree) => {
        await writeFile(join(worktree, 'base.txt'), 'baseline\nresolved\n');
        await commitAll(worktree, 'resolve');
        // Fold the resolution into a merge commit (two parents) via
        // plumbing — the shape a base-merge resolution would produce.
        const tree = (await gitIn(worktree, 'rev-parse', 'HEAD^{tree}')).trim();
        const first = await gitIn(worktree, 'rev-parse', 'HEAD');
        const merge = (
          await gitIn(
            worktree,
            'commit-tree',
            tree,
            '-p',
            first.trim(),
            '-p',
            f.baseline,
            '-m',
            'merge resolution',
          )
        ).trim();
        await gitIn(worktree, 'update-ref', 'refs/heads/cq-merge/pr-44', merge);
      });
      const op = fixtureOp(f.effects, driver);

      const result = await op({
        pr: 44,
        repoRoot: f.repoRoot,
        headBranch: 'feat/topic',
        baseBranch: 'main',
        modelSpec: MODEL_SPEC,
      });
      expect(result.status).toBe('needs-human');
      if (result.status === 'needs-human') {
        expect(result.reason).toContain('not a single commit on the prepared baseline');
        expect(result.reason).toContain('parents: '); // the actual parents are named
      }
      expect(f.pushes).toEqual([]);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  test('(c) a SINGLE commit on the prepared baseline with a clean diff still publishes (behavior preserved)', async () => {
    const f = await publicationFixture();
    try {
      const driver = new GitWorkerDriver(async (worktree) => {
        await writeFile(join(worktree, 'base.txt'), 'baseline\nresolved cleanly\n');
        await commitAll(worktree, 'resolve');
      });
      const op = fixtureOp(f.effects, driver);

      const result = await op({
        pr: 44,
        repoRoot: f.repoRoot,
        headBranch: 'feat/topic',
        baseBranch: 'main',
        modelSpec: MODEL_SPEC,
      });
      expect(result.status).toBe('ok');
      if (result.status === 'ok') {
        expect(result.value.decision).toBe('acted');
      }
      // The op pushed exactly once, to the head branch, the resolution
      // sha it validated.
      const resolution = (await gitIn(f.repoRoot, 'rev-parse', 'refs/heads/cq-merge/pr-44')).trim();
      expect(f.pushes).toHaveLength(1);
      expect(f.pushes[0]).toContain(`${resolution}:refs/heads/feat/topic`);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  test('(d) a single commit whose PARENT is not the baseline refuses', async () => {
    const f = await publicationFixture();
    try {
      const driver = new GitWorkerDriver(async (worktree) => {
        await writeFile(join(worktree, 'base.txt'), 'baseline\nresolved\n');
        await gitIn(worktree, 'add', '-A');
        const tree = (await gitIn(worktree, 'write-tree')).trim();
        const forged = (
          await gitIn(
            worktree,
            'commit-tree',
            tree,
            '-p',
            f.strayCommit,
            '-m',
            'resolve on the wrong parent',
          )
        ).trim();
        await gitIn(worktree, 'update-ref', 'refs/heads/cq-merge/pr-44', forged);
      });
      const op = fixtureOp(f.effects, driver);

      const result = await op({
        pr: 44,
        repoRoot: f.repoRoot,
        headBranch: 'feat/topic',
        baseBranch: 'main',
        modelSpec: MODEL_SPEC,
      });
      expect(result.status).toBe('needs-human');
      if (result.status === 'needs-human') {
        expect(result.reason).toContain('not a single commit on the prepared baseline');
        expect(result.reason).toContain(f.strayCommit.slice(0, 12));
      }
      expect(f.pushes).toEqual([]);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});
