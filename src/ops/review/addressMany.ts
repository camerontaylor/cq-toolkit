// `review.addressMany` — the S8 bulk executor (card R5).
//
// ONE selection, an ALLOCATION ledger, and independent per-PR address legs:
//
//   complete gh listing ──▶ selectAddressMany (strict facts, owner/viewer/
//   explicit bot allowlist) ──▶ shared allocation ledger (default 3, bounded
//   reservations) ──▶ per-PR `review.address` legs ──▶ aggregateAddressMany
//   (exact candidate coverage, per-PR truth, truthful exits).
//
// What this op does NOT do, stated once so no caller can infer otherwise:
//   - It does not run legs in parallel. `review.address` takes the Git
//     common-dir `cq-review-address-ownership` lock for a whole invocation, so
//     address execution is SERIAL per repository. `concurrency` bounds ADMISSION
//     and reservation width only; it is not a parallelism or provider-spend
//     claim. The single-PR op keeps its own per-worker budget semantics.
//   - Reservations bound ALLOCATIONS, not spend. The settled amount is the
//     governor's landed-usage fold (`totalTokens`) from each leg's report; when
//     a leg cannot report usage the allocation stays held as `unresolved` and
//     admission stops. Nothing here enforces a provider budget.
//   - Publication is NOT inferred. A leg's report carries no structured
//     per-range publication witness, so every aggregate row says
//     `publication: 'unknown'`; `verifiedHead` and round records are mutable and
//     are never read as publication.
//   - Enrollment is ADVISORY and injected. No transport is constructed here, so
//     the default performs no call at all and reports `not-requested`; a
//     composition that wants crq enrollment supplies the seam. Deduplication is
//     per run and per head — cross-run idempotency belongs to the transport, and
//     this op does not claim it. Enrollment never changes the aggregate status.
//   - No inline CodeRabbit call exists anywhere in this path.
import type { DriverFactory } from '../../driver/factory.js';
import type { Usage } from '../../driver/types.js';
import type { OpResult } from '../../kernel/types.js';
import { totalTokens } from '../../plans/review-loop.js';
import { makeGhRunner, type GhFn } from '../../adapters/forge-github/gh.js';
import type { WorktreeRegistry } from '../../adapters/git/prWorktree.js';
import type { CqConfig } from '../analyze/cqConfig.js';
import { makeReviewAddress, type ReviewAddressDeps, type ReviewAddressInput, type ReviewAddressResult } from './address.js';
import {
  admitAddressMany,
  aggregateAddressMany,
  initialAddressManyBudget,
  resolveAddressManyConcurrency,
  selectAddressMany,
  settleAddressMany,
  type AddressManyAggregate,
  type AddressManyBudgetState,
  type AddressManyCandidate,
  type AddressManyEnrollment,
  type AddressManyOutcomeInput,
  type AddressManyPrFacts,
  type AddressManyRefusal,
  type AddressManySelection,
} from './internal/addressManyPlan.js';

/**
 * The top-level listing cap. `gh pr list --limit` is a page cap with no cursor
 * in this transport, so completeness is only provable when the page comes back
 * SHORT: a full page may have been truncated and is refused as an incomplete
 * listing rather than silently narrowed.
 */
export const ADDRESS_MANY_LISTING_LIMIT = 100;

const HEX_40 = /^[0-9a-f]{40}$/;
const REPO_NAME = /^[^/\s]+\/[^/\s]+$/;
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

export interface ReviewAddressManyInput {
  repoRoot: string;
  /** Repository to select from, as `owner/name`. */
  repo: string;
  /** Explicit authorization: the repo owner, the current viewer, and any bot logins. */
  policy: { owner: string; viewer?: string; botLogins?: readonly string[] };
  /** Shared allocation for the whole run (positive safe integer). */
  maxTokens: number;
  /** Planned active-PR cap; bounds admission, never parallel execution. */
  concurrency?: number;
  rounds?: number;
  wallMs?: number;
  push?: boolean;
  journalDir?: string;
  /** Page cap for the listing; a full page refuses as incomplete. */
  listingLimit?: number;
}

/** Advisory enrollment request handed to the injected seam (never a live call by default). */
export interface ReviewAddressManyEnrollmentRequest {
  repo: string;
  pr: number;
  headOid: string;
}

