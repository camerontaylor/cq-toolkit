// E1 slice 3 — the I11 trap tests, CLI-driven: `fetchReviewState` runs
// against a FAKE gh EXECUTABLE (test/fixtures/gh/fake-gh.mjs) via
// makeGhRunner({ bin }) with CQ_GH_SCENARIO/CQ_GH_LOG in the spawned env.
// No network anywhere; the fake's built-in behaviors reproduce real gh's
// trap semantics (the scenario payloads pin the data side).
//
// One failing-without / passing-with pair per trap:
//   1. REST silent pagination loss — with NO `--paginate` the fake returns
//      only page 1 of a paged collection; `--paginate` alone merges all
//      pages (real gh fact), `--paginate --slurp` keeps the outer page
//      array. The implementation always sends `--paginate --slurp` at
//      per_page=100 (all 31 items, truncated: false) and a low restPages
//      cap truncates fail-closed with a reason.
//   2. GraphQL `query` collision — a `$query`-declaring document gets the
//      server's GraphQL validation-errors payload (exit 0); a duplicate
//      `-f query=` is silent last-wins (real gh runs no client check). The
//      implementation sends exactly one `-f query=` per graphql call, names
//      its cursors threadsAfter/reviewsAfter, and never sends an empty
//      cursor (proven via CQ_GH_LOG).
//   3. Replies-endpoint 404 — a GET `/replies` invocation exits 1 with gh's
//      404 stderr (POST is exempt: that is how replies are created); the
//      implementation never makes one (proven via CQ_GH_LOG) and rebuilds
//      reply chains from in_reply_to_id on the flat collection.
//   4. reviewThreads lag — the GraphQL snapshot knows ONE thread and
//      carries NO replies; REST knows both a fresh reply on that known
//      thread AND a fresh root thread the snapshot has never seen, plus a
//      fresh REST-only review. The known-thread reply attaches; the fresh
//      thread is NOT fabricated; both lag flavors truncate fail-closed in
//      stable order (`reviewThreads.lag`, then `reviews.lag`).
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { fetchReviewState } from '../../../src/ops/review/fetchReviewState.js';
import type { FetchReviewStateInput } from '../../../src/ops/review/fetchReviewState.js';
import { makeGhRunner } from '../../../src/ops/review/gh.js';
import type { GhFn } from '../../../src/ops/review/gh.js';

const FAKE_GH = fileURLToPath(new URL('../../fixtures/gh/fake-gh.mjs', import.meta.url));
const SCENARIO = fileURLToPath(
  new URL('../../fixtures/gh/scenarios/e1-traps.json', import.meta.url),
);
const LAG_SCENARIO = fileURLToPath(
  new URL('../../fixtures/gh/scenarios/e1-lag.json', import.meta.url),
);
const LAG_GRAPHQL_SNAPSHOT = fileURLToPath(
  new URL('../../fixtures/gh/scenarios/e1-lag-graphql.json', import.meta.url),
);
const INPUT: FetchReviewStateInput = { owner: 'octo', repo: 'toolkit', pr: 7 };

