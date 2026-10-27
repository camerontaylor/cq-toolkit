import { createHash } from 'node:crypto';
import {
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
  mkdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { makeAddressWorker } from '../../../src/ops/review/addressWorker.js';
import { makeReviewAddress } from '../../../src/ops/review/address.js';
import type { GhFn, GhResult } from '../../../src/adapters/forge-github/gh.js';
import type { DriverFactory, DriverRequest } from '../../../src/driver/factory.js';
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
import { DEV_LEDGER_VERSION, devLedgerPath } from '../../../src/ops/dev/record.js';
import { createEscalationState } from '../../../src/ops/fix/escalation.js';
import { makeSubprocessDevEffects } from '../../../src/ops/dev/effects.js';

// Hold the real ledger writer at a deterministic shared-checkout rendezvous.
const ledgerRace = vi.hoisted(() => ({
  beforeDisposition: undefined as (() => Promise<void>) | undefined,
  beforeRename: undefined as ((from: string, to: string) => void) | undefined,
}));
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return {
    ...fs,
    renameSync: (from: string, to: string) => {
      ledgerRace.beforeRename?.(from, to);
      return fs.renameSync(from, to);
    },
  };
});
vi.mock('../../../src/ops/dev/disposition.js', async (original) => {
  const module = await original<typeof import('../../../src/ops/dev/disposition.js')>();
  return {
    ...module,
    makeDevDisposition: (...args: Parameters<typeof module.makeDevDisposition>) => {
      const op = module.makeDevDisposition(...args);
      return async (input: Parameters<typeof op>[0]) => {
        await ledgerRace.beforeDisposition?.();
        return op(input);
      };
    },
  };
});

let scanner: Awaited<ReturnType<typeof makeGitleaksFixture>>;
beforeEach(async () => {
  scanner = await makeGitleaksFixture();
  vi.stubEnv('PATH', scanner.path);
  // Real PR/candidate checkouts must not inherit the host's global Git identity.
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  vi.stubEnv('GIT_ALLOW_PROTOCOL', 'file');
  vi.stubEnv('GIT_AUTHOR_NAME', 'Review fixture');
  vi.stubEnv('GIT_AUTHOR_EMAIL', 'review-fixture@example.invalid');
  vi.stubEnv('GIT_COMMITTER_NAME', 'Review fixture');
  vi.stubEnv('GIT_COMMITTER_EMAIL', 'review-fixture@example.invalid');
});
afterEach(async () => {
  ledgerRace.beforeDisposition = undefined;
  ledgerRace.beforeRename = undefined;
  vi.unstubAllEnvs();
  await rm(scanner.root, { recursive: true, force: true });
});

