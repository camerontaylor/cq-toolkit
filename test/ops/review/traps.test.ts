// E1 slice 3 — the I11 trap tests, CLI-driven: `fetchReviewState` runs
// against a FAKE gh EXECUTABLE (test/fixtures/gh/fake-gh.mjs) via
// makeGhRunner({ bin }) with CQ_GH_SCENARIO/CQ_GH_LOG in the spawned env.
// No network anywhere; the fake's built-in behaviors reproduce real gh's
// trap semantics (the scenario payloads pin the data side).
//
// One failing-without / passing-with pair per trap:
//   1. REST silent pagination loss — without `--paginate` the fake returns
//      only page 1 of a paged collection (pages payload, pages[0]); the
//      implementation always sends `--paginate --slurp` at per_page=100
//      (all 31 items, truncated: false) and a low restPages cap truncates
//      fail-closed with a reason.
//   2. GraphQL `query` variable collision — a duplicate `-f query=` flag or
//      a document declaring `$query` exits nonzero; the implementation sends
//      exactly one `-f query=` per graphql call, names its cursors
//      threadsAfter/reviewsAfter, and never sends an empty cursor (proven
//      via CQ_GH_LOG).
//   3. Replies-endpoint 404 — a GET `/replies` invocation exits 404 (POST is
//      exempt: that is how replies are created); the implementation never
//      makes one (proven via CQ_GH_LOG) and rebuilds reply chains from
//      in_reply_to_id on the flat collection.
//   4. reviewThreads lag — the recorded GraphQL snapshot carries NO thread
//      replies; the fresh responder reply exists only in REST, and the
//      fetched state surfaces it on the right thread via attachRestReplies.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { fetchReviewState } from '../../../src/ops/review/fetchReviewState.js';
import type { FetchReviewStateInput } from '../../../src/ops/review/fetchReviewState.js';
import { makeGhRunner } from '../../../src/ops/review/gh.js';
import { countUnresolvedThreads } from '../../../src/ops/review/threads.js';
import type { GhFn } from '../../../src/ops/review/gh.js';

const FAKE_GH = fileURLToPath(new URL('../../fixtures/gh/fake-gh.mjs', import.meta.url));
const SCENARIO = fileURLToPath(new URL('../../fixtures/gh/scenarios/e1-traps.json', import.meta.url));
const GRAPHQL_SNAPSHOT = fileURLToPath(new URL('../../fixtures/gh/scenarios/e1-graphql.json', import.meta.url));
const INPUT: FetchReviewStateInput = { owner: 'octo', repo: 'toolkit', pr: 7 };

// ---------------------------------------------------------------------------
// Harness: a fresh temp log per test; the fake rides makeGhRunner's env opt.
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A runner wired to the fake gh + e1 scenario, logging every call. */
const harness = async (label: string): Promise<{ run: GhFn; logPath: string }> => {
  const dir = await mkdtemp(join(tmpdir(), `cq-e1-${label}-`));
  tempDirs.push(dir);
  const logPath = join(dir, 'calls.jsonl');
  const run = makeGhRunner({
    bin: FAKE_GH,
    env: { CQ_GH_SCENARIO: SCENARIO, CQ_GH_LOG: logPath },
  });
  return { run, logPath };
};

/** The logged invocations: one `{ args }` JSON line per call. */
const readLog = async (logPath: string): Promise<string[][]> => {
  const text = await readFile(logPath, 'utf8');
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => (JSON.parse(line) as { args: string[] }).args);
};

/** One gh api flag as recorded in the log: `style` is `-f` or `-F`. */
interface LoggedFlag {
  style: string;
  name: string;
  value: string;
}

/** The -f/-F flags of one logged invocation, in order. */
const flagsOf = (args: string[]): LoggedFlag[] => {
  const flags: LoggedFlag[] = [];
  for (let i = 0; i < args.length - 1; i++) {
    const style = args[i];
    if ((style === '-f' || style === '-F') && (args[i + 1] ?? '').includes('=')) {
      const raw = args[i + 1] as string;
      const eq = raw.indexOf('=');
      flags.push({ style, name: raw.slice(0, eq), value: raw.slice(eq + 1) });
    }
  }
  return flags;
};

