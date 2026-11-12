// W1.2 slice C — tests for the merge-time recheck WIRING in the scheduled
// merge entry (src/selfhost/self-merge-prs.ts). The recheck itself is pinned
// by the merge-recheck-*.test.ts files and the store by state-branch.test.ts;
// the sibling test files
// self-merge-prs-recheck.{registry-view,settle-gate,identity-trust,state-durability,dry-run,base-branch}.test.ts
// pin the DEPLOYMENT composition end to end, through the REAL central
// registry (no driverRegistryView injected) with only the INNER merge
// effects faked (the `mergeEffects` seam) and the forge faked at the gh
// argv boundary:
//   1. recheckedRegistryView: non-merge entries pass through identical; a
//      missing merge.runPrs stays undefined (never fabricated).
//   2. An approval bound to an OLDER sha never merges — the inner mergePr is
//      never called and needsHuman carries the recheck refusal.
//   3. Head-bound approval + a durable prior observation older than the
//      settle window → the inner mergePr IS called, pinned to the head.
//   4. A prior observation younger than the window → refused settle_pending.
//   5. The run-start observation pass writes every open candidate in ONE
//      commit, and a second run over a FRESH, EMPTY journal root (simulated
//      Actions-cache eviction) still sees it and merges once settled.
//   6. The dry run makes NO state-branch calls (and resolves no identity).
//   7. The automation identity (`gh api user`) is excluded from trust; an
//      integration token's 403 proceeds; any other failure refuses every
//      merge 'automation identity unresolved'.
//   8. A settled merge run writes only the pre-merge audit observation —
//      the run-start pass over an already-anchored tuple writes nothing.
//   9. The recheck is wired with SelfhostDefaults.protectedBranch: a live
//      base of 'main' refuses whatever readBaseRef pinned.
//
// Split provenance: test/selfhost/self-merge-prs-recheck.test.ts was split
// into the sibling .test.ts files named above plus this shared fixture module
// (pure move).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MergeEffects } from '../../src/adapters/forge-github/mergeEffects.js';
import type { GhFn, GhResult } from '../../src/adapters/forge-github/gh.js';
import {
  emptySettleState,
  observe,
  parseSettleState,
  serializeSettleState,
} from '../../src/policy/queue/settle-state.js';
import type { SettleState } from '../../src/policy/queue/settle-state.js';
import { SETTLE_STATE_PATH } from '../../src/selfhost/config.js';
import { STATE_BRANCH } from '../../src/selfhost/state-branch.js';

const OWNER = 'octo';
const REPO = 'widget';
export const REPO_PATH = `${OWNER}/${REPO}`;
const LIST_PATH = `repos/${REPO_PATH}/pulls?state=open&per_page=100`;
const CLOSED_PATH = `repos/${REPO_PATH}/pulls?state=closed&sort=updated&direction=desc&per_page=100`;

/** A single-digit PR's head sha (e.g. '7777…'). */
export const HEAD = (pr: number): string => String(pr).repeat(40).slice(0, 40);
export const OLD_SHA = 'b'.repeat(40);
const BASE_SHA = 'c'.repeat(40);

/** The run clock: the PR's last commit is an hour before it. */
export const T0 = Date.parse('2026-06-01T12:00:00.000Z');
export const iso = (ms: number): string => new Date(ms).toISOString();

