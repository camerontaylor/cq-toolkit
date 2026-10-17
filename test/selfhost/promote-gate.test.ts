// W1.10 — tests for the promotion gate (src/selfhost/promote-gate.ts,
// ADR-0004 D-K; methods note Decisions 5, 12, 13).
//
// Pure rules: checkClosure (accepted merges pass; a direct push, a merge with
// no PR, a PR head that is not M^2, a PR into main, an unmerged PR, a fork
// PR, an octopus, and a commit reachable only through an unadmitted merge
// all refuse), selectVerdict (app-id and interim modes), verifierRanAt (the
// interim "default-branch cq-verify ran at main" rule), checkVerifiedRun
// (path/event/branch/repo/sha/conclusion and job shape), parseGateArgs.
//
// runGate end-to-end over a fake gh (a route table, every argv recorded), a
// fake acceptance and policy diff, a fake clock, and either fake git or —
// for the real promotion — the real hardened helpers over a temp repository
// pushing to a local bare remote. mainWith: the push credential is out of
// the env before any gh/git child runs, and `--push` without it is refused
// before any read. PR-C: the subject is the newest reviewed sha (the walk),
// selectPromotionReview pins the reviewer by type+login+id, and the push
// sends ONLY main.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import type { OpResult } from '../../src/kernel/types.js';
import { authorizePaths } from '../../src/ops/gates/d11Authorization.js';
import type { PolicyDiffInput, PolicyDiffOutcome } from '../../src/ops/gates/policyDiff.js';
import type { RangeCommit } from '../../src/ops/ratchet/git.js';
import type { GhFn, GhResult } from '../../src/ops/review/gh.js';
import type { AcceptanceInput, AcceptanceResult } from '../../src/selfhost/acceptance.js';
import {
  BANNED_REVIEWER_IDS,
  BANNED_REVIEWER_LOGINS,
  POLL_MS,
  checkClosure,
  bindQueueAuthorization,
  checkVerifiedRun,
  mainWith,
  parseGateArgs,
  realGateGit,
  remoteUrlFor,
  runGate,
  selectPromotionReview,
  selectVerdict,
  toMergedPr,
  verifierRanAt,
  type GateConfig,
  type GateDeps,
  type GateGit,
  type MergedPr,
  type ReviewerWant,
  type VerdictWant,
} from '../../src/selfhost/promote-gate.js';
import { verifyWithAuthorization } from '../../src/selfhost/verify-ratchet.js';
import type { VerifyRatchetInput } from '../../src/ops/ratchet/verifyRatchet.js';

const sha = (c: string): string => c.repeat(40);
const MAIN = sha('a');
const H1 = sha('b');
const M1 = sha('c');
const H2 = sha('d');
const M2 = sha('e');
const X = sha('f');
// The trust checkout is main's head: the gate refuses a trust ref that trails main.
const TRUST = MAIN;
const REPO_ID = 42;

// The pinned reviewer of the test world: a fixture identity, deliberately
// not any real App (identity values live in the registration record).
const REVIEWER: ReviewerWant = { login: 'promo-review-fixture[bot]', id: 4242424242 };

/** A trusted promotion-review status (creator = REVIEWER, success binding base). */
const promoReview = (
  base: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({
  context: 'crq/promotion-review',
  id: 900,
  state: 'success',
  description: `reviewed main=${base} crq#promo-0000000000`,
  created_at: '2026-09-01T00:00:00Z',
  creator: { login: REVIEWER.login, id: REVIEWER.id, type: 'Bot' },
  ...over,
});

const pr = (over: Partial<MergedPr> = {}): MergedPr => ({
  number: 7,
  mergeCommitSha: M1,
  baseRef: 'merge-queue',
  mergedAt: '2026-09-01T00:00:00Z',
  headSha: H1,
  headRepoId: REPO_ID,
  ...over,
});

const closure = (
  commits: RangeCommit[],
  firstParent: string[],
  prs: [string, MergedPr[]][],
): ReturnType<typeof checkClosure> =>
  checkClosure({
    commits,
    firstParent,
    prs: new Map(prs),
    repositoryId: REPO_ID,
    queueBranch: 'merge-queue',
  });

// main <- M1 (merge of H1) ; H1's parent is main.
const ONE: RangeCommit[] = [
  { sha: M1, parents: [MAIN, H1] },
  { sha: H1, parents: [MAIN] },
];

describe('checkClosure', () => {
  test('accepted PR merges pass (two stacked PRs, multi-commit head)', () => {
    const commits: RangeCommit[] = [
      { sha: M2, parents: [M1, H2] },
      { sha: H2, parents: [X] },
      { sha: X, parents: [M1] },
      ...ONE,
    ];
    const r = closure(
      commits,
      [M2, M1],
      [
        [M2, [pr({ number: 8, mergeCommitSha: M2, headSha: H2 })]],
        [M1, [pr(), pr({ number: 99, mergeCommitSha: sha('7') })]],
      ],
    );
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.admitted).toEqual([
      { pr: 8, merge: M2, head: H2 },
      { pr: 7, merge: M1, head: H1 },
    ]);
  });

  test('a direct push on the first-parent chain refuses', () => {
    const r = closure([{ sha: X, parents: [MAIN] }], [X], []);
    expect(r.ok).toBe(false);
    expect(r.violations[0]).toMatch(/non-merge commit .* direct push/);
  });

  test('a direct push is not laundered by a later PR branched from it', () => {
    const commits: RangeCommit[] = [
      { sha: M1, parents: [X, H1] },
      { sha: H1, parents: [X] },
      { sha: X, parents: [MAIN] },
    ];
    const r = closure(commits, [M1, X], [[M1, [pr()]]]);
    expect(r.ok).toBe(false);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]).toContain(X);
  });

  test('a merge with no PR refuses; an ambiguous one refuses', () => {
    expect(closure(ONE, [M1], []).violations[0]).toMatch(/no PR recorded/);
    expect(closure(ONE, [M1], [[M1, [pr({ mergeCommitSha: sha('7') })]]]).violations[0]).toMatch(
      /no PR recorded/,
    );
    expect(closure(ONE, [M1], [[M1, [pr(), pr({ number: 8 })]]]).violations[0]).toMatch(
      /ambiguous — PRs #7, #8/,
    );
  });

  test('PR head != M^2, PR into main, unmerged PR, fork PR each refuse', () => {
    const cases: [Partial<MergedPr>, RegExp][] = [
      [{ headSha: sha('3') }, /final head .* is not the merge's second parent/],
      [{ baseRef: 'main' }, /merged into 'main', not 'merge-queue'/],
      [{ mergedAt: null }, /is not merged/],
      [{ headRepoId: 999 }, /head repository 999 is not this repository \(fork\)/],
      [{ headRepoId: null }, /\(deleted\) is not this repository/],
    ];
    for (const [over, re] of cases) {
      const r = closure(ONE, [M1], [[M1, [pr(over)]]]);
      expect(r.ok).toBe(false);
      expect(r.violations[0]).toMatch(re);
      // H1 is then reachable only through the unadmitted merge.
      expect(r.violations[1]).toMatch(/not reachable from any admitted PR head/);
    }
  });

  test('an octopus merge refuses', () => {
    const r = closure(
      [
        { sha: M1, parents: [MAIN, H1, H2] },
        { sha: H1, parents: [MAIN] },
        { sha: H2, parents: [MAIN] },
      ],
      [M1],
      [[M1, [pr()]]],
    );
    expect(r.violations[0]).toMatch(/octopus merge \(3 parents\)/);
  });

  test('a commit reachable only from an unadmitted merge refuses', () => {
    const commits: RangeCommit[] = [
      { sha: M2, parents: [M1, X] },
      { sha: X, parents: [M1] },
      ...ONE,
    ];
    const r = closure(commits, [M2, M1], [[M1, [pr()]]]);
    expect(r.ok).toBe(false);
    expect(r.violations).toEqual([
      expect.stringMatching(new RegExp(`^${M2}: merge commit with no PR`)),
      expect.stringMatching(new RegExp(`^${X}: not reachable`)),
    ]);
  });

  test('toMergedPr normalizes the API shape and rejects malformed identity', () => {
    expect(
      toMergedPr({
        number: 7,
        merge_commit_sha: M1.toUpperCase(),
        base: { ref: 'merge-queue' },
        merged_at: '2026-09-01T00:00:00Z',
        head: { sha: H1, repo: { id: REPO_ID } },
      }),
    ).toEqual(pr());
    expect(toMergedPr({ number: 7, head: { sha: 'nope' } })).toBeNull();
    expect(toMergedPr({ number: -1, head: { sha: H1 } })).toBeNull();
    expect(toMergedPr({ number: 7, head: { sha: H1, repo: null } })?.headRepoId).toBeNull();
  });
});

const TIP = M1;
const run = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 1,
  app: { id: 500, slug: 'cq-verdict' },
  head_sha: TIP,
  external_id: `${MAIN}:${TIP}`,
  status: 'completed',
  conclusion: 'success',
  completed_at: '2026-09-01T00:00:00Z',
  ...over,
});

const appWant: VerdictWant = {
  tip: TIP,
  main: MAIN,
  verdictAppId: 500,
  verifierRan: false,
};

describe('selectVerdict (app-id mode)', () => {
  test('a valid success row wins', () => {
    const s = selectVerdict([run()], appWant);
    expect(s.state).toBe('success');
    expect(s.winner).toBe(1);
    expect(s.lines[0]).toBe('verdict selection: app id 500');
  });

  test("another app's newer success is ignored; the numeric id decides, never the slug", () => {
    const rows = [
      run({ conclusion: 'failure' }),
      run({
        id: 2,
        app: { id: 501, slug: 'cq-verdict' },
        completed_at: '2026-09-02T00:00:00Z',
      }),
    ];
    expect(selectVerdict(rows, appWant).state).toBe('failure');
    expect(selectVerdict([run({ app: { id: '500', slug: 'cq-verdict' } })], appWant).state).toBe(
      'missing',
    );
  });

  test('external_id bound to another main is not valid (missing → dispatch-eligible)', () => {
    const s = selectVerdict([run({ external_id: `${sha('1')}:${TIP}` })], appWant);
    expect(s.state).toBe('missing');
    expect(s.lines.join('\n')).toMatch(/bound to another main 1/);
  });

  test('newest valid wins (completed_at, tie → higher id); failure newest → failure', () => {
    const older = run({ id: 5, completed_at: '2026-09-01T00:00:00Z' });
    const newerFail = run({
      id: 3,
      conclusion: 'failure',
      completed_at: '2026-09-03T00:00:00Z',
    });
    expect(selectVerdict([older, newerFail], appWant).state).toBe('failure');
    const tieFail = run({
      id: 9,
      conclusion: 'neutral',
      completed_at: '2026-09-01T00:00:00Z',
    });
    expect(selectVerdict([older, tieFail], appWant)).toMatchObject({
      state: 'failure',
      winner: 9,
    });
    const tieOk = run({
      id: 2,
      conclusion: 'failure',
      completed_at: '2026-09-01T00:00:00Z',
    });
    expect(selectVerdict([tieOk, older], appWant)).toMatchObject({
      state: 'success',
      winner: 5,
    });
  });

  test('wrong head_sha is ignored; a running bound row is pending', () => {
    expect(selectVerdict([run({ head_sha: MAIN })], appWant).state).toBe('missing');
    expect(
      selectVerdict([run({ status: 'in_progress', conclusion: null, completed_at: null })], appWant)
        .state,
    ).toBe('pending');
  });
});

