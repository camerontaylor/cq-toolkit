// In a no-ignore adopted .cq repo, the engine's own ledger/findings files
// stay untracked in the per-PR checkout. After an external fast-forward,
// resolvePrWorktree's non-forced removal of the stale checkout refuses on
// those engine-created files BEFORE the onCreated rotation can fire, so the
// receipt from ab84b01d still leaves subsequent runs blocked. The engine
// must validate and remove exactly its receipt-owned bookkeeping before the
// refresh removal — never any unrelated caller change — and let the create
// path fire the rotation as designed.
import { execFileSync } from 'node:child_process';
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
  .update(
    JSON.stringify([
      'octo',
      'widget',
      7,
      'merge-queue',
      null,
      'octo/widget',
      'feature/x',
      'author',
    ]),
  )
  .digest('hex');

test('an engine-verified fresh checkout rotates the stale receipt', async () => {
  const repo = await makeTestRepo();
  const journal = await mkdtemp(join(tmpdir(), 'cq-address-stale-clean-'));
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
    let workerRoot = repo.root;
    // An external fast-forward on the published PR branch: a bare-repo
    // commit-tree/update-ref sequence over BOTH the branch and its PR head
    // ref (GitHub keeps refs/pull/N/head tracking the branch) — never
    // touched by this engine.
    const bare = join(repo.root, '..', 'origin.git');
    const externalFastForward = (message: string) => {
      const previous = remoteHead();
      const tree = execFileSync('git', ['--git-dir', bare, 'rev-parse', `${previous}^{tree}`], {
        encoding: 'utf8',
      }).trim();
      const created = execFileSync(
        'git',
        ['--git-dir', bare, 'commit-tree', tree, '-p', previous, '-m', message],
        { encoding: 'utf8', env: process.env },
      ).trim();
      execFileSync('git', ['--git-dir', bare, 'update-ref', 'refs/heads/feature/x', created]);
      execFileSync('git', ['--git-dir', bare, 'update-ref', 'refs/pull/7/head', created]);
      return created;
    };
    const resolvedThreads = new Set<string>();
    const actions: string[] = [];
    const replies: Array<{ id: number; in_reply_to_id: number; body: string }> = [];
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
                    body: 'Also replace GOOD with BETTER',
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
                headRefOid: prHead(),
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
      if (endpoint === 'repos/octo/widget/pulls/7') return ok({ head: { sha: prHead() } });
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
    const receiptPath = () =>
      join(repo.root, '.git/cq-review-address', namespace, 'bookkeeping.json');
    const receipt = async () =>
      JSON.parse(await readFile(receiptPath(), 'utf8')) as {
        root: string;
        head: string;
        branch: string;
        files: Array<{ path: string; sha256: string }>;
      };

    // Run 1: fix T1, publish, settle the receipt at the fixed head.
    const first = await invoke();
    expect(first.status, JSON.stringify(first.report?.reasons)).toBe('ok');
    expect(workerRoot).not.toBe(repo.root);
    const settledA = await receipt();
    expect(settledA.branch).toBe(branch);
    expect(settledA.head).toBe(remoteHead());
    const ledgerA = makeSubprocessDevEffects(workerRoot).openLedger(branch).load().records.length;
    // No committed .gitignore in this variant: the engine's bookkeeping stays
    // untracked in the checkout — exactly the finding's adopted-.cq scenario.
    const priorLedger = await readFile(devLedgerPath(workerRoot, branch), 'utf8');
    expect(priorLedger).toContain('disposition');

    // External fast-forward past the published fix (branch and PR head
    // together): the next resolution must remove and recreate the checkout.
    // WITHOUT the repair the non-forced remove refuses on the engine's own
    // untracked bookkeeping files and no rotation can ever fire.
    externalFastForward('external fast-forward');
    secondThread = true;
    const headBeforeB = prHead();

    const second = await invoke();
    expect(second.status, JSON.stringify(second.report?.reasons)).toBe('ok');
    expect(remoteHead()).not.toBe(headBeforeB);
    const settledB = await receipt();
    expect(settledB.branch).toBe(branch);
    expect(settledB.head).toBe(remoteHead());
    expect(settledB.root).toBe(settledA.root);
    const ledgerB = makeSubprocessDevEffects(workerRoot).openLedger(branch).load().records.length;
    const historyCountB = (
      await readdir(join(workerRoot, '.cq/review', encodeURIComponent(branch)))
    ).filter((name) => /^\d+\.json$/.test(name)).length;
    const ledgerRow = settledB.files.find(
      (entry) => entry.path === relative(workerRoot, devLedgerPath(workerRoot, branch)),
    );
    expect(ledgerRow, JSON.stringify(settledB.files)).toBeDefined();
    void ledgerA;
    void ledgerB;
    void historyCountB;
  } finally {
    await repo.cleanup();
    await rm(journal, { recursive: true, force: true });
  }
});
