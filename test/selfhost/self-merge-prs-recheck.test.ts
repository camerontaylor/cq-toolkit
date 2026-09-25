// W1.2 slice C — tests for the merge-time recheck WIRING in the scheduled
// merge entry (src/selfhost/self-merge-prs.ts). The recheck itself is pinned
// by merge-recheck.test.ts and the store by state-branch.test.ts; this file
// pins the DEPLOYMENT composition end to end, through the REAL central
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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { OpRegistryView } from '../../src/kernel/runner.js';
import type { OpRegistryEntry } from '../../src/kernel/types.js';
import { REVIEW_ACCEPT_SETTLE_MS } from '../../src/ops/merge/classify.config.js';
import type { MergeEffects } from '../../src/ops/merge/effects.js';
import type { GhFn, GhResult } from '../../src/ops/review/gh.js';
import { PR_SNAPSHOT_QUERY, trustPolicyFromConfig } from '../../src/selfhost/merge-recheck.js';
import { recheckedRegistryView, runSelfMergePrs } from '../../src/selfhost/self-merge-prs.js';
import {
  emptySettleState,
  observe,
  parseSettleState,
  serializeSettleState,
} from '../../src/selfhost/settle-state.js';
import type { SettleState } from '../../src/selfhost/settle-state.js';
import { SETTLE_STATE_PATH, STATE_BRANCH } from '../../src/selfhost/state-branch.js';

const OWNER = 'octo';
const REPO = 'widget';
const REPO_PATH = `${OWNER}/${REPO}`;
const LIST_PATH = `repos/${REPO_PATH}/pulls?state=open&per_page=100`;
const CLOSED_PATH = `repos/${REPO_PATH}/pulls?state=closed&sort=updated&direction=desc&per_page=100`;

/** A single-digit PR's head sha (e.g. '7777…'). */
const HEAD = (pr: number): string => String(pr).repeat(40).slice(0, 40);
const OLD_SHA = 'b'.repeat(40);
const BASE_SHA = 'c'.repeat(40);