describe('selectVerdict (interim mode)', () => {
  const want = (verifierRan: boolean): VerdictWant => ({
    ...appWant,
    verdictAppId: null,
    verifierRan,
  });
  const actionsRow = run({ app: { id: 15368, slug: 'github-actions' } });

  test('slug + binding + a completed verifier run pass; the report marks the interim form', () => {
    const s = selectVerdict([actionsRow], want(true));
    expect(s.state).toBe('success');
    expect(s.lines[0]).toBe(
      'interim verdict selection (app slug + binding + a completed default-branch cq-verify run at main; forgeable per RS-4 T-13; ends at C2)',
    );
  });

  test('no completed default-branch verifier run at main → every row is missing', () => {
    const s = selectVerdict([actionsRow], want(false));
    expect(s.state).toBe('missing');
    expect(s.lines.join('\n')).toMatch(/no completed cq-verify\.yml run on the default branch/);
    expect(
      selectVerdict([run({ app: { slug: 'github-actions' }, status: 'in_progress' })], want(false))
        .state,
    ).toBe('missing');
  });

  test('slug, head_sha and binding are each checked', () => {
    expect(selectVerdict([run({ app: { id: 1, slug: 'other' } })], want(true)).state).toBe(
      'missing',
    );
    expect(
      selectVerdict([run({ app: { slug: 'github-actions' }, head_sha: MAIN })], want(true)).state,
    ).toBe('missing');
    const other = selectVerdict(
      [
        run({
          app: { slug: 'github-actions' },
          external_id: `${sha('1')}:${TIP}`,
        }),
      ],
      want(true),
    );
    expect(other.state).toBe('missing');
    expect(other.lines.join('\n')).toMatch(/bound to another main 1/);
  });
});

describe('verifierRanAt (interim)', () => {
  const vwant = { main: MAIN, defaultBranch: 'main', repositoryId: REPO_ID };
  const vrun = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 31,
    path: '.github/workflows/cq-verify.yml',
    event: 'workflow_run',
    head_branch: 'main',
    head_sha: MAIN,
    head_repository: { id: REPO_ID },
    status: 'completed',
    conclusion: 'success',
    created_at: '2026-09-01T00:00:00Z',
    ...over,
  });

  test('a completed workflow_run or workflow_dispatch run at main counts; newest wins', () => {
    expect(verifierRanAt([vrun()], vwant)).toBe(31);
    expect(
      verifierRanAt([vrun({ event: 'workflow_dispatch', conclusion: 'failure' })], vwant),
    ).toBe(31);
    expect(
      verifierRanAt([vrun(), vrun({ id: 32, created_at: '2026-09-02T00:00:00Z' })], vwant),
    ).toBe(32);
    expect(verifierRanAt([], vwant)).toBeNull();
  });

  test('path, event, branch, sha, repository and status are each checked', () => {
    for (const over of [
      { path: '.github/workflows/evil.yml' },
      { event: 'push' },
      { event: 'pull_request' },
      { head_branch: 'merge-queue' },
      { head_sha: TIP },
      { head_repository: { id: 1 } },
      { head_repository: null },
      { status: 'in_progress' },
    ]) {
      expect(verifierRanAt([vrun(over)], vwant), JSON.stringify(over)).toBeNull();
    }
  });
});

describe('checkVerifiedRun', () => {
  const want = { file: 'ci.yml', tip: TIP, repositoryId: REPO_ID };
  const wf = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 77,
    run_attempt: 1,
    path: '.github/workflows/ci.yml',
    event: 'push',
    head_branch: 'merge-queue',
    head_repository: { id: REPO_ID },
    head_sha: TIP,
    status: 'completed',
    conclusion: 'success',
    ...over,
  });
  const job = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 1,
    run_attempt: 1,
    name: 'static',
    status: 'completed',
    conclusion: 'success',
    runner_id: 5,
    steps: [{ name: 'x' }],
    ...over,
  });

  test('a green run with real jobs passes', () => {
    expect(checkVerifiedRun(wf(), [job(), job({ name: 'b' })], want).state).toBe('success');
  });

  test('missing / pending / jobs not read', () => {
    expect(checkVerifiedRun(null, null, want).state).toBe('missing');
    expect(checkVerifiedRun(wf({ status: 'in_progress' }), null, want).state).toBe('pending');
    expect(checkVerifiedRun(wf(), null, want).state).toBe('pending');
  });

  test('path, event, repo, sha, conclusion each fail', () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ path: '.github/workflows/other.yml' }, /path/],
      [{ event: 'workflow_dispatch' }, /event/],
      [{ head_branch: 'x' }, /head branch 'x' is not 'merge-queue'/],
      [{ head_branch: null }, /head branch/],
      [{ head_repository: { id: 1 } }, /head repository/],
      [{ head_sha: MAIN }, /head_sha/],
      [{ conclusion: 'failure' }, /conclusion 'failure'/],
    ];
    for (const [over, re] of cases) {
      const c = checkVerifiedRun(wf(over), [job()], want);
      expect(c.state).toBe('failure');
      expect(c.reason).toMatch(re);
    }
  });

  test('job shape: runner_id null, zero steps, skipped job, no jobs', () => {
    expect(checkVerifiedRun(wf(), [job({ runner_id: null })], want).reason).toMatch(/no runner_id/);
    expect(checkVerifiedRun(wf(), [job({ steps: [] })], want).reason).toMatch(/no steps/);
    const skipped = checkVerifiedRun(
      wf(),
      [job(), job({ id: 2, name: 'b', conclusion: 'skipped' })],
      want,
    );
    expect(skipped.state).toBe('failure');
    expect(skipped.reason).toMatch(/completed\/skipped/);
    expect(checkVerifiedRun(wf(), [], want).reason).toMatch(/no jobs/);
  });

  test('requiredJobs: every named job must be in the run (policy data, not code)', () => {
    const named = { ...want, requiredJobs: ['static', 'crq-python'] };
    const missing = checkVerifiedRun(wf(), [job(), job({ name: 'from-source' })], named);
    expect(missing.state).toBe('failure');
    expect(missing.reason).toMatch(/missing required job 'crq-python'/);
    expect(checkVerifiedRun(wf(), [job(), job({ name: 'crq-python' })], named).state).toBe(
      'success',
    );
    // Still pending before the jobs are read: presence is judged on real jobs only.
    expect(checkVerifiedRun(wf(), null, named).state).toBe('pending');
  });

  test('a partial rerun (filter=all): each job is judged by its newest attempt', () => {
    const named = { ...want, requiredJobs: ['static', 'from-source'] };
    const run2 = wf({ run_attempt: 2 });
    // static green in attempt 1 and not rerun; from-source failed, then passed on rerun.
    const rerun = [
      job({ name: 'static', run_attempt: 1 }),
      job({ id: 2, name: 'from-source', run_attempt: 1, conclusion: 'failure' }),
      job({ id: 3, name: 'from-source', run_attempt: 2 }),
    ];
    expect(checkVerifiedRun(run2, rerun, named).state).toBe('success');
    // A rerun's failure supersedes its earlier success.
    const regressed = [
      job({ name: 'static', run_attempt: 1 }),
      job({ id: 2, name: 'static', run_attempt: 2, conclusion: 'failure' }),
    ];
    expect(checkVerifiedRun(run2, regressed, want).reason).toMatch(
      /job 'static' is completed\/failure/,
    );
  });

  test('job attribution fails closed: no attempt, duplicates, colliding names', () => {
    // run_attempt is never inferred.
    const bare = { ...job(), run_attempt: undefined };
    expect(checkVerifiedRun(wf(), [bare], want).reason).toMatch(/job 'static' has no run_attempt/);
    expect(checkVerifiedRun(wf({ run_attempt: undefined }), [job()], want).reason).toMatch(
      /the run has no run_attempt/,
    );
    // Twins sharing a display name in one attempt are ambiguous, even when
    // only one of them is rerun later.
    const twins = [
      job({ id: 1, name: 'x', run_attempt: 1, conclusion: 'failure' }),
      job({ id: 2, name: 'x', run_attempt: 1 }),
      job({ id: 3, name: 'x', run_attempt: 2 }),
    ];
    expect(checkVerifiedRun(wf({ run_attempt: 2 }), twins, want).reason).toMatch(
      /two jobs named 'x' in attempt 1: ambiguous/,
    );
    // Names that only collide after sanitization (`clean` maps both to
    // 'lint?') are distinct jobs: 'linté' failed in attempt 1 and was never
    // rerun, so the green 'lintö' of attempt 2 must not stand for it.
    const lookalikes = [
      job({ id: 1, name: 'linté', run_attempt: 1, conclusion: 'failure' }),
      job({ id: 2, name: 'lintö', run_attempt: 2 }),
    ];
    const masked = checkVerifiedRun(wf({ run_attempt: 2 }), lookalikes, want);
    expect(masked.state).toBe('failure');
    expect(masked.reason).toMatch(/job 'lint\?' is completed\/failure/);
  });

  test('jobs are bound to the run snapshot: a newer or unlisted attempt is pending', () => {
    // A rerun started after the run was read: its rows are never evidence.
    const newer = [job({ run_attempt: 1 }), job({ id: 2, name: 'b', run_attempt: 2 })];
    const inFlight = checkVerifiedRun(wf(), newer, want);
    expect(inFlight.state).toBe('pending');
    expect(inFlight.reason).toMatch(/newer than the run read \(attempt 1\)/);
    // The run says attempt 2, but no attempt-2 job is listed yet.
    const unlisted = checkVerifiedRun(wf({ run_attempt: 2 }), [job()], want);
    expect(unlisted.state).toBe('pending');
    expect(unlisted.reason).toMatch(/no job of attempt 2 listed yet/);
  });
});

describe('selectPromotionReview', () => {
  test('a trusted success is selected with its bound base', () => {
    const r = selectPromotionReview([promoReview(MAIN)], REVIEWER);
    expect(r.state).toBe('success');
    expect(r.winner).toBe(900);
    expect(r.base).toBe(MAIN);
    expect(r.others).toBe(0);
  });

  test('wrong id, string-typed id, wrong login, and a User creator are untrusted (others)', () => {
    for (const creator of [
      { login: REVIEWER.login, id: REVIEWER.id + 1, type: 'Bot' },
      { login: REVIEWER.login, id: String(REVIEWER.id), type: 'Bot' },
      { login: 'other[bot]', id: REVIEWER.id, type: 'Bot' },
      { login: 'camerontaylor', id: 1, type: 'User' },
    ]) {
      const r = selectPromotionReview([promoReview(MAIN, { id: 901, creator })], REVIEWER);
      expect(r.state, JSON.stringify(creator)).toBe('missing');
      expect(r.others, JSON.stringify(creator)).toBe(1);
    }
  });

  test('a foreign context is filtered before the trust split and never counts', () => {
    const r = selectPromotionReview(
      [
        {
          context: 'other-context',
          state: 'success',
          creator: { login: 'x', id: 1, type: 'User' },
        },
      ],
      REVIEWER,
    );
    expect(r.state).toBe('missing');
    expect(r.others).toBe(0);
  });

  test('newest trusted wins: a later failure overrides an earlier success', () => {
    const r = selectPromotionReview(
      [
        promoReview(MAIN),
        promoReview(MAIN, {
          id: 901,
          state: 'failure',
          created_at: '2026-09-01T00:01:00Z',
          description: 'blocked: 2 major main=' + MAIN,
        }),
      ],
      REVIEWER,
    );
    expect(r.state).toBe('failure');
    expect(r.winner).toBe(901);
    expect(r.base).toBeNull();
  });

  test('a pending trusted review is pending; a success without a main= binding is a failure', () => {
    expect(
      selectPromotionReview(
        [promoReview(MAIN, { state: 'pending', description: 'reviewing' })],
        REVIEWER,
      ).state,
    ).toBe('pending');
    expect(
      selectPromotionReview([promoReview(MAIN, { description: 'reviewed crq#x' })], REVIEWER).state,
    ).toBe('failure');
  });

  test('empty input is missing with no others', () => {
    const r = selectPromotionReview([], REVIEWER);
    expect(r.state).toBe('missing');
    expect(r.others).toBe(0);
  });
});