export const json = (value: unknown): GhResult => ({
  code: 0,
  stdout: JSON.stringify(value),
  stderr: '',
});
const notFound: GhResult = { code: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' };
const unprocessable: GhResult = {
  code: 1,
  stdout: '',
  stderr: 'gh: Reference update failed (HTTP 422)',
};

// -- the in-memory cq-state forge (git-data API) ------------------------------

interface ForgeCommit {
  sha: string;
  parent: string | null;
  content: string;
  message: string;
}

/** A minimal git-data forge holding the state branch; commits are recorded. */
export class StateForge {
  tip: string | null = null;
  readonly commits = new Map<string, ForgeCommit>();
  private readonly trees = new Map<string, string>();
  private counter = 0;

  private nextSha(): string {
    this.counter += 1;
    return this.counter.toString(16).padStart(40, 'd');
  }

  /** Pre-seed the branch with one commit holding `state`. */
  seed(state: SettleState): void {
    const sha = this.nextSha();
    this.commits.set(sha, {
      sha,
      parent: null,
      content: serializeSettleState(state),
      message: 'seed',
    });
    this.tip = sha;
  }

  /** The ledger at the tip, parsed (empty when no branch). */
  state(): SettleState {
    const commit = this.tip === null ? undefined : this.commits.get(this.tip);
    if (commit === undefined) return emptySettleState(REPO_PATH);
    return parseSettleState(JSON.parse(commit.content) as unknown, REPO_PATH).state;
  }

  /** Commits this forge received through the API (the pre-seed excluded), oldest first. */
  written(): ForgeCommit[] {
    return [...this.commits.values()].filter((commit) => commit.message !== 'seed');
  }

  /** Serve one gh argv, or undefined when it is not a state-branch call. */
  handle(args: string[]): GhResult | undefined {
    const method = args[1] === '-X' ? (args[2] ?? 'GET') : 'GET';
    const path = method === 'GET' ? (args[1] ?? '') : (args[3] ?? '');
    const field = (name: string): string | undefined =>
      args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
    const base = `repos/${REPO_PATH}`;
    if (method === 'GET' && path === `${base}/git/ref/heads/${STATE_BRANCH}`) {
      return this.tip === null ? notFound : json({ object: { sha: this.tip } });
    }
    if (method === 'GET' && path.startsWith(`${base}/contents/${SETTLE_STATE_PATH}?ref=`)) {
      const commit = this.commits.get(path.slice(path.indexOf('?ref=') + 5));
      if (commit === undefined) return notFound;
      return json({ encoding: 'base64', content: Buffer.from(commit.content).toString('base64') });
    }
    if (method === 'POST' && path === `${base}/git/trees`) {
      const sha = this.nextSha();
      this.trees.set(sha, field('tree[][content]') ?? '');
      return json({ sha });
    }
    if (method === 'POST' && path === `${base}/git/commits`) {
      const sha = this.nextSha();
      this.commits.set(sha, {
        sha,
        parent: field('parents[]') ?? null,
        content: this.trees.get(field('tree') ?? '') ?? '',
        message: field('message') ?? '',
      });
      return json({ sha });
    }
    if (method === 'PATCH' && path === `${base}/git/refs/heads/${STATE_BRANCH}`) {
      const commit = this.commits.get(field('sha') ?? '');
      // Compare-and-swap: only a fast-forward from the current tip lands.
      if (commit === undefined || this.tip === null || commit.parent !== this.tip) {
        return unprocessable;
      }
      this.tip = commit.sha;
      return json({ object: { sha: commit.sha } });
    }
    if (method === 'POST' && path === `${base}/git/refs`) {
      if (this.tip !== null) return unprocessable;
      const sha = field('sha') ?? '';
      if (!this.commits.has(sha)) return unprocessable;
      this.tip = sha;
      return json({ object: { sha } });
    }
    return undefined;
  }
}

// -- the fake forge: candidates + review state + snapshot + state branch ------

interface PrFixture {
  pr: number;
  /** The commit the trusted approval is bound to (the snapshot's commit.oid). */
  approvedOid: string;
  /** The snapshot's live baseRefName; default 'main' (what readBaseRef says). */
  liveBaseName?: string;
  baseName?: string;
}

export const APPROVER = 'maintainer';

/** fetchReviewState's GraphQL payload: one head-bound APPROVED non-author review after the last commit. */
const reviewStatePayload = (pr: number) => ({
  data: {
    repository: {
      pullRequest: {
        author: { login: `pr-author-${String(pr)}` },
        headRefName: `pr-${String(pr)}`,
        headRefOid: HEAD(pr),
        reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
        reviews: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              id: `R_${String(pr)}`,
              author: { login: APPROVER, __typename: 'User' },
              authorAssociation: 'MEMBER',
              // Classify (W1.1) binds reviews to the head too; the recheck's
              // own snapshot decides what the merge instant sees.
              commit: { oid: HEAD(pr) },
              state: 'APPROVED',
              body: '',
              submittedAt: iso(T0 - 30 * 60_000),
            },
          ],
        },
      },
    },
  },
});

