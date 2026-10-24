import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { makeReviewAddress } from '../../../src/ops/review/address.js';
import type { GhFn, GhResult } from '../../../src/adapters/forge-github/gh.js';
import type { DriverFactory } from '../../../src/driver/factory.js';
import { makeTestRepo } from '../dev/repo.js';
import { makeGitleaksFixture } from '../../helpers/gitleaks-fixture.js';
import { readWorkState } from '../../../src/ops/dev/internal/workState.js';
import { fileWorktreeRegistry, resolvePrWorktree } from '../../../src/adapters/git/prWorktree.js';
import { makeGhRunner } from '../../../src/adapters/forge-github/gh.js';
import {
  replySignature,
  replyHeadStamp,
  settleRound,
  REPLY_RESOLVE_MARKER,
} from '../../../src/plans/review-loop.js';
import { cycleRecord } from '../dev/fakes.js';
import { DEV_LEDGER_VERSION } from '../../../src/ops/dev/record.js';
import { createEscalationState } from '../../../src/ops/fix/escalation.js';
import { makeSubprocessDevEffects } from '../../../src/ops/dev/effects.js';

let scanner: Awaited<ReturnType<typeof makeGitleaksFixture>>;
beforeEach(async () => {
  scanner = await makeGitleaksFixture();
  vi.stubEnv('PATH', scanner.path);
  // Real PR/candidate checkouts must not inherit the host's global Git identity.
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  vi.stubEnv('GIT_AUTHOR_NAME', 'Review fixture');
  vi.stubEnv('GIT_AUTHOR_EMAIL', 'review-fixture@example.invalid');
  vi.stubEnv('GIT_COMMITTER_NAME', 'Review fixture');
  vi.stubEnv('GIT_COMMITTER_EMAIL', 'review-fixture@example.invalid');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(scanner.root, { recursive: true, force: true });
});

