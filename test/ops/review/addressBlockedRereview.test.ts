// Blocked re-reviews must not strand the durable bookkeeping receipt (#465).
// A successful addressing run settles the receipt; a later round whose agent
// re-review is blocked still appends a blocked cycle to the dev ledger and
// persists a findings record, so the bookkeeping revision advances while the
// receipt's ledger fingerprint stays old. With the repair, every engine-owned
// ledger write is registered independently of the review outcome, the receipt
// settles to the updated ledger, and the blocked outcome still returns
// needs-human.
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { makeReviewAddress } from '../../../src/ops/review/address.js';
import { makeGhRunner, type GhFn, type GhResult } from '../../../src/adapters/forge-github/gh.js';
import type { DriverFactory } from '../../../src/driver/factory.js';
import { makeTestRepo } from '../dev/repo.js';
import { makeGitleaksFixture } from '../../helpers/gitleaks-fixture.js';
import { devLedgerPath } from '../../../src/ops/dev/record.js';
import { makeSubprocessDevEffects } from '../../../src/ops/dev/effects.js';

let scanner: Awaited<ReturnType<typeof makeGitleaksFixture>>;
beforeEach(async () => {
  scanner = await makeGitleaksFixture();
  vi.stubEnv('PATH', scanner.path);
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  vi.stubEnv('GIT_ALLOW_PROTOCOL', 'file');
  vi.stubEnv('GIT_AUTHOR_NAME', 'Review fixture');
  vi.stubEnv('GIT_AUTHOR_EMAIL', 'review-fixture@example.invalid');
  vi.stubEnv('GIT_COMMITTER_NAME', 'Review fixture');
  vi.stubEnv('GIT_COMMITTER_EMAIL', 'review-fixture@example.invalid');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(scanner.root, { recursive: true, force: true });
});

const namespace = createHash('sha256')
  .update(JSON.stringify(['octo', 'widget', 7, 'main', null, 'octo/widget', 'feature/x', 'author']))
  .digest('hex');