/** The run clock: the PR's last commit is an hour before it. */
const T0 = Date.parse('2026-06-01T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

const json = (value: unknown): GhResult => ({ code: 0, stdout: JSON.stringify(value), stderr: '' });
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
class StateForge {
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
}

const APPROVER = 'maintainer';

/** fetchReviewState's GraphQL payload: one APPROVED non-author review after the last commit. */
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
              author: { login: APPROVER },
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
const AUTOMATION_LOGIN = 'cq-runner';

/**
 * The fake gh: records every argv; routes the identity read, state-branch,
 * snapshot, and candidate reads. `user` overrides the `gh api user` answer.
 */
const forgeGh = (
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
          base: { ref: 'merge-queue' },
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
        base: { ref: 'merge-queue' },
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
class RecordingMergeEffects implements MergeEffects {
  readonly merges: Array<{ pr: number; matchHeadCommit?: string }> = [];

  async validateRef(ref: string): Promise<{ ok: boolean; sha?: string }> {
    const match = /^refs\/pull\/(\d+)\/head$/.exec(ref);
    return match === null ? { ok: false } : { ok: true, sha: HEAD(Number(match[1])) };
  }
  async fetchRef(): Promise<GhResult> {
    return { code: 0, stdout: '', stderr: '' };
  }
  async readBaseRef(): Promise<{ ok: boolean; baseRefName?: string }> {
    return { ok: true, baseRefName: 'merge-queue' };
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
}

/** A ledger with PR `pr`'s live tuple observed once at `atMs`. */
const seededState = (pr: number, atMs: number): SettleState =>
  observe(
    emptySettleState(REPO_PATH),
    pr,
    { head: HEAD(pr), base: BASE_SHA, forcePushEpoch: 0 },
    atMs,
    'test:seed',
  );

const tmpRoots: string[] = [];
const tmpJournalRoot = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'self-merge-prs-recheck-'));
  tmpRoots.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of tmpRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const cfg = (journalRoot: string) => ({
  owner: OWNER,
  repo: REPO,
  repoRoot: '/checkout',
  journalRoot,
  disableConflictResolution: true,
});

const isStateBranchCall = (args: string[]): boolean =>
  args.some((arg) => arg.includes('/git/') || arg.includes('/contents/'));

// -----------------------------------------------------------------------------

describe('recheckedRegistryView', () => {
  const entry = (name: string): OpRegistryEntry<never, never> =>
    ({
      name,
      inputSchema: {},
      importer: async () => async () => ({ status: 'ok', value: name }),
    }) as unknown as OpRegistryEntry<never, never>;
  const neverRecheck = async (): Promise<{ ok: false; reason: string }> => ({
    ok: false,
    reason: 'unused',
  });

  test('non-merge entries pass through identical; merge.runPrs keeps name + schema, swaps the importer', () => {
    const other = entry('review.fetch');
    const merge = entry('merge.runPrs');
    const base: OpRegistryView = {
      get: (name) =>
        name === 'review.fetch' ? other : name === 'merge.runPrs' ? merge : undefined,
    };
    const view = recheckedRegistryView({
      baseView: base,
      innerEffects: new RecordingMergeEffects(),
      recheck: neverRecheck,
    });
    expect(view.get('review.fetch')).toBe(other);
    expect(view.get('nope')).toBeUndefined();
    const gated = view.get('merge.runPrs');
    expect(gated?.name).toBe('merge.runPrs');
    expect(gated?.inputSchema).toBe(merge.inputSchema);
    expect(gated?.importer).not.toBe(merge.importer);
  });

  test('a missing merge.runPrs stays undefined (never fabricated)', () => {
    const view = recheckedRegistryView({
      baseView: { get: () => undefined },
      innerEffects: new RecordingMergeEffects(),
      recheck: neverRecheck,
    });
    expect(view.get('merge.runPrs')).toBeUndefined();
  });
});

describe('runSelfMergePrs — merge-time recheck through the real registry', () => {
  test('an approval bound to an OLDER sha never merges: inner mergePr untouched, needsHuman carries the refusal', async () => {
    const forge = new StateForge();
    forge.seed(seededState(7, T0 - 2 * REVIEW_ACCEPT_SETTLE_MS));
    const effects = new RecordingMergeEffects();
    const calls: string[][] = [];
    const result = await runSelfMergePrs(
      {
        gh: forgeGh(forge, [{ pr: 7, approvedOid: OLD_SHA }], calls),
        mergeEffects: effects,
        nowMs: () => T0,
      },
      cfg(tmpJournalRoot()),
    );
    if (result.dryRun === true) throw new Error('unreachable');
    expect(effects.merges).toEqual([]);
    const row = result.outcome?.needsHuman.find((entry) => entry.pr === 7);
    expect(row?.reason).toContain('cq merge-time recheck refused pr 7');
    expect(row?.reason).toContain('no_head_bound_acceptance');
  });

  test('head-bound approval + a durable observation older than settle → the inner mergePr is called, pinned to the head', async () => {
    const forge = new StateForge();
    forge.seed(seededState(7, T0 - REVIEW_ACCEPT_SETTLE_MS - 60_000));
    const effects = new RecordingMergeEffects();
    const result = await runSelfMergePrs(
      {
        gh: forgeGh(forge, [{ pr: 7, approvedOid: HEAD(7) }], []),
        mergeEffects: effects,
        nowMs: () => T0,
      },
      cfg(tmpJournalRoot()),
    );
    if (result.dryRun === true) throw new Error('unreachable');
    expect(effects.merges).toEqual([{ pr: 7, matchHeadCommit: HEAD(7) }]);
    expect(result.outcome?.firstPass.merged).toEqual([7]);
    expect(result.settleObservation.observed).toEqual([7]);
    // The tuple was already anchored: the run-start pass writes nothing,
    // and the ONLY commit is the recheck's pre-merge audit observation.
    expect(result.settleObservation.write).toBeNull();
    expect(forge.written().map((commit) => commit.message)).toEqual(['settle: recheck pr #7']);
    expect(result.automationIdentity).toEqual({ resolved: true, login: AUTOMATION_LOGIN });
  });

  test("the automation identity's own head-bound approval never counts", async () => {
    const forge = new StateForge();
    forge.seed(seededState(7, T0 - REVIEW_ACCEPT_SETTLE_MS - 60_000));
    const effects = new RecordingMergeEffects();
    const result = await runSelfMergePrs(
      {
        // The token IS the approver: its approval must be excluded.
        gh: forgeGh(forge, [{ pr: 7, approvedOid: HEAD(7) }], [], json({ login: APPROVER })),
        mergeEffects: effects,
        nowMs: () => T0,
      },
      cfg(tmpJournalRoot()),
    );
    if (result.dryRun === true) throw new Error('unreachable');
    expect(result.automationIdentity).toEqual({ resolved: true, login: APPROVER });
    expect(effects.merges).toEqual([]);
    const row = result.outcome?.needsHuman.find((entry) => entry.pr === 7);
    expect(row?.reason).toContain('no_head_bound_acceptance');
  });

  test('an integration token (403 on /user) proceeds; the merge goes through', async () => {
    const forge = new StateForge();
    forge.seed(seededState(7, T0 - REVIEW_ACCEPT_SETTLE_MS - 60_000));
    const effects = new RecordingMergeEffects();
    const forbidden: GhResult = {
      code: 1,
      stdout: '',
      stderr: 'gh: Resource not accessible by integration (HTTP 403)',
    };
    const result = await runSelfMergePrs(
      {
        gh: forgeGh(forge, [{ pr: 7, approvedOid: HEAD(7) }], [], forbidden),
        mergeEffects: effects,
        nowMs: () => T0,
      },
      cfg(tmpJournalRoot()),
    );
    if (result.dryRun === true) throw new Error('unreachable');
    expect(result.automationIdentity).toMatchObject({
      resolved: false,
      reason: expect.stringContaining('integration token') as unknown,
    });
    expect(effects.merges).toEqual([{ pr: 7, matchHeadCommit: HEAD(7) }]);
  });

  test('any other identity failure fails closed: every merge refused, the run still completes', async () => {
    const forge = new StateForge();
    forge.seed(seededState(7, T0 - REVIEW_ACCEPT_SETTLE_MS - 60_000));
    const effects = new RecordingMergeEffects();
    const result = await runSelfMergePrs(
      {
        gh: forgeGh(forge, [{ pr: 7, approvedOid: HEAD(7) }], [], {
          code: 1,
          stdout: '',
          stderr: 'gh: Bad credentials (HTTP 401)',
        }),
        mergeEffects: effects,
        nowMs: () => T0,
      },
      cfg(tmpJournalRoot()),
    );
    if (result.dryRun === true) throw new Error('unreachable');
    expect(result.automationIdentity).toEqual({
      resolved: false,
      reason: 'gh exit 1: gh: Bad credentials (HTTP 401)',
    });
    expect(effects.merges).toEqual([]);
    const row = result.outcome?.needsHuman.find((entry) => entry.pr === 7);
    expect(row?.reason).toContain(
      'automation identity unresolved: gh exit 1: gh: Bad credentials (HTTP 401)',
    );
  });

  test('an integration token with trustedBots configured fails closed (the App bot is unknowable)', async () => {
    const forge = new StateForge();
    forge.seed(seededState(7, T0 - REVIEW_ACCEPT_SETTLE_MS - 60_000));
    const effects = new RecordingMergeEffects();
    const result = await runSelfMergePrs(
      {
        gh: forgeGh(forge, [{ pr: 7, approvedOid: HEAD(7) }], [], {
          code: 1,
          stdout: '',
          stderr: 'gh: Resource not accessible by integration (HTTP 403)',
        }),
        mergeEffects: effects,
        nowMs: () => T0,
      },
      {
        ...cfg(tmpJournalRoot()),
        trustPolicy: trustPolicyFromConfig({ trustedBots: ['coderabbitai[bot]'] }),
      },
    );
    if (result.dryRun === true) throw new Error('unreachable');
    expect(effects.merges).toEqual([]);
    const row = result.outcome?.needsHuman.find((entry) => entry.pr === 7);
    expect(row?.reason).toContain('integration token with trustedBots configured');
  });

  test('a non-integration 403 fails closed like any other identity failure', async () => {
    const forge = new StateForge();
    forge.seed(seededState(7, T0 - REVIEW_ACCEPT_SETTLE_MS - 60_000));
    const effects = new RecordingMergeEffects();
    const result = await runSelfMergePrs(
      {
        gh: forgeGh(forge, [{ pr: 7, approvedOid: HEAD(7) }], [], {
          code: 1,
          stdout: '',
          stderr: 'gh: Must have admin rights to Repository. (HTTP 403)',
        }),
        mergeEffects: effects,
        nowMs: () => T0,
      },
      cfg(tmpJournalRoot()),
    );
    if (result.dryRun === true) throw new Error('unreachable');
    expect(result.automationIdentity).toMatchObject({ resolved: false });
    expect(effects.merges).toEqual([]);
    const row = result.outcome?.needsHuman.find((entry) => entry.pr === 7);
    expect(row?.reason).toContain('automation identity unresolved');
  });

  test('a prior observation younger than settle → refused settle: settle_pending', async () => {
    const forge = new StateForge();
    forge.seed(seededState(7, T0 - REVIEW_ACCEPT_SETTLE_MS / 2));
    const effects = new RecordingMergeEffects();
    const result = await runSelfMergePrs(
      {
        gh: forgeGh(forge, [{ pr: 7, approvedOid: HEAD(7) }], []),
        mergeEffects: effects,
        nowMs: () => T0,
      },
      cfg(tmpJournalRoot()),
    );
    if (result.dryRun === true) throw new Error('unreachable');
    expect(effects.merges).toEqual([]);
    const row = result.outcome?.needsHuman.find((entry) => entry.pr === 7);
    expect(row?.reason).toContain('cq merge-time recheck refused pr 7');
    expect(row?.reason).toContain('settle: settle_pending');
  });

  test('state branch round-trip survives a simulated Actions-cache eviction', async () => {
    const forge = new StateForge(); // no cq-state branch yet: the first run bootstraps it
    const fixtures = [
      { pr: 7, approvedOid: HEAD(7) },
      { pr: 8, approvedOid: HEAD(8) },
    ];

    // Run 1: the observation pass writes BOTH open candidates in ONE commit;
    // the recheck refuses (a single instant is not a settle).
    const journal1 = tmpJournalRoot();
    const effects1 = new RecordingMergeEffects();
    const first = await runSelfMergePrs(
      { gh: forgeGh(forge, fixtures, []), mergeEffects: effects1, nowMs: () => T0 },
      cfg(journal1),
    );
    if (first.dryRun === true) throw new Error('unreachable');
    expect(first.settleObservation.observed).toEqual([7, 8]);
    expect(first.settleObservation.write?.ok).toBe(true);
    const observeCommit = forge.written()[0];
    expect(observeCommit?.message).toBe('settle: observe 2 open pr(s)');
    expect(observeCommit?.parent).toBeNull(); // the bootstrap root commit
    const observed = parseSettleState(
      JSON.parse(observeCommit?.content ?? '{}') as unknown,
      REPO_PATH,
    );
    expect(Object.keys(observed.state.prs)).toEqual(['7', '8']);
    expect(effects1.merges).toEqual([]);

    // The Actions cache is evicted: the first run's journal root is gone
    // and run 2 starts from a FRESH, EMPTY root.
    rmSync(journal1, { recursive: true, force: true });
    const journal2 = tmpJournalRoot();

    // Run 2, past the settle window: the state branch still carries run 1's
    // observation, so both PRs merge.
    const effects2 = new RecordingMergeEffects();
    const second = await runSelfMergePrs(
      {
        gh: forgeGh(forge, fixtures, []),
        mergeEffects: effects2,
        nowMs: () => T0 + REVIEW_ACCEPT_SETTLE_MS + 60_000,
      },
      cfg(journal2),
    );
    if (second.dryRun === true) throw new Error('unreachable');
    expect(effects2.merges).toEqual([
      { pr: 7, matchHeadCommit: HEAD(7) },
      { pr: 8, matchHeadCommit: HEAD(8) },
    ]);
    expect(second.outcome?.needsHuman).toEqual([]);
    expect(forge.state().prs['7']?.observations[0]?.observedAt).toBe(iso(T0));
  });

  test('the dry run makes NO state-branch calls', async () => {
    const forge = new StateForge();
    const calls: string[][] = [];
    const result = await runSelfMergePrs(
      {
        gh: forgeGh(forge, [{ pr: 7, approvedOid: HEAD(7) }], calls),
        mergeEffects: new RecordingMergeEffects(),
        nowMs: () => T0,
      },
      { ...cfg(tmpJournalRoot()), dryRun: true },
    );
    expect(result.dryRun).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter(isStateBranchCall)).toEqual([]);
    expect(calls.some((args) => args[0] === 'api' && args[1] === 'user')).toBe(false);
    expect(calls.some((args) => args.includes(`query=${PR_SNAPSHOT_QUERY}`))).toBe(false);
    expect(forge.tip).toBeNull();
  });
});