test('real PR adapter ref collision preserves admission and fresh re-review identity', async () => {
  const repo = await makeTestRepo();
  const journal = await mkdtemp(join(tmpdir(), 'cq-address-pr-git-'));
  const role = { provider: 'scripted', model: 'worker' };
  try {
    await repo.write('.gitignore', '.cq/\n');
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
    const initial = repo.commitAll('seed PR finding');
    repo.git('push', '-q', 'origin', 'HEAD:refs/pull/7/head', 'HEAD:refs/heads/feature/x');
    const before = await readWorkState(makeSubprocessDevEffects(repo.root), {
      target: 'merge-queue',
    });
    expect(before.ok && before.state.branch).toBe('feature/x');
    const ok = (value: unknown): GhResult => ({
      code: 0,
      stdout: typeof value === 'string' ? value : JSON.stringify(value),
      stderr: '',
    });
    const gh: GhFn = async (args) => {
      if (args[0] === 'repo') return ok({ nameWithOwner: 'octo/widget' });
      if (args[0] === 'pr')
        return ok({
          headRefName: 'feature/x',
          headRepositoryOwner: { login: 'octo' },
          headRepository: { name: 'widget' },
        });
      if (args.includes('user')) return ok('author');
      if (args.includes('POST')) throw new Error('publication opt-out forbids forge writes');
      if (args.includes('graphql'))
        return ok({
          data: {
            repository: {
              pullRequest: {
                author: { login: 'author' },
                headRefName: 'feature/x',
                headRefOid: initial,
                reviewThreads: {
                  nodes: [
                    {
                      id: 'T1',
                      isResolved: false,
                      isOutdated: false,
                      path: 'src/a.ts',
                      line: 1,
                      comments: {
                        nodes: [
                          {
                            databaseId: 101,
                            author: { login: 'reviewer', __typename: 'User' },
                            body: 'Replace BAD with GOOD',
                            createdAt: new Date(Date.now() - 60000).toISOString(),
                          },
                        ],
                      },
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
                reviews: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
              },
            },
          },
        });
      const endpoint = args.find((arg) => arg.startsWith('repos/')) ?? '';
      if (endpoint === 'repos/octo/widget/pulls/7') return ok({ head: { sha: initial } });
      if (endpoint.includes('/comments') || endpoint.includes('/reviews?')) return ok([]);
      throw new Error(`unexpected fake forge command: ${args.join(' ')}`);
    };
    const invocations: string[] = [];
    let workerRoot = '';
    const drivers: DriverFactory = {
      resolve: (request) => ({
        lane: 'ai-sdk',
        modelSpec: request.modelSpec,
        driver: {
          run: async (input) => {
            const schema = input.outputSchema!.name;
            invocations.push(schema);
            let output: unknown;
            if (schema === 'review.agent/v1') {
              expect(await readFile(join(input.workspace!.path, 'src/a.ts'), 'utf8')).toContain(
                'GOOD',
              );
              output = { findings: [] };
            } else if (schema === 'review.address.closure/v1')
              output = { closed: true, reason: 'verified candidate' };
            else {
              if (!input.prompt.startsWith('related-check feedback')) {
                workerRoot = input.workspace!.path;
                await writeFile(join(workerRoot, 'src/a.ts'), 'export const a = "GOOD";\n');
              }
              output = { disposition: 'fixed', reason: 'fixed', evidence: [] };
            }
            return {
              stopReason: 'complete',
              structuredOutput: output,
              usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 },
              denials: [],
            };
          },
        },
      }),
    };
    const result = await makeReviewAddress({ gh, drivers })({
      repoRoot: repo.root,
      source: 'pr:7',
      journalDir: journal,
      rounds: 1,
    });
    const report = result.status === 'ok' ? result.value : result.report!;
    expect(report.fixesPerRun, JSON.stringify(report.reasons)).toBe(1);
    expect(report.fixes[0]?.commit).toBeTruthy();
    expect(
      repo
        .git(
          '-C',
          workerRoot,
          'show',
          '-s',
          '--format=%an <%ae>|%cn <%ce>',
          report.fixes[0]!.commit!,
        )
        .trim(),
    ).toBe(
      'Review fixture <review-fixture@example.invalid>|Review fixture <review-fixture@example.invalid>',
    );
    expect(report.rounds).toHaveLength(1);
    expect(report.rounds[0]?.record.branch).toBe('cq-review/pr-7');
    expect(report.reasons.join('\n')).not.toMatch(
      /identity changed|admission|branch changed|unknown finding|disposition persistence|could not be persisted/,
    );
    const ledger = makeSubprocessDevEffects(workerRoot).openLedger('cq-review/pr-7').load();
    expect(ledger.records.filter((entry) => entry.kind === 'disposition')).toEqual([
      expect.objectContaining({
        kind: 'disposition',
        findingId: 'T1',
        action: 'fixed',
        head: report.fixes[0]?.commit,
      }),
    ]);
    expect(invocations).toEqual([
      'review.address.outcome/v1',
      'review.address.outcome/v1',
      'review.address.closure/v1',
      'review.agent/v1',
    ]);
    // The real adapter, not the test, creates both colliding refs.
    expect(repo.git('-C', workerRoot, 'symbolic-ref', '--short', 'HEAD').trim()).toBe(
      'heads/cq-review/pr-7',
    );
    const state = await readWorkState(makeSubprocessDevEffects(workerRoot), {
      target: 'merge-queue',
    });
    expect(state.ok && state.state.branch).toBe('cq-review/pr-7');
    expect(state.ok && state.state.head).toBe(report.fixes[0]?.commit);
    expect((await scanner.calls()).length).toBeGreaterThan(3);
    expect(result.status).toBe('needs-human'); // Verified local fix, forge thread stays open without --push.
  } finally {
    await repo.cleanup();
    await rm(journal, { recursive: true, force: true });
  }
});

test.each([
  'proven',
  'missing-record',
  'record-other-head',
  'wrong-author',
  'missing-reply',
  'legacy',
  'stale-round',
  'resolve-intent',
] as const)(
  'real persisted rejection carry requires current authenticated proof: %s',
  async (mode) => {
    const repo = await makeTestRepo();
    const journal = await mkdtemp(join(tmpdir(), 'cq-address-rejection-'));
    try {
      await repo.write('.gitignore', '.cq/\n');
      repo.commitAll('ignore engine state');
      const head = repo.git('rev-parse', 'HEAD').trim();
      repo.git('push', '-q', 'origin', 'HEAD:refs/pull/7/head');
      const registry = fileWorktreeRegistry(join(journal, 'worktrees.json'));
      const worktree = await resolvePrWorktree({
        repoRoot: repo.root,
        pr: 7,
        headRefName: 'feature/x',
        registry,
        run: makeGhRunner({ bin: 'git' }),
        nowMs: Date.now(),
      });
      const effects = makeSubprocessDevEffects(worktree.path);
      effects.openLedger(worktree.branch).save({
        version: DEV_LEDGER_VERSION,
        branch: worktree.branch,
        records: [
          cycleRecord({
            head,
            findings: [{ id: 'T1', severity: 'major', excerpt: 'False positive' }],
          }),
          ...(mode === 'missing-record'
            ? []
            : [
                {
                  kind: 'disposition' as const,
                  findingId: 'T1',
                  action: 'rejected' as const,
                  why: 'Verified false positive',
                  head: mode === 'record-other-head' ? 'a'.repeat(40) : head,
                  at: new Date().toISOString(),
                },
              ]),
        ],
      });
      const body = 'False positive';
      const round = settleRound({ id: 'T1', body }, []);
      const reply =
        mode === 'legacy'
          ? replySignature('octo', 'widget', 7)
          : `${replySignature('octo', 'widget', 7)}\n${replyHeadStamp(head, mode === 'stale-round' ? '00000000' : round)}${mode === 'resolve-intent' ? `\n${REPLY_RESOLVE_MARKER}` : ''}\n\nRejected with evidence`;
      const ok = (value: unknown): GhResult => ({
        code: 0,
        stdout: typeof value === 'string' ? value : JSON.stringify(value),
        stderr: '',
      });
      const gh: GhFn = async (args) => {
        if (args[0] === 'repo') return ok({ nameWithOwner: 'octo/widget' });
        if (args[0] === 'pr')
          return ok({
            headRefName: 'feature/x',
            headRepositoryOwner: { login: 'octo' },
            headRepository: { name: 'widget' },
          });
        if (args.includes('user')) return ok('author');
        if (args.includes('POST')) throw new Error('test forbids forge writes');
        if (args.includes('graphql'))
          return ok({
            data: {
              repository: {
                pullRequest: {
                  author: { login: 'author' },
                  headRefName: 'feature/x',
                  headRefOid: head,
                  reviewThreads: {
                    nodes: [
                      {
                        id: 'T1',
                        isResolved: false,
                        isOutdated: false,
                        path: 'src/a.ts',
                        line: 1,
                        comments: {
                          nodes: [
                            {
                              databaseId: 101,
                              author: { login: 'reviewer', __typename: 'User' },
                              body,
                              createdAt: new Date(Date.now() - 60000).toISOString(),
                            },
                          ],
                        },
                      },
                    ],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                  reviews: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
                },
              },
            },
          });
        const endpoint = args.find((arg) => arg.startsWith('repos/')) ?? '';
        if (endpoint === 'repos/octo/widget/pulls/7') return ok({ head: { sha: head } });
        if (endpoint.startsWith('repos/octo/widget/pulls/7/comments?'))
          return ok(
            mode === 'missing-reply'
              ? [
                  {
                    id: 101,
                    user: { login: 'reviewer' },
                    body,
                    created_at: new Date(Date.now() - 60000).toISOString(),
                  },
                ]
              : [
                  {
                    id: 101,
                    user: { login: 'reviewer' },
                    body,
                    created_at: new Date(Date.now() - 60000).toISOString(),
                  },
                  {
                    id: 102,
                    in_reply_to_id: 101,
                    user: { login: mode === 'wrong-author' ? 'mallory' : 'author' },
                    body: reply,
                    created_at: new Date(Date.now() - 30000).toISOString(),
                  },
                ],
          );
        if (endpoint.includes('/comments') || endpoint.includes('/reviews?')) return ok([]);
        throw new Error(`unexpected fake forge: ${args.join(' ')}`);
      };
      let attempts = 0;
      const role = { provider: 'scripted', model: 'worker' };
      const result = await makeReviewAddress({
        gh,
        worktreeRegistry: registry,
        config: {
          schemaVersion: 2,
          checks: [{ adapter: 'tsc-lines', command: { command: process.execPath, args: [] } }],
          roles: { worker: role, reviewer: role },
          budgets: { run: { maxTokens: 10000 } },
          review: { reviewers: ['agent'], rounds: 1 },
        },
        review: async () => ({
          status: 'ok',
          value: {
            schemaVersion: 1,
            branch: worktree.branch,
            head,
            sources: [{ kind: 'agent', status: 'terminal' }],
            findings: [],
          },
        }),
        workerFactory: () => ({
          escalation: createEscalationState,
          fix: async (finding) => {
            attempts++;
            return {
              finding: { ...finding, status: 'deferred', reason: 'needs investigation' },
              reason: 'needs investigation',
              observedHead: head,
              validation: [],
            };
          },
        }),
      })({ repoRoot: repo.root, source: 'pr:7', journalDir: journal, rounds: 1 });
      const report = result.status === 'ok' ? result.value : result.report!;
      expect(result.status, JSON.stringify(report.reasons)).toBe(
        mode === 'proven' ? 'ok' : 'needs-human',
      );
      if (mode === 'proven')
        expect(report.findings.find((finding) => finding.id === 'T1')?.status).toBe('rejected');
      else
        expect(report.findings.find((finding) => finding.id === 'T1')?.status).not.toBe('rejected');
      if (mode === 'proven') {
        expect(attempts).toBe(0);
        expect(report.openBlocking).toEqual([]);
      } else expect(report.openBlocking.some((finding) => finding.id === 'T1')).toBe(true);
    } finally {
      await repo.cleanup();
      await rm(journal, { recursive: true, force: true });
    }
  },
);