/** The recheck's PR_SNAPSHOT_QUERY payload. */
const snapshotPayload = (fixture: PrFixture) => ({
  data: {
    repository: {
      pullRequest: {
        state: 'OPEN',
        isDraft: false,
        author: { login: `pr-author-${String(fixture.pr)}`, __typename: 'User' },
        headRefOid: HEAD(fixture.pr),
        baseRefOid: BASE_SHA,
        baseRefName: fixture.liveBaseName ?? 'main',
        reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] },
        reviews: {
          pageInfo: { hasNextPage: false },
          nodes: [
            {
              author: { login: APPROVER, __typename: 'User' },
              authorAssociation: 'MEMBER',
              state: 'APPROVED',
              submittedAt: iso(T0 - 30 * 60_000),
              commit: { oid: fixture.approvedOid },
            },
          ],
        },
        timelineItems: { pageInfo: { hasNextPage: false }, nodes: [] },
      },
    },
  },
});

/** The token's own login as `gh api user` reports it (a plain automation user). */
export const AUTOMATION_LOGIN = 'cq-runner';

/**
 * The fake gh: records every argv; routes the identity read, state-branch,
 * snapshot, and candidate reads. `user` overrides the `gh api user` answer.
 */
export const forgeGh = (
  forge: StateForge,
  fixtures: PrFixture[],
  calls: string[][],
  user: GhResult = json({ login: AUTOMATION_LOGIN }),
): GhFn => {
  const byPr = new Map(fixtures.map((fixture) => [fixture.pr, fixture]));
  return async (args: string[]): Promise<GhResult> => {
    calls.push(args);
    if (args.length === 2 && args[0] === 'api' && args[1] === 'user') return user;
    const served = forge.handle(args);
    if (served !== undefined) return served;
    const path = args[0] === 'api' && typeof args[1] === 'string' ? args[1] : '';
    if (path === LIST_PATH) {
      return json(
        fixtures.map((fixture) => ({
          number: fixture.pr,
          state: 'open',
          draft: false,
          mergeable_state: 'clean',
          user: { login: `pr-author-${String(fixture.pr)}` },
          head: {
            ref: `pr-${String(fixture.pr)}`,
            sha: HEAD(fixture.pr),
            repo: { full_name: REPO_PATH },
          },
          base: { ref: fixture.baseName ?? 'main' },
        })),
      );
    }
    if (path === CLOSED_PATH) return json([]);
    if (path.startsWith(`repos/${REPO_PATH}/commits/`)) {
      const date = iso(T0 - 60 * 60_000);
      return json({ commit: { committer: { date }, author: { date } } });
    }
    const single = /^repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/.exec(path);
    if (single !== null) {
      const pr = Number(single[1]);
      return json({
        state: 'open',
        draft: false,
        mergeable: true,
        mergeable_state: 'clean',
        user: { login: `pr-author-${String(pr)}` },
        head: { ref: `pr-${String(pr)}`, sha: HEAD(pr), repo: { full_name: REPO_PATH } },
        base: { ref: fixtures.find((fixture) => fixture.pr === pr)?.baseName ?? 'main' },
      });
    }
    if (path === 'graphql') {
      const prEntry = args.find((arg) => arg.startsWith('pr='));
      const pr = prEntry === undefined ? 0 : Number(prEntry.slice('pr='.length));
      const fixture = byPr.get(pr);
      if (fixture === undefined)
        return { code: 1, stdout: '', stderr: `no fixture for pr ${String(pr)}` };
      // The recheck's snapshot is told apart from fetchReviewState by its query text.
      const query = args.find((arg) => arg.startsWith('query=')) ?? '';
      return query.includes('timelineItems')
        ? json(snapshotPayload(fixture))
        : json(reviewStatePayload(pr));
    }
    if (/^repos\/[^/]+\/[^/]+\/(pulls|issues)\/\d+\/(comments|reviews)(\?.*)?$/.test(path)) {
      return json([]);
    }
    return { code: 1, stdout: '', stderr: `unrouted gh invocation: ${args.join(' ')}` };
  };
};