export interface ReviewAddressManyDeps {
  git?: GhFn;
  drivers?: DriverFactory;
  worktreeRegistry?: WorktreeRegistry;
  config?: CqConfig;
  /** The single-PR op; defaults to `makeReviewAddress` over the same deps. */
  address?: (input: ReviewAddressInput) => Promise<ReviewAddressResult>;
  /** Pre-dispatch head revalidation. Absent ⇒ every leg is refused, never assumed. */
  revalidateHead?: (input: ReviewAddressManyEnrollmentRequest) => Promise<string | undefined>;
  /** Advisory enrollment seam. Absent ⇒ `not-requested` and no call is made. */
  enroll?: (input: ReviewAddressManyEnrollmentRequest) => Promise<AddressManyEnrollment>;
  now?: () => number;
}

/** The ok value of a bulk run: the exact aggregate plus every per-PR result. */
export interface ReviewAddressManyReport {
  repo: string;
  listed: number;
  selected: number;
  excluded: number;
  concurrency: number;
  /** Allocation for the run and per admitted leg. */
  limitTokens: number;
  reservationTokens: number;
  aggregate?: AddressManyAggregate;
  /** Independent per-PR results, verbatim, in candidate order. */
  results: ReadonlyArray<{ number: number; headOid: string; result: ReviewAddressResult }>;
  /** Landed usage folded across reporting legs (not a spend guarantee). */
  usage: Usage;
  wallMs: number;
}

export type ReviewAddressManyResult = OpResult<ReviewAddressManyReport> & {
  report?: ReviewAddressManyReport;
};

const zeroUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

const addUsage = (a: Usage, b: Usage): Usage => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
  ...(a.reasoning === undefined && b.reasoning === undefined
    ? {}
    : { reasoning: (a.reasoning ?? 0) + (b.reasoning ?? 0) }),
});

/**
 * Map one `gh pr list --json` row to the selector's strict facts.
 *
 * Wire facts this encoding depends on (verified against this repo's own gh
 * reads): `headRepository` is `{ name }` and `headRepositoryOwner` is
 * `{ login }`; `author` carries `login` and `is_bot`. gh exposes no
 * Organization discriminator, so a non-bot author is typed `User` — that label
 * carries no privilege here (authority is the owner/viewer login or an explicit
 * bot allowlist entry plus the Bot type), and an Organization author is simply
 * reported as `User`. Any row missing a required fact makes the whole listing
 * untrustworthy: it refuses instead of silently narrowing the run.
 */
export function parseAddressManyListing(
  text: string,
  repo: string,
): { ok: true; facts: AddressManyPrFacts[] } | { ok: false; detail: string } {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return { ok: false, detail: 'gh pr list returned a non-JSON payload' };
  }
  if (!Array.isArray(payload))
    return { ok: false, detail: 'gh pr list returned a non-array payload' };
  const facts: AddressManyPrFacts[] = [];
  for (const [index, raw] of payload.entries()) {
    if (raw === null || typeof raw !== 'object')
      return { ok: false, detail: `listing row ${index} is not an object` };
    const row = raw as Record<string, unknown>;
    const number = row['number'];
    if (typeof number !== 'number' || !Number.isInteger(number) || number < 1)
      return { ok: false, detail: `listing row ${index} has no positive integer number` };
    const state = row['state'];
    if (state !== 'OPEN' && state !== 'CLOSED' && state !== 'MERGED')
      return { ok: false, detail: `PR #${number} has an unrecognized state` };
    if (typeof row['isDraft'] !== 'boolean')
      return { ok: false, detail: `PR #${number} has no draft flag` };
    const author = row['author'];
    if (author === null || typeof author !== 'object' || Array.isArray(author))
      return { ok: false, detail: `PR #${number} has no author` };
    const login = (author as Record<string, unknown>)['login'];
    if (typeof login !== 'string' || !LOGIN.test(login))
      return { ok: false, detail: `PR #${number} has no valid author login` };
    const declaredType = (author as Record<string, unknown>)['type'];
    const authorType =
      declaredType === 'Bot' || declaredType === 'Organization' || declaredType === 'User'
        ? declaredType
        : (author as Record<string, unknown>)['is_bot'] === true
          ? 'Bot'
          : 'User';
    const headRefName = row['headRefName'];
    if (typeof headRefName !== 'string' || headRefName.trim() === '')
      return { ok: false, detail: `PR #${number} has no head ref name` };
    const headOid = row['headRefOid'];
    if (typeof headOid !== 'string' || !HEX_40.test(headOid))
      return { ok: false, detail: `PR #${number} has no valid head oid` };
    const headRepositoryOwner = row['headRepositoryOwner'];
    const headRepository = row['headRepository'];
    const ownerLogin =
      headRepositoryOwner !== null && typeof headRepositoryOwner === 'object'
        ? (headRepositoryOwner as Record<string, unknown>)['login']
        : undefined;
    const repoName =
      headRepository !== null && typeof headRepository === 'object'
        ? (headRepository as Record<string, unknown>)['name']
        : undefined;
    const deleted = headRepository === null || headRepositoryOwner === null;
    const missing = headRepository === undefined || headRepositoryOwner === undefined;
    if (missing)
      return { ok: false, detail: `PR #${number} has missing head repository metadata` };
    if (!deleted && (typeof ownerLogin !== 'string' || typeof repoName !== 'string'))
      return { ok: false, detail: `PR #${number} has malformed head repository metadata` };
    facts.push({
      repo,
      number,
      state,
      isDraft: row['isDraft'] as boolean,
      author: { login, type: authorType },
      headRepository: deleted ? '' : `${String(ownerLogin)}/${String(repoName)}`,
      headRefName,
      headOid,
    });
  }
  return { ok: true, facts };
}