test('a blocked agent re-review registers its ledger append and settles the receipt', async () => {
  const repo = await makeTestRepo();
  const journal = await mkdtemp(join(tmpdir(), 'cq-address-blocked-rr-'));
  const role = { provider: 'scripted', model: 'worker' };
  try {
    await repo.write('src/a.ts', 'export const a = "BAD";\n');
    await repo.write('scripts/check.cjs', 'process.exitCode=0;\n');
    await repo.write(
      'cq.json',
      JSON.stringify({
        schemaVersion: 2,
        checks: [
          {
            adapter: 'tsc-lines',
            command: { command: process.execPath, args: ['scripts/check.cjs'] },
          },
        ],
        roles: { worker: role, reviewer: role },
        review: { reviewers: ['agent'], rounds: 1 },
        budgets: { run: { maxTokens: 10000, wallMs: 20000 }, step: { wallMs: 5000 } },
        escalation: { workerAttempts: 1, rescueBase: 0 },
      }),
    );
    repo.commitAll('seed PR finding');
    repo.git('push', '-q', 'origin', 'HEAD:refs/pull/7/head', 'HEAD:refs/heads/feature/x');
    const ok = (value: unknown): GhResult => ({
      code: 0,
      stdout: typeof value === 'string' ? value : JSON.stringify(value),
      stderr: '',
    });
    const remoteHead = () =>
      repo.git('ls-remote', 'origin', 'refs/heads/feature/x').split(/\s+/)[0]!;
    const prHead = () => repo.git('ls-remote', 'origin', 'refs/pull/7/head').split(/\s+/)[0]!;
    // The composition publishes the review branch; advancing the PR head is
    // the external event each next invocation fetches (the original fixture's
    // refs/pull push between runs).
    const advancePrHead = () =>
      repo.git('-C', workerRoot, 'push', '-q', 'origin', 'HEAD:refs/pull/7/head');
    const resolvedThreads = new Set<string>();
    const actions: string[] = [];
    const replies: Array<{ id: number; in_reply_to_id: number; body: string }> = [];
    // T2 appears only after the first run completed successfully.
    let secondThread = false;
    const threads = () => [
      {
        id: 'T1',
        isResolved: resolvedThreads.has('T1'),
        isOutdated: false,
        path: 'src/a.ts',
        line: 1,
        comments: {
          nodes: [
            {
              databaseId: 101,
              author: { login: 'reviewer', __typename: 'User' },
              body: 'Replace BAD with GOOD',
              createdAt: new Date(Date.now() - 120000).toISOString(),
            },
          ],
        },
      },
      ...(secondThread
        ? [
            {
              id: 'T2',
              isResolved: resolvedThreads.has('T2'),
              isOutdated: false,
              path: 'src/a.ts',
              line: 1,
              comments: {
                nodes: [
                  {
                    databaseId: 102,
                    author: { login: 'reviewer', __typename: 'User' },
                    body: 'Also replace BAD with BETTER',
                    createdAt: new Date(Date.now() - 60000).toISOString(),
                  },
                ],
              },
            },
          ]
        : []),
    ];
    const gh: GhFn = async (args) => {
      if (args[0] === 'repo') return ok({ nameWithOwner: 'octo/widget' });
      if (args[0] === 'pr')
        return ok({
          headRefName: 'feature/x',
          headRepositoryOwner: { login: 'octo' },
          headRepository: { name: 'widget' },
        });
      if (args.includes('user')) return ok('author');
      const flag = (key: string) =>
        args.find((arg) => arg.startsWith(`${key}=`))?.slice(key.length + 1) ?? '';
      if (args.some((arg) => arg.includes('mutation') && arg.includes('resolveReviewThread'))) {
        resolvedThreads.add(flag('threadId'));
        actions.push('resolve');
        return ok({
          data: { resolveReviewThread: { thread: { id: flag('threadId'), isResolved: true } } },
        });
      }
      if (args.includes('POST')) {
        if (args.some((arg) => arg.endsWith('requested_reviewers'))) actions.push('rerequest');
        else {
          actions.push('reply');
          replies.push({
            id: 1001 + replies.length,
            in_reply_to_id: Number(flag('in_reply_to')),
            body: flag('body'),
          });
        }
        return ok({ id: 1001 + replies.length });
      }
      if (args.includes('graphql'))
        return ok({
          data: {
            repository: {
              pullRequest: {
                author: { login: 'author' },
                headRefName: 'feature/x',
                headRefOid: remoteHead(),
                reviewThreads: {
                  nodes: threads(),
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
                reviews: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
              },
            },
          },
        });
      const endpoint = args.find((arg) => arg.startsWith('repos/')) ?? '';
      if (endpoint === 'repos/octo/widget/pulls/7') return ok({ head: { sha: remoteHead() } });
      if (endpoint.includes('/pulls/7/comments'))
        return ok([
          ...threads().flatMap((thread) =>
            thread.comments.nodes.map((comment) => ({
              id: comment.databaseId,
              body: comment.body,
              user: { login: 'reviewer' },
              created_at: comment.createdAt,
            })),
          ),
          ...replies.map((reply) => ({
            ...reply,
            user: { login: 'author' },
            created_at: new Date().toISOString(),
          })),
        ]);
      if (endpoint.includes('/comments') || endpoint.includes('/reviews?')) return ok([]);
      throw new Error(`unexpected fake forge command: ${args.join(' ')}`);
    };
    // The re-review over the second fix is blocked exactly once; every other
    // reviewer call is ok. Partition fan-out makes call-counting unsafe, so the
    // block keys on the re-review's diff content (only run B carries BETTER).
    let blockedBetter = false;
    const usage = { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 };
    const drivers: DriverFactory = {
      resolve: (request) => ({
        lane: 'ai-sdk',
        modelSpec: request.modelSpec,
        driver: {
          run: async (input) => {
            if (input.outputSchema?.name === 'review.agent/v3') {
              const serialized = JSON.stringify({
                prompt: [{ role: 'user', content: [{ type: 'text', text: input.prompt }] }],
              });
              await request.beforeRequest?.(serialized, [{ text: input.prompt }], {
                kind: 'model-request',
              });
              if (input.prompt.includes('BETTER') && !blockedBetter) {
                blockedBetter = true;
                return {
                  stopReason: 'error' as const,
                  structuredOutput: undefined,
                  usage,
                  denials: [],
                };
              }
              return {
                stopReason: 'complete' as const,
                structuredOutput: { findings: [] },
                usage,
                denials: [],
              };
            }
            if (input.outputSchema?.name === 'review.address.closure/v1')
              return {
                stopReason: 'complete' as const,
                structuredOutput: { closed: true, reason: 'verified' },
                usage,
                denials: [],
              };
            if (!input.prompt.startsWith('related-check feedback')) {
              workerRoot = input.workspace!.path;
              const better = input.prompt.includes('BETTER');
              await writeFile(
                join(input.workspace!.path, 'src/a.ts'),
                `export const a = "${better ? 'BETTER' : 'GOOD'}";\n`,
              );
            }
            return {
              stopReason: 'complete' as const,
              structuredOutput: { disposition: 'fixed', reason: 'fixed', evidence: [] },
              usage,
              denials: [],
            };
          },
        },
      }),
    };
    const realGit = makeGhRunner({ bin: 'git', cwd: repo.root });
    const git: GhFn = async (args) =>
      realGit(
        args.map((arg) =>
          arg === 'https://github.com/octo/widget.git'
            ? repo.git('remote', 'get-url', 'origin').trim()
            : arg,
        ),
      );
    const invoke = () =>
      makeReviewAddress({ gh, drivers, git })({
        repoRoot: repo.root,
        source: 'pr:7',
        journalDir: journal,
        rounds: 1,
        push: true,
      });
    const branch = 'cq-review/pr-7';
    // The PR loop reassigns root to the resolved pr-worktree; everything
    // engine-owned lives there, not under the caller checkout.
    let workerRoot = repo.root;
    const ledgerPath = () => devLedgerPath(workerRoot, branch);
    const receiptPath = () =>
      join(repo.root, '.git/cq-review-address', namespace, 'bookkeeping.json');
    const expectReceiptMatchesLedger = async () => {
      const current = JSON.parse(await readFile(receiptPath(), 'utf8')) as {
        branch: string;
        head: string;
        files: Array<{ path: string; sha256: string }>;
      };
      expect(current.branch).toBe(branch);
      const row = current.files.find((entry) => entry.path === relative(workerRoot, ledgerPath()));
      expect(row, JSON.stringify(current.files)).toBeDefined();
      expect(row!.sha256).toBe(
        createHash('sha256')
          .update(await readFile(ledgerPath()))
          .digest('hex'),
      );
    };

    // Run A: fix T1, terminal re-review, everything settles.
    const first = await invoke();
    expect(first.status, JSON.stringify(first.report?.reasons)).toBe('ok');
    expect(actions).toEqual(['reply', 'resolve', 'rerequest']);
    expect(workerRoot, 'driver captured the resolved pr-worktree').not.toBe(repo.root);
    await expectReceiptMatchesLedger();
    const ledgerRecordsA = makeSubprocessDevEffects(workerRoot).openLedger(branch).load().records;
    advancePrHead();

    // Run B: a fresh thread arrives; the fix lands but the re-review is blocked.
    secondThread = true;
    const prHeadBeforeB = prHead();
    const second = await invoke();
    if (second.status !== 'needs-human')
      throw new Error(`run B expected needs-human: ${JSON.stringify(second)}`);
    expect(second.reason ?? '').toMatch(/PR re-review/);
    expect(prHead()).toBe(prHeadBeforeB);
    const ledgerRecordsB = makeSubprocessDevEffects(workerRoot).openLedger(branch).load().records;
    expect(ledgerRecordsB.length).toBeGreaterThan(ledgerRecordsA.length);
    expect(
      ledgerRecordsB.some(
        (entry) => entry.kind === 'cycle' && entry.completion?.kind === 'blocked',
      ),
    ).toBe(true);
    const historyFolder = join(workerRoot, '.cq/review', encodeURIComponent(branch));
    expect((await readdir(historyFolder)).filter((name) => /^\d+\.json$/.test(name))).toHaveLength(
      2,
    );
    // The engine-owned ledger append must be registered even though the
    // review outcome was blocked: the settled receipt carries the final
    // ledger bytes, and the blocked outcome still returned needs-human.
    await expectReceiptMatchesLedger();

    // Run C: the next default invocation must not be refused over bookkeeping.
    // The external world advances the PR head over run B's published fix.
    advancePrHead();
    const third = await invoke();
    expect(third.status, JSON.stringify(third.report?.reasons)).toBe('ok');
    expect(resolvedThreads.has('T2')).toBe(true);
  } finally {
    await repo.cleanup();
    await rm(journal, { recursive: true, force: true });
  }
});
