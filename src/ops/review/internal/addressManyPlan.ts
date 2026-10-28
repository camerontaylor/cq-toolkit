// Pure planning contract for the planned S8 `review.addressMany` (card R5).
//
// This module is THREE decisions as data, and nothing else: which PRs a
// complete listing admits (selection), how a shared token ALLOCATION is handed
// out and settled (admission), and how independent per-PR results roll up
// truthfully (aggregate). It performs no I/O, has no runtime imports, reads no
// configuration, dispatches no driver, queue, provider or provider CLI, and is
// imported only by its own test. `review.addressMany` itself, the registry/CLI
// grammar, per-PR worktrees, enrollment transport and shared spend seams are
// later integration work and are deliberately absent here.
//
// What this contract does NOT claim, stated once so no caller can infer it:
//   - Admissions bound ALLOCATIONS, never provider spend. The governor's
//     `reserve` is USD-only and the token cap is enforced by the governor's own
//     landed-usage fold (`input + output + cacheRead + cacheWrite`, with
//     `reasoning` already counted inside `output`). Nothing here enforces
//     actual usage, provider concurrency or a scheduler;
//     `DEFAULT_ADDRESS_MANY_CONCURRENCY` / `resolveAddressManyConcurrency` are
//     planning data for a caller that still has to enforce them.
//   - The current runtime is SERIAL per Git common directory: `review.address`
//     takes the common-dir `cq-review-address-ownership` lock for a whole
//     invocation. Resolving linked worktrees is not concurrent address
//     execution, and this module introduces none.
//   - Publication is UNKNOWABLE from a settled address report today. There is no
//     exported structured per-range publication witness, and report `reasons`
//     are prose that must never be parsed. Every aggregate row therefore says
//     `publication: 'unknown'`, and a `verifiedHead` that advanced past the
//     admitted head is legitimate local work, never proof of publication.
//   - Enrollment is externally supplied ADVISORY metadata. This module defines
//     no queue semantics, deduplication, idempotency or vendor-outage coupling,
//     and never turns an enrollment state into completion. A composition that
//     needs a required enrollment to BLOCK needs its own explicit policy input
//     and owner contract.
//   - No aggregate row can become success without trusted report-head evidence;
//     "no attributable head" is a non-success, including a report with zero
//     rounds. That deliberately rejects an otherwise-good early report rather
//     than inventing attribution.
//   - A per-PR result keeps the producer's asymmetric public shape: a successful
//     (`ok`) result carries its report in `value`, a non-ok result in `report`.
//     Aggregation reads exactly that, and a `needs-human` leg whose structured
//     `report.stop` is `budget` is classified as the budget-stopped outcome —
//     never success, and never an ordinary needs-human refusal.
import type { OpResult } from '../../../kernel/types.js';
import type { ReviewAddressReport, ReviewAddressResult } from '../address.js';
import type { Finding } from '../findings.js';

/** The frozen kernel result taxonomy, reused instead of a local status table. */
export type AddressManyStatus = OpResult<unknown>['status'];

const HEX_40 = /^[0-9a-f]{40}$/;
const REPO_NAME = /^[^/\s]+\/[^/\s]+$/;

const fold = (value: string): string => value.toLowerCase();
const isSafe = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value);
const isPositive = (value: unknown): value is number => isSafe(value) && value > 0;
const isNonNegative = (value: unknown): value is number => isSafe(value) && value >= 0;
const isText = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;
const isRepo = (value: unknown): value is string =>
  typeof value === 'string' && REPO_NAME.test(value);
const isHeadOid = (value: unknown): value is string =>
  typeof value === 'string' && HEX_40.test(value);

/** Total admitted allocation. `reserved` is in flight; `unresolved` is held but cannot be priced. */
const heldTokens = (state: AddressManyBudgetState): number =>
  state.outstanding.reduce((sum, entry) => sum + entry.tokens, 0);

/** The exact arithmetic the admission bound is stated in; throws rather than wrapping. */
function safeSum(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total))
      throw new Error('addressMany allocation arithmetic left the safe integer range');
  }
  return total;
}

// ---------------------------------------------------------------------------
// 1. Selection — strict metadata over a COMPLETE explicit listing
// ---------------------------------------------------------------------------

/** One PR's forge metadata, exactly as the listing reported it. */
export interface AddressManyPrFacts {
  repo: string;
  number: number;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  author: { login: string; type: 'User' | 'Organization' | 'Bot' };
  /** `''` when the head repository was deleted; never guessed from the base repo. */
  headRepository: string;
  headRefName: string;
  headOid: string;
}