describe('parseGateArgs / remoteUrlFor', () => {
  const base = [
    '--repo=/tmp/trust',
    '--repository=o/r',
    `--repositoryId=${String(REPO_ID)}`,
    `--trustRef=${TRUST}`,
    '--defaultBranch=main',
    `--reviewerBotLogin=${REVIEWER.login}`,
    `--reviewerBotId=${String(REVIEWER.id)}`,
  ];

  test('defaults and full form', () => {
    expect(parseGateArgs(base)).toMatchObject({
      owner: 'o',
      name: 'r',
      verdictAppId: null,
      verifiedWorkflows: ['ci.yml', 'denylist.yml'],
      reviewer: REVIEWER,
      timeoutMin: 20,
      push: false,
    });
    expect(
      parseGateArgs([
        ...base,
        '--verdictAppId=123',
        '--verifiedWorkflows=ci.yml',
        '--timeoutMin=5',
        '--push',
      ]),
    ).toMatchObject({
      verdictAppId: 123,
      verifiedWorkflows: ['ci.yml'],
      reviewer: REVIEWER,
      timeoutMin: 5,
      push: true,
    });
  });

  test('strict: unknown, repeated, missing, malformed', () => {
    expect(() => parseGateArgs([...base, '--force'])).toThrow(/unknown argument/);
    expect(() => parseGateArgs([...base, 'positional'])).toThrow(/unknown argument/);
    expect(() => parseGateArgs([...base, '--repo=/x'])).toThrow(/more than once/);
    expect(() => parseGateArgs(base.slice(1))).toThrow(/--repo is required/);
    expect(() => parseGateArgs([...base.slice(0, 3), '--trustRef=main', base[4] ?? ''])).toThrow(
      /40-hex/,
    );
    expect(() => parseGateArgs([...base, '--verdictAppId=0x1'])).toThrow(/positive integer/);
    expect(() => parseGateArgs([...base, '--verifiedWorkflows=../x.yml'])).toThrow(/workflow file/);
    expect(() => parseGateArgs([...base, '--push=yes'])).toThrow(/unknown argument/);
    // The reviewer pin is required and fails closed: missing, malformed, or
    // a banned (stranger's) identity refuses before any read.
    expect(() => parseGateArgs(base.slice(0, 5))).toThrow(/--reviewerBotLogin is required/);
    expect(() =>
      parseGateArgs(base.slice(0, 5).concat([`--reviewerBotLogin=${REVIEWER.login}`])),
    ).toThrow(/--reviewerBotId is required/);
    expect(() =>
      parseGateArgs([
        ...base.slice(0, 5),
        '--reviewerBotLogin=camerontaylor',
        `--reviewerBotId=${String(REVIEWER.id)}`,
      ]),
    ).toThrow(/pinnable bot login/);
    expect(() =>
      parseGateArgs([
        ...base.slice(0, 5),
        `--reviewerBotLogin=${BANNED_REVIEWER_LOGINS[0]}`,
        `--reviewerBotId=${String(REVIEWER.id)}`,
      ]),
    ).toThrow(/pinnable bot login/);
    expect(() =>
      parseGateArgs([
        ...base.slice(0, 5),
        `--reviewerBotLogin=${REVIEWER.login}`,
        `--reviewerBotId=${String(BANNED_REVIEWER_IDS[0])}`,
      ]),
    ).toThrow(/banned identity/);
  });

  test('remoteUrlFor', () => {
    expect(remoteUrlFor('https://github.com', 'o', 'r')).toBe('https://github.com/o/r.git');
    expect(() => remoteUrlFor('http://github.com', 'o', 'r')).toThrow(/bare https origin/);
    expect(() => remoteUrlFor('https://github.com/x', 'o', 'r')).toThrow(/bare https origin/);
  });
});

// -- runGate ----------------------------------------------------------------------

interface World {
  tip: string;
  main: string;
  prs: Map<string, unknown[]>;
  /** Promotion-review statuses per commit sha (the PR-C walk reads these). */
  statuses: Map<string, unknown[]>;
  checkRuns: unknown[][];
  measureRuns: unknown[];
  verifiedRuns: Map<string, unknown[]>;
  jobs: unknown[];
  /** cq-verify runs (the interim verifier-ran read). */
  verifyRuns: unknown[];
  dispatchCode: number;
  /** Called on each check-runs read (lets a test publish the verdict later). */
  onCheckRuns?: (n: number) => void;
  /** Called on each statuses read (the walk and the pre-push re-read). */
  onStatuses?: (n: number) => void;
  /** The cq/promoted replay marker's sha; undefined = ref absent. */
  promoted?: string | undefined;
  /** When set, the marker ref read fails with this stderr (fail-closed). */
  promotedError?: string;
  /** The cq-state ledger history, newest first; undefined = unrouted (unreadable). */
  settle?: { sha: string; ledger: unknown }[];
  /** The timeline label events per read (n = read index); default: one owner label. */
  timeline?: (n: number) => unknown[];
}

const ok = (value: unknown): GhResult => ({
  code: 0,
  stdout: JSON.stringify(value),
  stderr: '',
});

function fakeGh(world: World, calls: string[][]): GhFn {
  let checkReads = 0;
  let statusReads = 0;
  let timelineReads = 0;
  return (args) => {
    calls.push(args);
    const path = args[0] === 'api' && args[1] === '-X' ? (args[3] ?? '') : (args[1] ?? '');
    const q = path.split('?')[0] ?? '';
    if (args[2] === 'POST' && q.endsWith('/actions/workflows/cq-verify.yml/dispatches')) {
      return Promise.resolve({
        code: world.dispatchCode,
        stdout: '',
        stderr: 'boom',
      });
    }
    if (q === 'repos/o/r/git/ref/heads/merge-queue') {
      return Promise.resolve(ok({ object: { sha: world.tip, type: 'commit' } }));
    }
    if (q === 'repos/o/r/git/ref/heads/main') {
      return Promise.resolve(ok({ object: { sha: world.main, type: 'commit' } }));
    }
    if (q === 'repos/o/r/git/ref/heads/cq/promoted') {
      if (world.promotedError !== undefined)
        return Promise.resolve({ code: 1, stdout: '', stderr: world.promotedError });
      if (world.promoted === undefined)
        return Promise.resolve({ code: 1, stdout: '', stderr: 'HTTP 404: Not Found' });
      return Promise.resolve(ok({ object: { sha: world.promoted, type: 'commit' } }));
    }
    let m = /^repos\/o\/r\/commits\/([0-9a-f]{40})\/pulls$/.exec(q);
    if (m !== null) return Promise.resolve(ok([world.prs.get(m[1] ?? '') ?? []]));
    m = /^repos\/o\/r\/commits\/([0-9a-f]{40})\/statuses$/.exec(q);
    if (m !== null) {
      world.onStatuses?.(statusReads);
      statusReads += 1;
      return Promise.resolve(ok([world.statuses.get(m[1] ?? '') ?? []]));
    }
    if (q === 'repos/o/r') return Promise.resolve(ok({ owner: { id: 1 } }));
    if (world.settle !== undefined && q === 'repos/o/r/commits') {
      return Promise.resolve(ok(world.settle.map((v) => ({ sha: v.sha }))));
    }
    if (world.settle !== undefined && q === 'repos/o/r/contents/.cq/settle-state.json') {
      const ref = /[?&]ref=([0-9a-f]{40})/.exec(path)?.[1];
      const version = world.settle.find((v) => v.sha === ref);
      if (version === undefined) {
        return Promise.resolve({ code: 1, stdout: '', stderr: 'HTTP 404: Not Found' });
      }
      const content = Buffer.from(JSON.stringify(version.ledger)).toString('base64');
      return Promise.resolve(ok({ encoding: 'base64', content }));
    }
    if (world.timeline !== undefined && /^repos\/o\/r\/issues\/\d+\/timeline$/.test(q)) {
      const events = world.timeline(timelineReads);
      timelineReads += 1;
      return Promise.resolve(ok([events]));
    }
    if (/^repos\/o\/r\/issues\/\d+\/timeline$/.test(q)) {
      return Promise.resolve(
        ok([
          [
            { event: 'commented' },
            {
              event: 'labeled',
              label: { name: 'cq-override' },
              actor: { login: 'owner', id: 1, type: 'User' },
              created_at: '2026-09-01T00:00:00Z',
              performed_via_github_app: null,
            },
          ],
        ]),
      );
    }
    if (/^repos\/o\/r\/commits\/[0-9a-f]{40}\/check-runs$/.test(q)) {
      world.onCheckRuns?.(checkReads);
      checkReads += 1;
      return Promise.resolve(ok(world.checkRuns.map((rows) => ({ check_runs: rows }))));
    }
    m = /^repos\/o\/r\/actions\/workflows\/([^/]+)\/runs$/.exec(q);
    if (m !== null) {
      const file = m[1] ?? '';
      const runs =
        file === 'cq-measure.yml'
          ? world.measureRuns
          : file === 'cq-verify.yml'
            ? world.verifyRuns
            : (world.verifiedRuns.get(file) ?? []);
      return Promise.resolve(ok([{ workflow_runs: runs }]));
    }
    if (/^repos\/o\/r\/actions\/runs\/\d+\/jobs$/.test(q)) {
      return Promise.resolve(ok([{ jobs: world.jobs }]));
    }
    return Promise.resolve({ code: 1, stdout: '', stderr: `unrouted ${path}` });
  };
}

const greenRun = (file: string, tip: string): Record<string, unknown> => ({
  id: 100,
  run_attempt: 1,
  path: `.github/workflows/${file}`,
  event: 'push',
  head_branch: 'merge-queue',
  head_repository: { id: REPO_ID },
  head_sha: tip,
  status: 'completed',
  conclusion: 'success',
  created_at: '2026-09-01T00:00:00Z',
});

const greenJob = {
  id: 1,
  run_attempt: 1,
  name: 'j',
  status: 'completed',
  conclusion: 'success',
  runner_id: 3,
  steps: [{}],
};

const verdictRow = (tip: string, main: string, over: Record<string, unknown> = {}): unknown => ({
  id: 1,
  app: { id: 500, slug: 'cq-verdict' },
  head_sha: tip,
  external_id: `${main}:${tip}`,
  status: 'completed',
  conclusion: 'success',
  completed_at: '2026-09-01T00:00:00Z',
  ...over,
});

function world(tip = M1, main = MAIN, over: Partial<World> = {}): World {
  return {
    tip,
    main,
    prs: new Map([
      [
        tip,
        [
          {
            number: 7,
            merge_commit_sha: tip,
            base: { ref: 'merge-queue' },
            merged_at: '2026-09-01T00:00:00Z',
            head: { sha: H1, repo: { id: REPO_ID } },
          },
        ],
      ],
    ]),
    // The default world's tip carries a trusted success bound to main: the
    // normal "batch tip reviewed, ready to promote" shape.
    statuses: new Map([[tip, [promoReview(main)]]]),
    // The bootstrap invariant: the cq/promoted marker exists (== the main
    // at cutover). The gate refuses while it is missing — fail-closed — so
    // every fixture bootstraps it; tests exercise absence explicitly.
    promoted: main,
    checkRuns: [[verdictRow(tip, main)]],
    measureRuns: [],
    verifiedRuns: new Map([
      ['ci.yml', [greenRun('ci.yml', tip)]],
      ['denylist.yml', [greenRun('denylist.yml', tip)]],
    ]),
    jobs: [greenJob, { ...greenJob, name: 'crq-python' }],
    verifyRuns: [],
    dispatchCode: 0,
    ...over,
  };
}

/** Fake git over the ONE graph: main <- M1 (merge of H1). */
function fakeGit(over: Partial<GateGit> = {}): GateGit {
  return {
    revParse: (_repo, rev) => {
      if (rev === 'refs/remotes/origin/merge-queue') return Promise.resolve(M1);
      if (rev === 'refs/remotes/origin/main') return Promise.resolve(MAIN);
      return Promise.resolve(rev);
    },
    isAncestor: (_repo, a, b) => Promise.resolve(a === b || (a === MAIN && b === M1)),
    rangeCommits: () => Promise.resolve(ONE),
    firstParentRange: () => Promise.resolve([M1]),
    treeOf: () => Promise.resolve(sha('4')),
    mergeTreeClean: () => Promise.resolve(sha('4')),
    // No C3 attestation at the trust ref; the PR's contribution is empty.
    readBlob: () => Promise.resolve(null),
    changedPaths: () => Promise.resolve([]),
    pushAtomic: () => Promise.resolve({ ok: true, output: '' }),
    ...over,
  };
}

const passAcceptance = (input: AcceptanceInput): Promise<AcceptanceResult> =>
  Promise.resolve({
    verdict: 'pass',
    pr: input.pr,
    subject: input.subject,
    acceptedBy: ['user:owner'],
    report: ['pass: accepted by user:owner'],
  });

