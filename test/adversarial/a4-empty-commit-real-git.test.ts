// §7 A4 — `git commit --allow-empty -m "<thread-id>"` to resolve a review
// thread, and the ref-retarget variant.
//
// The evidence this row requires is a REAL empty commit: the attack is
// produced by the git binary in a scratch repository (the same command the
// plan names), the head SHA judged downstream is the SHA git really minted,
// and the forge read that answers it is bound to that real SHA. Nothing here
// is asserted from a hand-written constant: if the guard regressed to
// "read the commit message", or to "the head did not move", these cases
// would fail rather than pass.
//
// Offline by construction: the only forge access is a stub whose response is
// keyed by the REAL head SHA and by the real thread state, so a
// thread-resolution claim can only come from the API, never from the commit.
//
// What is pinned:
//   1. The attack really is an empty commit: a new 40-hex head, an identical
//      tree, and an empty changed-path set (`git diff --name-only`).
//   2. At that real head the acceptance check still fails on the still-open
//      thread — the `threads` rule, not a head mismatch.
//   3. Retargeting the branch (a second empty commit, and the merge-queue
//      ref moved with it) does not buy resolution at any real head.
//   4. Positive control: when the API alone reports the thread resolved, the
//      same real head passes — the gate keys on real thread state, so the
//      refusals above are the guard working, not a stub that always fails.
//   5. The retarget invalidates head-bound acceptance: a trusted APPROVED
//      review bound to the pre-attack real SHA no longer accepts at the
//      empty commit's real SHA.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { classifyPr } from '../../src/ops/merge/classifyPrs.js';
import type { PrCandidate } from '../../src/ops/merge/classifyPrs.js';
import { defaultClassifyPrConfig } from '../../src/ops/merge/classify.config.js';
import type { GhFn, GhResult } from '../../src/ops/review/gh.js';
import { judgeAcceptance } from '../../src/selfhost/acceptance.js';
import type { AcceptanceResult } from '../../src/selfhost/acceptance.js';
import { CONSERVATIVE_TRUST_POLICY } from '../../src/selfhost/merge-recheck.js';

const SLOW = { timeout: 60_000 };
const THREAD_ID = 'PRRT_kwDOAaBcDeFgHiJkLmNoPqR';

/** No user config, no system config, no prompts: the scratch repo's git is hermetic. */
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'attacker',
  GIT_AUTHOR_EMAIL: 'attacker@example.test',
  GIT_COMMITTER_NAME: 'attacker',
  GIT_COMMITTER_EMAIL: 'attacker@example.test',
};

let root: string;
let repo: string;

/** The head before the attack: a real reviewable commit with one real file. */
let reviewedHead: string;
/** The head after `git commit --allow-empty -m "<thread-id>"`. */
let attackHead: string;
/** The head after a second, ref-retargeting empty commit. */
let retargetHead: string;
/** The tree the reviewer was looking at. */
let reviewedTree: string;

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: GIT_ENV }).trim();
}

const isSha = (value: string): boolean => /^[0-9a-f]{40}$/.test(value);

const ok = (body: unknown): GhResult => ({ code: 0, stdout: JSON.stringify(body), stderr: '' });

/**
 * A forge stub keyed by REAL head SHAs. `resolvedAt` is the only thing that
 * can make a thread resolved, and it is supplied by the test, never derived
 * from the commit subject — the A4 attack's message is deliberately visible
 * to nothing here.
 */
function forge(head: string, resolved: boolean, log: string[]): GhFn {
  return (args) => {
    log.push(args.join(' '));
    if (args[0] !== 'api') throw new Error(`unexpected gh command: ${args.join(' ')}`);
    if (args[1] === 'graphql') {
      return Promise.resolve(
        ok({
          data: {
            repository: {
              pullRequest: {
                state: 'OPEN',
                isDraft: false,
                author: { login: 'author', __typename: 'User' },
                headRefOid: head,
                baseRefOid: 'b'.repeat(40),
                baseRefName: 'merge-queue',
                reviewThreads: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: THREAD_ID,
                      isResolved: resolved,
                      comments: {
                        nodes: [{ databaseId: 123456789, author: { login: 'reviewer' } }],
                      },
                    },
                  ],
                },
                reviews: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: 'review-1',
                      author: { login: 'reviewer', __typename: 'User' },
                      authorAssociation: 'MEMBER',
                      state: 'APPROVED',
                      submittedAt: '2026-09-26T00:10:00Z',
                      commit: { oid: head },
                      body: 'LGTM',
                    },
                  ],
                },
                timelineItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
              },
            },
          },
        }),
      );
    }
    if (args[1]?.endsWith('/reviews?per_page=100')) {
      return Promise.resolve(ok([[{ node_id: 'review-1', state: 'APPROVED' }]]));
    }
    if (args[1]?.endsWith('/comments?per_page=100')) {
      return Promise.resolve(ok([[{ id: 123456789, in_reply_to_id: null }]]));
    }
    throw new Error(`unexpected gh API: ${args.join(' ')}`);
  };
}

