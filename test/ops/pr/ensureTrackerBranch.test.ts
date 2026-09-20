// PR lane (goal D3 follow-up, review-debt #173) — evidence for
// pr.ensureTrackerBranch (src/ops/pr/ensureTrackerBranch.ts): the tracker
// PR's head branch is created + pushed BEFORE the tracker-first assembler
// opens its PR.
//
// Pinned here, on a scripted TrackerBranchEffects (zero processes) plus one
// real-git integration case for the production subprocess binding:
//   1. FRESH: no remote, no local → an empty commit on base is created,
//      pushed, and the remote re-read carries exactly that commit.
//   2. RE-INVOKE REUSE: an existing remote branch is reused verbatim — no
//      create, no push, never rewound.
//   3. STRANDED LOCAL: a local branch with no remote is pushed (created:false).
//   4. REMOTE RE-VERIFICATION: a push whose remote head is absent or
//      different fails the op — a fabricated PR head is refused.
//   5. BOUNDARY: a branch outside the run prefix, a control character, and a
//      flag-shaped base are `failed` results before any effect call.
//   6. PRODUCTION BINDING: makeSubprocessTrackerBranchEffects creates +
//      pushes against a real (bare) origin, and the second call reuses.
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import {
  makeEnsureTrackerBranch,
  makeSubprocessTrackerBranchEffects,
  type EnsureTrackerBranchInput,
  type TrackerBranchEffects,
} from '../../../src/ops/pr/ensureTrackerBranch.js';

const CLEANUP: string[] = [];
afterAll(() => {
  for (const dir of CLEANUP) rmSync(dir, { recursive: true, force: true });
});

interface Scripted {
  effects: TrackerBranchEffects;
  calls: string[];
  remote: string | null;
  local: string | null;
  /** What the remote reports after the push (defaults to the pushed sha). */
  remoteAfter?: string | null;
}

function scripted(seed: Partial<Scripted> = {}): Scripted {
  const state: Scripted = {
    calls: [],
    remote: seed.remote ?? null,
    local: seed.local ?? null,
    ...(seed.remoteAfter !== undefined ? { remoteAfter: seed.remoteAfter } : {}),
    effects: {
      remoteHead: async (branch) => {
        state.calls.push(`remote:${branch}`);
        // The first read is the pre-check; later reads are the post-push verify.
        if (state.calls.filter((call) => call.startsWith('remote:')).length === 1) {
          return state.remote;
        }
        return state.remoteAfter === undefined ? 'created-sha' : state.remoteAfter;
      },
      localHead: async (branch) => {
        state.calls.push(`local:${branch}`);
        return state.local;
      },
      createBranch: async (branch, base) => {
        state.calls.push(`create:${branch}:${base}`);
        state.local = 'created-sha';
        return 'created-sha';
      },
      pushBranch: async (branch) => {
        state.calls.push(`push:${branch}`);
      },
    },
  };
  return state;
}

const inputOf = (overrides: Partial<EnsureTrackerBranchInput> = {}): EnsureTrackerBranchInput => ({
  repoRoot: '/repo',
  runPrefix: 'cq/09-16a',
  base: 'origin/merge-queue',
  branch: 'cq/09-16a/tracker',
  ...overrides,
});

async function okReport(
  op: ReturnType<typeof makeEnsureTrackerBranch>,
  input: EnsureTrackerBranchInput,
) {
  const result = await op(input);
  if (result.status !== 'ok') {
    throw new Error(
      `expected ok, got ${result.status}: ${result.status === 'failed' ? result.error : result.status}`,
    );
  }
  return result.value;
}

async function failedAt(
  op: ReturnType<typeof makeEnsureTrackerBranch>,
  input: EnsureTrackerBranchInput,
) {
  const result = await op(input);
  if (result.status !== 'failed') throw new Error(`expected failed, got ${result.status}`);
  return result.error;
}