/**
 * The caller's listing assertion. `complete` is an ASSERTION, never inferred:
 * an incomplete or paginated listing must be passed as incomplete, and this
 * module then refuses instead of reporting an empty success.
 */
export interface AddressManyListing {
  complete: boolean;
  repo: string;
  pulls: readonly AddressManyPrFacts[];
}

/**
 * Authorization policy. `botLogins` is an explicit allowlist with no built-in
 * names: an empty/absent list authorizes no bot, and `author.type === 'Bot'` is
 * never authority on its own. Logins and repos compare case-insensitively; the
 * listing's original spelling is what the candidates carry.
 */
export interface AddressManyPolicy {
  repo: string;
  owner: string;
  viewer?: string;
  botLogins?: readonly string[];
}

export interface AddressManyCandidate {
  repo: string;
  number: number;
  headOid: string;
  headRefName: string;
  headRepository: string;
  authorLogin: string;
  matchedBy: 'owner' | 'viewer' | 'bot-allowlist';
}

export type AddressManyExclusion =
  | { reason: 'not-open'; state: 'CLOSED' | 'MERGED' }
  | { reason: 'draft' }
  | { reason: 'head-repository-deleted' }
  | { reason: 'unauthorized-author'; authorType: 'User' | 'Organization' | 'Bot' };

export type AddressManyRefusal =
  | { kind: 'incomplete-listing'; detail: string }
  | { kind: 'repo-mismatch'; detail: string }
  | {
      kind: 'invalid-facts';
      violations: ReadonlyArray<{ index: number; field: string; detail: string }>;
    }
  | { kind: 'duplicate-pr'; numbers: readonly number[] };

export type AddressManySelection =
  | {
      ok: true;
      repo: string;
      candidates: readonly AddressManyCandidate[];
      excluded: ReadonlyArray<{
        number: number;
        authorLogin: string;
        exclusion: AddressManyExclusion;
      }>;
    }
  | { ok: false; refusal: AddressManyRefusal };

/** Malformed POLICY is a programmer error, like `addressBatches`' bad concurrency. */
function assertPolicy(policy: AddressManyPolicy): void {
  if (!isRepo(policy.repo)) throw new Error('addressMany policy requires a repo as owner/name');
  if (!isText(policy.owner)) throw new Error('addressMany policy requires an explicit owner login');
  if (policy.viewer !== undefined && !isText(policy.viewer))
    throw new Error('addressMany policy viewer must be a non-empty login when present');
  if (policy.botLogins !== undefined) {
    if (!Array.isArray(policy.botLogins) || policy.botLogins.some((login) => !isText(login)))
      throw new Error('addressMany policy botLogins must be a list of non-empty logins');
  }
}

/** Facts are DATA: a defect refuses the listing, it never becomes an exclusion. */
function factViolations(pulls: readonly AddressManyPrFacts[]) {
  const violations: Array<{ index: number; field: string; detail: string }> = [];
  pulls.forEach((pull, index) => {
    if (!isRepo(pull.repo)) violations.push({ index, field: 'repo', detail: 'not owner/name' });
    if (!isPositive(pull.number))
      violations.push({ index, field: 'number', detail: 'not a positive safe integer' });
    if (pull.state !== 'OPEN' && pull.state !== 'CLOSED' && pull.state !== 'MERGED')
      violations.push({ index, field: 'state', detail: 'not OPEN, CLOSED or MERGED' });
    if (typeof pull.isDraft !== 'boolean')
      violations.push({ index, field: 'isDraft', detail: 'missing or non-boolean draft state' });
    if (pull.author === null || typeof pull.author !== 'object')
      violations.push({ index, field: 'author', detail: 'missing author' });
    else {
      if (!isText(pull.author.login))
        violations.push({ index, field: 'author.login', detail: 'missing or blank login' });
      if (!['User', 'Organization', 'Bot'].includes(pull.author.type))
        violations.push({ index, field: 'author.type', detail: 'unknown author type' });
    }
    if (typeof pull.headRepository !== 'string')
      violations.push({ index, field: 'headRepository', detail: 'missing head repository' });
    if (!isText(pull.headRefName))
      violations.push({ index, field: 'headRefName', detail: 'missing or blank head ref' });
    if (!isHeadOid(pull.headOid))
      violations.push({ index, field: 'headOid', detail: 'not a 40-character lowercase hex oid' });
  });
  return violations;
}

