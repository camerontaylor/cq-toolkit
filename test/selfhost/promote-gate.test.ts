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
// pushing to a local bare remote (including a queue rewound between the
// gate's read and its leased push). mainWith: the push credential is out of
// the env before any gh/git child runs, and `--push` without it is refused
// before any read.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import type { OpResult } from '../../src/kernel/types.js';
import type { PolicyDiffInput, PolicyDiffOutcome } from '../../src/ops/gates/policyDiff.js';
import type { RangeCommit } from '../../src/ops/ratchet/git.js';
import type { GhFn, GhResult } from '../../src/ops/review/gh.js';
import type { AcceptanceInput, AcceptanceResult } from '../../src/selfhost/acceptance.js';
import {
  POLL_MS,
  checkClosure,
  checkVerifiedRun,
  mainWith,
  parseGateArgs,
  realGateGit,
  remoteUrlFor,
  runGate,
  selectVerdict,
  toMergedPr,
  verifierRanAt,
  type GateConfig,
  type GateDeps,
  type GateGit,
  type MergedPr,
  type VerdictWant,
} from '../../src/selfhost/promote-gate.js';

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
      run({ id: 2, app: { id: 501, slug: 'cq-verdict' }, completed_at: '2026-09-02T00:00:00Z' }),
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
    const newerFail = run({ id: 3, conclusion: 'failure', completed_at: '2026-09-03T00:00:00Z' });
    expect(selectVerdict([older, newerFail], appWant).state).toBe('failure');
    const tieFail = run({ id: 9, conclusion: 'neutral', completed_at: '2026-09-01T00:00:00Z' });
    expect(selectVerdict([older, tieFail], appWant)).toMatchObject({ state: 'failure', winner: 9 });
    const tieOk = run({ id: 2, conclusion: 'failure', completed_at: '2026-09-01T00:00:00Z' });
    expect(selectVerdict([tieOk, older], appWant)).toMatchObject({ state: 'success', winner: 5 });
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
      [run({ app: { slug: 'github-actions' }, external_id: `${sha('1')}:${TIP}` })],
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
    const skipped = checkVerifiedRun(wf(), [job(), job({ conclusion: 'skipped' })], want);
    expect(skipped.state).toBe('failure');
    expect(skipped.reason).toMatch(/completed\/skipped/);
    expect(checkVerifiedRun(wf(), [], want).reason).toMatch(/no jobs/);
  });
});