// ---------------------------------------------------------------------------
// Harness: a fresh temp log per test; the fake rides makeGhRunner's env opt.
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A runner wired to the fake gh + a scenario, logging every call. */
const harness = async (
  label: string,
  scenario: string = SCENARIO,
): Promise<{ run: GhFn; logPath: string }> => {
  const dir = await mkdtemp(join(tmpdir(), `cq-e1-${label}-`));
  tempDirs.push(dir);
  const logPath = join(dir, 'calls.jsonl');
  const run = makeGhRunner({
    bin: FAKE_GH,
    env: { CQ_GH_SCENARIO: scenario, CQ_GH_LOG: logPath },
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
    const path = 'repos/octo/toolkit/pulls/7/comments';
    const naked = await run(['api', path]);
    expect(naked.code).toBe(0);
    const items = JSON.parse(naked.stdout) as unknown[];
    expect(items).toHaveLength(20); // the scenario's page 1 — 11 more exist, unreturned
    // Real gh facts the fake models: --paginate alone MERGES all pages into
    // one flat array (v2.100.0 paginatedArrayReader); --slurp keeps pages.
    const merged = await run(['api', path, '--paginate']);
    expect(JSON.parse(merged.stdout)).toHaveLength(31);
    const slurped = JSON.parse(
      (await run(['api', path, '--paginate', '--slurp'])).stdout,
    ) as unknown[][];
    expect(slurped).toHaveLength(2);
    expect(slurped[0]).toHaveLength(20);
    expect(slurped[1]).toHaveLength(11);
  }, 20_000);

  test('implementation survives: --paginate --slurp returns all 31; a low restPages cap truncates with a reason', async () => {
    const { run, logPath } = await harness('pageloss-with');
    const state = await fetchReviewState(INPUT, {}, run);
    expect(state.restReviewComments).toHaveLength(31);
    expect(state.truncated).toBe(false);
    // The REST calls really paginated: --paginate --slurp at per_page=100.
    const restCalls = (await readLog(logPath)).filter((args) =>
      args.some((a) => a.startsWith('repos/')),
    );
    expect(restCalls).toHaveLength(3); // pulls comments + issue comments + reviews
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
  test('trap fires: a $query doc gets the server errors payload (exit 0); duplicate -f query is silent last-wins', async () => {
    const { run } = await harness('collision-without');
    // Server-side modeling: a doc declaring `$query` yields GitHub's GraphQL
    // validation-errors body in a 200 response — the caller must check
    // payload.errors, never rely on a nonzero exit.
    const declared = await run([
      'api',
      'graphql',
      '-f',
      'query=query ($query: String) { viewer { login } }',
    ]);
    expect(declared.code).toBe(0);
    const payload = JSON.parse(declared.stdout) as { errors?: Array<{ message?: string }> };
    expect(payload.errors?.[0]?.message).toMatch(/\$query/);
    // Real gh runs NO client-side check: duplicate `-f query=` keys are
    // last-wins and the request proceeds with the normal route payload —
    // nothing may rely on gh erroring here.
    const duplicated = await run([
      'api',
      'graphql',
      '-f',
      'query=query { viewer { login } }',
      '-f',
      'query=query { repository { id } }',
    ]);
    expect(duplicated.code).toBe(0);
    expect(duplicated.stderr).not.toMatch(/collides|incorrect usage/);
    expect(JSON.parse(duplicated.stdout)).toHaveProperty('data.repository.pullRequest');
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
    expect(firstName).toEqual(['query', 'owner', 'name']);
    const secondNames = flagsOf(graphqlCalls[1] ?? [])
      .filter((flag) => flag.style === '-f')
      .map((flag) => flag.name);
    expect(secondNames).toContain('reviewsAfter');
    expect(secondNames).not.toContain('threadsAfter');
    // Codex thread: owner/name ride raw `-f` (gh `-F` would coerce
    // integer-looking or boolean-literal names and break String!); only pr
    // rides `-F` (Int! needs the number).
    const stylesOf = (call: string[]): Map<string, string> =>
      new Map(flagsOf(call).map((flag) => [flag.name, flag.style]));
    const firstStyles = stylesOf(graphqlCalls[0] ?? []);
    expect(firstStyles.get('owner')).toBe('-f');
    expect(firstStyles.get('name')).toBe('-f');
    expect(firstStyles.get('pr')).toBe('-F');
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Trap 3 — replies-endpoint 404
// ---------------------------------------------------------------------------

describe('trap: replies endpoint 404', () => {
  test('trap fires: a GET /replies invocation exits 1 with gh 404 stderr (a POST routes normally)', async () => {
    const { run } = await harness('replies-without');
    const get = await run([
      'api',
      '--method',
      'GET',
      'repos/octo/toolkit/pulls/7/comments/101/replies',
    ]);
    expect(get.code).toBe(1);
    expect(get.stderr).toContain(
      'gh: Not Found (HTTP 404) - no GET/list replies endpoint for review comments',
    );
    expect(get.stderr).toContain('in_reply_to_id');
    // A POST is how replies are CREATED — it bypasses the 404 builtin and
    // routes like any other call (the URL carries the pulls-comments route
    // substring, so it gets that route's payload); the point is the 404
    // never fires for a POST.
    const post = await run([
      'api',
      '--method=POST',
      'repos/octo/toolkit/pulls/7/comments/101/replies',
    ]);
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
  test('trap exists: the snapshot knows one thread (root-only) while REST carries a fresh root it does not know', async () => {
    const snapshot = JSON.parse(await readFile(LAG_GRAPHQL_SNAPSHOT, 'utf8')) as {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: { nodes: { id: string; comments: { nodes: unknown[] } }[] };
          };
        };
      };
    };
    const snapThreads = snapshot.data.repository.pullRequest.reviewThreads.nodes;
    expect(snapThreads).toHaveLength(1);
    expect(snapThreads[0]?.id).toBe('PRRT_kwDOClag1');
    expect(snapThreads[0]?.comments.nodes).toHaveLength(1); // root only — replies never ride GraphQL
  }, 20_000);

  test('implementation survives: the known-thread reply attaches, the fresh thread is NOT fabricated, lag truncates', async () => {
    const { run } = await harness('lag-with', LAG_SCENARIO);
    const state = await fetchReviewState(INPUT, {}, run);
    // The fresh REST-only thread (root 400) must NOT appear as a thread —
    // the fetch layer never fabricates threads from REST.
    expect(state.threads.map((thread) => thread.rootDatabaseId)).toEqual([300]);
    // The plain lag case — a fresh reply on a KNOWN thread — attaches fine.
    const known = state.threads.find((thread) => thread.id === 'PRRT_kwDOClag1');
    expect(known?.replies.map((reply) => reply.body)).toEqual([
      'fresh responder reply on the KNOWN thread',
    ]);
    // And BOTH lag flavors truncate the result fail-closed, in stable order:
    // the scenario also carries a fresh REST-only review (node_id absent
    // from the GraphQL snapshot).
    expect(state.truncated).toBe(true);
    expect(state.truncatedBecause).toEqual(['reviewThreads.lag', 'reviews.lag']);
  }, 20_000);
});
