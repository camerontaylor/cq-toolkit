// The PR review base must be pinned per invocation and actually consumed
// (#v5F9N). With source=pr:... and no explicit base, the engine captures the
// merge-base once from the resolved PR worktree; every admission and
// re-review in the invocation must review that SAME comparison even if the
// live target advances between rounds. This fixture advances the target
// MID-INVOCATION (between round 1 and round 2 of one rounds:2 run) and
// asserts the discriminating leg: the round-2 re-review must carry the
// original comparison's GOOD diff leg. Under live-target behavior the
// advanced target collapses the round-2 merge-base onto the round-1 fix, so
// the re-review is dispatched over an empty comparison instead.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { makeReviewAddress } from '../../../src/ops/review/address.js';
import { makeGhRunner, type GhFn, type GhResult } from '../../../src/adapters/forge-github/gh.js';
import type { DriverFactory, DriverRequest } from '../../../src/driver/factory.js';
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

test('the round-2 re-review keeps the invocation-pinned comparison when the target advances mid-run', async () => {
  const repo = await makeTestRepo();
  const journal = await mkdtemp(join(tmpdir(), 'cq-address-pin-rework-'));
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
    const pinnedBase = repo.git('rev-parse', 'origin/merge-queue').trim();
    const ok = (value: unknown): GhResult => ({
      code: 0,
      stdout: typeof value === 'string' ? value : JSON.stringify(value),
      stderr: '',
    });
    let secondThread = false;
    const resolvedThreads = new Set<string>();
    const replies: Array<{ id: number; in_reply_to_id: number; body: string }> = [];
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
    const forge: GhFn = async (args) => {
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
                headRefOid: repo.git('ls-remote', 'origin', 'refs/pull/7/head').split(/\s+/)[0]!,
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
      if (endpoint === 'repos/octo/widget/pulls/7')
        return ok({
          head: { sha: repo.git('ls-remote', 'origin', 'refs/pull/7/head').split(/\s+/)[0]! },
        });
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
    // Every review.agent/v3 prompt carries explicit Base/Head metadata and its
    // comparison partition; the
    // round-2 re-review's content is the discriminator under test.
    const prompts: string[] = [];
    const reviewBases: string[] = [];
    const reviewHeads: string[] = [];
    const drivers: DriverFactory = {
      resolve: (request: DriverRequest) => ({
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
              const metadata =
                /^Base: ([a-f0-9]{40})\nHead: ([a-f0-9]{40})\nScope: (?:full|uncommitted)$/m.exec(
                  input.prompt,
                );
              expect(
                metadata,
                'v3 reviewer prompts carry valid pinned Base and Head metadata',
              ).not.toBeNull();
              reviewBases.push(metadata![1]!);
              reviewHeads.push(metadata![2]!);
              // Round 1's re-review (seed leg -BAD +GOOD) reports the new
              // thread's change as a finding, which keeps the run in round
              // 2; round 2's re-review (over the T2 fix) returns clean.
              // Everything else returns no findings. Only non-seeded agent
              // prompts are captured (the re-review comparisons under test).
              if (input.prompt.includes('-export const a = "BAD"'))
                return {
                  stopReason: 'complete' as const,
                  structuredOutput: {
                    findings: [
                      {
                        file: 'src/a.ts',
                        line: 1,
                        severity: 'high' as const,
                        text: 'Also replace GOOD with BEST',
                      },
                    ],
                  },
                  usage,
                  denials: [],
                };
              prompts.push(input.prompt);
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
    // GraphQL timeline per invocation: (1) round-1 loop fetchReviewState,
    // (2) round-1 composition fetchReviewState, (3) round-2 loop
    // fetchReviewState, (4) round-2 composition fetchReviewState. The flip
    // fires at (3): round 2's worktree reuse has already completed (the PR
    // head ref never moves, so the unpushed-work guard never trips), and T2
    // plus the advanced target become visible from round 2's threads read
    // onward — the re-review after the T2 fix is the discriminator.
    let graphqlCalls = 0;
    let flipped = false;
    const realGit = makeGhRunner({ bin: 'git', cwd: repo.root });
    const git: GhFn = async (args) =>
      realGit(
        args.map((arg) =>
          arg === 'https://github.com/octo/widget.git'
            ? repo.git('remote', 'get-url', 'origin').trim()
            : arg,
        ),
      );
    const gh: GhFn = async (args) => {
      if (args.includes('graphql')) {
        graphqlCalls++;
        if (graphqlCalls === 3 && !flipped) {
          flipped = true;
          secondThread = true;
          // A stacked parent lands between the rounds: the bare target moves
          // to a commit whose parent chain contains the round-1 fix (built
          // in the shared work repo, which holds the worker's objects), and
          // the shared remote-tracking ref is refreshed — exactly what a
          // real landing leaves behind for round 2's re-review.
          const published = repo
            .git('ls-remote', 'origin', 'refs/heads/feature/x')
            .split(/\s+/)[0]!;
          const tree = repo.git('rev-parse', `${published}^{tree}`).trim();
          const stacked = repo
            .git('commit-tree', tree, '-p', published, '-m', 'stacked parent lands')
            .trim();
          repo.git('push', '-q', 'origin', `${stacked}:refs/heads/merge-queue`);
          repo.git('update-ref', 'refs/remotes/origin/merge-queue', stacked);
          // The loop's stage-5 publish already pushed the fix to feature/x;
          // GitHub keeps refs/pull/7/head tracking it, so round 2's
          // resolution fetch sees the published head and reuses the tree.
          repo.git('push', '-q', 'origin', `${published}:refs/pull/7/head`);
        }
      }
      return forge(args);
    };
    const result = await makeReviewAddress({ gh, drivers, git })({
      repoRoot: repo.root,
      source: 'pr:7',
      journalDir: journal,
      rounds: 2,
      push: true,
    });
    expect(result.status, JSON.stringify(result.report?.reasons)).toBe('ok');
    expect(flipped, 'the flip fired before round 2').toBe(true);
    expect(prompts.length, 'both rounds dispatched re-review partitions').toBeGreaterThan(0);
    expect(reviewBases.length).toBeGreaterThan(0);
    expect(reviewBases.every((base) => base === pinnedBase)).toBe(true);
    expect(reviewHeads.every((head) => /^[a-f0-9]{40}$/.test(head))).toBe(true);
    // DISCRIMINATING: comparison legs render base→HEAD. The invocation's pin
    // is the original seed, so round 2's leg is -BAD +BEST. If the live
    // (advanced) target leaked in, round 2's merge-base collapses onto the
    // round-1 fix and its leg becomes -GOOD +BEST — the -GOOD leg is the
    // leak signature and must never reach a reviewer.
    expect(
      prompts.some((prompt) => prompt.includes('-export const a = "GOOD"')),
      `live base leaked into a re-review comparison (${prompts.length} partitions)`,
    ).toBe(false);
    expect(
      prompts.some((prompt) => prompt.includes('+export const a = "BEST"')),
      'the round-2 re-review must cover the T2 change',
    ).toBe(true);
  } finally {
    await repo.cleanup();
    await rm(journal, { recursive: true, force: true });
  }
});