describe('parseGateArgs / remoteUrlFor', () => {
  const base = [
    '--repo=/tmp/trust',
    '--repository=o/r',
    `--repositoryId=${String(REPO_ID)}`,
    `--trustRef=${TRUST}`,
    '--defaultBranch=main',
  ];

  test('defaults and full form', () => {
    expect(parseGateArgs(base)).toMatchObject({
      owner: 'o',
      name: 'r',
      verdictAppId: null,
      verifiedWorkflows: ['ci.yml', 'denylist.yml'],
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
  checkRuns: unknown[][];
  measureRuns: unknown[];
  verifiedRuns: Map<string, unknown[]>;
  jobs: unknown[];
  /** cq-verify runs (the interim verifier-ran read). */
  verifyRuns: unknown[];
  dispatchCode: number;
  /** Called on each check-runs read (lets a test publish the verdict later). */
  onCheckRuns?: (n: number) => void;
}

const ok = (value: unknown): GhResult => ({ code: 0, stdout: JSON.stringify(value), stderr: '' });

function fakeGh(world: World, calls: string[][]): GhFn {
  let checkReads = 0;
  return (args) => {
    calls.push(args);
    const path = args[0] === 'api' && args[1] === '-X' ? (args[3] ?? '') : (args[1] ?? '');
    const q = path.split('?')[0] ?? '';
    if (args[2] === 'POST' && q.endsWith('/actions/workflows/cq-verify.yml/dispatches')) {
      return Promise.resolve({ code: world.dispatchCode, stdout: '', stderr: 'boom' });
    }
    if (q === 'repos/o/r/git/ref/heads/merge-queue') {
      return Promise.resolve(ok({ object: { sha: world.tip, type: 'commit' } }));
    }
    if (q === 'repos/o/r/git/ref/heads/main') {
      return Promise.resolve(ok({ object: { sha: world.main, type: 'commit' } }));
    }
    let m = /^repos\/o\/r\/commits\/([0-9a-f]{40})\/pulls$/.exec(q);
    if (m !== null) return Promise.resolve(ok([world.prs.get(m[1] ?? '') ?? []]));
    if (q === 'repos/o/r') return Promise.resolve(ok({ owner: { id: 1 } }));
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
    checkRuns: [[verdictRow(tip, main)]],
    measureRuns: [],
    verifiedRuns: new Map([
      ['ci.yml', [greenRun('ci.yml', tip)]],
      ['denylist.yml', [greenRun('denylist.yml', tip)]],
    ]),
    jobs: [greenJob],
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

const policyOutcome = (verdict: PolicyDiffOutcome['verdict']): OpResult<PolicyDiffOutcome> => ({
  status: 'ok',
  value: {
    verdict,
    posture: 'human',
    postureLayer: 'default',
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
    expect(h.policyInputs).toEqual([
      {
        repo: '/tmp/trust',
        trustRef: TRUST,
        subject: M1,
        subjectKind: 'push',
        base: 'refs/remotes/origin/main',
      },
    ]);
    const text = r.report.join('\n');
    expect(text).toMatch(/admitted PR #7/);
    expect(text).toMatch(/override PR #7 \(logged only\)/);
    // The label is logged invalid (no durable head observation), never honoured.
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
    expect(order.slice(order.lastIndexOf('verdict-read') + 1)).toEqual(['acceptance #7', 'push']);
    const text = r.report.join('\n');
    expect(text).toMatch(/acceptance pass 1 PR #7 .*: pass/);
    expect(text).toMatch(/acceptance pass 2 PR #7 .*: pass/);
  });

  test('policy needs-human refuses (break-glass), with the override still logged', async () => {
    const h = harness(world(), { policyDiff: () => Promise.resolve(policyOutcome('needs-human')) });
    const r = await runGate(h.deps, cfg());
    expect(r.verdict).toBe('refused');
    expect(r.report.at(-1)).toMatch(
      /policy: needs-human .* owner break-glass \(ADR-0004 D-G\.4, D-H\.4\)/,
    );
    expect(r.report.join('\n')).toMatch(/override PR #7 \(logged only\)/);
    const failed = harness(world(), {
      policyDiff: () => Promise.resolve({ status: 'failed', error: 'git fault' }),
    });
    expect((await runGate(failed.deps, cfg())).report.at(-1)).toMatch(/could not judge/);
  });

  test('a failure verdict refuses immediately (no wait)', async () => {
    const h = harness(
      world(M1, MAIN, { checkRuns: [[verdictRow(M1, MAIN, { conclusion: 'failure' })]] }),
    );
    const r = await runGate(h.deps, cfg());
    expect(r.verdict).toBe('refused');
    expect(r.report.at(-1)).toMatch(/newest valid cq\/ratchet verdict on the tip is not success/);
    expect(h.sleeps).toEqual([]);
  });

  test('waits, dispatches cq-verify once on the default ref, then proceeds', async () => {
    const w = world(M1, MAIN, {
      checkRuns: [[verdictRow(M1, sha('1'))]],
      measureRuns: [
        { ...greenRun('cq-measure.yml', M1), id: 555 },
        { ...greenRun('cq-measure.yml', M1), id: 556, path: '.github/workflows/evil.yml' },
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
    expect(r.report.join('\n')).toMatch(/waiting \(no completed cq-measure push run on tip\)/);
  });

  test('timeout refuses', async () => {
    const w = world(M1, MAIN, { checkRuns: [[verdictRow(M1, MAIN, { status: 'in_progress' })]] });
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

  test('the push is leased on the (main, tip) read at step 1', async () => {
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
    expect(seen).toEqual([
      {
        updates: [
          { refspec: `${M1}:refs/heads/main`, expected: MAIN },
          { refspec: `${M1}:refs/heads/merge-queue`, expected: M1 },
        ],
        token: 't',
      },
    ]);
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

  test('promotes tip onto main and merge-queue atomically', async () => {
    const { trust, remote, main, head, tip } = setup('ok');
    const h = harness(prWorld(tip, main, head));
    h.deps.git = realGateGit;
    const r = await runGate(
      h.deps,
      cfg({ repo: trust, trustRef: main, push: true, pushToken: 'tok', remoteUrl: remote }),
    );
    expect(r.report.at(-1)).toBe(`push: main and merge-queue at ${tip}`);
    expect(r.verdict).toBe('promoted');
    expect(git(remote, ['rev-parse', 'main'])).toBe(tip);
    expect(git(remote, ['rev-parse', 'merge-queue'])).toBe(tip);
    expect(h.acceptanceInputs).toEqual([
      { pr: 7, subject: head, base: 'merge-queue', state: 'merged' },
      { pr: 7, subject: head, base: 'merge-queue', state: 'merged' },
    ]);
  });

  test('a queue rewound to an ancestor during the wait is refused; main unchanged', async () => {
    const { trust, remote, main, head, tip } = setup('rewind');
    const h = harness(prWorld(tip, main, head));
    // Break-glass rewinds merge-queue to the PR head (an ancestor of the
    // tip) after the gate's step-1 read, just before its push. A plain
    // fast-forward push would re-promote the dropped merge.
    h.deps.git = {
      ...realGateGit,
      pushAtomic: (repo, url, updates, token) => {
        git(remote, ['update-ref', 'refs/heads/merge-queue', head]);
        return realGateGit.pushAtomic(repo, url, updates, token);
      },
    };
    const r = await runGate(
      h.deps,
      cfg({ repo: trust, trustRef: main, push: true, pushToken: 'tok', remoteUrl: remote }),
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
    const out = JSON.parse(h.lines[0] ?? '') as { status: string; value: { verdict: string } };
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