function authorizationOf(
  pull: AddressManyPrFacts,
  policy: AddressManyPolicy,
): AddressManyCandidate['matchedBy'] | undefined {
  const login = fold(pull.author.login);
  if (login === fold(policy.owner)) return 'owner';
  if (policy.viewer !== undefined && login === fold(policy.viewer)) return 'viewer';
  // An allowlist entry authorizes a BOT only: the server-reported type is part
  // of the match, so a listing entry that reuses a bot login with type User or
  // Organization is an unauthorized author, not a bot match. Owner and viewer
  // authority above stays independent of the type.
  const allowlisted =
    pull.author.type === 'Bot' && (policy.botLogins ?? []).some((entry) => fold(entry) === login);
  return allowlisted ? 'bot-allowlist' : undefined;
}

/**
 * Select the PRs a bulk run may address. Refusal precedence, deterministic:
 * malformed policy (throws) > `incomplete-listing` > `repo-mismatch` >
 * `invalid-facts` > `duplicate-pr`. Every valid PR that policy excludes is
 * reported with its reason; only a structurally untrustworthy listing refuses
 * wholesale, because a partial plan over unverifiable metadata is not a plan.
 * `(repo, number)` is the identity: two PRs on one branch and one head stay two
 * candidates. Output is ordered by `number`.
 */
export function selectAddressMany(
  listing: AddressManyListing,
  policy: AddressManyPolicy,
): AddressManySelection {
  assertPolicy(policy);

  if (listing.complete !== true)
    return {
      ok: false,
      refusal: {
        kind: 'incomplete-listing',
        detail: 'the listing is not asserted complete; a partial page cannot select a bulk run',
      },
    };
  if (!isRepo(listing.repo) || fold(listing.repo) !== fold(policy.repo))
    return {
      ok: false,
      refusal: {
        kind: 'repo-mismatch',
        detail: `listing repo ${String(listing.repo)} does not match policy repo ${policy.repo}`,
      },
    };
  const foreign = listing.pulls
    .map((pull, index) => ({ pull, index }))
    .filter(({ pull }) => typeof pull.repo === 'string' && fold(pull.repo) !== fold(listing.repo));
  if (foreign.length)
    return {
      ok: false,
      refusal: {
        kind: 'invalid-facts',
        violations: foreign.map(({ index }) => ({
          index,
          field: 'repo',
          detail: 'entry repo differs from the listing repo',
        })),
      },
    };

  const violations = factViolations(listing.pulls);
  if (violations.length) return { ok: false, refusal: { kind: 'invalid-facts', violations } };

  const seen = new Set<number>();
  const duplicates: number[] = [];
  for (const pull of listing.pulls) {
    if (seen.has(pull.number)) duplicates.push(pull.number);
    seen.add(pull.number);
  }
  if (duplicates.length)
    return {
      ok: false,
      refusal: { kind: 'duplicate-pr', numbers: [...new Set(duplicates)].sort((a, b) => a - b) },
    };

  const ordered = [...listing.pulls].sort((a, b) => a.number - b.number);
  const candidates: AddressManyCandidate[] = [];
  const excluded: Array<{ number: number; authorLogin: string; exclusion: AddressManyExclusion }> =
    [];
  for (const pull of ordered) {
    // One exclusion per PR, in this precedence: activity, draft, head repo, author.
    if (pull.state !== 'OPEN') {
      excluded.push({
        number: pull.number,
        authorLogin: pull.author.login,
        exclusion: { reason: 'not-open', state: pull.state },
      });
      continue;
    }
    if (pull.isDraft) {
      excluded.push({
        number: pull.number,
        authorLogin: pull.author.login,
        exclusion: { reason: 'draft' },
      });
      continue;
    }
    if (pull.headRepository === '') {
      excluded.push({
        number: pull.number,
        authorLogin: pull.author.login,
        exclusion: { reason: 'head-repository-deleted' },
      });
      continue;
    }
    const matchedBy = authorizationOf(pull, policy);
    if (matchedBy === undefined) {
      excluded.push({
        number: pull.number,
        authorLogin: pull.author.login,
        exclusion: { reason: 'unauthorized-author', authorType: pull.author.type },
      });
      continue;
    }
    candidates.push({
      repo: listing.repo,
      number: pull.number,
      headOid: pull.headOid,
      headRefName: pull.headRefName,
      headRepository: pull.headRepository,
      authorLogin: pull.author.login,
      matchedBy,
    });
  }
  return { ok: true, repo: listing.repo, candidates, excluded };
}

/** Planned default active-PR count. Planning data only — never an enforcement claim. */
export const DEFAULT_ADDRESS_MANY_CONCURRENCY = 3;

/** Validate a planned concurrency: a positive safe integer, defaulting to three. */
export function resolveAddressManyConcurrency(value?: number): number {
  if (value === undefined) return DEFAULT_ADDRESS_MANY_CONCURRENCY;
  if (!isPositive(value))
    throw new Error('addressMany concurrency must be a positive safe integer');
  return value;
}

