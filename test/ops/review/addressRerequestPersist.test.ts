// Pending reviewer re-requests must survive a failed run (#v4kjJ). A human
// reviewer's thread is fixed and pushed, but the agent re-review or the
// reviewer-request API fails, so the run exits before re-requesting them.
// On the next invocation fixesById is empty for the already-resolved thread,
// so without persistence the author is never re-requested and the run can
// return ok without ever asking for the human's review. With the repair the
// pending re-request is persisted alongside the publication receipts and
// cleared only after a successful dispatch.
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { makeReviewAddress } from '../../../src/ops/review/address.js';
import { makeGhRunner, type GhFn, type GhResult } from '../../../src/adapters/forge-github/gh.js';
import type { DriverFactory } from '../../../src/driver/factory.js';
import { makeTestRepo } from '../dev/repo.js';
import { makeGitleaksFixture } from '../../helpers/gitleaks-fixture.js';

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

test('a failed re-request is recovered on the next invocation', async () => {
  const repo = await makeTestRepo();
  const journal = await mkdtemp(join(tmpdir(), 'cq-address-rerequest-'));
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
    const advancePrHead = () =>
      repo.git('-C', workerRoot, 'push', '-q', 'origin', 'HEAD:refs/pull/7/head');
    const resolvedThreads = new Set<string>();
    const actions: string[] = [];
    const replies: Array<{ id: number; in_reply_to_id: number; body: string }> = [];
    const reRequested = new Set<string>();
    // Run 1's re-review works; only the reviewer-request API fails.
    let failReRequest = true;
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
              author: { login: 'octocat', __typename: 'User' },
              body: 'Replace BAD with GOOD',
              createdAt: new Date(Date.now() - 120000).toISOString(),
            },
          ],
        },
      },
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
        if (args.some((arg) => arg.endsWith('requested_reviewers'))) {
          for (const [index, value] of args.entries())
            if (value === 'reviewers[]=octocat') reRequested.add(`run${index}`);
          if (failReRequest) {
            actions.push('rerequest-failed');
            return { code: 1, stdout: '', stderr: 'service unavailable' };
          }
          actions.push('rerequest');
        } else {
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
          ...threads().map((thread) => ({
            id: thread.comments.nodes[0]!.databaseId,
            body: thread.comments.nodes[0]!.body,
            user: { login: 'octocat' },
            created_at: thread.comments.nodes[0]!.createdAt,
          })),
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
            if (input.outputSchema?.name === 'review.agent/v2')
              return {
                stopReason: 'complete' as const,
                structuredOutput: {
                  receipt: /receipt: ([a-f0-9]{64})/.exec(input.prompt)?.[1],
                  findings: [],
                },
                usage,
                denials: [],
              };
            if (input.outputSchema?.name === 'review.address.closure/v1')
              return {
                stopReason: 'complete' as const,
                structuredOutput: { closed: true, reason: 'verified' },
                usage,
                denials: [],
              };
            if (!input.prompt.startsWith('related-check feedback')) {
              workerRoot = input.workspace!.path;
              await writeFile(
                join(input.workspace!.path, 'src/a.ts'),
                'export const a = "GOOD";\n',
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
    let workerRoot = repo.root;
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
    const pendingPath = join(
      repo.root,
      '.git/cq-review-address',
      namespace,
      'pending-rerequests.json',
    );

    // Run 1: the fix lands, the re-review is fine, the re-request API fails.
    const first = await invoke();
    expect(first.status).toBe('needs-human');
    expect(actions).toEqual(['reply', 'resolve', 'rerequest-failed']);
    // The pending re-request is durably recorded beside the publication receipts.
    const pending = JSON.parse(await readFile(pendingPath, 'utf8')) as string[];
    expect(pending).toContain('octocat');

    // Run 2: the thread is now resolved externally; a fresh fixesById must not
    // lose the human reviewer, and a successful re-request clears the store.
    resolvedThreads.add('T1');
    failReRequest = false;
    advancePrHead();
    const second = await invoke();
    expect(second.status, JSON.stringify(second.report?.reasons)).toBe('ok');
    expect(actions).toEqual(['reply', 'resolve', 'rerequest-failed', 'rerequest']);
    expect(reRequested.size).toBeGreaterThanOrEqual(1);
    await expect(readFile(pendingPath)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await repo.cleanup();
    await rm(journal, { recursive: true, force: true });
  }
});
