// E1 slice 3 — the I11 trap tests, CLI-driven: `fetchReviewState` runs
// against a FAKE gh EXECUTABLE (test/fixtures/gh/fake-gh.mjs) via
// makeGhRunner({ bin }) with CQ_GH_SCENARIO/CQ_GH_LOG in the spawned env.
// No network anywhere; the fake's built-in behaviors reproduce real gh's
// trap semantics (the scenario payloads pin the data side).
//
// One failing-without / passing-with pair per trap:
//   1. REST silent pagination loss — without `--paginate` gh returns only
//      page 1 of a paged collection (pages payload, pages[0]); the
//      implementation always paginates (all 31 items, truncated: false) and
//      a low restPages cap truncates fail-closed with a reason.
//   2. GraphQL `query` variable collision — a duplicate `-f query=` flag or
//      a document declaring `$query` exits nonzero; the implementation sends
//      exactly one `-f query=` per graphql call and names its cursors
//      threadsAfter/reviewsAfter (proven via CQ_GH_LOG).
//   3. Replies-endpoint 404 — any `/replies` invocation exits 404; the
//      implementation never makes one (proven via CQ_GH_LOG) and rebuilds
//      reply chains from in_reply_to_id on the flat collection.
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

/** -f/-F flag names of one logged invocation, in order. */
const flagNames = (args: string[]): string[] => {
  const names: string[] = [];
  for (let i = 0; i < args.length - 1; i++) {
    if ((args[i] === '-f' || args[i] === '-F') && (args[i + 1] ?? '').includes('=')) {
      names.push((args[i + 1] as string).slice(0, (args[i + 1] as string).indexOf('=')));
    }
  }
  return names;
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

  test('implementation survives: --paginate returns all 31; a low restPages cap truncates with a reason', async () => {
    const { run } = await harness('pageloss-with');
    const state = await fetchReviewState(INPUT, {}, run);
    expect(state.restReviewComments).toHaveLength(31);
    expect(state.truncated).toBe(false);
    // Cap path end to end: restPages 0 allows nothing — everything must be
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
    const log = await readLog(logPath);
    const graphqlCalls = log.filter((args) => args.includes('graphql'));
    expect(graphqlCalls).toHaveLength(1); // single-page scenario: one call
    const names = flagNames(graphqlCalls[0] ?? []);
    expect(names.filter((name) => name === 'query')).toHaveLength(1);
    expect(names).toContain('threadsAfter');
    expect(names).toContain('reviewsAfter');
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Trap 3 — replies-endpoint 404
// ---------------------------------------------------------------------------

describe('trap: replies endpoint 404', () => {
  test('trap fires: any /replies invocation exits 404', async () => {
    const { run } = await harness('replies-without');
    const res = await run(['api', 'repos/octo/toolkit/pulls/7/comments/101/replies']);
    expect(res.code).not.toBe(0); // process.exit(404) truncates to 8 bits on POSIX
    expect(res.stderr).toMatch(/404/);
  }, 20_000);

  test('implementation survives: no /replies call, and the reply lands on the right thread', async () => {
    const { run, logPath } = await harness('replies-with');
    const state = await fetchReviewState(INPUT, {}, run);
    const log = await readLog(logPath);
    expect(log.some((args) => args.some((arg) => arg.includes('/replies')))).toBe(false);
    const t1 = state.threads.find((thread) => thread.id === 'PRRT_1');
    expect(t1?.replies.map((reply) => reply.body)).toEqual([
      'fresh responder reply: fixed in 0123456', // in_reply_to_id 100 → root node_id PRRT_1
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
    const t1 = snapshot.data.repository.pullRequest.reviewThreads.nodes.find((n) => n.id === 'PRRT_1');
    expect(t1?.comments.nodes).toHaveLength(1); // root only — no reply, fresh or otherwise
  }, 20_000);

  test('implementation survives: the fresh REST-only responder reply surfaces on the lagged thread', async () => {
    const { run } = await harness('lag-with');
    const state = await fetchReviewState(INPUT, {}, run);
    const t1 = state.threads.find((thread) => thread.id === 'PRRT_1');
    const freshReply = t1?.replies.find((reply) => reply.body.startsWith('fresh responder reply'));
    expect(freshReply).toEqual({
      authorLogin: 'pr-author',
      body: 'fresh responder reply: fixed in 0123456',
      createdAt: '2026-09-15T09:00:00Z',
    });
    // The full vocabulary rides along: the resolved thread is not counted,
    // both external threads are.
    expect(state.threads.find((thread) => thread.id === 'PRRT_2')?.isResolved).toBe(true);
    expect(countUnresolvedThreads(state.threads, { excludeAuthorLogin: 'pr-author' })).toBe(2);
    expect(state.truncated).toBe(false);
  }, 20_000);
});