const policyOutcome = (
  verdict: PolicyDiffOutcome['verdict'],
  requiredJobs: PolicyDiffOutcome['requiredJobs'] = {},
  postureLayer: PolicyDiffOutcome['postureLayer'] = 'default',
): OpResult<PolicyDiffOutcome> => ({
  status: 'ok',
  value: {
    verdict,
    posture: postureLayer === 'window' ? 'diff-check' : 'human',
    postureLayer,
    requiredJobs,
    trustRef: TRUST,
    subject: M1,
    rangeBase: MAIN,
    findings: [],
    override: { status: 'absent', reasons: [] },
    report: [`verdict: ${verdict}`],
  },
});

interface Harness {
  deps: GateDeps;
  calls: string[][];
  policyInputs: PolicyDiffInput[];
  acceptanceInputs: AcceptanceInput[];
  sleeps: number[];
}

function harness(w: World, over: Partial<GateDeps> = {}): Harness {
  const calls: string[][] = [];
  const policyInputs: PolicyDiffInput[] = [];
  const acceptanceInputs: AcceptanceInput[] = [];
  const sleeps: number[] = [];
  let now = 0;
  const deps: GateDeps = {
    gh: fakeGh(w, calls),
    git: fakeGit(),
    acceptance: (input) => {
      acceptanceInputs.push(input);
      return passAcceptance(input);
    },
    policyDiff: (input) => {
      policyInputs.push(input);
      return Promise.resolve(policyOutcome('pass'));
    },
    sleep: (ms) => {
      sleeps.push(ms);
      now += ms;
      return Promise.resolve();
    },
    nowMs: () => now,
    ...over,
  };
  return { deps, calls, policyInputs, acceptanceInputs, sleeps };
}

const cfg = (over: Partial<GateConfig> = {}): GateConfig => ({
  repo: '/tmp/trust',
  owner: 'o',
  name: 'r',
  repositoryId: REPO_ID,
  trustRef: TRUST,
  defaultBranch: 'main',
  verdictAppId: 500,
  verifiedWorkflows: ['ci.yml', 'denylist.yml'],
  reviewer: REVIEWER,
  timeoutMin: 20,
  push: false,
  pushToken: null,
  remoteUrl: 'https://github.com/o/r.git',
  ...over,
});

const dispatches = (calls: string[][]): string[][] => calls.filter((c) => c[2] === 'POST');

