import { z } from 'zod';
import { mkdtemp, symlink, access, readFile, mkdir, rm, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { makeQueueOps } from './queue.js';
import type { QueueEnqueueInput } from './internal/queueProtocol.js';
import { resolve, dirname } from 'node:path';
import { makeGhRunner, type GhFn } from '../../adapters/forge-github/gh.js';
import { ReviewAddressManyInputSchema } from './registry.js';
import type { OpResult } from '../../kernel/types.js';
import { parseCqConfig } from '../analyze/cqConfig.js';
import { makeReviewAddress, type ReviewAddressInput, type ReviewAddressResult } from './address.js';
import {
  selectAddressMany,
  resolveAddressManyConcurrency,
  type AddressManyEnrollment,
  initialAddressManyBudget,
  admitAddressMany,
  settleAddressMany,
  aggregateAddressMany,
  type AddressManyPrFacts,
  type AddressManyAggregate,
  type AddressManyOutcomeInput,
} from './internal/addressManyPlan.js';

const PullMetadata = z.object({
  number: z.number().int().positive(),
  merged: z.boolean(),
  state: z.enum(['open', 'closed']),
  draft: z.boolean(),
  user: z.object({ login: z.string(), type: z.enum(['User', 'Organization', 'Bot']) }).nullable(),
  head: z.object({
    sha: z.string(),
    ref: z.string(),
    repo: z.object({ full_name: z.string() }).nullable(),
  }),
});
const RepositoryMetadata = z.object({ nameWithOwner: z.string() });

export interface ReviewAddressManyInput {
  repoRoot: string;
  repo: string;
  pulls?: number[];
  query?: string;
  concurrency?: number;
  cloneRoot?: string;
  enrollments?: Array<{ number: number; request: QueueEnqueueInput }>;
  owner: string;
  maxTokens: number;
  tokensPerPr: number;
  rounds?: number;
  wallMs?: number;
  push?: boolean;
}
export type ReviewAddressManyResult = OpResult<AddressManyAggregate> & {
  report?: AddressManyAggregate;
};

class IsolationRefusal extends Error {}

/** Independent object store and common directory; caller receipts remain durable. */
export async function isolateAddressMany(
  repoRoot: string,
  number: number,
  options: { cloneRoot: string; target?: string },
): Promise<string> {
  const git = promisify(execFile);
  // Inspect key names only: helpers, HTTP headers and signing values may contain credentials.
  const scopes = ['--local'];
  try {
    const extension = await git('git', [
      '-C',
      repoRoot,
      'config',
      '--bool',
      '--get',
      'extensions.worktreeConfig',
    ]);
    if (extension.stdout.trim() === 'true') scopes.push('--worktree');
  } catch (error) {
    if ((error as { code?: unknown }).code !== 1)
      throw new IsolationRefusal('Cannot inspect worktree configuration capability');
  }
  for (const scope of scopes) {
    try {
      const local = await git('git', [
        '-C',
        repoRoot,
        'config',
        scope,
        '--name-only',
        '--get-regexp',
        '^(http\\..*extraheader|credential\\..*helper|commit\\.gpgsign|gpg\\.format|user\\.signingkey)$',
      ]);
      if (local.stdout.trim())
        throw new IsolationRefusal(
          'Repository-local or worktree credential-helper, HTTP header or signing settings require plain review.address; bulk isolation refuses to copy sensitive configuration',
        );
    } catch (error) {
      if (error instanceof IsolationRefusal) throw error;
      if ((error as { code?: unknown }).code !== 1)
        throw new IsolationRefusal(
          'Cannot inspect repository-local or worktree credential and signing configuration',
        );
    }
  }
  await mkdir(options.cloneRoot, { recursive: true });
  const parent = await mkdtemp(resolve(options.cloneRoot, `pr-${number}-`));
  const root = resolve(parent, 'repo');
  try {
    const origin = await git('git', ['-C', repoRoot, 'remote', 'get-url', 'origin']);
    await git('git', ['clone', '--no-hardlinks', '--', repoRoot, root]);
    await git('git', ['-C', root, 'remote', 'set-url', 'origin', origin.stdout.trim()]);
    for (const role of ['author', 'committer']) {
      let ident: string;
      try {
        ident = (
          await git('git', ['-C', repoRoot, 'var', `GIT_${role.toUpperCase()}_IDENT`])
        ).stdout.trim();
      } catch {
        throw new IsolationRefusal(
          `Cannot resolve caller ${role} identity; configure Git identity before bulk addressing`,
        );
      }
      const parsed = /^(.*) <([^<>]+)> [0-9]+ [+-][0-9]{4}$/.exec(ident);
      if (!parsed) throw new IsolationRefusal(`Cannot resolve caller ${role} identity`);
      await git('git', ['-C', root, 'config', `${role}.name`, parsed[1]!]);
      await git('git', ['-C', root, 'config', `${role}.email`, parsed[2]!]);
    }
    const target = options.target ?? 'main';
    await git('git', [
      '-C',
      root,
      'fetch',
      'origin',
      `+refs/heads/${target}:refs/remotes/origin/${target}`,
    ]);
    const modules = resolve(repoRoot, 'node_modules');
    try {
      await access(modules);
    } catch {
      return root;
    }
    await symlink(modules, resolve(root, 'node_modules'), 'dir');
    return root;
  } catch (error) {
    await rm(parent, { recursive: true, force: true });
    throw error;
  }
}
export function makeReviewAddressMany(
  deps: {
    gh?: GhFn;
    isolate?: typeof isolateAddressMany;
    coordinationRoot?: string;
    enqueue?: ReturnType<typeof makeQueueOps>['enqueue'];
    address?: (input: ReviewAddressInput) => Promise<ReviewAddressResult>;
  } = {},
) {
  return async (input: ReviewAddressManyInput): Promise<ReviewAddressManyResult> => {
    const valid = ReviewAddressManyInputSchema.safeParse(input);
    if (!valid.success) return { status: 'failed', error: valid.error.message };
    const gh =
      deps.gh ?? makeGhRunner({ cwd: input.repoRoot, unsetEnv: ['GH_REPO'], timeoutMs: 30_000 });
    const facts = async (number: number): Promise<AddressManyPrFacts> => {
      const response = await gh(['api', `repos/${input.repo}/pulls/${number}`]);
      if (response.code !== 0) throw new Error(`cannot read PR #${number}: ${response.stderr}`);
      const pr = PullMetadata.parse(JSON.parse(response.stdout) as unknown);
      return {
        repo: input.repo,
        number: pr.number,
        state: pr.merged ? 'MERGED' : pr.state === 'open' ? 'OPEN' : 'CLOSED',
        isDraft: pr.draft,
        author: { login: pr.user?.login ?? '', type: pr.user?.type ?? 'User' },
        headRepository: pr.head.repo?.full_name ?? '',
        headRefName: pr.head.ref,
        headOid: pr.head.sha,
      };
    };
    try {
      const repository = await gh(['repo', 'view', '--json', 'nameWithOwner']);
      if (
        repository.code !== 0 ||
        RepositoryMetadata.parse(
          JSON.parse(repository.stdout) as unknown,
        ).nameWithOwner.toLowerCase() !== input.repo.toLowerCase()
      )
        return { status: 'needs-human', reason: 'repoRoot remote does not match requested repo' };
      let numbers = input.pulls ?? [];
      if (input.query !== undefined) {
        try {
          numbers = [];
          let total: number | undefined;
          for (let page = 1; ; page++) {
            const response = await gh([
              'api',
              '-X',
              'GET',
              'search/issues',
              '-f',
              `q=repo:${input.repo} is:pr ${input.query}`,
              '-f',
              'per_page=100',
              '-f',
              `page=${page}`,
            ]);
            if (response.code !== 0)
              return { status: 'needs-human', reason: 'PR discovery failed' };
            const parsed = z
              .object({
                total_count: z.number().int().nonnegative(),
                incomplete_results: z.boolean(),
                items: z.array(
                  z.object({
                    number: z.number().int().positive(),
                    repository_url: z.string(),
                    pull_request: z.object({ url: z.string() }),
                  }),
                ),
              })
              .safeParse(JSON.parse(response.stdout) as unknown);
            if (!parsed.success)
              return { status: 'needs-human', reason: 'Invalid PR discovery response' };
            const data = parsed.data;
            if (
              data.incomplete_results ||
              data.total_count > 1000 ||
              (total !== undefined && total !== data.total_count)
            )
              return { status: 'needs-human', reason: 'Incomplete or truncated PR discovery' };
            total = data.total_count;
            if (
              data.items.some(
                (item) =>
                  item.repository_url.toLowerCase() !==
                  `https://api.github.com/repos/${input.repo}`.toLowerCase(),
              )
            )
              return { status: 'needs-human', reason: 'Query returned another repository' };
            numbers.push(...data.items.map((item) => item.number));
            if (numbers.length === total && new Set(numbers).size === total) break;
            if (data.items.length < 100 || page >= 10 || numbers.length >= total)
              return { status: 'needs-human', reason: 'Incomplete PR discovery pagination' };
          }
        } catch (error) {
          return { status: 'needs-human', reason: `PR discovery failed: ${String(error)}` };
        }
      }
      if (input.enrollments?.some((row) => !numbers.includes(row.number)))
        return { status: 'needs-human', reason: 'Enrollment outside selection' };
      const listed: AddressManyPrFacts[] = [];
      let cursor = 0;
      const reads = await Promise.allSettled(
        Array.from({ length: Math.min(8, numbers.length) }, async () => {
          while (cursor < numbers.length) listed.push(await facts(numbers[cursor++]!));
        }),
      );
      if (reads.some((r) => r.status === 'rejected'))
        return { status: 'needs-human', reason: 'PR facts enumeration failed; no legs dispatched' };
      const selection = selectAddressMany(
        { repo: input.repo, complete: true, pulls: listed },
        { repo: input.repo, owner: input.owner },
      );
      if (!selection.ok)
        return { status: 'needs-human', reason: JSON.stringify(selection.refusal) };
      if (!selection.candidates.length)
        return { status: 'needs-human', reason: 'No eligible PRs in selection' };
      const git = promisify(execFile);
      const coordinationRoot =
        deps.coordinationRoot ??
        (await realpath(
          (
            await git('git', [
              '-C',
              input.repoRoot,
              'rev-parse',
              '--path-format=absolute',
              '--git-common-dir',
            ])
          ).stdout.trim(),
        ));
      const cloneRoot = input.cloneRoot ?? resolve(coordinationRoot, 'cq-address-many-clones');
      let address = deps.address;
      if (!address) {
        const parsed = parseCqConfig(
          await readFile(resolve(input.repoRoot, 'cq.json'), 'utf8'),
          input.repoRoot,
        );
        if (!parsed.ok) return { status: 'needs-human', reason: parsed.reason };
        const config = parsed.config;
        // Bulk fixes use agent review and existing threads; vendor debt is advisory.
        config.review = { ...config.review, reviewers: ['agent'] };
        address = makeReviewAddress({ config, coordinationRoot });
      }
      let budget = initialAddressManyBudget({ limitTokens: input.maxTokens });
      const outcomes: AddressManyOutcomeInput[] = [];
      const pending = [...selection.candidates];
      const faults: string[] = [];
      const preservedClones: Array<{ number: number; path: string }> = [];
      const requestedEnrollment = (number: number): AddressManyEnrollment =>
        input.enrollments?.some((r) => r.number === number)
          ? { state: 'unavailable', reason: 'Requested but leg not dispatched' }
          : { state: 'not-requested' };
      const worker = async () => {
        while (pending.length) {
          const candidate = pending.shift()!;
          const identity = {
            id: String(candidate.number),
            repo: input.repo,
            number: candidate.number,
            headOid: candidate.headOid,
          };
          const admission = admitAddressMany(budget, { ...identity, tokens: input.tokensPerPr });
          if (admission.kind !== 'admitted') {
            if (admission.reason === 'over-limit' && budget.outstanding.length > 0) {
              pending.unshift(candidate);
              return;
            }
            outcomes.push({
              number: candidate.number,
              headOid: candidate.headOid,
              notAdmitted: 'budget',
              enrollment: requestedEnrollment(candidate.number),
            });
            continue;
          }
          budget = admission.state;
          let result: ReviewAddressResult | undefined;
          let dispatched = false;
          let enrollment: AddressManyEnrollment = requestedEnrollment(candidate.number);
          let isolatedRoot: string | undefined;
          try {
            const request = input.enrollments?.find(
              (row) => row.number === candidate.number,
            )?.request;
            if (request) {
              try {
                if (request.action && request.action !== 'enqueue')
                  throw new Error('Enrollment requires enqueue action');
                if (
                  request.binding.kind !== 'deferred-author' ||
                  request.binding.repo.toLowerCase() !== input.repo.toLowerCase() ||
                  request.binding.head !== candidate.headOid
                )
                  throw new Error('Enrollment binding does not match admitted PR head');
                const queued = await (deps.enqueue ?? makeQueueOps().enqueue)(request);
                enrollment =
                  queued.status === 'ok' &&
                  queued.value.state !== 'unsupported' &&
                  queued.value.enqueued === true
                    ? { state: 'enrolled' }
                    : { state: 'unavailable', reason: JSON.stringify(queued) };
              } catch (error) {
                enrollment = { state: 'unavailable', reason: String(error) };
              }
            }
            const root = deps.isolate
              ? await deps.isolate(input.repoRoot, candidate.number, { cloneRoot })
              : await isolateAddressMany(input.repoRoot, candidate.number, { cloneRoot });
            isolatedRoot = root;
            preservedClones.push({ number: candidate.number, path: root });
            if (!deps.isolate) {
              const checked = await makeGhRunner({
                cwd: root,
                unsetEnv: ['GH_REPO'],
                timeoutMs: 30_000,
              })(['repo', 'view', '--json', 'nameWithOwner']);
              if (
                checked.code !== 0 ||
                RepositoryMetadata.parse(
                  JSON.parse(checked.stdout) as unknown,
                ).nameWithOwner.toLowerCase() !== input.repo.toLowerCase()
              )
                throw new Error('Isolated repository does not match requested repo');
            }
            const current = await facts(candidate.number);
            const revalidated = selectAddressMany(
              { repo: input.repo, complete: true, pulls: [current] },
              { repo: input.repo, owner: input.owner },
            );
            if (
              !revalidated.ok ||
              !revalidated.candidates.length ||
              current.headOid !== candidate.headOid ||
              current.headRepository !== candidate.headRepository ||
              current.headRefName !== candidate.headRefName
            ) {
              result = {
                status: 'needs-human',
                reason: 'PR eligibility or head changed before dispatch',
              };
            } else {
              dispatched = true;
              result = await address({
                repoRoot: root,
                source: `pr:${candidate.number}`,
                expectedHead: candidate.headOid,
                maxTokens: input.tokensPerPr,
                ...(input.rounds === undefined ? {} : { rounds: input.rounds }),
                ...(input.wallMs === undefined ? {} : { wallMs: input.wallMs }),
                ...(input.push === undefined ? {} : { push: input.push }),
                journalDir: resolve(
                  coordinationRoot,
                  'cq-address-many-reports',
                  root.split('/').at(-2)!,
                  String(candidate.number),
                ),
              });
            }
            outcomes.push({
              number: candidate.number,
              headOid: candidate.headOid,
              result,
              enrollment,
            });
          } catch (error) {
            if (error instanceof IsolationRefusal)
              result = { status: 'needs-human', reason: error.message };
            outcomes.push({
              number: candidate.number,
              headOid: candidate.headOid,
              ...(result ? { result } : { exception: String(error) }),
              enrollment,
            });
          }
          const report = result?.status === 'ok' ? result.value : result?.report;
          const usage = report?.usage;
          const settled = usage
            ? settleAddressMany(budget, {
                ...identity,
                usage: {
                  kind: 'known',
                  tokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
                },
              })
            : dispatched
              ? settleAddressMany(budget, { ...identity, usage: { kind: 'unknown' } })
              : settleAddressMany(budget, { ...identity, usage: { kind: 'known', tokens: 0 } });
          budget = settled.state;
          if (settled.kind === 'refused')
            faults.push(`PR #${candidate.number} settlement refused: ${JSON.stringify(settled)}`);
          if (
            isolatedRoot &&
            !deps.isolate &&
            (!dispatched || (result?.status === 'ok' && result.value.fixes.length === 0))
          ) {
            try {
              await rm(dirname(isolatedRoot), { recursive: true, force: true });
              preservedClones.splice(
                preservedClones.findIndex((entry) => entry.path === isolatedRoot),
                1,
              );
            } catch (error) {
              faults.push(`PR #${candidate.number} cleanup failed: ${String(error)}`);
            }
          }
        }
      };
      const workers = await Promise.allSettled(
        Array.from(
          {
            length: Math.min(
              selection.candidates.length,
              resolveAddressManyConcurrency(input.concurrency),
            ),
          },
          worker,
        ),
      );
      for (const item of workers)
        if (item.status === 'rejected') faults.push(`Worker rejected: ${String(item.reason)}`);
      for (const candidate of selection.candidates) {
        if (!outcomes.some((row) => row.number === candidate.number))
          outcomes.push({
            number: candidate.number,
            headOid: candidate.headOid,
            exception: faults.length
              ? `Not dispatched after worker failure: ${faults.join('; ')}`
              : 'Worker failed before producing outcome',
            enrollment: requestedEnrollment(candidate.number),
          });
      }
      const rolled = aggregateAddressMany({
        repo: input.repo,
        budget,
        candidates: selection.candidates,
        outcomes,
      });
      if (!rolled.ok) return { status: 'failed', error: JSON.stringify(rolled.refusal) };
      const report = {
        ...rolled.aggregate,
        preservedClones,
        rows: rolled.aggregate.rows.map((row) =>
          row.status === 'not-admitted' && faults.length
            ? { ...row, detail: `Runtime faults: ${faults.join('; ')}` }
            : row,
        ),
        excluded: selection.excluded.map((row) => ({
          number: row.number,
          reason: row.exclusion.reason,
          enrollment: requestedEnrollment(row.number),
        })),
        ...(faults.length && rolled.aggregate.status === 'ok'
          ? { status: 'needs-human' as const }
          : {}),
        reasons: [
          ...rolled.aggregate.reasons,
          ...faults,
          ...rolled.aggregate.rows
            .filter((row) => row.status !== 'settled-ok')
            .map((row) => {
              const leg = row.result;
              let detail = row.reason ?? row.status;
              if (leg?.status === 'needs-human') detail = leg.reason;
              else if (leg?.status === 'failed') detail = leg.error;
              else if (leg?.status === 'indeterminate') detail = leg.detail;
              return `PR #${row.scope.number}: ${detail}`;
            }),
        ],
      };
      if (report.status === 'ok') return { status: 'ok', value: report };
      if (report.status === 'failed')
        return { status: 'failed', error: report.reasons.join('; '), report };
      if (report.status === 'indeterminate')
        return { status: 'indeterminate', detail: report.reasons.join('; '), report };
      if (report.status === 'budget-exhausted') return { status: 'budget-exhausted', report };
      return { status: 'needs-human', reason: report.reasons.join('; '), report };
    } catch (error) {
      return { status: 'failed', error: String(error) };
    }
  };
}