const formatRefusal = (refusal: AddressManyRefusal): string => {
  switch (refusal.kind) {
    case 'incomplete-listing':
    case 'repo-mismatch':
      return `${refusal.kind}: ${refusal.detail}`;
    case 'invalid-facts':
      return `invalid-facts: ${refusal.violations.map((v) => `[${v.index}] ${v.field} ${v.detail}`).join('; ')}`;
    case 'duplicate-pr':
      return `duplicate-pr: ${refusal.numbers.join(', ')}`;
  }
};

/** A pre-work refusal carried as a needs-human result: no report, no attribution claims. */
const refusalResult = (reason: string): ReviewAddressResult => ({ status: 'needs-human', reason });

const reportOf = (result: ReviewAddressResult): ReviewAddressResult['report'] =>
  result.status === 'ok' ? result.value : result.report;

/**
 * Build the bulk op. `deps.gh` supplies the listing read when `revalidateHead`
 * is absent; both are injectable so the whole executor is exercised offline.
 */
export function makeReviewAddressMany(deps: ReviewAddressManyDeps = {}) {
  return async (input: ReviewAddressManyInput): Promise<ReviewAddressManyResult> => {
    const start = (deps.now ?? Date.now)();
    const gh = deps.git ?? makeGhRunner();
    const concurrency = resolveAddressManyConcurrency(input.concurrency);
    const limit = input.listingLimit ?? ADDRESS_MANY_LISTING_LIMIT;
    if (!Number.isInteger(limit) || limit < 1)
      return { status: 'failed', error: 'listingLimit must be a positive integer' };
    if (!Number.isSafeInteger(input.maxTokens) || input.maxTokens < 1)
      return { status: 'failed', error: 'maxTokens must be a positive safe integer' };
    if (!REPO_NAME.test(input.repo))
      return { status: 'failed', error: 'repo must be owner/name' };

    // --- listing (completeness proven only by a short page) ------------------
    const listed = await gh([
      'pr',
      'list',
      '--repo',
      input.repo,
      '--state',
      'open',
      '--limit',
      String(limit),
      '--json',
      'number,state,isDraft,author,headRefName,headRefOid,headRepository,headRepositoryOwner',
    ]);
    if (listed.code !== 0)
      return { status: 'failed', error: `gh pr list failed: ${listed.stderr.trim() || listed.code}` };
    const parsed = parseAddressManyListing(listed.stdout, input.repo);
    if (!parsed.ok) return { status: 'failed', error: parsed.detail };

    const listing = {
      // A full page may have been truncated: refuse rather than narrow.
      complete: parsed.facts.length < limit,
      repo: input.repo,
      pulls: parsed.facts,
    };
    if (!listing.complete) {
      const refusal = {
        kind: 'incomplete-listing',
        detail: `listing filled its ${limit}-row page; pagination is unproven`,
      } as const;
      return { status: 'needs-human', reason: formatRefusal(refusal) };
    }

    const policy = {
      repo: input.repo,
      owner: input.policy.owner,
      ...(input.policy.viewer === undefined ? {} : { viewer: input.policy.viewer }),
      ...(input.policy.botLogins === undefined ? {} : { botLogins: input.policy.botLogins }),
    };
    let selection: AddressManySelection;
    try {
      selection = selectAddressMany(listing, policy);
    } catch (error) {
      return {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (!selection.ok) return { status: 'needs-human', reason: formatRefusal(selection.refusal) };

    const candidates = selection.candidates;
    if (candidates.length === 0) {
      // A legitimate empty selection is a no-op, not an ok aggregate: the
      // aggregate contract refuses empty coverage by design.
      return {
        status: 'ok',
        value: {
          repo: input.repo,
          listed: listing.pulls.length,
          selected: 0,
          excluded: selection.excluded.length,
          concurrency,
          limitTokens: input.maxTokens,
          reservationTokens: 0,
          aggregate: {
            repo: input.repo,
            accounting: {
              limitTokens: input.maxTokens,
              observedTokens: 0,
              heldTokens: 0,
              unresolved: [],
              stop: null,
            },
            rows: [],
            findings: [],
            totals: {
              candidates: 0,
              settledOk: 0,
              needsHuman: 0,
              failed: 0,
              budgetExhausted: 0,
              unattributed: 0,
              notAdmitted: 0,
              exceptions: 0,
              fixesPerRun: 0,
            },
            status: 'ok',
            reasons: ['no open non-draft PR matched the authorization policy'],
          },
          results: [],
          usage: zeroUsage(),
          wallMs: (deps.now ?? Date.now)() - start,
        },
      };
    }

    // --- shared allocation + serial legs ------------------------------------
    const reservationTokens = Math.max(1, Math.floor(input.maxTokens / concurrency));
    let budget: AddressManyBudgetState = initialAddressManyBudget({ limitTokens: input.maxTokens });
    const address =
      deps.address ??
      makeReviewAddress({
        ...(deps.drivers === undefined ? {} : { drivers: deps.drivers }),
        ...(deps.git === undefined ? {} : { git: deps.git }),
        ...(deps.worktreeRegistry === undefined ? {} : { worktreeRegistry: deps.worktreeRegistry }),
        ...(deps.config === undefined ? {} : { config: deps.config }),
      } satisfies ReviewAddressDeps);

    const outcomes: AddressManyOutcomeInput[] = [];
    const results: Array<{ number: number; headOid: string; result: ReviewAddressResult }> = [];
    const enrolled = new Map<string, AddressManyEnrollment>();
    let usage = zeroUsage();
    let pending: AddressManyCandidate[] = [...candidates];
    const active: Array<{ candidate: AddressManyCandidate; id: string }> = [];

    const admitNext = (): 'admitted' | 'stop' | 'error' => {
      const candidate = pending.shift();
      if (candidate === undefined) return 'stop';
      const id = `${candidate.number}@${candidate.headOid}`;
      const admission = admitAddressMany(budget, {
        id,
        repo: input.repo,
        number: candidate.number,
        headOid: candidate.headOid,
        tokens: reservationTokens,
      });
      budget = admission.state;
      if (admission.kind === 'admitted') {
        active.push({ candidate, id });
        return 'admitted';
      }
      // Only a ledger stop or an exhausted allocation explains a non-run. An
      // invalid or duplicate request is a defect in this executor, not a PR
      // outcome, and must never be dressed up as one.
      if (admission.reason === 'invalid' || admission.reason === 'duplicate') {
        pending.unshift(candidate);
        return 'error';
      }
      outcomes.push({ number: candidate.number, headOid: candidate.headOid, notAdmitted: 'budget' });
      return 'stop';
    };

    let admissionDefect: string | undefined;
    while ((pending.length > 0 || active.length > 0) && admissionDefect === undefined) {
      while (pending.length > 0 && active.length < concurrency) {
        const step = admitNext();
        if (step === 'error') {
          admissionDefect = 'allocation ledger refused a well-formed reservation';
          break;
        }
        if (step === 'stop') {
          // Stop admitting: every remaining candidate is a truthful budget non-run.
          while (pending.length > 0) {
            const rest = pending.shift()!;
            outcomes.push({ number: rest.number, headOid: rest.headOid, notAdmitted: 'budget' });
          }
        }
      }
      if (admissionDefect !== undefined) break;
      const leg = active.shift();
      if (leg === undefined) break;
      const { candidate, id } = leg;
      const request = { repo: input.repo, pr: candidate.number, headOid: candidate.headOid };

      // Revalidate BEFORE any work: a moved or unreadable head refuses this PR.
      let observed: string | undefined;
      if (deps.revalidateHead === undefined) {
        const headRead = await gh([
          'pr',
          'view',
          String(candidate.number),
          '--repo',
          input.repo,
          '--json',
          'headRefOid',
        ]);
        if (headRead.code === 0) {
          try {
            const value = (JSON.parse(headRead.stdout) as { headRefOid?: unknown })['headRefOid'];
            observed = typeof value === 'string' ? value : undefined;
          } catch {
            observed = undefined;
          }
        }
      } else {
        observed = await deps.revalidateHead(request);
      }

      let result: ReviewAddressResult;
      if (observed !== candidate.headOid) {
        result = refusalResult(
          observed === undefined
            ? `PR #${candidate.number} head could not be revalidated before work`
            : `PR #${candidate.number} head moved before work: expected ${candidate.headOid}, forge reports ${observed}`,
        );
      } else {
        const legJournal =
          input.journalDir === undefined
            ? undefined
            : `${input.journalDir}/pr-${candidate.number}`;
        result = await address({
          repoRoot: input.repoRoot,
          source: `pr:${candidate.number}`,
          maxTokens: reservationTokens,
          ...(input.rounds === undefined ? {} : { rounds: input.rounds }),
          ...(input.wallMs === undefined ? {} : { wallMs: input.wallMs }),
          ...(input.push === undefined ? {} : { push: input.push }),
          ...(legJournal === undefined ? {} : { journalDir: legJournal }),
        });
      }
      results.push({ number: candidate.number, headOid: candidate.headOid, result });

      // Advisory enrollment: once per head per run, never status-changing.
      let enrollment: AddressManyEnrollment = { state: 'not-requested' };
      if (deps.enroll !== undefined) {
        const existing = enrolled.get(candidate.headOid);
        if (existing !== undefined) enrollment = existing;
        else {
          try {
            enrollment = await deps.enroll(request);
          } catch (error) {
            enrollment = {
              state: 'unavailable',
              reason: error instanceof Error ? error.message : String(error),
            };
          }
          enrolled.set(candidate.headOid, enrollment);
        }
      }

      const legReport = reportOf(result);
      if (legReport !== undefined) usage = addUsage(usage, legReport.usage);
      const settlement = settleAddressMany(budget, {
        id,
        repo: input.repo,
        number: candidate.number,
        headOid: candidate.headOid,
        usage: legReport === undefined ? { kind: 'unknown' } : { kind: 'known', tokens: totalTokens(legReport.usage) },
      });
      budget = settlement.state;
      outcomes.push({ number: candidate.number, headOid: candidate.headOid, result, enrollment });
    }

    const aggregate = aggregateAddressMany({
      repo: input.repo,
      budget,
      candidates,
      outcomes,
    });
    if (!aggregate.ok)
      return {
        status: 'failed',
        error: `aggregate refused: ${aggregate.refusal.kind}`,
      };

    const report: ReviewAddressManyReport = {
      repo: input.repo,
      listed: listing.pulls.length,
      selected: candidates.length,
      excluded: selection.excluded.length,
      concurrency,
      limitTokens: input.maxTokens,
      reservationTokens,
      aggregate: aggregate.aggregate,
      results,
      usage,
      wallMs: (deps.now ?? Date.now)() - start,
    };

    const status = aggregate.aggregate.status;
    if (status === 'ok') return { status: 'ok', value: report };
    const reasons = aggregate.aggregate.reasons;
    const detail = reasons.length > 0 ? reasons.join('; ') : 'bulk address did not settle cleanly';
    if (status === 'budget-exhausted') return { status: 'budget-exhausted', report };
    if (status === 'failed') return { status: 'failed', error: detail, report };
    if (status === 'indeterminate') return { status: 'indeterminate', detail, report };
    return { status: 'needs-human', reason: detail, report };
  };
}

export { DEFAULT_ADDRESS_MANY_CONCURRENCY };