// ---------------------------------------------------------------------------
// Trap 1 — REST silent pagination loss
// ---------------------------------------------------------------------------

describe('trap: REST silent pagination loss', () => {
  test('trap fires: without --paginate only page 1 comes back (page 2 silently lost)', async () => {
    const { run } = await harness('pageloss-without');
    const res = await run(['api', 'repos/octo/toolkit/pulls/7/comments']);
    expect(res.code).toBe(0);
    const items = JSON.parse(res.stdout) as unknown[];
    expect(items).toHaveLength(20); // the scenario's page 1 — 11 more exist, unreturned
  }, 20_000);

  test('implementation survives: --paginate --slurp returns all 31; a low restPages cap truncates with a reason', async () => {
    const { run, logPath } = await harness('pageloss-with');
    const state = await fetchReviewState(INPUT, {}, run);
    expect(state.restReviewComments).toHaveLength(31);
    expect(state.truncated).toBe(false);
    // The REST calls really paginated: --paginate --slurp at per_page=100.
    const restCalls = (await readLog(logPath)).filter((args) => args.some((a) => a.startsWith('repos/')));
    expect(restCalls).toHaveLength(2); // pulls comments + issue comments
    for (const call of restCalls) {
      expect(call).toContain('--paginate');
      expect(call).toContain('--slurp');
      expect(call.some((a) => a.includes('per_page=100'))).toBe(true);
    }
    // Cap path end to end: restPages 0 allows no pages — everything must be
    // reported truncated, never silently swallowed.
    const capped = await fetchReviewState(INPUT, { restPages: 0 }, run);
    expect(capped.truncated).toBe(true);
    expect(capped.truncatedBecause).toContain('restComments.pageCap');
    expect(capped.restReviewComments).toHaveLength(0);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Trap 2 — GraphQL `query` variable collision (I11)
// ---------------------------------------------------------------------------

describe('trap: GraphQL query variable collision', () => {
  test('trap fires: a $query variable or a duplicate -f query flag exits nonzero', async () => {
    const { run } = await harness('collision-without');
    const declared = await run(['api', 'graphql', '-f', 'query=query ($query: String) { viewer { login } }']);
    expect(declared.code).not.toBe(0);
    expect(declared.stderr).toMatch(/Variable "\$query"|collides/);
    const duplicated = await run([
      'api',
      'graphql',
      '-f',
      'query=query { viewer { login } }',
      '-f',
      'query=query { repository { id } }',
    ]);
    expect(duplicated.code).not.toBe(0);
    expect(duplicated.stderr).toContain(
      'incorrect usage: the value of a -f flag named "query" collides with the GraphQL query parameter',
    );
  }, 20_000);

  test('implementation survives: exactly one -f query per graphql call; cursors named threadsAfter/reviewsAfter', async () => {
    const { run, logPath } = await harness('collision-with');
    const state = await fetchReviewState(INPUT, {}, run);
    expect(state.truncated).toBe(false);
    expect(state.reviews).toHaveLength(2); // the scenario's reviews walk two pages
    const log = await readLog(logPath);
    const graphqlCalls = log.filter((args) => args.includes('graphql'));
    expect(graphqlCalls).toHaveLength(2);
    // Exactly one -f query flag per call — never a duplicate `query` — and
    // no -f flag anywhere carries an empty value (M1).
    for (const call of graphqlCalls) {
      const fFlags = flagsOf(call).filter((flag) => flag.style === '-f');
      expect(fFlags.filter((flag) => flag.name === 'query')).toHaveLength(1);
      for (const flag of fFlags) {
        expect(flag.value).not.toBe('');
      }
    }
    // M1: the first call sends NO cursor flags (never empty strings); the
    // paginating call names its cursor reviewsAfter. Threads finished on
    // page 1, so threadsAfter is (correctly) never sent.
    const firstName = flagsOf(graphqlCalls[0] ?? [])
      .filter((flag) => flag.style === '-f')
      .map((flag) => flag.name);
    expect(firstName).toEqual(['query']);
    const secondNames = flagsOf(graphqlCalls[1] ?? [])
      .filter((flag) => flag.style === '-f')
      .map((flag) => flag.name);
    expect(secondNames).toContain('reviewsAfter');
    expect(secondNames).not.toContain('threadsAfter');
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Trap 3 — replies-endpoint 404
// ---------------------------------------------------------------------------

describe('trap: replies endpoint 404', () => {
  test('trap fires: a GET /replies invocation exits 404 (a POST routes normally)', async () => {
    const { run } = await harness('replies-without');
    const get = await run(['api', '--method', 'GET', 'repos/octo/toolkit/pulls/7/comments/101/replies']);
    expect(get.code).not.toBe(0); // process.exit(404) truncates to 8 bits on POSIX
    expect(get.stderr).toMatch(/404/);
    expect(get.stderr).toContain('no GET/list replies endpoint for review comments');
    // A POST is how replies are CREATED — it bypasses the 404 builtin and
    // routes like any other call (the URL carries the pulls-comments route
    // substring, so it gets that route's payload); the point is the 404
    // never fires for a POST.
    const post = await run(['api', '--method=POST', 'repos/octo/toolkit/pulls/7/comments/101/replies']);
    expect(post.code).toBe(0);
    expect(post.stderr).not.toMatch(/404/);
  }, 20_000);

  test('implementation survives: no /replies call, and the reply lands on the right thread', async () => {
    const { run, logPath } = await harness('replies-with');
    const state = await fetchReviewState(INPUT, {}, run);
    const log = await readLog(logPath);
    expect(log.some((args) => args.some((arg) => arg.includes('/replies')))).toBe(false);
    const t1 = state.threads.find((thread) => thread.id === 'PRRT_kwDOCxyz111');
    expect(t1?.replies.map((reply) => reply.body)).toEqual([
      'fresh responder reply: fixed in 0123456', // in_reply_to_id 100 → root REST id 100 ↔ rootDatabaseId 100
      'reviewer follow-up on T1',
    ]);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Trap 4 — reviewThreads lag (GraphQL snapshot is stale; REST is fresh)
// ---------------------------------------------------------------------------

describe('trap: reviewThreads lag', () => {
  test('trap exists: the recorded GraphQL snapshot carries no thread replies', async () => {
    const snapshot = JSON.parse(await readFile(GRAPHQL_SNAPSHOT, 'utf8')) as {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: { nodes: { id: string; comments: { nodes: unknown[] } }[] };
          };
        };
      };
    };
    const t1 = snapshot.data.repository.pullRequest.reviewThreads.nodes.find((n) => n.id === 'PRRT_kwDOCxyz111');
    expect(t1?.comments.nodes).toHaveLength(1); // root only — no reply, fresh or otherwise
  }, 20_000);

  test('implementation survives: the fresh REST-only responder reply surfaces on the lagged thread', async () => {
    const { run } = await harness('lag-with');
    const state = await fetchReviewState(INPUT, {}, run);
    const t1 = state.threads.find((thread) => thread.id === 'PRRT_kwDOCxyz111');
    const freshReply = t1?.replies.find((reply) => reply.body.startsWith('fresh responder reply'));
    expect(freshReply).toEqual({
      authorLogin: 'pr-author',
      body: 'fresh responder reply: fixed in 0123456',
      createdAt: '2026-09-15T09:00:00Z',
    });
    // The full vocabulary rides along: the resolved thread is not counted,
    // both external threads are.
    expect(state.threads.find((thread) => thread.id === 'PRRT_kwDOCxyz222')?.isResolved).toBe(true);
    expect(countUnresolvedThreads(state.threads, { excludeAuthorLogin: 'pr-author' })).toBe(2);
    expect(state.truncated).toBe(false);
  }, 20_000);
});