// ---------------------------------------------------------------------------
// 2. Admission — a token ALLOCATION bound, never spend or concurrency
// ---------------------------------------------------------------------------

/**
 * One held allocation. `state` distinguishes work that can still settle for a
 * known amount (`reserved`) from work whose usage is already unknown
 * (`unresolved`): the second stays in `outstanding` at its full allocation, so
 * an unknown settlement is visible, never refunded and never silently dropped.
 */
export interface AddressManyReservation {
  id: string;
  repo: string;
  number: number;
  headOid: string;
  tokens: number;
  state: 'reserved' | 'unresolved';
}

/**
 * The allocation ledger. The bound
 * `observedTokens + Σ outstanding.tokens ≤ limitTokens` holds for every state
 * this module returns with `stop === null`; a state with a non-null `stop` is a
 * truthful record of a breach or of an unpriceable hold and is NOT claimed to
 * satisfy the bound. `stop` is sticky: it is never cleared, and a stopped state
 * admits nothing further while still letting held reservations settle.
 */
export interface AddressManyBudgetState {
  limitTokens: number;
  observedTokens: number;
  outstanding: readonly AddressManyReservation[];
  settledIds: readonly string[];
  stop: 'unknown-usage' | 'overrun' | null;
}

export interface AddressManyReservationRequest {
  /** Caller-supplied stable identity; a second admission of it is refused, not merged. */
  id: string;
  repo: string;
  number: number;
  headOid: string;
  tokens: number;
}

export type AddressManyAdmission =
  | { kind: 'admitted'; state: AddressManyBudgetState; reservation: AddressManyReservation }
  | {
      kind: 'refused';
      state: AddressManyBudgetState;
      reason: 'stopped' | 'over-limit' | 'duplicate' | 'invalid';
      detail: string;
    };

export type AddressManySettlementRequest = {
  id: string;
  repo: string;
  number: number;
  headOid: string;
} & ({ usage: { kind: 'known'; tokens: number } } | { usage: { kind: 'unknown' } });

export type AddressManySettlement =
  | {
      kind: 'settled';
      state: AddressManyBudgetState;
      reservation: AddressManyReservation;
      tokens: number;
      overrun: boolean;
    }
  | { kind: 'unknown-usage'; state: AddressManyBudgetState; reservation: AddressManyReservation }
  | {
      kind: 'refused';
      state: AddressManyBudgetState;
      reason: 'unknown-reservation' | 'identity-mismatch' | 'already-settled' | 'invalid';
      detail: string;
    };

const identityOf = (value: { repo: string; number: number; headOid: string }): string =>
  `${fold(value.repo)}#${value.number}@${value.headOid}`;

/**
 * Open the ledger. Malformed inputs are programmer errors (throw); a factual
 * breach — `observedTokens` already above `limitTokens` — is recorded as
 * `stop: 'overrun'` instead of being thrown or hidden.
 */
export function initialAddressManyBudget(input: {
  limitTokens: number;
  observedTokens?: number;
}): AddressManyBudgetState {
  if (!isPositive(input.limitTokens))
    throw new Error('addressMany limitTokens must be a positive safe integer');
  const observedTokens = input.observedTokens ?? 0;
  if (!isNonNegative(observedTokens))
    throw new Error('addressMany observedTokens must be a non-negative safe integer');
  return {
    limitTokens: input.limitTokens,
    observedTokens,
    outstanding: [],
    settledIds: [],
    stop: observedTokens > input.limitTokens ? 'overrun' : null,
  };
}

/**
 * Admit one reservation. Refusals (invalid, duplicate id or duplicate active
 * `repo`/`PR`/`head` identity, stopped ledger, allocation over the remaining
 * bound) return the SAME state object, so a refused admission can never leak a
 * mutation. `duplicate` covers both a repeated id and a second id aimed at an
 * identity that is already held, so two ids cannot bypass one PR/head.
 */