/** A recording in-memory MergeEffects: every ref resolves to the PR's head; merges succeed. */
export class RecordingMergeEffects implements MergeEffects {
  constructor(private readonly baseName = 'main') {}
  readonly merges: Array<{ pr: number; matchHeadCommit?: string }> = [];

  async validateRef(ref: string): Promise<{ ok: boolean; sha?: string }> {
    const match = /^refs\/pull\/(\d+)\/head$/.exec(ref);
    return match === null ? { ok: false } : { ok: true, sha: HEAD(Number(match[1])) };
  }
  async fetchRef(): Promise<GhResult> {
    return { code: 0, stdout: '', stderr: '' };
  }
  async readBaseRef(): Promise<{ ok: boolean; baseRefName?: string }> {
    return { ok: true, baseRefName: this.baseName };
  }
  async worktreePrepare(pr: number): Promise<{ path: string }> {
    return { path: `/wt/${String(pr)}` };
  }
  async worktreeRemove(): Promise<void> {}
  async mergePr(
    pr: number,
    opts: { method: 'merge'; matchHeadCommit?: string },
  ): Promise<GhResult> {
    this.merges.push({
      pr,
      ...(opts.matchHeadCommit !== undefined ? { matchHeadCommit: opts.matchHeadCommit } : {}),
    });
    return { code: 0, stdout: '', stderr: '' };
  }
  async retargetBase(): Promise<GhResult> {
    return { code: 0, stdout: '', stderr: '' };
  }
  async pushRef(): Promise<GhResult> {
    return { code: 0, stdout: '', stderr: '' };
  }

  async diffPatch(): Promise<GhResult> {
    return { code: 0, stdout: '', stderr: '' };
  }

  async commitParents(): Promise<{ ok: boolean; parents?: string[] }> {
    return { ok: true, parents: [] };
  }

  async isAncestor(): Promise<GhResult> {
    return { code: 0, stdout: '', stderr: '' };
  }

  async readCommitMessage(): Promise<GhResult> {
    return { code: 0, stdout: 'resolve\n', stderr: '' };
  }

  async readCommitEncoding(): Promise<GhResult> {
    return { code: 0, stdout: '', stderr: '' };
  }

  async readCommitIdentity(): Promise<GhResult> {
    return {
      code: 0,
      stdout: 'Fixture <fixture@localhost>\nFixture <fixture@localhost>\n',
      stderr: '',
    };
  }

  async objectExists(): Promise<GhResult> {
    return { code: 0, stdout: '', stderr: '' };
  }

  async fetchBaseBranch(): Promise<GhResult> {
    return { code: 0, stdout: '', stderr: '' };
  }
}

/** A ledger with PR `pr`'s live tuple observed once at `atMs`. */
export const seededState = (pr: number, atMs: number): SettleState =>
  observe(
    emptySettleState(REPO_PATH),
    pr,
    { head: HEAD(pr), base: BASE_SHA, forcePushEpoch: 0 },
    atMs,
    'test:seed',
  );

const tmpRoots: string[] = [];
export const tmpJournalRoot = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'self-merge-prs-recheck-'));
  tmpRoots.push(dir);
  return dir;
};

/** Per-file afterEach hook: drop every journal root this file created. */
export function cleanupTmpRoots(): void {
  for (const dir of tmpRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export const cfg = (journalRoot: string) => ({
  owner: OWNER,
  repo: REPO,
  repoRoot: '/checkout',
  journalRoot,
  disableConflictResolution: true,
});

export const isStateBranchCall = (args: string[]): boolean =>
  args.some((arg) => arg.includes('/git/') || arg.includes('/contents/'));
