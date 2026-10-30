import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { makeGhRunner, type GhFn } from '../../adapters/forge-github/gh.js';
import { ReviewAddressManyInputSchema } from './registry.js';
import type { OpResult } from '../../kernel/types.js';
import { parseCqConfig } from '../analyze/cqConfig.js';
import { makeReviewAddress, type ReviewAddressInput, type ReviewAddressResult } from './address.js';
import {
  selectAddressMany,
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
  pulls: number[];
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

/** Serial execution respects address's common-directory ownership lock. No inline vendor review. */
export function makeReviewAddressMany(
  deps: {
    gh?: GhFn;
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
      const selection = selectAddressMany(
        { repo: input.repo, complete: true, pulls: await Promise.all(input.pulls.map(facts)) },
        { repo: input.repo, owner: input.owner },
      );
      if (!selection.ok)
        return { status: 'needs-human', reason: JSON.stringify(selection.refusal) };
      if (!selection.candidates.length)
        return { status: 'needs-human', reason: 'No eligible PRs in explicit selection' };
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
      for (const candidate of selection.candidates) {
        const identity = {
          id: String(candidate.number),
          repo: input.repo,
          number: candidate.number,
          headOid: candidate.headOid,
        };
        const admission = admitAddressMany(budget, { ...identity, tokens: input.tokensPerPr });
        if (admission.kind !== 'admitted') {
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
          )
            throw new Error('PR eligibility or head changed before admission');
          dispatched = true;
          result = await address({
            repoRoot: input.repoRoot,
            source: `pr:${candidate.number}`,
            maxTokens: input.tokensPerPr,
            ...(input.rounds === undefined ? {} : { rounds: input.rounds }),
            ...(input.wallMs === undefined ? {} : { wallMs: input.wallMs }),
            ...(input.push === undefined ? {} : { push: input.push }),
          });
          outcomes.push({ number: candidate.number, headOid: candidate.headOid, result });
        } catch (error) {
          outcomes.push({
            number: candidate.number,
            headOid: candidate.headOid,
            exception: String(error),
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
      const rolled = aggregateAddressMany({
        repo: input.repo,
        budget,
        candidates: selection.candidates,
        outcomes,
      });
      if (!rolled.ok) return { status: 'failed', error: JSON.stringify(rolled.refusal) };
      const report = rolled.aggregate;
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