export function admitAddressMany(
  state: AddressManyBudgetState,
  request: AddressManyReservationRequest,
): AddressManyAdmission {
  if (
    !isText(request.id) ||
    !isRepo(request.repo) ||
    !isPositive(request.number) ||
    !isHeadOid(request.headOid) ||
    !isPositive(request.tokens)
  )
    return {
      kind: 'refused',
      state,
      reason: 'invalid',
      detail: 'reservation facts are not well formed',
    };

  if (state.stop !== null)
    return {
      kind: 'refused',
      state,
      reason: 'stopped',
      detail: `allocation ledger is stopped (${state.stop}); no further admission`,
    };

  const identity = identityOf(request);
  const duplicate =
    state.settledIds.includes(request.id) ||
    state.outstanding.some((entry) => entry.id === request.id || identityOf(entry) === identity);
  if (duplicate)
    return {
      kind: 'refused',
      state,
      reason: 'duplicate',
      detail: `reservation id ${request.id} or identity ${identity} is already held or settled`,
    };

  const held = safeSum(state.outstanding.map((entry) => entry.tokens));
  const remaining = state.limitTokens - state.observedTokens - held;
  if (request.tokens > remaining)
    return {
      kind: 'refused',
      state,
      reason: 'over-limit',
      detail: `requested ${request.tokens} tokens exceeds remaining allocation ${Math.max(0, remaining)}`,
    };

  const reservation: AddressManyReservation = {
    id: request.id,
    repo: request.repo,
    number: request.number,
    headOid: request.headOid,
    tokens: request.tokens,
    state: 'reserved',
  };
  return {
    kind: 'admitted',
    state: { ...state, outstanding: [...state.outstanding, reservation] },
    reservation,
  };
}

/**
 * Settle one held reservation, exactly once, at its own identity/head.
 *
 * - Known usage of zero is legal (a fixer that spent nothing) and does not stop
 *   admission. Known usage above the reservation's own allocation, or one that
 *   would push `observed + remaining held` past the cap, is an HONEST OVERRUN:
 *   it is recorded, reported, and stops further admission.
 * - Unknown usage keeps the FULL allocation in `outstanding` marked
 *   `unresolved`, sets the sticky `unknown-usage` stop, preserves every sibling,
 *   and refunds nothing. Settling it again is refused (`already-settled`).
 * - Settlement remains possible while the ledger is stopped: a stop gates
 *   ADMISSION, so bounded in-flight work can still land.
 */
export function settleAddressMany(
  state: AddressManyBudgetState,
  request: AddressManySettlementRequest,
): AddressManySettlement {
  if (
    !isText(request.id) ||
    !isRepo(request.repo) ||
    !isPositive(request.number) ||
    !isHeadOid(request.headOid)
  )
    return {
      kind: 'refused',
      state,
      reason: 'invalid',
      detail: 'settlement identity is not well formed',
    };
  const known = request.usage.kind === 'known' ? request.usage.tokens : undefined;
  if (known !== undefined && !isNonNegative(known))
    return {
      kind: 'refused',
      state,
      reason: 'invalid',
      detail: 'actual usage must be a non-negative safe integer',
    };

  const reservation = state.outstanding.find((entry) => entry.id === request.id);
  if (reservation === undefined) {
    if (state.settledIds.includes(request.id))
      return {
        kind: 'refused',
        state,
        reason: 'already-settled',
        detail: `reservation ${request.id} is already settled`,
      };
    return {
      kind: 'refused',
      state,
      reason: 'unknown-reservation',
      detail: `reservation ${request.id} is not held`,
    };
  }
  if (reservation.state === 'unresolved')
    return {
      kind: 'refused',
      state,
      reason: 'already-settled',
      detail: `reservation ${request.id} recorded unknown usage and stays held`,
    };
  if (identityOf(request) !== identityOf(reservation))
    return {
      kind: 'refused',
      state,
      reason: 'identity-mismatch',
      detail: 'settlement identity or head does not match the reservation',
    };

  if (known === undefined) {
    const unresolved: AddressManyReservation = { ...reservation, state: 'unresolved' };
    return {
      kind: 'unknown-usage',
      state: {
        ...state,
        outstanding: state.outstanding.map((entry) =>
          entry.id === reservation.id ? unresolved : entry,
        ),
        stop: state.stop ?? 'unknown-usage',
      },
      reservation: unresolved,
    };
  }

  const siblings = state.outstanding
    .filter((entry) => entry.id !== reservation.id)
    .map((entry) => entry.tokens);
  const overrun =
    known > reservation.tokens ||
    safeSum([state.observedTokens, known, ...siblings]) > state.limitTokens;
  return {
    kind: 'settled',
    state: {
      ...state,
      observedTokens: safeSum([state.observedTokens, known]),
      outstanding: state.outstanding.filter((entry) => entry.id !== reservation.id),
      settledIds: [...state.settledIds, reservation.id],
      stop: state.stop ?? (overrun ? 'overrun' : null),
    },
    reservation,
    tokens: known,
    overrun,
  };
}

// ---------------------------------------------------------------------------
// 3. Aggregate — independent per-PR truth over an EXACT candidate set
// ---------------------------------------------------------------------------

/**
 * Externally supplied advisory enrollment metadata. Deliberately three states:
 * this module executes nothing, deduplicates nothing and classifies no vendor
 * outage. `unavailable` is reported and is never completion; whether it should
 * block is a composition policy this package does not establish.
 */