test.each([
  'local-only',
  'publish',
  'publish-reuse',
  'publish-reuse-alias',
  'publish-reuse-modified-ledger',
  'publish-reuse-modified-history',
  'publish-reuse-caller',
  'publish-reuse-unregistered',
  'publish-reuse-malformed',
  'publish-reuse-missing-receipt',
  'publish-reuse-corrupt-receipt',
  'publish-reuse-partial-receipt',
  'publish-reuse-wrong-branch',
  'publish-reuse-wrong-root',
  'publish-reuse-wrong-identity',
  'publish-reuse-stale-head',
  'publish-siblings',
  'publish-admission-transition',
  'publish-siblings-ledger-snapshot',
  'publish-rejection',
  'publish-rejection-refreshed',
  'caller-file',
  'caller-cq',
  'caller-ledger-temp',
  'caller-index',
  'bookkeeping-tamper',
  'bookkeeping-before-disposition',
] as const)(
  'real PR adapter without cq ignore preserves admission and publication hygiene: %s',
  async (mode) => {
    const refreshedRejection = mode === 'publish-rejection-refreshed';
    const rejection = mode === 'publish-rejection' || refreshedRejection;
    const admissionTransition = mode === 'publish-admission-transition';
    const ledgerSnapshot = mode === 'publish-siblings-ledger-snapshot';
    const siblings =
      mode === 'publish-siblings' || ledgerSnapshot || rejection || admissionTransition;
    const reuse = mode.startsWith('publish-reuse');
    const refusedReuse = reuse && mode !== 'publish-reuse' && mode !== 'publish-reuse-alias';
    const publish = mode === 'publish' || reuse || siblings;
    const earlyTamper = mode === 'bookkeeping-before-disposition';
    const tampered = mode === 'bookkeeping-tamper' || earlyTamper;
    const repo = await makeTestRepo();
    const journal = await mkdtemp(join(tmpdir(), 'cq-address-pr-git-'));
    const role = { provider: 'scripted', model: 'worker' };
    try {
      await repo.write('src/a.ts', 'export const a = "BAD";\n');
      if (siblings) await repo.write('src/b.ts', 'export const b = "BAD";\n');
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
      let reuseRound = false;
      const resolvedThreads = new Set<string>();
      const actions: string[] = [];
      const replies: Array<{
        id: number;
        in_reply_to_id: number;
        body: string;
        user: { login: string };
        created_at: string;
      }> = [];
      const rootCreatedAt = new Date(Date.now() - 60000).toISOString();
      const remoteHead = () =>
        repo.git('ls-remote', 'origin', 'refs/heads/feature/x').split(/\s+/)[0]!;
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
          expect(publish).toBe(true);
          expect(remoteHead()).not.toBe(initial);
          expect(
            replies.some(
              (reply) =>
                reply.in_reply_to_id === (reuseRound ? 103 : flag('threadId') === 'T1' ? 101 : 102),
            ),
          ).toBe(true);
          resolvedThreads.add(flag('threadId'));
          actions.push('resolve');
          return ok({
            data: { resolveReviewThread: { thread: { id: flag('threadId'), isResolved: true } } },
          });
        }
        if (args.includes('POST')) {
          expect(publish).toBe(true);
          expect(remoteHead()).not.toBe(initial);
          if (args.some((arg) => arg.endsWith('requested_reviewers'))) actions.push('rerequest');
          else {
            actions.push('reply');
            replies.push({
              id: 1001 + replies.length,
              in_reply_to_id: Number(flag('in_reply_to')),
              body: flag('body'),
              user: { login: 'author' },
              created_at: new Date().toISOString(),
            });
          }
          return ok({ id: replies.at(-1)?.id ?? 1001 });
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
                    nodes: (siblings ? ['T1', 'T2'] : ['T1']).map((id, index) => ({
                      id: reuseRound ? 'T2' : id,
                      isResolved: resolvedThreads.has(reuseRound ? 'T2' : id),
                      isOutdated: false,
                      path: index === 0 ? 'src/a.ts' : 'src/b.ts',
                      line: 1,
                      comments: {
                        nodes: [
                          {
                            databaseId: (reuseRound ? 103 : 101) + index,
                            author: { login: 'reviewer', __typename: 'User' },
                            body: reuseRound ? 'Replace GOOD with BETTER' : 'Replace BAD with GOOD',
                            createdAt: rootCreatedAt,
                          },
                        ],
                      },
                    })),
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
            // REST reply chains require their real roots to authenticate discussion proof.
            ...(siblings ? [101, 102] : [reuseRound ? 103 : 101]).map((id) => ({
              id,
              body: reuseRound ? 'Replace GOOD with BETTER' : 'Replace BAD with GOOD',
              user: { login: 'reviewer' },
              created_at: rootCreatedAt,
            })),
            ...replies,
            ...(refreshedRejection && replies.some((reply) => reply.in_reply_to_id === 102)
              ? [
                  {
                    id: 2001,
                    in_reply_to_id: 102,
                    body: 'Fresh review feedback: the cited sibling does not settle this finding.',
                    user: { login: 'reviewer' },
                    created_at: new Date(Date.now() + 1000).toISOString(),
                  },
                ]
              : []),
          ]);
        if (endpoint.includes('/comments') || endpoint.includes('/reviews?')) return ok([]);
        throw new Error(`unexpected fake forge command: ${args.join(' ')}`);
      };
      const invocations: string[] = [];
      let workerRoot = '';
      let editing = 0,
        maximumEditing = 0,
        enteredEdits = 0;
      let releaseEdits!: () => void;
      const editGate = new Promise<void>((resolve) => {
        releaseEdits = resolve;
      });
      let rejectionQueued!: () => void;
      const queued = new Promise<void>((resolve) => {
        rejectionQueued = resolve;
      });
      let firstVerified!: () => void;
      const verified = new Promise<void>((resolve) => {
        firstVerified = resolve;
      });
      let captureStarted!: () => void;
      const capturedAdmission = new Promise<void>((resolve) => {
        captureStarted = resolve;
      });
      let firstEditing!: () => void;
      const firstEdit = new Promise<void>((resolve) => {
        firstEditing = resolve;
      });
      let adapterBranches = 0;
      let heldAdmission = false;
      let fencedAdmissions = 0;
      const drivers: DriverFactory = {
        resolve: (request: DriverRequest) => ({
          lane: 'ai-sdk',
          modelSpec: request.modelSpec,
          driver: {
            run: async (input, options) => {
              const schema = input.outputSchema!.name;
              invocations.push(schema);
              let output: unknown;
              if (schema === 'review.agent/v3') {
                const serialized = JSON.stringify({
                  prompt: [{ role: 'user', content: [{ type: 'text', text: input.prompt }] }],
                });
                await request.beforeRequest?.(serialized, [{ text: input.prompt }], {
                  kind: 'model-request',
                });
                expect(await readFile(join(input.workspace!.path, 'src/a.ts'), 'utf8')).toContain(
                  reuseRound ? 'BETTER' : 'GOOD',
                );
                output = { findings: [] };
              } else if (schema === 'review.address.closure/v1') {
                if (earlyTamper) {
                  const path = devLedgerPath(workerRoot, 'cq-review/pr-7');
                  await writeFile(path, `${await readFile(path, 'utf8')}\n`);
                }
                output = { closed: true, reason: 'verified candidate' };
              } else {
                if (!input.prompt.startsWith('related-check feedback')) {
                  workerRoot = input.workspace!.path;
                  const file = input.prompt.includes('"file":"src/b.ts"') ? 'src/b.ts' : 'src/a.ts';
                  if (rejection && file === 'src/b.ts')
                    return {
                      stopReason: 'complete',
                      structuredOutput: {
                        disposition: 'rejected',
                        reason: 'sibling supplied current proof',
                        evidence: [{ path: 'src/a.ts', line: 2 }],
                      },
                      usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 },
                      denials: [],
                    };
                  if (rejection) await queued;
                  if (admissionTransition && file === 'src/a.ts') {
                    firstEditing();
                    await capturedAdmission;
                  }
                  if (siblings && !rejection && !admissionTransition) {
                    editing++;
                    enteredEdits++;
                    maximumEditing = Math.max(maximumEditing, editing);
                    if (enteredEdits === 2) releaseEdits();
                    await new Promise<void>((resolve, reject) => {
                      const aborted = () =>
                        reject(options?.signal?.reason ?? new Error('editing cancelled'));
                      if (options?.signal?.aborted) {
                        aborted();
                        return;
                      }
                      options?.signal?.addEventListener('abort', aborted, { once: true });
                      void editGate.then(() => {
                        options?.signal?.removeEventListener('abort', aborted);
                        resolve();
                      }, reject);
                    });
                  }
                  await writeFile(
                    join(workerRoot, file),
                    `export const ${file === 'src/a.ts' ? 'a' : 'b'} = "${reuseRound ? 'BETTER' : 'GOOD'}";\n${rejection ? '// introduced citation\n' : ''}`,
                  );
                  if (siblings && !admissionTransition) editing--;
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
      let dispositionEntered!: () => void;
      const dispositionStarted = new Promise<void>((resolve) => {
        dispositionEntered = resolve;
      });
      let ownedDiffs = 0;
      let ledgerRenames = 0;
      let fencedSnapshots = 0;
      let snapshotRequested!: () => void;
      const snapshotRequest = new Promise<void>((resolve) => {
        snapshotRequested = resolve;
      });
      let capturedSnapshot!: (result: GhResult) => void;
      let pendingSnapshot = false;
      let rootSnapshots = 0;
      const transientPaths: string[] = [];
      if (ledgerSnapshot) {
        let first = true;
        ledgerRace.beforeDisposition = async () => {
          if (!first) return;
          first = false;
          dispositionEntered();
          await snapshotRequest;
        };
        ledgerRace.beforeRename = (from, to) => {
          if (!workerRoot || to !== devLedgerPath(workerRoot, 'cq-review/pr-7')) return;
          ledgerRenames++;
          if (!pendingSnapshot) return;
          // Git really sees the atomic writer's file before rename. Its result
          // can arrive after the writer has removed that path.
          const stdout = repo.git(
            '-C',
            workerRoot,
            'ls-files',
            '-z',
            '--others',
            '--exclude-standard',
          );
          transientPaths.push(from.slice(workerRoot.length + 1));
          console.info('ledger snapshot at atomic rename:', JSON.stringify(transientPaths));
          expect(stdout.split('\0')).toContain(transientPaths.at(-1));
          pendingSnapshot = false;
          capturedSnapshot(ok(stdout));
        };
      }
      const realGit = makeGhRunner({ bin: 'git', cwd: repo.root });
      let inserted = false;
      const git: GhFn = async (args) => {
        if (
          admissionTransition &&
          args.length === 5 &&
          args[2] === 'symbolic-ref' &&
          args[3] === '--quiet'
        ) {
          if (++adapterBranches === 2 && fencedAdmissions === 0) await firstEdit;
        }
        if (
          admissionTransition &&
          fencedAdmissions === 0 &&
          adapterBranches === 2 &&
          workerRoot &&
          !heldAdmission &&
          args.length === 4 &&
          args[1] === workerRoot &&
          args[2] === 'rev-parse' &&
          args[3] === 'HEAD'
        ) {
          heldAdmission = true;
          const captured = await realGit(args);
          captureStarted();
          await verified;
          expect(captured.stdout.trim()).not.toBe(
            repo.git('-C', workerRoot, 'rev-parse', 'HEAD').trim(),
          );
          console.info('held admission captured pre-sibling head:', captured.stdout.trim());
          return captured;
        }

        if (
          !inserted &&
          (mode === 'caller-file' ||
            mode === 'caller-cq' ||
            mode === 'caller-ledger-temp' ||
            mode === 'caller-index' ||
            mode === 'bookkeeping-tamper') &&
          args.includes('status') &&
          workerRoot
        ) {
          inserted = true;
          if (mode === 'caller-index') {
            const original = await readFile(join(workerRoot, 'README.md'), 'utf8');
            await writeFile(join(workerRoot, 'README.md'), 'CALLER STAGED BYTES\n');
            expect((await realGit(['-C', workerRoot, 'add', '--', 'README.md'])).code).toBe(0);
            await writeFile(join(workerRoot, 'README.md'), original);
          } else if (mode === 'bookkeeping-tamper') {
            const path = devLedgerPath(workerRoot, 'cq-review/pr-7');
            await writeFile(path, `${await readFile(path, 'utf8')}\n`);
          } else {
            const path =
              mode === 'caller-cq'
                ? '.cq/private.txt'
                : mode === 'caller-ledger-temp'
                  ? '.cq/dev/.caller.json.123.0.tmp'
                  : 'private.txt';
            await mkdir(join(workerRoot, '.cq'), { recursive: true });
            await writeFile(join(workerRoot, path), 'CALLER PRIVATE BYTES\n');
          }
        }
        if (
          ledgerSnapshot &&
          args[1] === workerRoot &&
          args.includes('diff') &&
          args.includes('--name-only') &&
          args.includes('HEAD')
        ) {
          if (++ownedDiffs === 2) await dispositionStarted;
        }
        if (ledgerSnapshot && args[1] === workerRoot && args.includes('ls-files')) {
          rootSnapshots++;
          if (rootSnapshots === 2) {
            snapshotRequested();
            // Old per-path recognition starts this read while disposition owns
            // the bookkeeping FIFO. Atomic inspection instead queues the read.
            if (ledgerRace.beforeDisposition) {
              pendingSnapshot = true;
              return new Promise<GhResult>((resolve) => {
                capturedSnapshot = resolve;
              });
            }
          }
        }
        // Fake forge identity maps to this fixture's bare remote; transport is
        // real Git, but no command may contact a network service.
        return realGit(
          args.map((arg) =>
            arg === 'https://github.com/octo/widget.git'
              ? repo.git('remote', 'get-url', 'origin').trim()
              : arg,
          ),
        );
      };
      const result = await makeReviewAddress({
        gh,
        drivers,
        git,
        ...(ledgerSnapshot
          ? {
              workerFactory: (deps) => {
                const inspect = deps.inspectUntracked;
                if (typeof inspect !== 'function') return makeAddressWorker(deps);
                let inspections = 0;
                return makeAddressWorker({
                  ...deps,
                  inspectUntracked: async (read) => {
                    if (++inspections === 3) {
                      snapshotRequested();
                      ledgerRace.beforeDisposition = undefined;
                    }
                    return inspect(async () => {
                      if (inspections === 3) {
                        expect(ledgerRenames).toBeGreaterThan(0);
                        fencedSnapshots++;
                      }
                      return read();
                    });
                  },
                });
              },
            }
          : {}),
        ...(admissionTransition
          ? {
              workerFactory: (deps) => {
                const worker = makeAddressWorker(deps) as ReturnType<typeof makeAddressWorker> & {
                  withVerifiedHead?<T>(action: (head: string) => Promise<T>): Promise<T>;
                };
                return {
                  ...worker,
                  ...(worker.withVerifiedHead
                    ? {
                        withVerifiedHead: <T>(action: (head: string) => Promise<T>) =>
                          worker.withVerifiedHead!(async (head) => {
                            if (++fencedAdmissions === 2) captureStarted();
                            return action(head);
                          }),
                      }
                    : {}),
                  fix: async (finding, round) => {
                    const fix = await worker.fix(finding, round);
                    if (finding.file === 'src/a.ts') firstVerified();
                    return fix;
                  },
                };
              },
            }
          : {}),
        ...(rejection
          ? {
              workerFactory: (deps) => {
                const worker = makeAddressWorker(deps);
                return {
                  ...worker,
                  fix: async (finding, round) => {
                    if (finding.file === 'src/b.ts') {
                      rejectionQueued();
                      await verified;
                    }
                    const fix = await worker.fix(finding, round);
                    if (finding.file === 'src/a.ts') firstVerified();
                    return fix;
                  },
                };
              },
            }
          : {}),
      })({
        repoRoot: repo.root,
        source: 'pr:7',
        journalDir: journal,
        rounds: 1,
        push: mode !== 'local-only',
      });
      const report = result.status === 'ok' ? result.value : result.report!;
      if (rejection) {
        expect(report.fixesPerRun, JSON.stringify(report.reasons)).toBe(1);
        expect(result.status, JSON.stringify(report.reasons)).toBe(
          refreshedRejection ? 'needs-human' : 'ok',
        );
        expect(report.openBlocking.some((finding) => finding.id === 'T2')).toBe(refreshedRejection);
        expect(report.findings.find((finding) => finding.id === 'T2')?.status).toBe(
          refreshedRejection ? 'open' : 'rejected',
        );
        const fixed = report.fixes.find((fix) => fix.commit)!;
        const rejected = report.fixes.find((fix) => fix.finding.status === 'rejected')!;
        expect(rejected.observedHead).toBe(fixed.commit);
        const reply = replies.find((row) => row.in_reply_to_id === 102);
        expect(reply, JSON.stringify(report.reasons)).toBeDefined();
        expect(reply!.body).toContain(`<!-- cq-review-loop-head:${fixed.commit} round:`);
        expect(resolvedThreads.has('T2')).toBe(false);
        expect(remoteHead()).toBe(fixed.commit);
        return;
      }
      if (earlyTamper) {
        expect(remoteHead(), 'tampered ledger must never authorize a push').toBe(initial);
        expect(actions).toEqual([]);
      }
      expect(report.fixesPerRun, JSON.stringify(report.reasons)).toBe(siblings ? 2 : 1);
      if (siblings && !admissionTransition) expect(maximumEditing).toBe(2);
      if (admissionTransition) {
        expect(heldAdmission).toBe(false);
        expect(fencedAdmissions).toBe(2);
      }
      if (ledgerSnapshot) {
        // A successful run may serialize before capture; unchanged source must
        // expose the real temporary path and refuse instead.
        expect(pendingSnapshot).toBe(false);
        expect(fencedSnapshots).toBe(1);
        expect(transientPaths).toEqual([]);
      }
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
      // Every case here completed admitted work: later disposition/publication
      // bookkeeping refusals must retain that settled run exactly once.
      expect(report.rounds).toHaveLength(1);
      expect(report.rounds[0]?.record.branch).toBe('cq-review/pr-7');
      expect(report.rounds[0]?.runs).toHaveLength(1);
      if (!earlyTamper)
        expect(report.reasons.join('\n')).not.toMatch(
          /identity changed|admission|branch changed|unknown finding|disposition persistence|could not be persisted/,
        );
      const ledger = makeSubprocessDevEffects(workerRoot).openLedger('cq-review/pr-7').load();
      const dispositions = ledger.records.filter((entry) => entry.kind === 'disposition');
      expect(dispositions).toHaveLength(earlyTamper ? 0 : siblings ? 2 : 1);
      for (const disposition of dispositions) expect(disposition.head).toMatch(/^[a-f0-9]{40}$/);
      for (const id of earlyTamper ? [] : siblings ? ['T1', 'T2'] : ['T1'])
        expect(dispositions).toContainEqual(
          expect.objectContaining({
            kind: 'disposition',
            findingId: id,
            action: 'fixed',
          }),
        );
      if (!tampered)
        expect(invocations.filter((name) => name === 'review.agent/v3').length).toBeGreaterThan(0);
      if (siblings) {
        expect(invocations.filter((name) => name === 'review.address.outcome/v1')).toHaveLength(4);
        expect(invocations.filter((name) => name === 'review.address.closure/v1')).toHaveLength(2);
      } else
        expect(invocations).toEqual([
          'review.address.outcome/v1',
          'review.address.outcome/v1',
          'review.address.closure/v1',
          ...(tampered ? [] : invocations.filter((name) => name === 'review.agent/v3')),
        ]);
      // The real adapter, not the test, creates both colliding refs.
      expect(repo.git('-C', workerRoot, 'symbolic-ref', '--short', 'HEAD').trim()).toBe(
        'heads/cq-review/pr-7',
      );
      const state = await readWorkState(makeSubprocessDevEffects(workerRoot), {
        target: 'merge-queue',
      });
      expect(state.ok && state.state.branch).toBe('cq-review/pr-7');
      expect(report.fixes.map((fix) => fix.commit)).toContain(state.ok && state.state.head);
      const scanCount = (await scanner.calls()).length;
      if (tampered) expect(scanCount).toBe(3);
      else expect(scanCount).toBeGreaterThan(3);
      if (publish) {
        expect(result.status, JSON.stringify(report.reasons)).toBe('ok');
        expect(actions).toEqual(
          siblings
            ? ['reply', 'reply', 'resolve', 'resolve', 'rerequest']
            : ['reply', 'resolve', 'rerequest'],
        );
        expect(remoteHead()).toBe(state.ok && state.state.head);
        expect(repo.git('-C', workerRoot, 'status', '--porcelain')).toContain('.cq/');
      } else {
        expect(result.status).toBe('needs-human');
        expect(actions).toEqual([]);
        expect(remoteHead()).toBe(initial);
        if (mode !== 'local-only') {
          expect(report.reasons.join(' ')).toMatch(/dirty|untracked/);
          if (mode === 'caller-index') {
            expect(repo.git('-C', workerRoot, 'show', ':README.md')).toBe('CALLER STAGED BYTES\n');
            expect(await readFile(join(workerRoot, 'README.md'), 'utf8')).toBe('# fixture\n');
          } else if (tampered) {
            expect(await readFile(devLedgerPath(workerRoot, 'cq-review/pr-7'), 'utf8')).toMatch(
              /\n\n$/,
            );
          } else {
            expect(
              await readFile(
                join(
                  workerRoot,
                  mode === 'caller-cq'
                    ? '.cq/private.txt'
                    : mode === 'caller-ledger-temp'
                      ? '.cq/dev/.caller.json.123.0.tmp'
                      : 'private.txt',
                ),
                'utf8',
              ),
            ).toBe('CALLER PRIVATE BYTES\n');
          }
        }
      }
      if (reuse) {
        const originalRoot = workerRoot;
        const priorLedger = await readFile(devLedgerPath(workerRoot, 'cq-review/pr-7'), 'utf8');
        expect(priorLedger).toContain('disposition');
        repo.git('-C', workerRoot, 'push', '-q', 'origin', 'HEAD:refs/pull/7/head');
        const ledgerPath = devLedgerPath(workerRoot, 'cq-review/pr-7');
        const historyFolder = join(workerRoot, '.cq/review', encodeURIComponent('cq-review/pr-7'));
        const historyPath = join(
          historyFolder,
          (await readdir(historyFolder)).find((name) => /^\d+\.json$/.test(name))!,
        );
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
        const receiptPath = join(
          repo.root,
          '.git/cq-review-address',
          namespace,
          'bookkeeping.json',
        );
        const receiptBytes = await readFile(receiptPath, 'utf8');
        const receipt = JSON.parse(receiptBytes) as {
          files: Array<{ path: string; sha256: string }>;
          branch: string;
          root: string;
          identity: string;
          head: string;
        };
        expect(
          receipt.files.some(
            (row: { path: string }) => row.path === relative(workerRoot, ledgerPath),
          ),
        ).toBe(true);
        let protectedPath: string | undefined;
        if (mode === 'publish-reuse-modified-ledger' || mode === 'publish-reuse-malformed') {
          protectedPath = ledgerPath;
          await writeFile(
            ledgerPath,
            mode === 'publish-reuse-malformed' ? '{bad' : priorLedger + '\n',
          );
        }
        if (mode === 'publish-reuse-modified-history') {
          protectedPath = historyPath;
          await writeFile(historyPath, `${await readFile(historyPath, 'utf8')}\n`);
        }
        if (mode === 'publish-reuse-caller' || mode === 'publish-reuse-unregistered') {
          protectedPath =
            mode === 'publish-reuse-caller'
              ? join(workerRoot, '.cq/private.txt')
              : join(historyFolder, '999999.json');
          await writeFile(
            protectedPath,
            mode === 'publish-reuse-caller'
              ? 'CALLER PRIVATE BYTES\n'
              : await readFile(historyPath),
          );
        }
        if (mode === 'publish-reuse-missing-receipt') await unlink(receiptPath);
        else if (mode === 'publish-reuse-corrupt-receipt') {
          protectedPath = receiptPath;
          await writeFile(receiptPath, '{bad');
        } else if (mode === 'publish-reuse-partial-receipt') {
          protectedPath = receiptPath;
          receipt.files = receipt.files.filter(
            (row: { path: string }) => row.path !== relative(workerRoot, ledgerPath),
          );
          await writeFile(receiptPath, JSON.stringify(receipt));
        } else if (mode.startsWith('publish-reuse-wrong-') || mode === 'publish-reuse-stale-head') {
          protectedPath = receiptPath;
          if (mode === 'publish-reuse-wrong-branch') receipt.branch = 'different';
          if (mode === 'publish-reuse-wrong-root') receipt.root = repo.root;
          if (mode === 'publish-reuse-wrong-identity') receipt.identity = 'other-pr-actor';
          if (mode === 'publish-reuse-stale-head') receipt.head = initial;
          await writeFile(receiptPath, JSON.stringify(receipt));
        }
        const protectedBytes = protectedPath ? await readFile(protectedPath) : undefined;
        const previousHead = repo.git('-C', workerRoot, 'rev-parse', 'HEAD').trim();
        const invocationCount = invocations.length;
        const actionCount = actions.length;
        const callerAlias = join(journal, 'caller-alias');
        if (mode === 'publish-reuse-alias') await symlink(repo.root, callerAlias, 'dir');
        reuseRound = true;
        // A fresh default invocation must discover and reuse the same no-ignore checkout.
        const second = await makeReviewAddress({ gh, git, drivers })({
          repoRoot: mode === 'publish-reuse-alias' ? callerAlias : repo.root,
          source: 'pr:7',
          rounds: 1,
          push: true,
        });
        const again = second.status === 'ok' ? second.value : second.report!;
        if (refusedReuse) {
          expect(second.status, JSON.stringify(again.reasons)).toBe('needs-human');
          expect(again.fixesPerRun, JSON.stringify(again.reasons)).toBe(0);
          expect(invocations).toHaveLength(invocationCount);
          expect(actions).toHaveLength(actionCount);
          expect(repo.git('-C', originalRoot, 'rev-parse', 'HEAD').trim()).toBe(previousHead);
          if (protectedPath) expect(await readFile(protectedPath)).toEqual(protectedBytes);
          if (mode === 'publish-reuse-missing-receipt')
            await expect(readFile(receiptPath)).rejects.toMatchObject({ code: 'ENOENT' });
          return;
        }
        expect(again.fixesPerRun, JSON.stringify(again.reasons)).toBe(1);
        expect(second.status, JSON.stringify(again.reasons)).toBe('ok');
        expect(await realpath(workerRoot)).toBe(await realpath(originalRoot));
        expect(repo.git('-C', workerRoot, 'show', 'HEAD:src/a.ts')).toContain('BETTER');
        expect(await readFile(devLedgerPath(workerRoot, 'cq-review/pr-7'), 'utf8')).toContain('T2');
      }
    } finally {
      await repo.cleanup();
      await rm(journal, { recursive: true, force: true });
    }
  },
);

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