async function judge(
  head: string,
  resolved: boolean,
): Promise<AcceptanceResult & { gh: string[] }> {
  const calls: string[] = [];
  const verdict = await judgeAcceptance(
    {
      gh: forge(head, resolved, calls),
      owner: 'octo',
      repo: 'widget',
      policy: CONSERVATIVE_TRUST_POLICY,
    },
    { pr: 7, subject: head, base: 'merge-queue', state: 'open' },
  );
  return { ...verdict, gh: calls };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'cq-a4-empty-commit-'));
  repo = join(root, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { env: GIT_ENV });

  writeFileSync(join(repo, 'auth.ts'), 'export const check = () => true;\n');
  git(['add', 'auth.ts']);
  git(['commit', '-q', '-m', 'add the auth check']);
  reviewedHead = git(['rev-parse', 'HEAD']);
  reviewedTree = git(['rev-parse', 'HEAD^{tree}']);

  // The attack, verbatim: an empty commit whose subject is the thread id.
  git(['commit', '--allow-empty', '-q', '-m', THREAD_ID]);
  attackHead = git(['rev-parse', 'HEAD']);

  // The ref-retarget variant: push again, and drag the queue ref with it.
  git(['commit', '--allow-empty', '-q', '-m', `${THREAD_ID} (resolved)`]);
  retargetHead = git(['rev-parse', 'HEAD']);
  git(['update-ref', 'refs/heads/merge-queue', retargetHead]);
}, 60_000);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('§7 A4 the attack is a real empty commit', SLOW, () => {
  test('git mints a new head whose tree and changed-path set are untouched', () => {
    expect(isSha(reviewedHead)).toBe(true);
    expect(isSha(attackHead)).toBe(true);
    expect(isSha(retargetHead)).toBe(true);
    expect(attackHead).not.toBe(reviewedHead);
    expect(retargetHead).not.toBe(attackHead);
    // Nothing about the tree changed: the attack touches no path at all, which
    // is exactly why no forge can have recorded a thread resolution from it.
    expect(git(['rev-parse', `${attackHead}^{tree}`])).toBe(reviewedTree);
    expect(git(['diff', '--name-only', `${reviewedHead}..${attackHead}`])).toBe('');
    expect(git(['diff', '--name-only', `${reviewedHead}..${retargetHead}`])).toBe('');
    // The subject really is the thread id (and the message is not a resolution).
    expect(git(['log', '-1', '--format=%s', attackHead])).toBe(THREAD_ID);
    expect(git(['rev-parse', 'refs/heads/merge-queue'])).toBe(retargetHead);
  });
});

describe('§7 A4 an empty commit does not resolve a thread', SLOW, () => {
  test('acceptance fails on the still-open thread at the attacker’s real head', async () => {
    const verdict = await judge(attackHead, false);
    expect(verdict.verdict).toBe('fail');
    expect(
      verdict.report.some((line) => line === 'fail (threads): unresolved external threads: 1'),
    ).toBe(true);
    expect(verdict.acceptedBy).toEqual([]);
    // The judged head is the real attack head, not a stand-in.
    expect(verdict.subject).toBe(attackHead);
    expect(verdict.gh.length).toBeGreaterThan(0);
  });

  test('retargeting the branch and the merge-queue ref buys no resolution', async () => {
    const verdict = await judge(retargetHead, false);
    expect(verdict.verdict).toBe('fail');
    expect(verdict.report).toContain('fail (threads): unresolved external threads: 1');
    expect(verdict.subject).toBe(retargetHead);
  });

  test('positive control: real thread state alone decides, at the same real head', async () => {
    const resolved = await judge(attackHead, true);
    expect(resolved.verdict).toBe('pass');
    expect(resolved.acceptedBy).toEqual(['user:reviewer']);
  });
});

describe('§7 A4 the ref retarget invalidates head-bound acceptance', SLOW, () => {
  const candidate = (headRefOid: string, reviewedHeadOid: string): PrCandidate => ({
    pr: 7,
    authorLogin: 'author',
    draft: false,
    mergeState: 'CLEAN',
    truncated: false,
    threads: [],
    reviews: [
      {
        id: 'review-1',
        authorLogin: 'maintainer',
        authorAssociation: 'MEMBER',
        state: 'APPROVED',
        body: 'LGTM',
        submittedAt: '2026-09-26T00:10:00Z',
        commitOid: reviewedHeadOid,
      },
    ],
    issueComments: [],
    lastCommitAt: '2026-09-26T00:00:00Z',
    headRefOid,
  });
  const config = {
    ...defaultClassifyPrConfig,
    trustedBots: [],
    trustedAssociations: ['MEMBER'],
    automationLogin: 'cq-automation',
  };

  test('an APPROVED review of the pre-attack real SHA does not accept the new head', () => {
    const atReviewedHead = classifyPr(candidate(reviewedHead, reviewedHead), Date.now(), config);
    expect(atReviewedHead).toMatchObject({ verdict: 'eligible' });
    const atAttackHead = classifyPr(candidate(attackHead, reviewedHead), Date.now(), config);
    expect(atAttackHead).toMatchObject({
      verdict: 'awaiting',
      reason: 'no_acceptable_review',
    });
  });
});