export type AddressManyEnrollment =
  | { state: 'not-requested' }
  | { state: 'enrolled' }
  | { state: 'unavailable'; reason: string };

/** One PR's supplied outcome. Exactly one of result / notAdmitted / exception. */
export interface AddressManyOutcomeInput {
  number: number;
  headOid: string;
  /** The original per-PR result, carried verbatim on every path. */
  result?: ReviewAddressResult;
  notAdmitted?: 'budget' | 'concurrency' | 'cancel';
  exception?: string;
  enrollment?: AddressManyEnrollment;
}

export interface AddressManyScopedFinding {
  scope: { repo: string; number: number; headOid: string };
  finding: Finding;
}

export type AddressManyRowStatus =
  | 'settled-ok'
  | 'settled-needs-human'
  | 'settled-failed'
  | 'settled-indeterminate'
  | 'settled-budget-exhausted'
  | 'unattributed'
  | 'not-admitted'
  | 'exception';

export interface AddressManyRow {
  scope: { repo: string; number: number; headOid: string };
  status: AddressManyRowStatus;
  /** `trusted` only when the report's first reviewed head equals the admitted head. */
  attribution: 'trusted' | 'unattributed' | 'absent';
  result?: ReviewAddressResult;
  reason?: string;
  /** Counted only from a head-attributed report; the original value stays in `result`. */
  fixesPerRun: number;
  deferredVendorDebt: 'absent' | 'present' | 'unknown';
  /** No structured publication producer exists; never derived from fixes or prose. */
  publication: 'unknown';
  enrollment: AddressManyEnrollment;
}

export interface AddressManyAccounting {
  limitTokens: number;
  observedTokens: number;
  heldTokens: number;
  unresolved: readonly string[];
  stop: 'unknown-usage' | 'overrun' | null;
}

/** Roll-up counts. `failed` covers settled `failed`/`indeterminate` legs; thrown
 * legs are counted separately in `exceptions`, so the two never double-count. */
export interface AddressManyTotals {
  candidates: number;
  settledOk: number;
  needsHuman: number;
  failed: number;
  budgetExhausted: number;
  unattributed: number;
  notAdmitted: number;
  exceptions: number;
  fixesPerRun: number;
}

export interface AddressManyAggregate {
  repo: string;
  accounting: AddressManyAccounting;
  rows: readonly AddressManyRow[];
  findings: readonly AddressManyScopedFinding[];
  totals: AddressManyTotals;
  status: AddressManyStatus;
  reasons: readonly string[];
}

export type AddressManyAggregateRefusal =
  | { kind: 'empty-coverage'; detail: string }
  | { kind: 'repo-mismatch'; detail: string }
  | { kind: 'duplicate-coverage'; numbers: readonly number[] }
  | { kind: 'missing-outcome'; numbers: readonly number[] }
  | {
      kind: 'extra-outcome' | 'duplicate-outcome' | 'malformed-outcome';
      entries: ReadonlyArray<{ number: number; headOid: string }>;
    };

export type AddressManyAggregateResult =
  | { ok: true; aggregate: AddressManyAggregate }
  | { ok: false; refusal: AddressManyAggregateRefusal };

const entryRef = (value: { number: number; headOid: string }) => ({
  number: value.number,
  headOid: value.headOid,
});

const suppliedKinds = (outcome: AddressManyOutcomeInput): number =>
  [
    outcome.result !== undefined,
    outcome.notAdmitted !== undefined,
    outcome.exception !== undefined,
  ].filter(Boolean).length;

/**
 * Roll independent per-PR outcomes up. The caller must pass the EXACT selected
 * candidate set: an empty set, a duplicate candidate, or an outcome that is
 * missing, extra, duplicated or self-contradictory is a REFUSAL, because a roll
 * up over a subset could report `ok` for work that was never admitted.
 *
 * Status precedence is deliberate and documented: a definitive per-PR failure
 * outranks a budget stop, which outranks an incomplete/needs-human run; `ok`
 * requires every candidate row to be a head-attributed `settled-ok` AND a clean
 * ledger (no sticky stop, no held allocation, no unresolved hold).
 */