describe('pr.ensureTrackerBranch (review-debt #173)', () => {
  test('fresh: creates an empty commit on base, pushes it, and verifies the remote head', async () => {
    const forge = scripted({ remote: null, local: null, remoteAfter: 'created-sha' });
    const report = await okReport(makeEnsureTrackerBranch(forge.effects), inputOf());
    expect(report).toEqual({
      branch: 'cq/09-16a/tracker',
      headSha: 'created-sha',
      created: true,
      pushed: true,
      reusedRemote: false,
    });
    expect(forge.calls).toEqual([
      'remote:cq/09-16a/tracker',
      'local:cq/09-16a/tracker',
      'create:cq/09-16a/tracker:origin/merge-queue',
      'push:cq/09-16a/tracker',
      'remote:cq/09-16a/tracker',
    ]);
  });

  test('re-invoke: an existing remote branch is reused verbatim (no create, no push)', async () => {
    const forge = scripted({ remote: 'existing-sha' });
    const report = await okReport(makeEnsureTrackerBranch(forge.effects), inputOf());
    expect(report).toEqual({
      branch: 'cq/09-16a/tracker',
      headSha: 'existing-sha',
      created: false,
      pushed: false,
      reusedRemote: true,
    });
    expect(forge.calls).toEqual(['remote:cq/09-16a/tracker']);
  });

  test('push:false (local-only) ensures the local branch but never touches the remote', async () => {
    const forge = scripted({ remote: null, local: null });
    const report = await okReport(makeEnsureTrackerBranch(forge.effects), inputOf({ push: false }));
    expect(report).toEqual({
      branch: 'cq/09-16a/tracker',
      headSha: 'created-sha',
      created: true,
      pushed: false,
      reusedRemote: false,
    });
    expect(forge.calls).toEqual([
      'local:cq/09-16a/tracker',
      'create:cq/09-16a/tracker:origin/merge-queue',
    ]);
    expect(forge.calls.some((call) => call.startsWith('remote:') || call.startsWith('push:'))).toBe(
      false,
    );
  });

  test('stranded local: a local branch with no remote is pushed (created:false)', async () => {
    const forge = scripted({ remote: null, local: 'stranded-sha', remoteAfter: 'stranded-sha' });
    const report = await okReport(makeEnsureTrackerBranch(forge.effects), inputOf());
    expect(report.created).toBe(false);
    expect(report.pushed).toBe(true);
    expect(report.reusedRemote).toBe(false);
    expect(forge.calls).toContain('push:cq/09-16a/tracker');
  });

  test('the remote re-read must carry exactly the pushed commit', async () => {
    const absent = scripted({ remote: null, local: null, remoteAfter: null });
    expect(await failedAt(makeEnsureTrackerBranch(absent.effects), inputOf())).toMatch(
      /remote reports no head/,
    );
    const divergent = scripted({ remote: null, local: null, remoteAfter: 'some-other-sha' });
    expect(await failedAt(makeEnsureTrackerBranch(divergent.effects), inputOf())).toMatch(
      /is not the pushed commit/,
    );
  });

  test('boundary: prefix, control characters and a flag-shaped base fail before any effect', async () => {
    const forge = scripted();
    const op = makeEnsureTrackerBranch(forge.effects);
    expect(await failedAt(op, inputOf({ branch: 'other/tracker' }))).toMatch(
      /must start with the run prefix/,
    );
    expect(await failedAt(op, inputOf({ branch: 'cq/09-16a/tra\ncker' }))).toMatch(
      /control characters/,
    );
    expect(await failedAt(op, inputOf({ base: '--upload-pack=evil' }))).toMatch(
      /must not start with '-'/,
    );
    expect(
      await failedAt(op, { ...inputOf(), push: 'yes' } as unknown as EnsureTrackerBranchInput),
    ).toMatch(/push .* must be a boolean/);
    expect(forge.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The production subprocess binding, against a real (bare) origin
// ---------------------------------------------------------------------------

function gitOut(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args],
      { cwd, timeout: 10_000, killSignal: 'SIGKILL' },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

describe('makeSubprocessTrackerBranchEffects (real git)', () => {
  test(
    'creates + pushes the tracker branch to a bare origin, then reuses it',
    { timeout: 60_000 },
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'pr-tracker-branch-'));
      CLEANUP.push(root);
      const repo = join(root, 'repo');
      const origin = join(root, 'origin.git');
      await gitOut(['init', '-q', '-b', 'main', repo], root);
      await gitOut(['-C', repo, 'config', 'user.email', 'e2e@example.invalid'], root);
      await gitOut(['-C', repo, 'config', 'user.name', 'e2e'], root);
      await gitOut(['-C', repo, 'config', 'commit.gpgsign', 'false'], root);
      await gitOut(['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'seed'], root);
      await gitOut(['init', '-q', '--bare', origin], root);
      await gitOut(['-C', repo, 'remote', 'add', 'origin', origin], root);

      const effects = makeSubprocessTrackerBranchEffects(repo);
      const op = makeEnsureTrackerBranch(effects);
      const first = await okReport(op, inputOf({ repoRoot: repo, base: 'main' }));
      expect(first.created).toBe(true);
      expect(first.pushed).toBe(true);
      expect(first.reusedRemote).toBe(false);
      // The remote carries exactly the reported head, one empty commit on base.
      const heads = await gitOut(['ls-remote', '--heads', 'origin'], repo);
      expect(heads).toContain('refs/heads/cq/09-16a/tracker');
      expect(heads).toContain(first.headSha);
      const parent = (await gitOut(['-C', repo, 'rev-parse', `${first.headSha}^`], root)).trim();
      const base = (await gitOut(['-C', repo, 'rev-parse', 'main'], root)).trim();
      expect(parent).toBe(base);

      // Re-invoke: the existing remote branch is reused, never moved.
      const second = await okReport(op, inputOf({ repoRoot: repo, base: 'main' }));
      expect(second.reusedRemote).toBe(true);
      expect(second.created).toBe(false);
      expect(second.pushed).toBe(false);
      expect(second.headSha).toBe(first.headSha);
    },
  );

  test(
    'localHead rejects a git FAULT instead of reporting the ref absent (r2 finding 4)',
    { timeout: 60_000 },
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'pr-tracker-nonrepo-'));
      CLEANUP.push(root);
      const effects = makeSubprocessTrackerBranchEffects(root);
      // A non-repo path exits nonzero WITH stderr — the classification must
      // surface that as a fault, never fold it into "branch absent".
      await expect(effects.localHead('cq/09-16a/tracker')).rejects.toThrow(
        /not a git repository|rev-parse/,
      );
    },
  );
});
