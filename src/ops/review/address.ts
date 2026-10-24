import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile, realpath, lstat } from 'node:fs/promises';
import { resolve, join, posix, relative } from 'node:path';
import { createDriverFactory, type DriverFactory } from '../../driver/factory.js';
import type { Usage, WorkerResult } from '../../driver/types.js';
import { createGovernor, currentJobContext } from '../../kernel/governor.js';
import { runPlan, type OpRegistryView } from '../../kernel/runner.js';
import type { OpRegistryEntry, OpResult, Plan, RunReport } from '../../kernel/types.js';
import { makeGhRunner, type GhFn } from '../../adapters/forge-github/gh.js';
import { fetchReviewState } from '../../adapters/forge-github/fetchReviewState.js';
import { requestReviewers } from '../../adapters/forge-github/requestReviewers.js';
import { fileWorktreeRegistry, type WorktreeRegistry } from '../../adapters/git/prWorktree.js';
import { loopReplyVerdict, replySignature, runReviewLoop } from '../../plans/review-loop.js';
import { parseCqConfig, type CqConfig } from '../analyze/cqConfig.js';
import { resolveCqConfigDefaults, requireAgenticTokenBudget } from '../analyze/cqConfigDefaults.js';
import { makeDevDisposition } from '../dev/disposition.js';
import { makeSubprocessDevEffects } from '../dev/effects.js';
import {
  FindingsRecordSchema,
  isComplete,
  merge,
  openBlocking,
  type Finding,
  type FindingsRecord,
} from './findings.js';
import { makeReviewRun, type ReviewRunInput } from './run.js';
import {
  makeAddressWorker,
  type AddressAttempt,
  type AddressFix,
  type AddressWorker,
} from './addressWorker.js';
import { FixReviewItemInputSchema } from './registry.js';
import {
  NO_OUTCOME_REASON,
  type FixReviewItemInput,
  type FindingReviewItemInput,
  type FixReviewItemResult,
} from './fixReviewItem.js';
import { readWorkState } from '../dev/internal/workState.js';
import { makeGitMutex } from '../../shared/gitMutex.js';
import { DEV_LEDGER_VERSION, devLedgerPath, type DevCycleRecord } from '../dev/record.js';

export interface ReviewAddressInput {
  repoRoot: string;
  source: string;
  record?: string;
  target?: string;
  base?: string;
  maxTokens?: number;
  wallMs?: number;
  rounds?: number;
  concurrency?: number;
  journalDir?: string;
  push?: boolean;
}
export interface ReviewAddressReport {
  source: string;
  reportPath: string;
  rounds: Array<{ round: number; record: FindingsRecord; run?: RunReport }>;
  findings: Finding[];
  openBlocking: Finding[];
  fixes: AddressFix[];
  attempts: AddressAttempt[];
  fixesPerRun: number;
  usage: Usage;
  costUSD?: number;
  wallMs: number;
  reasons: string[];
  escalation?: ReturnType<AddressWorker['escalation']>;
}
export type ReviewAddressResult = OpResult<ReviewAddressReport> & { report?: ReviewAddressReport };
export interface ReviewAddressDeps {
  drivers?: DriverFactory;
  git?: GhFn;
  gh?: GhFn;
  worktreeRegistry?: WorktreeRegistry;
  config?: CqConfig;
  initialRecord?: FindingsRecord;
  review?: (input: ReviewRunInput) => Promise<OpResult<FindingsRecord>>;
  workerFactory?: (deps: Parameters<typeof makeAddressWorker>[0]) => AddressWorker;
  disposition?: (root: string, finding: Finding) => Promise<OpResult<unknown>>;
}

/** Deterministic file-disjoint waves. Missing scope is handled explicitly, never fanned out. */
export function addressBatches(findings: readonly Finding[], concurrency: number): Finding[][] {
  if (!Number.isInteger(concurrency) || concurrency < 1)
    throw new Error('address concurrency must be positive');
  const pending = [...findings];
  const batches: Finding[][] = [];
  while (pending.length) {
    const files = new Set<string>();
    const batch: Finding[] = [];
    for (let i = 0; i < pending.length && batch.length < concurrency;) {
      const finding = pending[i]!;
      const file = finding.file === undefined ? undefined : posix.normalize(finding.file);
      if (file === undefined) {
        if (batch.length) break;
        batch.push(finding);
        pending.splice(i, 1);
        break;
      }
      if (!files.has(file)) {
        batch.push(finding);
        files.add(file);
        pending.splice(i, 1);
      } else i++;
    }
    batches.push(batch);
  }
  return batches;
}
const issue = (result: OpResult<unknown>) =>
  result.status === 'needs-human'
    ? result.reason
    : result.status === 'failed'
      ? result.error
      : result.status === 'indeterminate'
        ? result.detail
        : result.status;
const identity = (f: Finding) => JSON.stringify([f.file, f.line, f.rule, f.text]);
const discussionText = (
  body: string,
  comments: readonly { authorLogin: string | null; body: string; createdAt: string | null }[],
) =>
  comments.length
    ? `${body}\n\nFollow-up discussion (chronological):\n${comments.map((comment) => `Author: ${comment.authorLogin ?? 'unknown'}; at: ${comment.createdAt ?? 'unknown'}\n${comment.body}`).join('\n\n')}`
    : body;