export function aggregateAddressMany(input: {
  repo: string;
  budget: AddressManyBudgetState;
  candidates: readonly AddressManyCandidate[];
  outcomes: readonly AddressManyOutcomeInput[];
}): AddressManyAggregateResult {
  const { repo, budget, candidates, outcomes } = input;
  if (!isRepo(repo)) throw new Error('addressMany aggregate requires a repo as owner/name');
  if (candidates.length === 0)
    return {
      ok: false,
      refusal: {
        kind: 'empty-coverage',
        detail:
          'an empty candidate set is not an ok aggregate; report the selection outcome instead',
      },
    };

  const foreign = candidates.filter((candidate) => fold(candidate.repo) !== fold(repo));
  if (foreign.length)
    return {
      ok: false,
      refusal: { kind: 'repo-mismatch', detail: 'a selected candidate belongs to another repo' },
    };

  const coverage = new Set<number>();
  const duplicateCoverage: number[] = [];
  for (const candidate of candidates) {
    if (coverage.has(candidate.number)) duplicateCoverage.push(candidate.number);
    coverage.add(candidate.number);
  }
  if (duplicateCoverage.length)
    return {
      ok: false,
      refusal: {
        kind: 'duplicate-coverage',
        numbers: [...new Set(duplicateCoverage)].sort((a, b) => a - b),
      },
    };

  const expected = new Map<string, AddressManyCandidate>();
  for (const candidate of candidates) expected.set(identityOf(candidate), candidate);
  const supplied = new Map<string, AddressManyOutcomeInput>();
  const duplicates: AddressManyOutcomeInput[] = [];
  const extras: AddressManyOutcomeInput[] = [];
  const malformed: AddressManyOutcomeInput[] = [];
  for (const outcome of outcomes) {
    const key = identityOf({ repo, number: outcome.number, headOid: outcome.headOid });
    if (!expected.has(key)) extras.push(outcome);
    else if (supplied.has(key)) duplicates.push(outcome);
    else if (suppliedKinds(outcome) !== 1) malformed.push(outcome);
    else supplied.set(key, outcome);
  }
  if (duplicates.length)
    return { ok: false, refusal: { kind: 'duplicate-outcome', entries: duplicates.map(entryRef) } };
  if (malformed.length)
    return { ok: false, refusal: { kind: 'malformed-outcome', entries: malformed.map(entryRef) } };
  if (extras.length)
    return { ok: false, refusal: { kind: 'extra-outcome', entries: extras.map(entryRef) } };
  const missing = [...expected.entries()]
    .filter(([key]) => !supplied.has(key))
    .map(([, candidate]) => candidate.number)
    .sort((a, b) => a - b);
  if (missing.length) return { ok: false, refusal: { kind: 'missing-outcome', numbers: missing } };

  const ordered = [...candidates].sort((a, b) => a.number - b.number);
  const rows: AddressManyRow[] = [];
  const findings: AddressManyScopedFinding[] = [];
  const reasons: string[] = [];
  const totals: AddressManyTotals = {
    candidates: ordered.length,
    settledOk: 0,
    needsHuman: 0,
    failed: 0,
    budgetExhausted: 0,
    unattributed: 0,
    notAdmitted: 0,
    exceptions: 0,
    fixesPerRun: 0,
  };

  for (const candidate of ordered) {
    const outcome = supplied.get(identityOf(candidate))!;
    const scope = { repo, number: candidate.number, headOid: candidate.headOid };
    const enrollment: AddressManyEnrollment = outcome.enrollment ?? { state: 'not-requested' };
    const base = { scope, enrollment, publication: 'unknown' as const };

    if (outcome.exception !== undefined) {
      totals.exceptions++;
      reasons.push(`#${candidate.number} threw: ${outcome.exception}`);
      rows.push({
        ...base,
        status: 'exception',
        attribution: 'absent',
        reason: outcome.exception,
        fixesPerRun: 0,
        deferredVendorDebt: 'absent',
      });
      continue;
    }
    if (outcome.notAdmitted !== undefined) {
      totals.notAdmitted++;
      reasons.push(`#${candidate.number} was not admitted (${outcome.notAdmitted})`);
      rows.push({
        ...base,
        status: 'not-admitted',
        attribution: 'absent',
        reason: outcome.notAdmitted,
        fixesPerRun: 0,
        deferredVendorDebt: 'absent',
      });
      continue;
    }

    const result = outcome.result!;
    // The producer's public shape is asymmetric: a successful result carries its
    // report in `value`, while non-ok results carry it in `report`. Reading only
    // `report` would silently discard a real success's head evidence, findings,
    // fixes per run and vendor debt.
    const report: ReviewAddressReport | undefined =
      result.status === 'ok' ? result.value : result.report;
    // The ONLY trusted attribution evidence: the first reviewed head in the
    // report. Zero rounds or a different head is "unattributed", never success,
    // and the original result is retained verbatim either way.
    const reviewedHead = report?.rounds[0]?.record.head;
    const attribution: AddressManyRow['attribution'] =
      report === undefined
        ? 'absent'
        : reviewedHead === candidate.headOid
          ? 'trusted'
          : 'unattributed';
    const trusted = attribution === 'trusted' && report !== undefined;

    let status: AddressManyRowStatus;
    switch (result.status) {
      case 'ok':
        status = trusted ? 'settled-ok' : 'unattributed';
        break;
      case 'needs-human':
        // The engine's budget path exits needs-human but records the structured
        // marker `report.stop === 'budget'`: that leg stopped on the budget, so
        // it is classified as the budget-stopped outcome, never as success and
        // never as an ordinary needs-human refusal.
        status = report?.stop === 'budget' ? 'settled-budget-exhausted' : 'settled-needs-human';
        break;
      case 'failed':
        status = 'settled-failed';
        break;
      case 'indeterminate':
        status = 'settled-indeterminate';
        break;
      case 'budget-exhausted':
        status = 'settled-budget-exhausted';
        break;
    }

    if (status === 'settled-ok') totals.settledOk++;
    else if (status === 'unattributed') {
      totals.unattributed++;
      reasons.push(
        report === undefined
          ? `#${candidate.number} returned ok without a report; no head evidence, not success`
          : `#${candidate.number} report head ${String(reviewedHead)} is not the admitted head; not success`,
      );
    } else if (status === 'settled-needs-human') totals.needsHuman++;
    else if (status === 'settled-budget-exhausted') {
      totals.budgetExhausted++;
      if (result.status === 'needs-human' && report?.stop === 'budget')
        reasons.push(`#${candidate.number} stopped on the engine's structured budget marker`);
    } else totals.failed++;

    const fixesPerRun = trusted ? report.fixesPerRun : 0;
    totals.fixesPerRun += fixesPerRun;
    const debt: AddressManyRow['deferredVendorDebt'] =
      report === undefined
        ? 'absent'
        : trusted
          ? report.deferredVendorDebt === undefined
            ? 'absent'
            : 'present'
          : 'unknown';
    if (debt === 'present') reasons.push(`#${candidate.number} carries deferred vendor debt`);
    if (debt === 'unknown')
      reasons.push(`#${candidate.number} debt state unknowable at an unattributed head`);
    if (enrollment.state !== 'not-requested')
      reasons.push(`#${candidate.number} enrollment ${enrollment.state}`);

    if (trusted && report !== undefined)
      for (const finding of report.findings) findings.push({ scope, finding });

    const row: AddressManyRow = {
      ...base,
      status,
      attribution,
      result,
      fixesPerRun,
      deferredVendorDebt: debt,
    };
    if (result.status === 'needs-human') rows.push({ ...row, reason: result.reason });
    else if (result.status === 'failed') rows.push({ ...row, reason: result.error });
    else if (result.status === 'indeterminate') rows.push({ ...row, reason: result.detail });
    else rows.push(row);
  }

  const held = heldTokens(budget);
  const unresolved = budget.outstanding
    .filter((entry) => entry.state === 'unresolved')
    .map((entry) => entry.id);
  const accounting: AddressManyAccounting = {
    limitTokens: budget.limitTokens,
    observedTokens: budget.observedTokens,
    heldTokens: held,
    unresolved,
    stop: budget.stop,
  };
  const breached = budget.observedTokens + held > budget.limitTokens;
  if (budget.stop !== null) reasons.push(`allocation ledger stopped: ${budget.stop}`);
  if (held > 0)
    for (const entry of budget.outstanding)
      reasons.push(
        `#${entry.number} ${entry.state} allocation of ${entry.tokens} tokens is still held`,
      );
  if (breached) reasons.push('allocation ledger is over its cap and cannot be reported clean');

  let status: AddressManyStatus;
  const definitiveFailure = rows.some(
    (row) =>
      row.status === 'settled-failed' ||
      row.status === 'settled-indeterminate' ||
      row.status === 'exception',
  );
  const budgetBlocked =
    budget.stop !== null ||
    held > 0 ||
    breached ||
    rows.some(
      (row) =>
        row.status === 'settled-budget-exhausted' ||
        (row.status === 'not-admitted' && row.reason === 'budget'),
    );
  const needsHuman = rows.some(
    (row) =>
      row.status === 'settled-needs-human' ||
      row.status === 'unattributed' ||
      (row.status === 'not-admitted' && row.reason !== 'budget'),
  );
  if (definitiveFailure) status = 'failed';
  else if (budgetBlocked) status = 'budget-exhausted';
  else if (needsHuman) status = 'needs-human';
  else status = 'ok';

  return {
    ok: true,
    aggregate: { repo, accounting, rows, findings, totals, status, reasons },
  };
}
