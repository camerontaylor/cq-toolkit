import { z } from 'zod';
import { mkdtemp, symlink, access, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { makeQueueOps } from './queue.js';
import type { QueueEnqueueInput } from './internal/queueProtocol.js';
import { resolve } from 'node:path';
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

/** Each production leg has its own Git common directory; the ownership lock stays intact. */
export async function isolateAddressMany(repoRoot: string, number: number): Promise<string> {
  const git = promisify(execFile);
  const parent = await mkdtemp(resolve(tmpdir(), `cq-address-many-${number}-`));
  const root = resolve(parent, 'repo');
  const origin = await git('git', ['-C', repoRoot, 'remote', 'get-url', 'origin']);
  await git('git', ['clone', '--no-hardlinks', '--', repoRoot, root]);
  await git('git', ['-C', root, 'remote', 'set-url', 'origin', origin.stdout.trim()]);
  // Dependencies are read-only inputs to address's private candidate copies.
  const modules = resolve(repoRoot, 'node_modules');
  try {
    await access(modules);
  } catch {
    return root;
  }
  await symlink(modules, resolve(root, 'node_modules'), 'dir');
  return root;
}
export function makeReviewAddressMany(
  deps: {
    gh?: GhFn;
    isolate?: typeof isolateAddressMany;
    enqueue?: ReturnType<typeof makeQueueOps>['enqueue'];
    address?: (input: ReviewAddressInput) => Promise<ReviewAddressResult>;
  } = {},
) {
  return async (input: ReviewAddressManyInput): Promise<ReviewAddressManyResult> => {
    const valid = ReviewAddressManyInputSchema.safeParse(input);
    if (!valid.success) return { status: 'failed', error: valid.error.message };
    const gh = deps.gh ?? makeGhRunner({ cwd: input.repoRoot, timeoutMs: 30_000 });
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
      const selection = selectAddressMany(
        { repo: input.repo, complete: true, pulls: await Promise.all(numbers.map(facts)) },
        { repo: input.repo, owner: input.owner },
      );
      if (!selection.ok)
        return { status: 'needs-human', reason: JSON.stringify(selection.refusal) };
      if (!selection.candidates.length)
        return { status: 'needs-human', reason: 'No eligible PRs in selection' };
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
        address = makeReviewAddress({ config });
      }
      let budget = initialAddressManyBudget({ limitTokens: input.maxTokens });
      const outcomes: AddressManyOutcomeInput[] = [];
      const pending = [...selection.candidates];
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
            });
            continue;
          }
          budget = admission.state;
          let result: ReviewAddressResult | undefined;
          let dispatched = false;
          let enrollment: AddressManyEnrollment = { state: 'not-requested' };
          try {
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
              outcomes.push({ number: candidate.number, headOid: candidate.headOid, result });
              budget = settleAddressMany(budget, {
                ...identity,
                usage: { kind: 'known', tokens: 0 },
              }).state;
              continue;
            }
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
              ? await deps.isolate(input.repoRoot, candidate.number)
              : await isolateAddressMany(input.repoRoot, candidate.number);
            dispatched = true;
            result = await address({
              repoRoot: root,
              source: `pr:${candidate.number}`,
              maxTokens: input.tokensPerPr,
              ...(input.rounds === undefined ? {} : { rounds: input.rounds }),
              ...(input.wallMs === undefined ? {} : { wallMs: input.wallMs }),
              ...(input.push === undefined ? {} : { push: input.push }),
            });
            outcomes.push({
              number: candidate.number,
              headOid: candidate.headOid,
              result,
              enrollment,
            });
          } catch (error) {
            outcomes.push({
              number: candidate.number,
              headOid: candidate.headOid,
              exception: String(error),
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
        }
      };
      await Promise.all(
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
      const rolled = aggregateAddressMany({
        repo: input.repo,
        budget,
        candidates: selection.candidates,
        outcomes,
      });
      if (!rolled.ok) return { status: 'failed', error: JSON.stringify(rolled.refusal) };
      const report = {
        ...rolled.aggregate,
        reasons: [
          ...rolled.aggregate.reasons,
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