/** SDK-first fix/disposition/re-review composition; kernel dispatch itself remains retry-free. */
export function makeReviewAddress(deps: ReviewAddressDeps = {}) {
  return async (input: ReviewAddressInput): Promise<ReviewAddressResult> => {
    const start = Date.now();
    const enclosingContext = currentJobContext();
    const parent = enclosingContext?.signal;
    const journalDir = resolve(
      input.journalDir ?? resolve(input.repoRoot, '..', '.cq-address-runs', randomUUID()),
    );
    const report: ReviewAddressReport = {
      source: input.source,
      reportPath: resolve(journalDir, 'review-address-report.json'),
      rounds: [],
      findings: [],
      openBlocking: [],
      fixes: [],
      attempts: [],
      fixesPerRun: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      wallMs: 0,
      reasons: [],
    };
    const bookkeeping = new Map<string, string>();
    let bookkeepingTampered = false;
    const noteBookkeeping = async (path: string) => {
      const canonical = await realpath(path);
      const stat = await lstat(canonical);
      if (!stat.isFile() || stat.nlink !== 1)
        throw new Error('bookkeeping is not an ordinary owned file');
      bookkeeping.set(
        canonical,
        createHash('sha256')
          .update(await readFile(canonical))
          .digest('hex'),
      );
    };
    let worker: AddressWorker | undefined;
    let publishOnExit: (() => Promise<void>) | undefined;
    let cleanStop: (() => string | undefined) | undefined;
    const finish = async (
      status: 'ok' | 'failed' | 'needs-human',
      reason = '',
    ): Promise<ReviewAddressResult> => {
      if (reason) report.reasons.push(reason);
      if (publishOnExit && !parent?.aborted) {
        try {
          await publishOnExit();
        } catch (error) {
          status = 'needs-human';
          reason = `verified publication failed: ${String(error)}`;
          report.reasons.push(reason);
        }
      }
      const stopped = status === 'ok' ? cleanStop?.() : undefined;
      if (stopped) {
        status = 'needs-human';
        reason = stopped;
        report.reasons.push(stopped);
      }
      report.wallMs = Date.now() - start;
      report.fixesPerRun = new Set(
        report.fixes.flatMap((fix) => (fix.commit ? [fix.commit] : [])),
      ).size;
      if (worker) report.escalation = worker.escalation();
      try {
        await mkdir(journalDir, { recursive: true });
        await writeFile(report.reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
      } catch (error) {
        return {
          status: 'failed',
          error: `review.address report write failed at ${report.reportPath}: ${String(error)}`,
          report,
        };
      }
      if (status === 'ok') return { status, value: report };
      const detail = `${reason || report.reasons.join('; ') || 'open blocking findings or incomplete review'}; report: ${report.reportPath}`;
      return status === 'failed'
        ? { status, error: detail, report }
        : { status, reason: detail, report };
    };
    try {
      if (parent?.aborted) return await finish('needs-human', 'parent cancelled');
      if (input.source !== 'local' && !/^pr:[1-9]\d*$/.test(input.source))
        return await finish('failed', 'source must be local or pr:<positive number>');
      let config = deps.config;
      if (!config) {
        const parsed = parseCqConfig(
          await readFile(resolve(input.repoRoot, 'cq.json'), 'utf8'),
          input.repoRoot,
        );
        if (!parsed.ok) return await finish('needs-human', parsed.reason);
        config = parsed.config;
      }
      const policy = resolveCqConfigDefaults(config, {
        packageName: 'repository',
        ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
        review: {
          ...(input.rounds === undefined ? {} : { rounds: input.rounds }),
          ...(input.concurrency === undefined ? {} : { addressConcurrency: input.concurrency }),
        },
      });
      const budget = requireAgenticTokenBudget(policy);
      if (budget) return await finish('needs-human', budget.reason);
      if (!policy.roles.worker || !policy.roles.reviewer)
        return await finish('needs-human', 'cq.json roles.worker and roles.reviewer are required');
      const cap = Math.min(policy.budgets.run.wallMs, input.wallMs ?? Infinity);
      const remainingTokens = () =>
        policy.budgets.run.maxTokens! -
        report.usage.input -
        report.usage.output -
        report.usage.cacheRead -
        report.usage.cacheWrite -
        (report.usage.reasoning ?? 0);
      const remainingWallMs = () => cap - (Date.now() - start);
      const stop = () =>
        parent?.aborted
          ? 'parent cancelled'
          : bookkeepingTampered
            ? 'engine bookkeeping changed; worker tree is dirty'
            : remainingTokens() <= 0 || remainingWallMs() <= 0
              ? 'token or wall budget exhausted'
              : undefined;
      cleanStop = stop;
      const account = (result: WorkerResult, governed = true) => {
        for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'] as const)
          report.usage[key] += result.usage[key];
        if (result.costUSD !== undefined) report.costUSD = (report.costUSD ?? 0) + result.costUSD;
        if (result.usage.reasoning !== undefined)
          report.usage.reasoning = (report.usage.reasoning ?? 0) + result.usage.reasoning;
        if (governed) {
          const context = currentJobContext();
          const measurement = {
            usage: result.usage,
            ...(result.costUSD === undefined ? {} : { costUSD: result.costUSD }),
          };
          context?.reportResult(measurement);
          if (enclosingContext && enclosingContext !== context)
            enclosingContext.reportResult(measurement);
        }
      };
      const drivers = deps.drivers ?? createDriverFactory();
      // Review source calls share the same landed usage meter as fix/feedback/closure calls.
      const reviewDrivers: DriverFactory = {
        resolve(request) {
          const resolved = drivers.resolve(request);
          return {
            ...resolved,
            driver: {
              ...resolved.driver,
              run: async (...args) => {
                const stopped = stop();
                if (stopped) throw new Error(stopped);
                const result = await resolved.driver.run(...args);
                account(result, false);
                return result;
              },
            },
          };
        },
      };
      const reviewImplementation =
        deps.review ??
        makeReviewRun({
          drivers: reviewDrivers,
          ...(parent ? { parentSignal: parent } : {}),
          writeFindingsRecord: async (path, content) => {
            await writeFile(path, content, { flag: 'wx', mode: 0o600 });
            await noteBookkeeping(path);
          },
        });
      const git =
        deps.git ??
        makeGhRunner({ bin: 'git', cwd: input.repoRoot, timeoutMs: Math.min(cap, 60_000) });
      const gh =
        deps.gh ??
        makeGhRunner({
          cwd: input.repoRoot,
          unsetEnv: ['GH_REPO'],
          timeoutMs: Math.min(cap, 60_000),
        });
      // Ownership spans worker edits as well as index mutation, restoration and
      // publication. Linked worktrees share this conservative exclusion domain;
      // UUID journal paths and lexical checkout aliases cannot split it.
      const common = await git([
        '-C',
        input.repoRoot,
        'rev-parse',
        '--path-format=absolute',
        '--git-common-dir',
      ]);
      if (common.code !== 0 || !common.stdout.trim())
        throw new Error('checkout ownership identity unavailable');
      const commonPath = resolve(input.repoRoot, common.stdout.trim());
      await mkdir(commonPath, { recursive: true });
      const ownership = makeGitMutex({
        lockPath: resolve(await realpath(commonPath), 'cq-review-address-ownership'),
        failFast: true,
      });
      return await ownership.withLock(async () => {
        try {
          await mkdir(journalDir, { recursive: true });
          const bookkeepingKey = async (root: string, path: string) =>
            resolve(await realpath(root), path);
          const untrackedAllowed = async (root: string, path: string) => {
            const key = await bookkeepingKey(root, path);
            const expected = bookkeeping.get(key);
            if (!expected) return false;
            const stat = await lstat(key);
            const unchanged =
              stat.isFile() &&
              stat.nlink === 1 &&
              (await realpath(key)) === key &&
              createHash('sha256')
                .update(await readFile(key))
                .digest('hex') === expected;
            if (!unchanged) bookkeepingTampered = true;
            return unchanged;
          };
          const gitText = async (root: string, args: string[]) => {
            const result = await git(['-C', root, ...args]);
            if (result.code !== 0)
              throw new Error(`git ${args[0]} failed: ${result.stderr.slice(0, 500)}`);
            return result.stdout.trim();
          };
          const branchName = async (root: string) => {
            const ref = await gitText(root, ['symbolic-ref', '--quiet', 'HEAD']);
            if (!ref.startsWith('refs/heads/') || ref.length === 'refs/heads/'.length)
              throw new Error('worker HEAD does not name a local branch ref');
            return ref.slice('refs/heads/'.length);
          };
          const admitHistory = async (root: string, branch: string) => {
            const folder = resolve(root, '.cq', 'review', encodeURIComponent(branch));
            let names: string[];
            try {
              names = await readdir(folder);
            } catch (error) {
              if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
              throw error;
            }
            for (const name of names.filter((name) => /^\d+\.json$/.test(name))) {
              const path = join(folder, name);
              if (bookkeeping.has(await bookkeepingKey(root, relative(root, path)))) continue;
              let raw: unknown;
              try {
                raw = JSON.parse(await readFile(path, 'utf8'));
              } catch (error) {
                if (error instanceof SyntaxError) continue;
                throw error;
              }
              const record = FindingsRecordSchema.safeParse(raw);
              // History is bookkeeping only, never current clean proof.
              if (
                !record.success ||
                record.data.branch !== branch ||
                !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(record.data.head)
              )
                continue;
              const ancestor = await git([
                '-C',
                root,
                'merge-base',
                '--is-ancestor',
                record.data.head,
                'HEAD',
              ]);
              if (ancestor.code === 0) await noteBookkeeping(path);
            }
          };
          const review = async (request: ReviewRunInput) => {
            // Review.run legitimately appends to the same ledger. Check ownership
            // before its write, then register only that engine-produced revision.
            for (const path of bookkeeping.keys())
              if (!(await untrackedAllowed(request.repoRoot, path)))
                throw new Error('engine bookkeeping changed; worker tree is dirty');
            const result = await reviewImplementation(request);
            if (!deps.review && result.status === 'ok')
              await noteBookkeeping(devLedgerPath(request.repoRoot, result.value.branch));
            return result;
          };
          const bindWorker = (root: string) =>
            (worker ??= (deps.workerFactory ?? makeAddressWorker)({
              repoRoot: root,
              dependencyRoot: input.repoRoot,
              journalDir,
              policy,
              git,
              drivers,
              attempts: report.attempts,
              isBookkeepingPath: (path) => untrackedAllowed(root, path),
              remainingTokens,
              remainingWallMs,
              account,
              ...(parent ? { parentSignal: parent } : {}),
            }));
          const publicationTreeClean = async (root: string) => {
            // A later engine rewrite must not erase an observed ownership violation.
            if (bookkeepingTampered) return false;
            await admitHistory(root, await branchName(root));
            if (await gitText(root, ['diff', '--cached', '--name-only', '-z'])) return false;
            if (await gitText(root, ['diff', '--name-only', '-z'])) return false;
            const untracked = await git([
              '-C',
              root,
              'ls-files',
              '-z',
              '--others',
              '--exclude-standard',
            ]);
            if (untracked.code !== 0) throw new Error('publication untracked paths unavailable');
            for (const path of untracked.stdout.split('\0').filter(Boolean))
              if (!(await untrackedAllowed(root, path))) return false;
            return true;
          };
          const unpublished = new Set<string>();
          let publishBranch: string | undefined;
          let publishRemote = 'origin';
          let publishedBase: string | undefined;
          let workerRoot = resolve(input.repoRoot);
          const remember = (fix: AddressFix) => {
            report.fixes.push(fix);
            if (fix.commit) unpublished.add(fix.commit);
          };
          publishOnExit = async () => {
            if (!input.push || unpublished.size === 0 || parent?.aborted) return;
            if (!publishedBase) throw new Error('publication baseline unavailable');
            const range = (await gitText(workerRoot, ['rev-list', `${publishedBase}..HEAD`]))
              .split('\n')
              .filter(Boolean);
            if (
              range.length === 0 ||
              range.some((sha) => !unpublished.has(sha)) ||
              [...unpublished].some((sha) => !range.includes(sha))
            )
              throw new Error('publication contains an unverified commit or changed ancestry');
            await gitText(workerRoot, ['merge-base', '--is-ancestor', publishedBase, 'HEAD']);
            if (!(await publicationTreeClean(workerRoot)))
              throw new Error('worker tree/index is dirty; verified commits retained');
            const branch = publishBranch ?? (await branchName(workerRoot));
            if (parent?.aborted) throw new Error('parent cancelled');
            await gitText(workerRoot, ['push', publishRemote, `HEAD:refs/heads/${branch}`]);
            publishedBase = await gitText(workerRoot, ['rev-parse', 'HEAD']);
            unpublished.clear();
          };
          const dispositions = new Map<string, Finding>();
          let bookkeepingFailed = false;
          let reviewedBase: string | undefined;
          const admitCleanRecord = async (root: string, record: FindingsRecord) => {
            const effects = makeSubprocessDevEffects(root);
            const read = await readWorkState(effects, {
              target: input.target ?? 'merge-queue',
              ...(reviewedBase ? { base: reviewedBase } : {}),
            });
            if (!read.ok) throw new Error(read.reason);
            const state = read.state;
            if (record.head !== state.head || record.branch !== state.branch)
              throw new Error('clean findings record does not match current branch/head');
            if (state.staged || state.unstaged || !(await publicationTreeClean(root)))
              throw new Error(
                'clean findings record cannot prove dirty or untracked worktree content; run review.run again',
              );
            if (record.reviewed?.scope !== 'full' || record.reviewed.base !== reviewedBase)
              throw new Error(
                'clean findings record lacks matching full reviewed base/scope; run review.run again',
              );
            if (stop()) throw new Error(stop());
          };
          const admitRecord = async (root: string, record: FindingsRecord) => {
            if (deps.disposition) return;
            const effects = makeSubprocessDevEffects(root);
            const read = await readWorkState(effects, {
              target: input.target ?? 'merge-queue',
              ...(input.base ? { base: input.base } : {}),
            });
            if (!read.ok) throw new Error(read.reason);
            const state = read.state;
            if (record.head !== state.head || record.branch !== state.branch)
              throw new Error('findings admission head/branch changed');
            await admitHistory(root, state.branch);
            await effects.openLedger(state.branch).mutate((ledger) => {
              const entry: DevCycleRecord = {
                kind: 'cycle',
                cycleId: `address-${randomUUID()}`,
                reviewer: 'review.address:import',
                scope: 'full',
                target: input.target ?? 'merge-queue',
                base: state.base,
                head: state.head,
                dirtySha256: state.dirtySha256,
                completion: { kind: 'terminal' },
                findings: record.findings.map((finding) => ({
                  id: finding.id,
                  severity: finding.severity,
                  ...(finding.file ? { fileName: finding.file } : {}),
                  excerpt: finding.text,
                })),
                logPath: report.reportPath,
                untracked: state.untracked,
                at: effects.nowIso(),
              };
              return {
                ledger: {
                  version: DEV_LEDGER_VERSION,
                  branch: ledger.branch,
                  records: [...ledger.records, entry],
                },
                value: undefined,
              };
            });
            await noteBookkeeping(
              await bookkeepingKey(root, relative(root, devLedgerPath(root, state.branch))),
            );
          };
          const recordDisposition = async (root: string, finding: Finding) => {
            const recorded = deps.disposition
              ? await deps.disposition(root, finding)
              : await makeDevDisposition(makeSubprocessDevEffects(root))({
                  repoRoot: root,
                  findingId: finding.id,
                  action: finding.status as 'fixed' | 'rejected' | 'deferred',
                  why: finding.reason ?? 'engine validated fix',
                });
            if (recorded.status !== 'ok') {
              bookkeepingFailed = true;
              report.reasons.push(`disposition ${finding.id}: ${issue(recorded)}`);
              return false;
            }
            if (!deps.disposition) {
              const branch = await branchName(root);
              await noteBookkeeping(
                await bookkeepingKey(root, relative(root, devLedgerPath(root, branch))),
              );
            }
            dispositions.set(identity(finding), finding);
            return true;
          };
          const dispatchFindings = async (root: string, record: FindingsRecord, round: number) => {
            if (
              new Set(record.findings.map((finding) => finding.id)).size !== record.findings.length
            )
              throw new Error('duplicate finding identity');
            await admitRecord(root, record);
            publishedBase ??= await gitText(root, ['rev-parse', 'HEAD']);
            for (const batch of addressBatches(
              record.findings.filter((finding) => finding.status === 'open'),
              policy.review.addressConcurrency,
            )) {
              if (stop()) return;
              const jobs = batch.map((finding, index) => ({
                id: `finding-${index}`,
                op: 'review.fixItem',
                input: {
                  item: { kind: 'finding', finding },
                  worktree: { path: root, branch: record.branch },
                  driver: policy.roles.worker!,
                } satisfies FindingReviewItemInput,
              }));
              const plan: Plan = { id: `review-address-${round}-${randomUUID()}`, jobs };
              const entry: OpRegistryEntry = {
                name: 'review.fixItem',
                inputSchema: FixReviewItemInputSchema,
                importer: async () => async (raw: unknown) => {
                  const request = raw as FindingReviewItemInput;
                  const fix = await bindWorker(root).fix(request.item.finding, round);
                  remember(fix);
                  return { status: 'ok', value: fix };
                },
              };
              const run = await runPlan(
                plan,
                {
                  concurrency: policy.review.addressConcurrency,
                  stopOnError: false,
                  maxTokens: Math.max(1, remainingTokens()),
                  journalDir: resolve(journalDir, `round-${round}`),
                },
                {
                  get: (name) =>
                    name === entry.name
                      ? (entry as unknown as OpRegistryEntry<never, never>)
                      : undefined,
                },
                {
                  governor: createGovernor({
                    maxTokens: Math.max(1, remainingTokens()),
                    perJobWallClockMs: Math.min(policy.budgets.unit.wallMs, remainingWallMs()),
                  }),
                  ...(parent ? { signal: parent } : {}),
                  allowAdvisory: true,
                  allowAdvisoryProvenance: 'product',
                },
              );
              for (const row of run.jobs) {
                if (row.result.status !== 'ok') {
                  report.reasons.push(`finding job ${row.jobId}: ${issue(row.result)}`);
                  continue;
                }
                const fix = row.result.value as AddressFix;
                if (!(await recordDisposition(root, fix.finding))) fix.finding.status = 'open';
              }
              report.rounds.push({ round, record, run });
            }
          };
          const retainDeferred = (record: FindingsRecord): FindingsRecord => {
            const findings = record.findings.map((finding) => {
              const prior = dispositions.get(identity(finding));
              return prior?.status === 'deferred'
                ? { ...finding, status: prior.status, reason: prior.reason ?? '' }
                : finding;
            });
            for (const prior of dispositions.values())
              if (
                prior.status === 'deferred' &&
                !findings.some((finding) => identity(finding) === identity(prior))
              )
                findings.push(prior);
            return { ...record, findings };
          };
          let root = resolve(input.repoRoot);
          let previous: FindingsRecord | undefined;
          let prMetadata:
            | {
                owner: string;
                repo: string;
                pr: number;
                headRefName: string;
                headRepo?: string;
                login: string;
              }
            | undefined;
          let dispatchLogPath: string | undefined;
          const reviewers = new Set<string>();
          if (input.source !== 'local') {
            const pr = Number(input.source.slice(3));
            const repoResult = await gh(['repo', 'view', '--json', 'nameWithOwner']);
            const loginResult = await gh(['api', 'user', '--jq', '.login']);
            if (repoResult.code !== 0 || loginResult.code !== 0 || !loginResult.stdout.trim())
              return await finish(
                'needs-human',
                'current authenticated forge identity/repository unavailable',
              );
            const name = (JSON.parse(repoResult.stdout) as { nameWithOwner: string }).nameWithOwner;
            const [owner, repo] = name.split('/');
            if (!owner || !repo)
              return await finish('needs-human', 'invalid forge repository identity');
            const metaResult = await gh([
              'pr',
              'view',
              String(pr),
              '--repo',
              name,
              '--json',
              'headRefName,headRepositoryOwner,headRepository',
            ]);
            if (metaResult.code !== 0)
              return await finish('needs-human', 'PR head metadata unavailable');
            const meta = JSON.parse(metaResult.stdout) as {
              headRefName: string;
              headRepositoryOwner: { login: string };
              headRepository: { name: string };
            };
            if (
              !/^[A-Za-z0-9_.-]+$/.test(meta.headRepositoryOwner.login) ||
              !/^[A-Za-z0-9_.-]+$/.test(meta.headRepository.name) ||
              !meta.headRefName ||
              meta.headRefName.startsWith('-')
            )
              return await finish('needs-human', 'invalid PR head repository/branch');
            prMetadata = {
              owner,
              repo,
              pr,
              headRefName: meta.headRefName,
              headRepo: `${meta.headRepositoryOwner.login}/${meta.headRepository.name}`,
              login: loginResult.stdout.trim(),
            };
            // Publication receipts outlive run-specific reports. A changed target,
            // fork/branch or authenticated actor cannot borrow another run's log.
            // The loop still requires fetched authenticated current-head/round proof;
            // a stored receipt alone never authorizes resolution.
            const commonDir = await gitText(root, [
              'rev-parse',
              '--path-format=absolute',
              '--git-common-dir',
            ]);
            if (!commonDir) return await finish('needs-human', 'Git common directory unavailable');
            const namespace = createHash('sha256')
              .update(
                JSON.stringify([
                  owner.toLowerCase(),
                  repo.toLowerCase(),
                  pr,
                  input.target ?? 'merge-queue',
                  input.base ?? null,
                  prMetadata.headRepo!.toLowerCase(),
                  meta.headRefName,
                  prMetadata.login.toLowerCase(),
                ]),
              )
              .digest('hex');
            const receiptDir = resolve(root, commonDir, 'cq-review-address', namespace);
            await mkdir(receiptDir, { recursive: true });
            dispatchLogPath = resolve(receiptDir, 'dispatch.jsonl');
          }
          if (input.source === 'local') {
            const read = await readWorkState(makeSubprocessDevEffects(root), {
              target: input.target ?? 'merge-queue',
              ...(input.base ? { base: input.base } : {}),
            });
            if (!read.ok) return await finish('needs-human', read.reason);
            reviewedBase = read.state.base;
          }
          for (let round = 1; round <= policy.review.rounds; round++) {
            const stopped = stop();
            if (stopped) return await finish('needs-human', stopped);
            if (prMetadata) {
              const meta = prMetadata;
              const fixesById = new Map<string, AddressFix>();
              const entry: OpRegistryEntry = {
                name: 'review.fixItem',
                inputSchema: FixReviewItemInputSchema,
                importer: async () => async (raw: unknown) => {
                  const item = raw as FixReviewItemInput;
                  root = item.worktree.path;
                  workerRoot = root;
                  publishBranch = meta.headRefName;
                  publishRemote =
                    meta.headRepo === `${meta.owner}/${meta.repo}`
                      ? 'origin'
                      : `https://github.com/${meta.headRepo}.git`;
                  publishedBase ??= await gitText(root, ['rev-parse', 'HEAD']);
                  const finding: Finding = {
                    id: item.item.id,
                    source: 'pr-threads',
                    ...(item.item.path ? { file: item.item.path } : {}),
                    ...(item.item.line && item.item.line > 0 ? { line: item.item.line } : {}),
                    severity: 'major',
                    text: discussionText(item.item.body, item.item.comments),
                    status: 'open',
                  };
                  if ((await branchName(root)) !== item.worktree.branch)
                    throw new Error('worker execution branch changed');
                  await admitRecord(root, {
                    schemaVersion: 1,
                    branch: item.worktree.branch,
                    head: await gitText(root, ['rev-parse', 'HEAD']),
                    sources: [{ kind: 'pr-threads', status: 'terminal' }],
                    findings: [finding],
                  });
                  const fix = await bindWorker(root).fix(finding, round);
                  const dispositionRecorded = await recordDisposition(root, fix.finding);
                  if (!dispositionRecorded) fix.finding.status = 'open';
                  remember(fix);
                  fixesById.set(finding.id, fix);
                  if (!dispositionRecorded)
                    return {
                      status: 'needs-human',
                      reason: `${NO_OUTCOME_REASON}: disposition persistence failed`,
                    };
                  if (fix.finding.status === 'rejected' && fix.evidence?.length)
                    return {
                      status: 'ok',
                      value: {
                        disposition: 'unchanged_with_reason',
                        changed: false,
                        summary: fix.reason,
                        commits: [],
                        evidence: fix.evidence,
                        denials: [],
                      } satisfies FixReviewItemResult,
                    };
                  if (!fix.commit)
                    return { status: 'needs-human', reason: `${NO_OUTCOME_REASON}: ${fix.reason}` };
                  const value: FixReviewItemResult = {
                    disposition: 'fixed',
                    changed: true,
                    summary: fix.reason,
                    commits: [fix.commit],
                    evidence: [],
                    denials: [],
                  };
                  return { status: 'ok', value };
                },
              };
              const loop = await runReviewLoop({
                owner: meta.owner,
                repo: meta.repo,
                pr: meta.pr,
                headRefName: meta.headRefName,
                ...(meta.headRepo ? { headRepo: meta.headRepo } : {}),
                repoRoot: input.repoRoot,
                gh,
                git,
                registry:
                  deps.worktreeRegistry ??
                  fileWorktreeRegistry(resolve(journalDir, 'worktrees.json')),
                driver: policy.roles.worker!,
                driverRegistryView: {
                  get: (name) => (name === 'review.fixItem' ? entry : undefined),
                } as OpRegistryView,
                responderLogin: meta.login,
                nowMs: Date.now(),
                dispatchLogPath: dispatchLogPath!,
                allowAdvisoryBudget: true,
                engineOwnedConcurrency: policy.review.addressConcurrency,
                publish: input.push === true,
                publicationTreeClean,
                ...(parent ? { signal: parent } : {}),
                runOptions: {
                  maxTokens: Math.max(1, remainingTokens()),
                  journalDir: resolve(journalDir, `pr-round-${round}`),
                },
              });
              root = loop.worktree.path;
              workerRoot = root;
              publishBranch = meta.headRefName;
              if (input.push && loop.status === 'ok') {
                unpublished.clear();
                publishedBase = await gitText(root, ['rev-parse', 'HEAD']);
              }
              if (loop.status !== 'ok') report.reasons.push(...loop.reasons);
              const fetched = await fetchReviewState(
                { owner: meta.owner, repo: meta.repo, pr: meta.pr },
                undefined,
                gh,
              );
              if (fetched.truncated)
                return await finish('needs-human', 'PR review source truncated');
              for (const thread of fetched.threads) {
                if (
                  thread.isResolved &&
                  fixesById.get(thread.id)?.commit &&
                  thread.authorLogin &&
                  (thread.authorType === 'Bot' || thread.authorLogin.endsWith('[bot]'))
                ) {
                  const reason = `advisory: bot reviewer ${thread.authorLogin} cannot be re-requested through the human reviewer API; no bot re-request performed`;
                  if (!report.reasons.includes(reason)) report.reasons.push(reason);
                  continue;
                }
                if (
                  thread.isResolved &&
                  fixesById.get(thread.id)?.commit &&
                  thread.authorLogin &&
                  thread.authorType !== 'Bot' &&
                  !thread.authorLogin.endsWith('[bot]') &&
                  thread.authorLogin !== meta.login
                )
                  reviewers.add(thread.authorLogin);
              }
              if ((await branchName(root)) !== loop.worktree.branch)
                return await finish('needs-human', 'PR worker branch changed');
              const currentHead = await gitText(root, ['rev-parse', 'HEAD']);
              const rejectionReasons = new Map<string, string>();
              const ledger = makeSubprocessDevEffects(root).openLedger(loop.worktree.branch).load();
              for (const thread of fetched.threads) {
                const proof = loopReplyVerdict(thread, {
                  signature: replySignature(meta.owner, meta.repo, meta.pr),
                  headSha: currentHead,
                  ownLogin: meta.login,
                  requireCurrentIdentity: true,
                });
                const latest = ledger.records
                  .filter((entry) => entry.kind === 'disposition' && entry.findingId === thread.id)
                  .at(-1);
                if (
                  proof.kind === 'settled' &&
                  !proof.carryResolve &&
                  latest?.kind === 'disposition' &&
                  latest.action === 'rejected' &&
                  latest.head === currentHead
                )
                  rejectionReasons.set(thread.id, latest.why);
              }
              const threads: FindingsRecord = {
                schemaVersion: 1,
                branch: loop.worktree.branch,
                head: currentHead,
                sources: [{ kind: 'pr-threads', status: 'terminal' }],
                findings: fetched.threads
                  .filter(
                    (thread) =>
                      !thread.isResolved &&
                      thread.authorLogin !== meta.login &&
                      thread.authorLogin !== fetched.authorLogin,
                  )
                  .map((thread) => ({
                    id: thread.id,
                    source: 'pr-threads',
                    ...(thread.path ? { file: thread.path } : {}),
                    ...(thread.line && thread.line > 0 ? { line: thread.line } : {}),
                    text: discussionText(thread.body, thread.replies),
                    severity: 'major',
                    status:
                      (loop.status === 'ok' &&
                        fixesById.get(thread.id)?.finding.status === 'rejected') ||
                      rejectionReasons.has(thread.id)
                        ? 'rejected'
                        : 'open',
                    ...((loop.status === 'ok' &&
                      fixesById.get(thread.id)?.finding.status === 'rejected') ||
                    rejectionReasons.has(thread.id)
                      ? {
                          reason:
                            rejectionReasons.get(thread.id) ?? fixesById.get(thread.id)!.reason,
                        }
                      : {}),
                  })),
              };
              report.findings = retainDeferred(threads).findings;
              report.openBlocking = openBlocking(
                { ...threads, findings: report.findings },
                policy.review.blockingSeverities,
              );
              if (stop()) return await finish('needs-human', stop());
              const agent = await review({
                repoRoot: root,
                target: input.target ?? 'merge-queue',
                ...(input.base ? { base: input.base } : {}),
                maxTokens: Math.max(1, remainingTokens()),
                wallMs: Math.max(1, remainingWallMs()),
                reviewers: ['agent'],
              });
              if (agent.status !== 'ok')
                return await finish('needs-human', `PR re-review: ${issue(agent)}`);
              if (agent.value.branch !== threads.branch || agent.value.head !== threads.head)
                return await finish('needs-human', 'PR re-review identity changed');
              previous = retainDeferred(merge([threads, agent.value]));
              report.rounds.push({
                round,
                record: previous,
                ...(loop.fixReport ? { run: loop.fixReport } : {}),
              });
              report.findings = previous.findings;
              report.openBlocking = openBlocking(previous, policy.review.blockingSeverities);
              if (
                report.openBlocking.length === 0 &&
                !bookkeepingFailed &&
                loop.status === 'ok' &&
                isComplete(previous, ['agent', 'pr-threads'])
              ) {
                if (stop()) return await finish('needs-human', stop());
                if (reviewers.size)
                  await requestReviewers({
                    owner: meta.owner,
                    repo: meta.repo,
                    pr: meta.pr,
                    reviewers: [...reviewers],
                    run: gh,
                  });
                return await finish('ok');
              }
              // Local agent findings share the same engine and round cap as forge threads.
              await dispatchFindings(root, retainDeferred(agent.value), round);
              await publishOnExit();
              continue;
            }
            if (!previous) {
              const branch = await branchName(root);
              let record = deps.initialRecord;
              if (!record) {
                let path = input.record;
                if (!path) {
                  const folder = resolve(root, '.cq', 'review', encodeURIComponent(branch));
                  const files = (await readdir(folder))
                    .filter((name) => /^\d+\.json$/.test(name))
                    .sort((a, b) => Number(b.slice(0, -5)) - Number(a.slice(0, -5)));
                  if (!files[0])
                    return await finish(
                      'needs-human',
                      'no findings record; run review.run or pass --record',
                    );
                  path = join(folder, files[0]);
                }
                record = FindingsRecordSchema.parse(
                  JSON.parse(await readFile(resolve(root, path), 'utf8')),
                );
                await noteBookkeeping(
                  await bookkeepingKey(root, relative(root, resolve(root, path))),
                );
              }
              if (
                record.branch !== branch ||
                record.head !== (await gitText(root, ['rev-parse', 'HEAD']))
              )
                return await finish(
                  'needs-human',
                  'findings record does not match current branch/head',
                );
              previous = record;
            }
            report.findings = previous.findings;
            report.openBlocking = openBlocking(previous, policy.review.blockingSeverities);
            if (!isComplete(previous, policy.review.reviewers))
              return await finish('needs-human', 'review source incomplete');
            const pending = previous.findings.filter((f) => f.status === 'open');
            if (!pending.length && !report.openBlocking.length && !bookkeepingFailed) {
              await admitCleanRecord(root, previous);
              return await finish('ok');
            }
            await dispatchFindings(root, previous, round);
            await publishOnExit();
            if (stop()) return await finish('needs-human', stop());
            const refreshed = await review({
              repoRoot: root,
              target: input.target ?? 'merge-queue',
              ...(reviewedBase ? { base: reviewedBase } : {}),
              maxTokens: Math.max(1, remainingTokens()),
              wallMs: Math.max(1, remainingWallMs()),
            });
            if (refreshed.status !== 'ok')
              return await finish('needs-human', `re-review: ${issue(refreshed)}`);
            if (
              refreshed.value.branch !== (await branchName(root)) ||
              refreshed.value.head !== (await gitText(root, ['rev-parse', 'HEAD']))
            )
              return await finish('needs-human', 're-review identity changed');
            previous = retainDeferred(refreshed.value);
            report.findings = previous.findings;
            report.openBlocking = openBlocking(previous, policy.review.blockingSeverities);
            report.rounds.push({ round, record: previous });
            if (
              isComplete(previous, policy.review.reviewers) &&
              !report.openBlocking.length &&
              !bookkeepingFailed
            ) {
              await admitCleanRecord(root, previous);
              return await finish('ok');
            }
          }
          return await finish('needs-human', 'review round cap reached with open findings');
        } catch (error) {
          return await finish(
            'needs-human',
            error instanceof Error ? error.message : String(error),
          );
        }
      }, parent);
    } catch (error) {
      return await finish('needs-human', error instanceof Error ? error.message : String(error));
    }
  };
}
