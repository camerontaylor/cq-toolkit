// The PR review base must be pinned per invocation (#v5F9N). With
// source=pr:... and no explicit base, every re-review re-resolves the
// merge-base against the live target, so if the target advances during
// addressing (a stacked parent lands), successive rounds review DIFFERENT
// comparisons and the run can report clean against a smaller diff than it
// started with. The engine must capture the immutable base at the initial
// PR checkout and pass it to every admission and re-review in that
// invocation, mirroring the local path's reviewedBase behavior.
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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

test('the PR review base stays pinned while the target advances mid-run', async () => {
  const repo = await makeTestRepo();
  const journal = await mkdtemp(join(tmpdir(), 'cq-address-pin-base-'));
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
        review: { reviewers: ['agent'], rounds: 2 },
        budgets: { run: { maxTokens: 20000, wallMs: 40000 }, step: { wallMs: 5000 } },
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
    let workerRoot = repo.root;
    const advancePrHead = () =>
      repo.git('-C', workerRoot, 'push', '-q', 'origin', 'HEAD:refs/pull/7/head');
    const bare = join(repo.root, '..', 'origin.git');
    // The stacked parent lands: the target advances to a commit whose parent
    // chain CONTAINS the current PR head, so the live merge-base collapses to
    // the fix commit and the naive round-2 comparison becomes empty.
    const advanceTargetOverHead = () => {
      const previous = remoteHead();
      const tree = execFileSync('git', ['--git-dir', bare, 'rev-parse', `${previous}^{tree}`], {
        encoding: 'utf8',
      }).trim();
      const created = execFileSync(
        'git',
        ['--git-dir', bare, 'commit-tree', tree, '-p', previous, '-m', 'stacked parent lands'],
        { encoding: 'utf8', env: process.env },
      ).trim();
      execFileSync('git', ['--git-dir', bare, 'update-ref', 'refs/heads/merge-queue', created]);
      return created;
    };
    const resolvedThreads = new Set<string>();
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
                    body: 'Also replace GOOD with BEST',
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
        return ok({
          data: { resolveReviewThread: { thread: { id: flag('threadId'), isResolved: true } } },
        });
      }
      if (args.includes('POST')) return ok({ id: 1001 + replies.length });
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
    const usage = { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 };
    // The re-review's comparison is observable in the agent prompt: it embeds
    // the reviewed diff legs (one per changed file). The test swaps the
    // capture target per invocation.
    let capture: string[] | undefined;
    const drivers: DriverFactory = {
      resolve: (request) => ({
        lane: 'ai-sdk',
        modelSpec: request.modelSpec,
        driver: {
          run: async (input) => {
            if (input.outputSchema?.name === 'review.agent/v2') {
              capture?.push(input.prompt);
              return {
                stopReason: 'complete' as const,
                structuredOutput: {
                  receipt: /receipt: ([a-f0-9]{64})/.exec(input.prompt)?.[1],
                  findings: [],
                },
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
              const content = input.prompt.includes('BEST') ? 'BEST' : 'GOOD';
              await writeFile(
                join(input.workspace!.path, 'src/a.ts'),
                `export const a = "${content}";\n`,
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
        rounds: 2,
        push: true,
      });

    // Run 1: fix T1, publish, resolve. Round 1's comparison covers the seed.
    const first = await invoke();
    expect(first.status, JSON.stringify(first.report?.reasons)).toBe('ok');
    expect(workerRoot).not.toBe(repo.root);

    // The stacked parent lands mid-addressing; a second thread arrives, so
    // the next invocation runs a second round against the advanced target.
    // The published fix was already pushed to the PR head; then the target
    // advances to a commit whose parent chain CONTAINS that fix, so the live
    // merge-base collapses onto the fix commit and the naive round-2
    // comparison becomes empty.
    advancePrHead();
    advanceTargetOverHead();
    secondThread = true;
    capture = [];
    const second = await invoke();
    expect(second.status, JSON.stringify(second.report?.reasons)).toBe('ok');
    // The round-2 re-review must still review the SAME comparison this
    // invocation started with (the engine-captured base), not the shrunken
    // live merge-base against the advanced target: the reviewed diff must
    // carry the fix's src/a.ts leg, not an empty comparison.
    expect(capture!.length, 'run-2 re-review prompts').toBeGreaterThan(0);
    expect(
      capture!.some(
        (prompt) => prompt.includes('src/a.ts') && prompt.includes('export const a = "BEST"'),
      ),
      `round-2 comparisons: ${JSON.stringify(capture!.map((prompt) => prompt.length))}`,
    ).toBe(true);
  } finally {
    await repo.cleanup();
    await rm(journal, { recursive: true, force: true });
  }
});