describe('runGate', () => {
  test('dry run: every check passes → would-promote, nothing pushed', async () => {
    const h = harness(world());
    let pushed = false;
    h.deps.git = fakeGit({
      pushAtomic: () => {
        pushed = true;
        return Promise.resolve({ ok: true, output: '' });
      },
    });
    const r = await runGate(h.deps, cfg());
    expect(r.verdict).toBe('would-promote');
    expect(r).toMatchObject({ tip: M1, main: MAIN });
    expect(pushed).toBe(false);
    // Judged twice: before the waits and again just before the (dry-run) push.
    expect(h.acceptanceInputs).toEqual([
      { pr: 7, subject: H1, base: 'merge-queue', state: 'merged' },
      { pr: 7, subject: H1, base: 'merge-queue', state: 'merged' },
    ]);
    expect(h.policyInputs).toHaveLength(1);
    expect(h.policyInputs[0]).toMatchObject({
      repo: '/tmp/trust',
      trustRef: TRUST,
      subject: M1,
      subjectKind: 'push',
      base: 'refs/remotes/origin/main',
      authorization: { attested: false },
    });
    expect(h.policyInputs[0]?.authorization?.contributions).toMatchObject([
      { pr: 7, merge: M1, head: H1 },
    ]);
    const text = r.report.join('\n');
    expect(text).toMatch(/admitted PR #7/);
    expect(text).toMatch(/override PR #7 \(merge c{40}, head b{40}\):/);
    // No settle ledger is routed, so the label is invalid (no durable head
    // observation), never honoured.
    expect(text).toMatch(/settle ledger unreadable/);
    expect(text).toMatch(/verdict: invalid/);
    expect(text).toMatch(/verified ci\.yml: success/);
    expect(text).toMatch(/push: dry run/);
    expect(dispatches(h.calls)).toEqual([]);
    // Verified runs are the queue's own push runs: branch-filtered.
    expect(h.calls.map((c) => c[1])).toContain(
      `repos/o/r/actions/workflows/ci.yml/runs?head_sha=${M1}&event=push&branch=merge-queue&per_page=100`,
    );
    // App mode never reads the interim verifier runs.
    expect(h.calls.some((c) => (c[1] ?? '').includes('cq-verify.yml/runs'))).toBe(false);
  });

  test('noop when tip == main or tip is an ancestor of main', async () => {
    const same = harness(world(MAIN, MAIN));
    same.deps.git = fakeGit({
      revParse: (_r, rev) => Promise.resolve(rev.startsWith('refs/') ? MAIN : rev),
    });
    expect((await runGate(same.deps, cfg())).verdict).toBe('noop');
    const behind = harness(world(MAIN, M1));
    behind.deps.git = fakeGit({
      revParse: (_r, rev) =>
        Promise.resolve(
          rev === 'refs/remotes/origin/main' ? M1 : rev.startsWith('refs/') ? MAIN : rev,
        ),
    });
    const r = await runGate(behind.deps, cfg({ trustRef: M1 }));
    expect(r.verdict).toBe('noop');
    expect(behind.policyInputs).toEqual([]);
  });

  test('a trailing trust ref with the tip contained in main is a noop, not a refusal', async () => {
    // The second carrier's run after a promotion: main moved to the tip, and
    // this run's trust checkout is the old main.
    for (const [tipSha, mainSha] of [
      [M1, M1],
      [MAIN, M1],
    ] as const) {
      const h = harness(world(tipSha, mainSha));
      h.deps.git = fakeGit({
        revParse: (_r, rev) =>
          Promise.resolve(
            rev === 'refs/remotes/origin/main'
              ? mainSha
              : rev === 'refs/remotes/origin/merge-queue'
                ? tipSha
                : rev,
          ),
        isAncestor: (_r, a, b) => Promise.resolve(a === b || (a === MAIN && b === M1)),
      });
      const r = await runGate(h.deps, cfg({ trustRef: X }));
      expect(r.verdict, `tip ${tipSha} main ${mainSha}`).toBe('noop');
      expect(r.report.join('\n')).not.toMatch(/trails main/);
      expect(h.acceptanceInputs).toEqual([]);
      expect(h.policyInputs).toEqual([]);
      expect(dispatches(h.calls)).toEqual([]);
    }
  });

  test('a trailing trust ref with the tip ahead refuses before any judging check', async () => {
    const h = harness(world());
    const r = await runGate(h.deps, cfg({ trustRef: X }));
    expect(r.verdict).toBe('refused');
    expect(r).toMatchObject({ tip: M1, main: MAIN });
    expect(r.report.at(-1)).toBe(
      `refused: trust ref ${X} trails main ${MAIN}: this run's code and definitions are not main's; the next sweep retries`,
    );
    expect(h.acceptanceInputs).toEqual([]);
    expect(h.policyInputs).toEqual([]);
    expect(dispatches(h.calls)).toEqual([]);
    // No closure read either: only the two ref reads happened.
    expect(h.calls.map((c) => c[1])).toEqual([
      'repos/o/r/git/ref/heads/merge-queue',
      'repos/o/r/git/ref/heads/main',
    ]);
  });

  test('diverged refuses', async () => {
    const h = harness(world());
    h.deps.git = fakeGit({ isAncestor: () => Promise.resolve(false) });
    const r = await runGate(h.deps, cfg());
    expect(r.verdict).toBe('refused');
    expect(r.report.at(-1)).toMatch(/diverged/);
  });

  test('tip moved since fetch refuses', async () => {
    const h = harness(world());
    h.deps.git = fakeGit({
      revParse: (_r, rev) =>
        Promise.resolve(
          rev === 'refs/remotes/origin/merge-queue'
            ? X
            : rev === 'refs/remotes/origin/main'
              ? MAIN
              : rev,
        ),
    });
    const r = await runGate(h.deps, cfg());
    expect(r.verdict).toBe('refused');
    expect(r.report.at(-1)).toMatch(/tip moved since fetch; next sweep retries/);
  });

  test('closure violation refuses before acceptance', async () => {
    const h = harness(world(M1, MAIN, { prs: new Map() }));
    const r = await runGate(h.deps, cfg());
    expect(r.verdict).toBe('refused');
    expect(r.report.join('\n')).toMatch(/violation: .*no PR recorded/);
    expect(h.acceptanceInputs).toEqual([]);
  });

  test('an evil merge refuses', async () => {
    const h = harness(world());
    h.deps.git = fakeGit({ treeOf: () => Promise.resolve(sha('5')) });
    const r = await runGate(h.deps, cfg());
    expect(r.verdict).toBe('refused');
    expect(r.report.at(-1)).toMatch(/evil or conflict-resolving merge/);
  });

  test('acceptance fail refuses', async () => {
    const h = harness(world(), {
      acceptance: (input) =>
        Promise.resolve({
          verdict: 'fail',
          pr: input.pr,
          subject: input.subject,
          acceptedBy: [],
          report: ['fail (acceptance): no trusted acceptance'],
        }),
    });
    const r = await runGate(h.deps, cfg());
    expect(r.verdict).toBe('refused');
    expect(r.report.at(-1)).toMatch(/acceptance: PR\(s\) #7 lack I2 acceptance evidence/);
    expect(h.policyInputs).toEqual([]);
  });

  test('acceptance re-judged after the waits: a change during the wait refuses, no push', async () => {
    // With --push and as a dry run: neither promotes nor says would-promote.
    for (const push of [true, false]) {
      let calls = 0;
      let pushed = false;
      const h = harness(world(), {
        acceptance: (input) => {
          calls += 1;
          if (calls === 1) return passAcceptance(input);
          return Promise.resolve({
            verdict: 'fail',
            pr: input.pr,
            subject: input.subject,
            acceptedBy: [],
            report: ['fail (objection): outstanding trusted objection'],
          });
        },
      });
      h.deps.git = fakeGit({
        pushAtomic: () => {
          pushed = true;
          return Promise.resolve({ ok: true, output: '' });
        },
      });
      const r = await runGate(h.deps, cfg({ push, pushToken: push ? 'tok' : null }));
      expect(r.verdict, `push ${String(push)}`).toBe('refused');
      expect(calls).toBe(2);
      expect(pushed).toBe(false);
      expect(r.report.at(-1)).toBe(
        'refused: acceptance: PR #7: acceptance changed during the wait',
      );
      const text = r.report.join('\n');
      expect(text).toMatch(/verdict cq\/ratchet: success/);
      expect(text).toMatch(/acceptance pass 1 PR #7 .*: pass/);
      expect(text).toMatch(/acceptance pass 2 PR #7 .*: fail/);
      expect(text).toMatch(/outstanding trusted objection/);
      expect(text).not.toMatch(/push: /);
    }
  });

  test('acceptance passing both times promotes; judged once before the verdict reads, once after', async () => {
    const order: string[] = [];
    let pushed = false;
    const h = harness(world());
    const gh = h.deps.gh;
    h.deps.gh = (args) => {
      if ((args[1] ?? '').includes('/check-runs?')) order.push('verdict-read');
      return gh(args);
    };
    h.deps.acceptance = (input) => {
      order.push(`acceptance #${String(input.pr)}`);
      h.acceptanceInputs.push(input);
      return passAcceptance(input);
    };
    h.deps.git = fakeGit({
      pushAtomic: () => {
        order.push('push');
        pushed = true;
        return Promise.resolve({ ok: true, output: '' });
      },
    });
    const r = await runGate(h.deps, cfg({ push: true, pushToken: 'tok' }));
    expect(r.verdict).toBe('promoted');
    expect(pushed).toBe(true);
    expect(h.acceptanceInputs).toHaveLength(2);
    const first = order.indexOf('verdict-read');
    expect(first).toBeGreaterThan(0);
    expect(order.slice(0, first)).toEqual(['acceptance #7']);
    // Pass 2 follows the waited verdict reads; one no-wait recheck read
    // follows pass 2; the push comes last.
    const pass2 = order.lastIndexOf('acceptance #7');
    expect(order.slice(first, pass2).every((e) => e === 'verdict-read')).toBe(true);
    expect(order.slice(pass2 + 1)).toEqual(['verdict-read', 'push']);
    const text = r.report.join('\n');
    expect(text).toMatch(/acceptance pass 1 PR #7 .*: pass/);
    expect(text).toMatch(/acceptance pass 2 PR #7 .*: pass/);
  });

  test('a verdict that turns red after acceptance pass 2 refuses at the recheck, no push', async () => {
    let reads = 0;
    let pushed = false;
    const h = harness(world());
    const gh = h.deps.gh;
    h.deps.gh = async (args) => {
      const res = await gh(args);
      if (!(args[1] ?? '').includes('/check-runs?')) return res;
      reads += 1;
      if (reads === 1) return res;
      // The recheck read: the same row, now concluded failure.
      return {
        ...res,
        stdout: res.stdout.replaceAll('"success"', '"failure"'),
      };
    };
    h.deps.git = fakeGit({
      pushAtomic: () => {
        pushed = true;
        return Promise.resolve({ ok: true, output: '' });
      },
    });
    const r = await runGate(h.deps, cfg({ push: true, pushToken: 'tok' }));
    expect(r.verdict).toBe('refused');
    expect(pushed).toBe(false);
    expect(reads).toBe(2);
    expect(r.report.join('\n')).toMatch(/recheck before push:/);
    expect(r.report.at(-1)).toMatch(
      /newest valid cq\/ratchet verdict on the subject is not success|no longer green after the acceptance pass/,
    );
  });

  test('policy needs-human refuses (break-glass), with the override still echoed', async () => {
    const h = harness(world(), {
      policyDiff: () => Promise.resolve(policyOutcome('needs-human')),
    });
    const r = await runGate(h.deps, cfg());
    expect(r.verdict).toBe('refused');
    expect(r.report.at(-1)).toMatch(
      /policy: needs-human .* owner break-glass \(ADR-0004 D-G\.4, D-H\.4\)/,
    );
    expect(r.report.join('\n')).toMatch(/override PR #7 \(merge /);
    const failed = harness(world(), {
      policyDiff: () => Promise.resolve({ status: 'failed', error: 'git fault' }),
    });
    expect((await runGate(failed.deps, cfg())).report.at(-1)).toMatch(/could not judge/);
  });

  test('requiredJobs from the trust policy list: a missing job refuses, a present one promotes', async () => {
    const missing = harness(world(), {
      policyDiff: () => Promise.resolve(policyOutcome('pass', { 'ci.yml': ['macos-pilot'] })),
    });
    const refused = await runGate(missing.deps, cfg());
    expect(refused.verdict).toBe('refused');
    expect(refused.report.join('\n')).toMatch(
      /verified ci\.yml: failure .*missing required job 'macos-pilot'/,
    );
    const present = harness(world(), {
      policyDiff: () => Promise.resolve(policyOutcome('pass', { 'ci.yml': ['j'] })),
    });
    expect((await runGate(present.deps, cfg())).verdict).toBe('would-promote');
  });

  test('a pass that relied on the revision window is re-judged at push time', async () => {
    // First judgement inside the window; the second (after the waits) finds it expired.
    const answers = [policyOutcome('pass', {}, 'window'), policyOutcome('needs-human')];
    const expired = harness(world(), {
      policyDiff: () => Promise.resolve(answers.shift() ?? policyOutcome('needs-human')),
    });
    const r = await runGate(expired.deps, cfg());
    expect(r.verdict).toBe('refused');
    expect(r.report).toContain('policy recheck (revision-window): needs-human');
    expect(r.report.at(-1)).toMatch(/revision-window pass no longer holds at push time/);

    const calls: PolicyDiffInput[] = [];
    const still = harness(world(), {
      policyDiff: (input) => {
        calls.push(input);
        return Promise.resolve(policyOutcome('pass', {}, 'window'));
      },
    });
    expect((await runGate(still.deps, cfg())).verdict).toBe('would-promote');
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
    // With --push the recheck is the last read: after the promotion-review
    // re-fetch, before the push. A window expiring during that fetch refuses.
    for (const expires of [false, true]) {
      const order: string[] = [];
      const h = harness(world(), {
        policyDiff: () => {
          order.push('policy');
          const second = order.filter((o) => o === 'policy').length > 1;
          return Promise.resolve(
            second && expires ? policyOutcome('needs-human') : policyOutcome('pass', {}, 'window'),
          );
        },
      });
      const gh = h.deps.gh;
      h.deps.gh = (args) => {
        if (/\/statuses\?/.test(args[1] ?? '')) order.push('statuses');
        return gh(args);
      };
      h.deps.git = fakeGit({
        pushAtomic: () => {
          order.push('push');
          return Promise.resolve({ ok: true, output: '' });
        },
      });
      const r = await runGate(h.deps, cfg({ push: true, pushToken: 'tok' }));
      const tail = order.slice(order.lastIndexOf('statuses'));
      expect(tail).toEqual(expires ? ['statuses', 'policy'] : ['statuses', 'policy', 'push']);
      expect(r.verdict).toBe(expires ? 'refused' : 'promoted');
    }
    // A pass that did not rely on the window is not re-judged.
    const plain = harness(world());
    await runGate(plain.deps, cfg());
    expect(plain.policyInputs).toHaveLength(1);
  });

  test('requiredJobs naming a workflow the gate does not verify refuses (never checkable)', async () => {
    const h = harness(world(), {
      policyDiff: () => Promise.resolve(policyOutcome('pass', { 'other.yml': ['x'] })),
    });
    const r = await runGate(h.deps, cfg());
    expect(r.verdict).toBe('refused');
    expect(r.report.at(-1)).toMatch(/requiredJobs names unverified workflow\(s\) other\.yml/);
  });

  test('a failure verdict refuses immediately (no wait)', async () => {
    const h = harness(
      world(M1, MAIN, {
        checkRuns: [[verdictRow(M1, MAIN, { conclusion: 'failure' })]],
      }),
    );
    const r = await runGate(h.deps, cfg());
    expect(r.verdict).toBe('refused');
    expect(r.report.at(-1)).toMatch(
      /newest valid cq\/ratchet verdict on the subject is not success/,
    );
    expect(h.sleeps).toEqual([]);
  });

  test('waits, dispatches cq-verify once on the default ref, then proceeds', async () => {
    const w = world(M1, MAIN, {
      checkRuns: [[verdictRow(M1, sha('1'))]],
      measureRuns: [
        { ...greenRun('cq-measure.yml', M1), id: 555 },
        {
          ...greenRun('cq-measure.yml', M1),
          id: 556,
          path: '.github/workflows/evil.yml',
        },
      ],
    });
    w.onCheckRuns = (n) => {
      if (n === 3) w.checkRuns = [[verdictRow(M1, MAIN)]];
    };
    const h = harness(w);
    const r = await runGate(h.deps, cfg());
    expect(r.verdict).toBe('would-promote');
    expect(h.sleeps).toEqual([POLL_MS, POLL_MS, POLL_MS]);
    expect(dispatches(h.calls)).toEqual([
      [
        'api',
        '-X',
        'POST',
        'repos/o/r/actions/workflows/cq-verify.yml/dispatches',
        '-f',
        'ref=main',
        '-f',
        'inputs[measure_run_id]=555',
      ],
    ]);
    expect(r.report.join('\n')).toMatch(/waited: 4 poll\(s\)/);
  });

  test('no completed measure run yet: the dispatch is retried until one exists', async () => {
    const w = world(M1, MAIN, { checkRuns: [] });
    w.onCheckRuns = (n) => {
      if (n === 1) w.measureRuns = [{ ...greenRun('cq-measure.yml', M1), id: 9 }];
      if (n === 2) w.checkRuns = [[verdictRow(M1, MAIN)]];
    };
    const h = harness(w);
    const r = await runGate(h.deps, cfg());
    expect(r.verdict).toBe('would-promote');
    expect(dispatches(h.calls)).toHaveLength(1);
    expect(r.report.join('\n')).toMatch(/waiting \(no completed cq-measure push run on subject\)/);
  });

  test('timeout refuses', async () => {
    const w = world(M1, MAIN, {
      checkRuns: [[verdictRow(M1, MAIN, { status: 'in_progress' })]],
    });
    const h = harness(w);
    const r = await runGate(h.deps, cfg({ timeoutMin: 2 }));
    expect(r.verdict).toBe('refused');
    expect(r.report.at(-1)).toMatch(/timeout: verdicts not green within 2 minute/);
    expect(h.sleeps).toHaveLength(4);
    expect(dispatches(h.calls)).toEqual([]);
  });

  test('a red verified run refuses; an in-progress one waits', async () => {
    const red = world();
    red.verifiedRuns.set('ci.yml', [{ ...greenRun('ci.yml', M1), conclusion: 'failure' }]);
    const r = await runGate(harness(red).deps, cfg());
    expect(r.verdict).toBe('refused');
    expect(r.report.at(-1)).toMatch(/verified run ci\.yml: not green/);

    const slow = world();
    slow.verifiedRuns.set('denylist.yml', [
      { ...greenRun('denylist.yml', M1), status: 'in_progress' },
    ]);
    slow.onCheckRuns = (n) => {
      if (n === 1) slow.verifiedRuns.set('denylist.yml', [greenRun('denylist.yml', M1)]);
    };
    const h = harness(slow);
    expect((await runGate(h.deps, cfg())).verdict).toBe('would-promote');
    expect(h.sleeps).toEqual([POLL_MS]);
  });

  test('interim mode: a completed default-branch verifier run at main admits the row', async () => {
    const verifyRun = {
      id: 31,
      path: '.github/workflows/cq-verify.yml',
      event: 'workflow_run',
      head_branch: 'main',
      head_sha: MAIN,
      head_repository: { id: REPO_ID },
      status: 'completed',
      created_at: '2026-09-01T00:00:00Z',
    };
    const w = world(M1, MAIN, {
      checkRuns: [[verdictRow(M1, MAIN, { app: { id: 15368, slug: 'github-actions' } })]],
      verifyRuns: [verifyRun],
    });
    const h = harness(w);
    const r = await runGate(h.deps, cfg({ verdictAppId: null }));
    expect(r.verdict).toBe('would-promote');
    const text = r.report.join('\n');
    expect(text).toMatch(/interim verdict selection/);
    expect(text).toMatch(new RegExp(`interim: cq-verify\\.yml run 31 completed at ${MAIN}`));
    expect(h.calls.map((c) => c[1])).toContain(
      `repos/o/r/actions/workflows/cq-verify.yml/runs?head_sha=${MAIN}&branch=main&per_page=100`,
    );
    expect(h.calls.some((c) => (c[1] ?? '').includes('check_suite_id'))).toBe(false);
  });

  test('interim mode: no verifier run yet → missing, one dispatch, then admitted', async () => {
    const w = world(M1, MAIN, {
      checkRuns: [[verdictRow(M1, MAIN, { app: { id: 15368, slug: 'github-actions' } })]],
      measureRuns: [{ ...greenRun('cq-measure.yml', M1), id: 555 }],
    });
    w.onCheckRuns = (n) => {
      if (n === 1) {
        w.verifyRuns = [
          {
            id: 32,
            path: '.github/workflows/cq-verify.yml',
            event: 'workflow_dispatch',
            head_branch: 'main',
            head_sha: MAIN,
            head_repository: { id: REPO_ID },
            status: 'completed',
          },
        ];
      }
    };
    const h = harness(w);
    const r = await runGate(h.deps, cfg({ verdictAppId: null }));
    expect(r.verdict).toBe('would-promote');
    expect(dispatches(h.calls)).toHaveLength(1);
    expect(h.sleeps).toEqual([POLL_MS]);
  });

  test('the push always leases all three refs: main, the replay marker, and the queue', async () => {
    const h = harness(world());
    const seen: unknown[] = [];
    h.deps.git = fakeGit({
      pushAtomic: (_repo, _url, updates, token) => {
        seen.push({ updates, token });
        return Promise.resolve({ ok: true, output: '' });
      },
    });
    const r = await runGate(h.deps, cfg({ push: true, pushToken: 't' }));
    expect(r.verdict).toBe('promoted');
    // luna round 4: the queue ref is leased at the run-start tip EVEN when
    // it equals the tip (an up-to-date ref passes; any movement rejects the
    // whole push), and the cq/promoted marker MUST move with the promotion
    // (leased at its own read: the bootstrap marker is main).
    expect(seen).toEqual([
      {
        updates: [
          { refspec: `${M1}:refs/heads/main`, expected: MAIN },
          { refspec: `${M1}:refs/heads/cq/promoted`, expected: MAIN },
          { refspec: `${M1}:refs/heads/merge-queue`, expected: M1 },
        ],
        token: 't',
      },
    ]);
    expect(r.report.join('\n')).toMatch(
      new RegExp(`push: main at ${M1} \\(reviewed sha, base ${MAIN}\\)`),
    );
  });

  test('a replay marker naming the subject blocks selection (stateful refusal)', async () => {
    // Break-glass rewind to exactly the review base: base === main holds,
    // the success is still newest-trusted — but the cq/promoted marker at
    // the subject refuses the replay statelessly-unreachable case.
    const h = harness(world(M1, MAIN, { promoted: M1 }));
    const r = await runGate(h.deps, cfg());
    expect(r.verdict).toBe('awaiting');
    expect(r.subject).toBeNull();
    expect(r.report.join('\n')).toMatch(new RegExp(`already promoted \\(cq/promoted at ${M1}\\)`));
    expect(h.acceptanceInputs).toEqual([]);
  });

  test('a missing replay marker refuses (bootstrap required; deletion never re-enables replay)', async () => {
    const h = harness(world(M1, MAIN, { promoted: undefined }));
    const r = await runGate(h.deps, cfg());
    expect(r.verdict).toBe('refused');
    expect(r.report.at(-1)).toMatch(/replay marker is absent/);
    expect(h.acceptanceInputs).toEqual([]);
  });

  test('an unreadable replay marker fails closed', async () => {
    const h = harness(world(M1, MAIN, { promotedError: 'HTTP 500: kaboom' }));
    const r = await runGate(h.deps, cfg());
    expect(r.verdict).toBe('refused');
    expect(r.report.at(-1)).toMatch(/gate error: gh exit 1: HTTP 500/);
  });

  test('a tip ahead of the reviewed sha promotes the SUBJECT and leaves the queue alone', async () => {
    // main <- M1 (reviewed) <- T2 (not yet reviewed): the walk selects M1,
    // closure and every check judge main..M1, and the push sends M1:main.
    // The unreviewed T2 is never promoted and merge-queue is never written.
    const t2 = sha('2');
    const h = harness(
      world(t2, MAIN, {
        prs: new Map([
          [
            M1,
            [
              {
                number: 7,
                merge_commit_sha: M1,
                base: { ref: 'merge-queue' },
                merged_at: '2026-09-01T00:00:00Z',
                head: { sha: H1, repo: { id: REPO_ID } },
              },
            ],
          ],
        ]),
        statuses: new Map([
          [t2, [promoReview(MAIN, { state: 'pending', id: 901, description: 'reviewing' })]],
          [M1, [promoReview(MAIN)]],
        ]),
        checkRuns: [[verdictRow(M1, MAIN)]],
        verifiedRuns: new Map([
          ['ci.yml', [greenRun('ci.yml', M1)]],
          ['denylist.yml', [greenRun('denylist.yml', M1)]],
        ]),
      }),
    );
    h.deps.git = fakeGit({
      revParse: (_r, rev) =>
        Promise.resolve(
          rev === 'refs/remotes/origin/merge-queue' ? t2 : rev.startsWith('refs/') ? MAIN : rev,
        ),
      // The fake graph is main <- M1 <- t2: the queue advanced one batch past
      // the reviewed sha. Without this edge the gate's diverged-refusal check
      // (isAncestor(main, tip)) would refuse the very scenario under test.
      isAncestor: (_r, a, b) => Promise.resolve(a === b || (a === MAIN && (b === M1 || b === t2))),
      firstParentRange: (_r, _from, to) => Promise.resolve(to === t2 ? [t2, M1] : [M1]),
      rangeCommits: (_r, _from, to) => Promise.resolve(to === M1 ? ONE : []),
    });
    const seen: unknown[] = [];
    const innerPush = h.deps.git.pushAtomic;
    h.deps.git = {
      ...h.deps.git,
      pushAtomic: (repo, url, updates, token) => {
        seen.push(updates);
        return innerPush(repo, url, updates, token);
      },
    };
    const r = await runGate(h.deps, cfg({ push: true, pushToken: 't' }));
    expect(r.verdict).toBe('promoted');
    expect(r.subject).toBe(M1);
    expect(r.tip).toBe(t2);
    // The queue refspec is ALWAYS leased at the run-start tip (luna round
    // 4 — even off-tip it can never land; --atomic would refuse main with
    // it), and the cq/promoted marker moves with the promotion (leased at
    // its read: the bootstrap marker is main).
    expect(seen).toEqual([
      [
        { refspec: `${M1}:refs/heads/main`, expected: MAIN },
        { refspec: `${M1}:refs/heads/cq/promoted`, expected: MAIN },
        { refspec: `${t2}:refs/heads/merge-queue`, expected: t2 },
      ],
    ]);
    const text = r.report.join('\n');
    expect(text).toMatch(new RegExp(`subject: reviewed sha ${M1} .* queue tip ${t2} waits`));
    expect(h.acceptanceInputs).toEqual([
      { pr: 7, subject: H1, base: 'merge-queue', state: 'merged' },
      { pr: 7, subject: H1, base: 'merge-queue', state: 'merged' },
    ]);
  });

  test('a success bound to an older base is not selectable (rewind replay refused)', async () => {
    // Break-glass rewind: main sits at MAIN while the reviewed M1 (whose
    // success binds base=M1, the rewind target) is still on the queue. The
    // exact-base binding refuses to replay the older review; nothing is
    // judged and nothing promotes.
    const h = harness(
      world(M1, MAIN, {
        statuses: new Map([[M1, [promoReview(M1)]]]),
      }),
    );
    const r = await runGate(h.deps, cfg());
    expect(r.verdict).toBe('awaiting');
    expect(r.subject).toBeNull();
    expect(r.report.join('\n')).toMatch(
      new RegExp(`success base ${M1} is not the current main ${MAIN}`),
    );
    expect(h.acceptanceInputs).toEqual([]);
    expect(h.policyInputs).toEqual([]);
  });

  test('the selected promotion review is re-read before the push; a stale one refuses', async () => {
    for (const [name, later] of [
      [
        'a newer trusted failure',
        { state: 'failure', description: `blocked: 2 major main=${MAIN}` },
      ],
      ['a malformed success', { description: 'reviewed crq#x' }],
    ] as const) {
      let pushed = false;
      const w = world();
      w.onStatuses = (n) => {
        if (n === 1) w.statuses = new Map([[M1, [promoReview(MAIN, { id: 901, ...later })]]]);
      };
      const h = harness(w);
      h.deps.git = fakeGit({
        pushAtomic: () => {
          pushed = true;
          return Promise.resolve({ ok: true, output: '' });
        },
      });
      const r = await runGate(h.deps, cfg({ push: true, pushToken: 't' }));
      expect(r.verdict, name).toBe('refused');
      expect(pushed, name).toBe(false);
      expect(r.report.at(-1), name).toMatch(/changed since selection/);
    }
  });

  test('an unchanged promotion review passes the pre-push re-read and promotes', async () => {
    let pushed = false;
    const h = harness(world());
    h.deps.git = fakeGit({
      pushAtomic: () => {
        pushed = true;
        return Promise.resolve({ ok: true, output: '' });
      },
    });
    const r = await runGate(h.deps, cfg({ push: true, pushToken: 't' }));
    expect(r.verdict).toBe('promoted');
    expect(pushed).toBe(true);
  });

  test('no reviewed commit on the queue is an awaiting (green), with no judging reads', async () => {
    const h = harness(world(M1, MAIN, { statuses: new Map([[M1, []]]) }));
    const r = await runGate(h.deps, cfg());
    expect(r.verdict).toBe('awaiting');
    expect(r.subject).toBeNull();
    expect(h.acceptanceInputs).toEqual([]);
    expect(h.policyInputs).toEqual([]);
    expect(dispatches(h.calls)).toEqual([]);
  });

  test('untrusted promotion-review statuses on the tip with no trusted review refuse', async () => {
    const h = harness(
      world(M1, MAIN, {
        statuses: new Map([
          [
            M1,
            [
              promoReview(MAIN, {
                id: 902,
                creator: { login: 'camerontaylor', id: 1, type: 'User' },
                state: 'success',
              }),
            ],
          ],
        ]),
      }),
    );
    const r = await runGate(h.deps, cfg());
    expect(r.verdict).toBe('refused');
    expect(r.report.at(-1)).toMatch(
      /crq\/promotion-review status\(es\) from creators other than the pinned reviewer/,
    );
  });

  test('a rejected push refuses with the porcelain output', async () => {
    const h = harness(world());
    h.deps.git = fakeGit({
      pushAtomic: () =>
        Promise.resolve({
          ok: false,
          output: '!\trefs/heads/main\t[rejected] (atomic push failed)',
        }),
    });
    const r = await runGate(h.deps, cfg({ push: true, pushToken: 't' }));
    expect(r.verdict).toBe('refused');
    expect(r.report.join('\n')).toMatch(/push: .*atomic push failed/);
  });

  test('an unexpected fault is a refusal, never a throw', async () => {
    const h = harness(world());
    h.deps.gh = () => Promise.resolve({ code: 1, stdout: '', stderr: 'HTTP 502' });
    const r = await runGate(h.deps, cfg());
    expect(r.verdict).toBe('refused');
    expect(r.report.at(-1)).toMatch(/gate error: gh exit 1: HTTP 502/);
  });
});

// -- runGate: decisive D11 authorization (ADR-0004 D-C.3, D-G.4) ----------------

const C3_OK = JSON.stringify({
  schemaVersion: 1,
  attests: 'C3',
  attestedAt: '2026-09-01T00:00:00Z',
});
const EPOCH = '2026-09-01T00:00:00.000Z';
const CHANGED = 'vitest.config.ts';

/** A ledger version; `prs` maps a PR number to the head its record observed. */
const ledger = (prs: Record<string, string>): unknown => ({
  version: 1,
  repo: 'o/r',
  prs: Object.fromEntries(
    Object.entries(prs).map(([pr, head]) => [
      pr,
      {
        tuple: { head, base: MAIN, forcePushEpoch: 0 },
        observations: [{ observedAt: EPOCH, by: 'self-merge-prs:observe' }],
      },
    ]),
  ),
});

/** The settle history after the merge: the tip has pruned PR #7; an older version holds it. */
const PRUNED_HISTORY = [
  { sha: sha('1'), ledger: ledger({}) },
  { sha: sha('2'), ledger: ledger({ '7': H1 }) },
];

const ownerLabel = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  event: 'labeled',
  label: { name: 'cq-override' },
  actor: { login: 'owner', id: 1, type: 'User' },
  created_at: '2026-09-02T00:00:00Z',
  performed_via_github_app: null,
  ...over,
});

/**
 * A policy fake over the real D11 predicate: the range needs a human for
 * `paths`, and passes only when the bound authorization authorizes them all.
 */
function d11Policy(
  inputs: PolicyDiffInput[],
  paths: readonly string[] = [CHANGED],
): GateDeps['policyDiff'] {
  return (input) => {
    inputs.push(input);
    const auth = input.authorization;
    if (auth === undefined) return Promise.resolve(policyOutcome('needs-human'));
    const d11 = authorizePaths(auth, paths);
    const base = policyOutcome(d11.authorized ? 'pass' : 'needs-human');
    if (base.status !== 'ok') return Promise.resolve(base);
    return Promise.resolve({
      status: 'ok',
      value: { ...base.value, d11, report: d11.lines },
    });
  };
}

function d11Harness(
  over: Partial<World>,
  attestation: string | null = C3_OK,
  contribution: readonly string[] = [CHANGED],
): { h: Harness; inputs: PolicyDiffInput[] } {
  const inputs: PolicyDiffInput[] = [];
  const h = harness(world(M1, MAIN, { settle: PRUNED_HISTORY, ...over }), {
    policyDiff: d11Policy(inputs),
  });
  h.deps.git = fakeGit({
    readBlob: (_repo, rev, path) =>
      Promise.resolve(rev === TRUST && path === 'policy/attestations/c3.json' ? attestation : null),
    changedPaths: (_repo, from, to) =>
      Promise.resolve(from === MAIN && to === M1 ? [...contribution] : []),
  });
  return { h, inputs };
}

describe('runGate — decisive D11 authorization', () => {
  test('valid record + C3 attested at the trust ref → the definition change promotes', async () => {
    const { h, inputs } = d11Harness({ timeline: () => [ownerLabel()] });
    const r = await runGate(h.deps, cfg());
    expect(r.verdict).toBe('would-promote');
    const text = r.report.join('\n');
    // The epoch came from the older ledger version (the tip pruned PR #7).
    expect(text).toMatch(/settle ledger — 2 version\(s\) read/);
    expect(text).toMatch(/attestation: .* valid at the trust ref — records honoured/);
    expect(text).toMatch(/verdict: honoured/);
    expect(text).toMatch(/d11: vitest\.config\.ts authorized by PR #7/);
    // It relied on the record, so the record is re-read after the waits and
    // once more as the last read before the push (or the dry-run verdict).
    expect(inputs).toHaveLength(3);
    expect(text).toMatch(/d11 pass 2:/);
    expect(text).toMatch(/d11 recheck \(D11\):/);
  });

  test('valid record, no attestation → needs-human refusal with dormant logged', async () => {
    const { h } = d11Harness({ timeline: () => [ownerLabel()] }, null);
    const r = await runGate(h.deps, cfg());
    expect(r.verdict).toBe('refused');
    const text = r.report.join('\n');
    expect(text).toMatch(/verdict: dormant/);
    expect(text).toMatch(/dormant: ADR-0004 D-G\.4 records are honoured only once/);
    expect(text).toMatch(/d11: vitest\.config\.ts unauthorized — PR #7 .* record is dormant/);
    expect(r.report.at(-1)).toMatch(/dormant until the C3 attestation, .* owner break-glass/);
  });

  test('a malformed attestation at the trust ref is dormant, never armed', async () => {
    const malformed = JSON.stringify({ schemaVersion: 1, attests: 'C3' });
    const { h } = d11Harness({ timeline: () => [ownerLabel()] }, malformed);
    const r = await runGate(h.deps, cfg());
    expect(r.verdict).toBe('refused');
    const text = r.report.join('\n');
    expect(text).toMatch(/present but invalid \(schema violation/);
    expect(text).toMatch(/verdict: dormant/);
  });

  test('an unreadable attestation is dormant', async () => {
    const { h } = d11Harness({ timeline: () => [ownerLabel()] });
    h.deps.git = { ...h.deps.git, readBlob: () => Promise.reject(new Error('git fault')) };
    const r = await runGate(h.deps, cfg());
    expect(r.verdict).toBe('refused');
    expect(r.report.join('\n')).toMatch(/unreadable at the trust ref \(git fault\)/);
  });

  test('#338 P1: a label applied before C3 attestedAt is invalid — C3 is never retroactive', async () => {
    const late = JSON.stringify({
      schemaVersion: 1,
      attests: 'C3',
      attestedAt: '2026-10-01T00:00:00Z',
    });
    const { h } = d11Harness({ timeline: () => [ownerLabel()] }, late);
    const r = await runGate(h.deps, cfg());
    expect(r.verdict).toBe('refused');
    const text = r.report.join('\n');
    expect(text).toMatch(/records honoured when applied after attestedAt 2026-10-01T00:00:00Z/);
    expect(text).toMatch(/verdict: invalid/);
    expect(text).toMatch(
      /label created_at 2026-09-02T00:00:00Z is not after the C3 attestation attestedAt 2026-10-01T00:00:00Z/,
    );
    expect(r.report.at(-1)).toMatch(/not every path needing a human is authorized/);
  });

  test('a label applied before the head-observation epoch is invalid', async () => {
    const { h } = d11Harness({
      timeline: () => [ownerLabel({ created_at: '2026-08-31T00:00:00Z' })],
    });
    const r = await runGate(h.deps, cfg());
    expect(r.verdict).toBe('refused');
    const text = r.report.join('\n');
    expect(text).toMatch(/verdict: invalid/);
    expect(text).toMatch(/is not after the head observation epoch/);
    expect(r.report.at(-1)).toMatch(/not every path needing a human is authorized/);
  });

  test('an App-applied label is invalid (the A14 regression)', async () => {
    const { h } = d11Harness({
      timeline: () => [
        ownerLabel({
          actor: { login: 'cq-automation[bot]', id: 99, type: 'Bot' },
          performed_via_github_app: { slug: 'cq-automation' },
        }),
      ],
    });
    const r = await runGate(h.deps, cfg());
    expect(r.verdict).toBe('refused');
    const text = r.report.join('\n');
    expect(text).toMatch(/label applied via GitHub App 'cq-automation'/);
    expect(text).toMatch(/actor id 99 is not the repository owner id 1/);
  });

  test('the newest ledger version holding the PR observed another head → invalid', async () => {
    const { h } = d11Harness({
      timeline: () => [ownerLabel()],
      settle: [
        { sha: sha('1'), ledger: ledger({ '7': sha('9') }) },
        { sha: sha('2'), ledger: ledger({ '7': H1 }) },
      ],
    });
    const r = await runGate(h.deps, cfg());
    expect(r.verdict).toBe('refused');
    expect(r.report.join('\n')).toMatch(/no durable head observation for b{40}/);
  });

  test('an absent settle ledger leaves the record invalid', async () => {
    const { h } = d11Harness({ timeline: () => [ownerLabel()], settle: [] });
    const r = await runGate(h.deps, cfg());
    expect(r.verdict).toBe('refused');
    const text = r.report.join('\n');
    expect(text).toMatch(/settle ledger — 0 version\(s\) read \(history exhausted/);
    expect(text).toMatch(/no durable head observation/);
  });

  test('a needs-human path no admitted PR contributes is named, even with a valid record', async () => {
    const { h } = d11Harness({ timeline: () => [ownerLabel()] }, C3_OK, ['src/other.ts']);
    const r = await runGate(h.deps, cfg());
    expect(r.verdict).toBe('refused');
    expect(r.report.join('\n')).toMatch(
      /d11: vitest\.config\.ts unauthorized — not contributed by any admitted PR in the closure/,
    );
  });

  test('an unlabel during the wait refuses at the D11 recheck', async () => {
    const { h } = d11Harness({
      timeline: (n) =>
        n === 0
          ? [ownerLabel()]
          : [
              ownerLabel(),
              { ...ownerLabel(), event: 'unlabeled', created_at: '2026-09-03T00:00:00Z' },
            ],
    });
    const r = await runGate(h.deps, cfg());
    expect(r.verdict).toBe('refused');
    expect(r.report.at(-1)).toMatch(/\(D11 recheck after the wait\)$/);
  });

  test('an unlabel after the D11 recheck still refuses at the last pre-push read', async () => {
    // Labelled for pass 1 and pass 2; removed only by the final read.
    const { h } = d11Harness({
      timeline: (n) =>
        n < 2
          ? [ownerLabel()]
          : [
              ownerLabel(),
              { ...ownerLabel(), event: 'unlabeled', created_at: '2026-09-03T00:00:00Z' },
            ],
    });
    let pushed = false;
    h.deps.git = {
      ...h.deps.git,
      pushAtomic: () => {
        pushed = true;
        return Promise.resolve({ ok: true, output: '' });
      },
    };
    const r = await runGate(h.deps, cfg({ push: true, pushToken: 'tok' }));
    expect(r.verdict).toBe('refused');
    expect(pushed).toBe(false);
    expect(r.report.at(-1)).toMatch(/the D11 pass no longer holds at push time/);
  });
});

describe('runGate — real git, promoted to a local bare remote', { timeout: 180_000 }, () => {
  const GIT_ENV: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
  const git = (cwd: string, args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV }).trim();
  const tmp = mkdtempSync(join(tmpdir(), 'cq-promote-gate-'));
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  /** trust clone + bare remote: main <- tip (merge of `feature` head); origin/* fetched. */
  function setup(name: string): {
    trust: string;
    remote: string;
    main: string;
    head: string;
    tip: string;
  } {
    const trust = join(tmp, `${name}-trust`);
    const remote = join(tmp, `${name}-remote.git`);
    mkdirSync(trust);
    mkdirSync(remote);
    git(remote, ['init', '-q', '--bare', '-b', 'main']);
    git(trust, ['init', '-q', '-b', 'main']);
    git(trust, ['config', 'user.email', 't@example.test']);
    git(trust, ['config', 'user.name', 't']);
    git(trust, ['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(trust, 'a.txt'), 'a\n');
    git(trust, ['add', '-A']);
    git(trust, ['commit', '-q', '-m', 'base']);
    const main = git(trust, ['rev-parse', 'HEAD']);
    git(trust, ['checkout', '-q', '-b', 'feature']);
    writeFileSync(join(trust, 'b.txt'), 'b\n');
    git(trust, ['add', '-A']);
    git(trust, ['commit', '-q', '-m', 'feature']);
    const head = git(trust, ['rev-parse', 'HEAD']);
    git(trust, ['checkout', '-q', '-b', 'mq', main]);
    git(trust, ['merge', '-q', '--no-ff', '-m', 'Merge PR #7', 'feature']);
    const tip = git(trust, ['rev-parse', 'HEAD']);
    git(trust, ['update-ref', 'refs/remotes/origin/main', main]);
    git(trust, ['update-ref', 'refs/remotes/origin/merge-queue', tip]);
    git(trust, ['push', '-q', remote, `${main}:refs/heads/main`, `${tip}:refs/heads/merge-queue`]);
    // C2-cutover bootstrap: the replay marker starts at the cutover main.
    git(trust, ['push', '-q', remote, `${main}:refs/heads/cq/promoted`]);
    return { trust, remote, main, head, tip };
  }

  function prWorld(tip: string, main: string, head: string): World {
    const w = world(tip, main);
    w.prs = new Map([
      [
        tip,
        [
          {
            number: 7,
            merge_commit_sha: tip,
            base: { ref: 'merge-queue' },
            merged_at: '2026-09-01T00:00:00Z',
            head: { sha: head, repo: { id: REPO_ID } },
          },
        ],
      ],
    ]);
    return w;
  }

  test('promotes the reviewed sha onto main with only the main refspec (real git)', async () => {
    const { trust, remote, main, head, tip } = setup('ok');
    const h = harness(prWorld(tip, main, head));
    h.deps.git = realGateGit;
    const r = await runGate(
      h.deps,
      cfg({
        repo: trust,
        trustRef: main,
        push: true,
        pushToken: 'tok',
        remoteUrl: remote,
      }),
    );
    expect(r.report.at(-1)).toBe(`push: main at ${tip} (reviewed sha, base ${main})`);
    expect(r.verdict).toBe('promoted');
    expect(git(remote, ['rev-parse', 'main'])).toBe(tip);
    // The queue is NEVER written by the gate (PR-C): the setup's push put it
    // at the tip and the promotion leaves it exactly there.
    expect(git(remote, ['rev-parse', 'merge-queue'])).toBe(tip);
    expect(h.acceptanceInputs).toEqual([
      { pr: 7, subject: head, base: 'merge-queue', state: 'merged' },
      { pr: 7, subject: head, base: 'merge-queue', state: 'merged' },
    ]);
  });

  test('a main moved since the step-1 read is refused by the lease; nothing promotes', async () => {
    const { trust, remote, main, head, tip } = setup('rewind');
    const h = harness(prWorld(tip, main, head));
    // Break-glass rewinds MAIN to the PR head after the gate's step-1 read.
    // The push's main lease (expected = the read main) no longer matches the
    // remote, so --atomic refuses: a rewound main is never jumped over, and
    // the reviewed sha is re-judged against the new main on the next sweep
    // (its base is then not contained in main → awaiting, still no move).
    h.deps.git = {
      ...realGateGit,
      pushAtomic: (repo, url, updates, token) => {
        git(remote, ['update-ref', 'refs/heads/main', head]);
        return realGateGit.pushAtomic(repo, url, updates, token);
      },
    };
    const r = await runGate(
      h.deps,
      cfg({
        repo: trust,
        trustRef: main,
        push: true,
        pushToken: 'tok',
        remoteUrl: remote,
      }),
    );
    expect(r.verdict).toBe('refused');
    expect(r.report.at(-1)).toMatch(/atomic leased push was rejected/);
    expect(git(remote, ['rev-parse', 'main'])).toBe(head);
    expect(git(remote, ['rev-parse', 'merge-queue'])).toBe(tip);
  });

  test('a queue rewound to an ancestor before the push is refused; main unchanged', async () => {
    const { trust, remote, main, head, tip } = setup('queue-rewind');
    const h = harness(prWorld(tip, main, head));
    // Break-glass rewinds merge-queue to the PR head (an ancestor of the
    // tip) between the gate's step-1 read and the push itself. The push
    // ALWAYS carries the queue refspec leased at the run-start tip (luna
    // round 4 — leased even when the observation still served the tip):
    // git refuses it against the rewound ref, and --atomic refuses main
    // with it — a dropped merge (the subject among it) is never silently
    // re-promoted off a stale queue read.
    h.deps.git = {
      ...realGateGit,
      pushAtomic: (repo, url, updates, token) => {
        git(remote, ['update-ref', 'refs/heads/merge-queue', head]);
        return realGateGit.pushAtomic(repo, url, updates, token);
      },
    };
    const r = await runGate(
      h.deps,
      cfg({
        repo: trust,
        trustRef: main,
        push: true,
        pushToken: 'tok',
        remoteUrl: remote,
      }),
    );
    expect(r.verdict).toBe('refused');
    expect(r.report.at(-1)).toMatch(/atomic leased push was rejected/);
    expect(git(remote, ['rev-parse', 'main'])).toBe(main);
    expect(git(remote, ['rev-parse', 'merge-queue'])).toBe(head);
  });
});

describe('mainWith (the CLI seam)', () => {
  const ARGV = [
    '--repo=/nonexistent/trust',
    '--repository=o/r',
    `--repositoryId=${String(REPO_ID)}`,
    `--trustRef=${TRUST}`,
    '--defaultBranch=main',
    `--reviewerBotLogin=${REVIEWER.login}`,
    `--reviewerBotId=${String(REVIEWER.id)}`,
  ];
  const TOKEN = 'ghp_PROMOTETOKEN0123456789';

  function mainHarness(env: NodeJS.ProcessEnv) {
    const lines: string[] = [];
    const ghEnvs: NodeJS.ProcessEnv[] = [];
    const pushTokens: string[] = [];
    let ghBuilt = false;
    const deps = {
      makeGh: (): GhFn => {
        ghBuilt = true;
        // The env every gh child would inherit, as of each call.
        return () => {
          ghEnvs.push({ ...env });
          return Promise.resolve({ code: 1, stdout: '', stderr: 'HTTP 502' });
        };
      },
      git: fakeGit({
        pushAtomic: (_r, _u, _updates, token) => {
          pushTokens.push(token);
          return Promise.resolve({ ok: true, output: '' });
        },
      }),
      sleep: () => Promise.resolve(),
      nowMs: () => 0,
      write: (line: string) => lines.push(line),
    };
    return { deps, lines, ghEnvs, pushTokens, ghBuilt: () => ghBuilt };
  }

  test('the token leaves the env before any gh child runs', async () => {
    const env: NodeJS.ProcessEnv = { CQ_PROMOTE_TOKEN: TOKEN, KEEP: 'x' };
    const h = mainHarness(env);
    const code = await mainWith([...ARGV, '--push'], env, h.deps);
    expect(code).toBe(1);
    expect(env).toEqual({ KEEP: 'x' });
    expect(h.ghEnvs.length).toBeGreaterThan(0);
    for (const childEnv of h.ghEnvs) {
      expect(childEnv).not.toHaveProperty('CQ_PROMOTE_TOKEN');
      expect(JSON.stringify(childEnv)).not.toContain(TOKEN);
    }
    expect(h.lines).toHaveLength(1);
    expect(h.lines[0]).not.toContain(TOKEN);
    const out = JSON.parse(h.lines[0] ?? '') as {
      status: string;
      value: { verdict: string };
    };
    expect(out.status).toBe('ok');
    expect(out.value.verdict).toBe('refused');
  });

  test('--push without the token is refused before any read', async () => {
    for (const env of [{}, { CQ_PROMOTE_TOKEN: '' }] as NodeJS.ProcessEnv[]) {
      const h = mainHarness(env);
      const code = await mainWith([...ARGV, '--push'], env, h.deps);
      expect(code).toBe(1);
      expect(h.ghBuilt()).toBe(false);
      expect(h.ghEnvs).toEqual([]);
      expect(JSON.parse(h.lines[0] ?? '')).toEqual({
        status: 'failed',
        error: '--push requires CQ_PROMOTE_TOKEN',
      });
      expect(env).not.toHaveProperty('CQ_PROMOTE_TOKEN');
    }
  });

  test('a dry run without the token still runs (and strips a stray token)', async () => {
    const env: NodeJS.ProcessEnv = { CQ_PROMOTE_TOKEN: TOKEN };
    const h = mainHarness(env);
    expect(await mainWith(ARGV, env, h.deps)).toBe(1);
    expect(h.ghBuilt()).toBe(true);
    expect(h.pushTokens).toEqual([]);
    expect(env).toEqual({});
  });
});

// -- cq-verify binds the SAME authorization (readiness T2) -------------------------

describe('bindQueueAuthorization — the object cq-verify consumes', () => {
  const report = (): string[] => [];

  test('the gate world with a valid record + C3: the definition change is authorized', async () => {
    const { h } = d11Harness({ timeline: () => [ownerLabel()] });
    const auth = await bindQueueAuthorization(h.deps, cfg(), MAIN, M1, report());
    expect(auth.attested).toBe(true);
    expect(auth.contributions.map((c) => [c.pr, c.record.status])).toEqual([[7, 'honoured']]);
    expect(authorizePaths(auth, [CHANGED]).authorized).toBe(true);
    // One label never authorizes a path its PR did not change.
    expect(authorizePaths(auth, ['tsconfig.json']).authorized).toBe(false);
  });

  test('no attestation: the record is dormant and nothing is authorized (as today)', async () => {
    const { h } = d11Harness({ timeline: () => [ownerLabel()] }, null);
    const auth = await bindQueueAuthorization(h.deps, cfg(), MAIN, M1, report());
    expect(auth.attested).toBe(false);
    expect(authorizePaths(auth, [CHANGED]).authorized).toBe(false);
  });

  test('a listed ledger version whose file is missing (404) is a barrier too', async () => {
    const { h } = d11Harness({
      timeline: () => [ownerLabel()],
      settle: [
        { sha: sha('1'), ledger: ledger({}) },
        { sha: sha('2'), ledger: ledger({ '7': H1 }) },
      ],
    });
    const gh = h.deps.gh;
    h.deps.gh = (args) =>
      (args[1] ?? '').includes(`settle-state.json?ref=${sha('1')}`)
        ? Promise.resolve({ code: 1, stdout: '', stderr: 'HTTP 404: Not Found' })
        : gh(args);
    const lines: string[] = [];
    const auth = await bindQueueAuthorization(h.deps, cfg(), MAIN, M1, lines);
    expect(lines.join('\n')).toMatch(/missing at listed history commit/);
    expect(lines.join('\n')).toMatch(/lookup barrier/);
    expect(auth.contributions[0]?.record.status).toBe('invalid');
  });

  test('a malformed newest ledger version is a barrier: no stale epoch from an older one', async () => {
    const { h } = d11Harness({
      timeline: () => [ownerLabel()],
      settle: [
        { sha: sha('1'), ledger: 'not a ledger' },
        { sha: sha('2'), ledger: ledger({ '7': H1 }) },
      ],
    });
    const lines: string[] = [];
    const auth = await bindQueueAuthorization(h.deps, cfg(), MAIN, M1, lines);
    expect(lines.join('\n')).toMatch(/malformed version is a lookup barrier/);
    expect(auth.contributions[0]?.record.status).toBe('invalid');
    expect(authorizePaths(auth, [CHANGED]).authorized).toBe(false);
  });

  test('a run that changes while its jobs are read is never evidence (pending, then timeout)', async () => {
    const h = harness(world());
    const gh = h.deps.gh;
    let ciReads = 0;
    h.deps.gh = async (args) => {
      const result = await gh(args);
      if (!/actions\/workflows\/ci\.yml\/runs/.test(args[1] ?? '')) return result;
      ciReads += 1;
      if (ciReads < 2) return result;
      // Every later read sees a rerun (attempt 2) of the same run.
      const pages = JSON.parse(result.stdout) as { workflow_runs: Record<string, unknown>[] }[];
      for (const page of pages) for (const run of page.workflow_runs) run['run_attempt'] = 2;
      return { ...result, stdout: JSON.stringify(pages) };
    };
    const r = await runGate(h.deps, cfg());
    expect(r.verdict).toBe('refused');
    expect(r.report.join('\n')).toMatch(
      /the run changed while its jobs were read|no job of attempt 2/,
    );
  });

  test('the gate reads every job execution (filter=all) of a verified run', async () => {
    const h = harness(world());
    await runGate(h.deps, cfg());
    const jobReads = h.calls.map((c) => c[1] ?? '').filter((p) => /\/jobs\?/.test(p));
    expect(jobReads.length).toBeGreaterThan(0);
    for (const p of jobReads) expect(p).toMatch(/[?&]filter=all(?:&|$)/);
  });

  test('a closure the gate would refuse binds no contribution (fail closed)', async () => {
    const { h } = d11Harness({ timeline: () => [ownerLabel()] });
    h.deps.git = { ...h.deps.git, firstParentRange: () => Promise.resolve([]) };
    const lines: string[] = [];
    const auth = await bindQueueAuthorization(h.deps, cfg(), MAIN, M1, lines);
    expect(auth.contributions).toEqual([]);
    expect(auth.report.join('\n')).toMatch(
      /no authorization bound — closure: the first-parent chain/,
    );
    expect(authorizePaths(auth, [CHANGED]).authorized).toBe(false);
  });

  test("cq-verify's in-process verifier forwards exactly that object for a queue-tip subject", async () => {
    for (const [attestation, expected] of [
      [C3_OK, true],
      [null, false],
    ] as const) {
      const { h } = d11Harness({ timeline: () => [ownerLabel()] }, attestation);
      const seen: VerifyRatchetInput[] = [];
      const result = await verifyWithAuthorization(
        {
          gh: h.deps.gh,
          git: h.deps.git,
          verify: (input) => {
            seen.push(input);
            const d11 =
              input.authorization === undefined
                ? undefined
                : authorizePaths(input.authorization, [CHANGED]);
            return Promise.resolve({
              status: 'ok',
              value: {
                verdict: d11?.authorized === true ? 'pass' : 'needs-human',
                trustRef: TRUST,
                subject: M1,
                rangeBase: MAIN,
                definitionChanges: [CHANGED],
                ...(d11 === undefined ? {} : { d11 }),
                guard: { ok: true, violations: [], filesChecked: 0 },
                results: [],
                reasons: d11?.lines ?? [],
              },
            });
          },
        },
        {
          repo: '/tmp/trust',
          repository: 'o/r',
          repositoryId: REPO_ID,
          trustRef: TRUST,
          subject: M1,
          subjectKind: 'push',
          base: 'refs/remotes/origin/main',
          measureConclusion: 'success',
        },
      );
      expect(seen).toHaveLength(1);
      expect(seen[0]?.authorization?.attested).toBe(expected);
      expect(result.status === 'ok' && result.value.verdict).toBe(
        expected ? 'pass' : 'needs-human',
      );
      // The evidence is journalled in the verdict's reasons.
      expect(result.status === 'ok' && result.value.reasons.join('\n')).toMatch(
        /override PR #7 \(merge /,
      );
    }
  });
});
