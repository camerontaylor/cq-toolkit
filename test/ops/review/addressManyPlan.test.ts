import { describe, expect, test } from 'vitest';
import type { ReviewAddressReport, ReviewAddressResult } from '../../../src/ops/review/address.js';
import type { Finding, FindingsRecord } from '../../../src/ops/review/findings.js';
import { DeferredVendorDebtSchema } from '../../../src/ops/dev/internal/deferredReview.js';
import {
  DEFAULT_ADDRESS_MANY_CONCURRENCY,
  admitAddressMany,
  aggregateAddressMany,
  initialAddressManyBudget,
  resolveAddressManyConcurrency,
  selectAddressMany,
  settleAddressMany,
  type AddressManyBudgetState,
  type AddressManyCandidate,
  type AddressManyListing,
  type AddressManyOutcomeInput,
  type AddressManyPolicy,
  type AddressManyPrFacts,
} from '../../../src/ops/review/internal/addressManyPlan.js';

const REPO = 'owner/repo';
const BASE = 'd'.repeat(40);
const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const HEAD_C = 'c'.repeat(40);

// ---------------------------------------------------------------------------
// fixtures — scripted metadata and reports, no git, process, forge or provider
// ---------------------------------------------------------------------------

const facts = (over: Partial<AddressManyPrFacts> = {}): AddressManyPrFacts => ({
  repo: REPO,
  number: 7,
  state: 'OPEN',
  isDraft: false,
  author: { login: 'owner', type: 'User' },
  headRepository: REPO,
  headRefName: 'feat/x',
  headOid: HEAD_A,
  ...over,
});

const listing = (
  pulls: readonly AddressManyPrFacts[],
  over: Partial<AddressManyListing> = {},
): AddressManyListing => ({
  complete: true,
  repo: REPO,
  pulls,
  ...over,
});

const policy = (over: Partial<AddressManyPolicy> = {}): AddressManyPolicy => ({
  repo: REPO,
  owner: 'owner',
  ...over,
});

/** Force invalid metadata through the type boundary: facts are data, not policy. */
const hostile = (value: unknown): AddressManyPrFacts => value as AddressManyPrFacts;

const finding = (id: string, over: Partial<Finding> = {}): Finding => ({
  id,
  source: 'agent',
  severity: 'major',
  text: `finding ${id}`,
  status: 'open',
  ...over,
});

const record = (head: string, findings: readonly Finding[] = []): FindingsRecord => ({
  schemaVersion: 1,
  branch: 'feat/x',
  head,
  sources: [{ kind: 'agent', status: 'terminal' }],
  findings: [...findings],
});

const usage = (input = 0, output = 0) => ({ input, output, cacheRead: 0, cacheWrite: 0 });

function makeReport(over: Partial<ReviewAddressReport> = {}): ReviewAddressReport {
  return {
    source: 'review',
    reportPath: 'review-address-report.json',
    rounds: [{ round: 1, record: record(HEAD_A), runs: [] }],
    findings: [],
    openBlocking: [],
    fixes: [],
    attempts: [],
    failed: [],
    fixesPerRun: 0,
    usage: usage(),
    wallMs: 10,
    reasons: [],
    ...over,
  };
}

/** The producer's real success shape: the report rides in `value`, not `report`. */
const okResult = (report: ReviewAddressReport): ReviewAddressResult => ({
  status: 'ok',
  value: report,
});

/** A minimally valid deferred vendor debt for the head/request under test. */
const deferredDebt = (head: string, requestId: string, cycleId: string) =>
  DeferredVendorDebtSchema.parse({
    reference: {
      requestId,
      binding: {
        kind: 'deferred-author',
        repo: REPO,
        producer: 'coderabbit',
        head,
        target: 'merge-queue',
        targetSelector: 'merge-queue',
      },
    },
    queue: {
      state: 'blocked',
      pr: 5,
      mergeSha: null,
      itemId: null,
      receiptId: null,
      consumed: false,
      enqueued: true,
      reviewed: false,
      fixed: false,
    },
    originAttempt: {
      cycleId,
      head,
      base: BASE,
      target: 'merge-queue',
      scope: 'full',
      dirtySha256: 'clean-tree',
      failure: { source: 'vendor', category: 'vendor-unavailable', codes: ['con_err'] },
    },
    deferral: { id: `deferral-${cycleId}`, base: BASE, dirtySha256: 'clean-tree' },
    vendor: 'vendor-blocked-transient',
    vendorCompleted: false,
  });

const needHumanResult = (reason: string, report?: ReviewAddressReport): ReviewAddressResult =>
  report === undefined
    ? { status: 'needs-human', reason }
    : { status: 'needs-human', reason, report };

const failedResult = (error: string): ReviewAddressResult => ({ status: 'failed', error });

const budgetResult = (): ReviewAddressResult => ({ status: 'budget-exhausted' });

/** Only states the module returns with `stop === null` may claim the bound. */
function expectCleanBound(state: AddressManyBudgetState): void {
  expect(state.stop).toBeNull();
  const held = state.outstanding.reduce((sum, entry) => sum + entry.tokens, 0);
  expect(state.observedTokens + held).toBeLessThanOrEqual(state.limitTokens);
}

const held = (state: AddressManyBudgetState): AddressManyBudgetState['outstanding'] =>
  state.outstanding;

function selected(
  pulls: readonly AddressManyPrFacts[],
  over: Partial<AddressManyPolicy> = {},
): readonly AddressManyCandidate[] {
  const selection = selectAddressMany(listing(pulls), policy(over));
  if (!selection.ok) throw new Error(`fixture selection refused: ${selection.refusal.kind}`);
  return selection.candidates;
}

// ---------------------------------------------------------------------------
// selection
// ---------------------------------------------------------------------------

describe('selectAddressMany', () => {
  test('admits owner, viewer and an explicitly allowlisted bot, preserving spelling', () => {
    const candidates = selected(
      [
        facts({ number: 1, author: { login: 'Owner', type: 'User' }, headOid: HEAD_A }),
        facts({ number: 2, author: { login: 'VIEWER', type: 'User' }, headOid: HEAD_B }),
        facts({ number: 3, author: { login: 'Dependabot[bot]', type: 'Bot' }, headOid: HEAD_C }),
      ],
      { owner: 'owner', viewer: 'viewer', botLogins: ['dependabot[bot]'] },
    );
    expect(
      candidates.map((candidate) => [candidate.number, candidate.authorLogin, candidate.matchedBy]),
    ).toEqual([
      [1, 'Owner', 'owner'],
      [2, 'VIEWER', 'viewer'],
      [3, 'Dependabot[bot]', 'bot-allowlist'],
    ]);
  });

  test('treats an empty bot allowlist as authorizing no bot, and Bot type as no authority', () => {
    const selection = selectAddressMany(
      listing([
        facts({ number: 1, author: { login: 'renovate[bot]', type: 'Bot' } }),
        facts({ number: 2, author: { login: 'stranger', type: 'User' } }),
      ]),
      policy({ botLogins: [] }),
    );
    expect(selection.ok).toBe(true);
    if (!selection.ok) return;
    expect(selection.candidates).toEqual([]);
    expect(selection.excluded.map((entry) => [entry.number, entry.exclusion])).toEqual([
      [1, { reason: 'unauthorized-author', authorType: 'Bot' }],
      [2, { reason: 'unauthorized-author', authorType: 'User' }],
    ]);
  });

  test('requires a server-typed Bot for an allowlisted login and keeps owner authority independent', () => {
    const selection = selectAddressMany(
      listing([
        facts({ number: 1, author: { login: 'Dependabot[BOT]', type: 'Bot' }, headOid: HEAD_A }),
        facts({ number: 2, author: { login: 'renovate[bot]', type: 'User' }, headOid: HEAD_B }),
        facts({
          number: 3,
          author: { login: 'Renovate[bot]', type: 'Organization' },
          headOid: HEAD_C,
        }),
        facts({ number: 4, author: { login: 'stranger[bot]', type: 'Bot' } }),
        facts({ number: 5, author: { login: 'OWNER', type: 'User' } }),
      ]),
      policy({ botLogins: ['dependabot[bot]', 'renovate[bot]'] }),
    );
    expect(selection.ok).toBe(true);
    if (!selection.ok) return;
    // A listed login is Bot authority only for a server-typed Bot: the same
    // login carried by a User or Organization is an unauthorized author, and a
    // Bot with no allowlist entry stays excluded. Owner authority is
    // independent of the author type and of the allowlist.
    expect(
      selection.candidates.map((candidate) => [
        candidate.number,
        candidate.authorLogin,
        candidate.matchedBy,
      ]),
    ).toEqual([
      [1, 'Dependabot[BOT]', 'bot-allowlist'],
      [5, 'OWNER', 'owner'],
    ]);
    expect(selection.excluded.map((entry) => [entry.number, entry.exclusion])).toEqual([
      [2, { reason: 'unauthorized-author', authorType: 'User' }],
      [3, { reason: 'unauthorized-author', authorType: 'Organization' }],
      [4, { reason: 'unauthorized-author', authorType: 'Bot' }],
    ]);
  });

  test('excludes closed, merged, draft and deleted-head PRs with their own reasons', () => {
    const selection = selectAddressMany(
      listing([
        facts({ number: 1, state: 'CLOSED' }),
        facts({ number: 2, state: 'MERGED' }),
        facts({ number: 3, isDraft: true }),
        facts({ number: 4, headRepository: '' }),
        facts({ number: 5 }),
      ]),
      policy(),
    );
    expect(selection.ok).toBe(true);
    if (!selection.ok) return;
    expect(selection.candidates.map((candidate) => candidate.number)).toEqual([5]);
    expect(selection.excluded.map((entry) => [entry.number, entry.exclusion])).toEqual([
      [1, { reason: 'not-open', state: 'CLOSED' }],
      [2, { reason: 'not-open', state: 'MERGED' }],
      [3, { reason: 'draft' }],
      [4, { reason: 'head-repository-deleted' }],
    ]);
  });

  test('refuses an incomplete listing instead of returning an empty success', () => {
    expect(selectAddressMany(listing([]), policy())).toMatchObject({
      ok: true,
      candidates: [],
    });
    for (const pulls of [[], [facts()]] as const) {
      const refused = selectAddressMany(listing(pulls, { complete: false }), policy());
      expect(refused.ok).toBe(false);
      if (refused.ok) continue;
      expect(refused.refusal.kind).toBe('incomplete-listing');
      if (refused.refusal.kind !== 'incomplete-listing') continue;
      expect(refused.refusal.detail.length).toBeGreaterThan(0);
    }
  });

  test('refuses a listing for another repo, or an entry from another repo', () => {
    expect(selectAddressMany(listing([facts()], { repo: 'other/repo' }), policy())).toMatchObject({
      ok: false,
      refusal: { kind: 'repo-mismatch' },
    });
    expect(selectAddressMany(listing([facts({ repo: 'other/repo' })]), policy())).toMatchObject({
      ok: false,
      refusal: { kind: 'invalid-facts' },
    });
  });

  test('refuses structurally invalid facts with per-entry violations', () => {
    const selection = selectAddressMany(
      listing([
        hostile({ ...facts({ number: 1 }), isDraft: undefined }),
        hostile({ ...facts({ number: 2 }), headOid: 'not-an-oid' }),
        hostile({ ...facts({ number: 3 }), headRefName: '   ' }),
        hostile({ ...facts({ number: 4 }), number: 1.5 }),
        hostile({ ...facts({ number: 5 }), author: { login: '', type: 'User' } }),
      ]),
      policy(),
    );
    expect(selection.ok).toBe(false);
    if (selection.ok) return;
    expect(selection.refusal.kind).toBe('invalid-facts');
    if (selection.refusal.kind !== 'invalid-facts') return;
    expect(selection.refusal.violations.map((violation) => violation.field)).toEqual([
      'isDraft',
      'headOid',
      'headRefName',
      'number',
      'author.login',
    ]);
  });

  test('refuses a duplicate PR number rather than merging two identities', () => {
    expect(
      selectAddressMany(
        listing([facts({ number: 7 }), facts({ number: 7, headOid: HEAD_B })]),
        policy(),
      ),
    ).toEqual({ ok: false, refusal: { kind: 'duplicate-pr', numbers: [7] } });
  });

  test('keeps one branch on two PR numbers as two candidates with their own heads', () => {
    const candidates = selected([
      facts({ number: 5, headRefName: 'feat/shared', headOid: HEAD_A }),
      facts({ number: 6, headRefName: 'feat/shared', headOid: HEAD_B }),
    ]);
    expect(
      candidates.map((candidate) => [candidate.number, candidate.headRefName, candidate.headOid]),
    ).toEqual([
      [5, 'feat/shared', HEAD_A],
      [6, 'feat/shared', HEAD_B],
    ]);
  });

  test('rejects malformed policy as a programmer error', () => {
    expect(() => selectAddressMany(listing([]), { repo: 'no-slash', owner: 'owner' })).toThrow(
      /owner\/name/,
    );
    expect(() => selectAddressMany(listing([]), { repo: REPO, owner: '' })).toThrow(/owner login/);
    expect(() => selectAddressMany(listing([]), policy({ viewer: ' ' }))).toThrow(/viewer/);
    expect(() => selectAddressMany(listing([]), policy({ botLogins: [''] }))).toThrow(/botLogins/);
  });
});

describe('resolveAddressManyConcurrency', () => {
  test('defaults to three as planning data and rejects non-positive or fractional values', () => {
    expect(DEFAULT_ADDRESS_MANY_CONCURRENCY).toBe(3);
    expect(resolveAddressManyConcurrency()).toBe(3);
    expect(resolveAddressManyConcurrency(5)).toBe(5);
    for (const value of [0, -1, 1.5, Number.NaN])
      expect(() => resolveAddressManyConcurrency(value)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// admission
// ---------------------------------------------------------------------------

describe('admission allocation bound', () => {
  const request = (
    id: string,
    tokens: number,
    over: Partial<Parameters<typeof admitAddressMany>[1]> = {},
  ) => ({
    id,
    repo: REPO,
    number: 7,
    headOid: HEAD_A,
    tokens,
    ...over,
  });

  test('admits exactly to the cap and refuses one token over without mutating state', () => {
    let state = initialAddressManyBudget({ limitTokens: 1000, observedTokens: 100 });
    const first = admitAddressMany(state, request('a', 400));
    expect(first.kind).toBe('admitted');
    if (first.kind !== 'admitted') return;
    state = first.state;
    expectCleanBound(state);

    const boundary = admitAddressMany(state, request('b', 500, { number: 8, headOid: HEAD_B }));
    expect(boundary.kind).toBe('admitted');
    if (boundary.kind !== 'admitted') return;
    state = boundary.state;
    expectCleanBound(state);
    expect(held(state).reduce((sum, entry) => sum + entry.tokens, 0)).toBe(900);

    const over = admitAddressMany(state, request('c', 1, { number: 9, headOid: HEAD_C }));
    expect(over.kind).toBe('refused');
    if (over.kind !== 'refused') return;
    expect(over.reason).toBe('over-limit');
    expect(over.state).toBe(state);
  });

  test('refuses invalid reservation facts and keeps the ledger untouched', () => {
    const state = initialAddressManyBudget({ limitTokens: 1000 });
    const invalid = [
      request('', 10),
      request('a', 0),
      request('a', -5),
      request('a', 1.5),
      request('a', Number.MAX_SAFE_INTEGER + 2),
      request('a', 10, { repo: 'noslash' }),
      request('a', 10, { number: 0 }),
      request('a', 10, { headOid: 'short' }),
    ];
    for (const entry of invalid) {
      const admission = admitAddressMany(state, entry);
      expect(admission.kind).toBe('refused');
      if (admission.kind !== 'refused') continue;
      expect(admission.reason).toBe('invalid');
      expect(admission.state).toBe(state);
    }
  });

  test('refuses a second id for an identity already held, and a re-used id', () => {
    const state = initialAddressManyBudget({ limitTokens: 1000 });
    const admitted = admitAddressMany(state, request('a', 100));
    expect(admitted.kind).toBe('admitted');
    if (admitted.kind !== 'admitted') return;

    for (const duplicate of [
      request('b', 100),
      request('a', 100, { number: 8, headOid: HEAD_B }),
    ]) {
      const refusal = admitAddressMany(admitted.state, duplicate);
      expect(refusal.kind).toBe('refused');
      if (refusal.kind !== 'refused') continue;
      expect(refusal.reason).toBe('duplicate');
      expect(refusal.state).toBe(admitted.state);
    }

    // A changed head is a distinct identity at the ledger; the aggregate is what
    // refuses to attribute work to a head that is not the admitted one.
    const changedHead = admitAddressMany(admitted.state, request('c', 100, { headOid: HEAD_B }));
    expect(changedHead.kind).toBe('admitted');
  });

  test('settles known usage once and leaves no hold', () => {
    const state = initialAddressManyBudget({ limitTokens: 1000 });
    const admitted = admitAddressMany(state, request('a', 300));
    expect(admitted.kind).toBe('admitted');
    if (admitted.kind !== 'admitted') return;

    const settlement = settleAddressMany(admitted.state, {
      id: 'a',
      repo: REPO,
      number: 7,
      headOid: HEAD_A,
      usage: { kind: 'known', tokens: 120 },
    });
    expect(settlement.kind).toBe('settled');
    if (settlement.kind !== 'settled') return;
    expect(settlement.tokens).toBe(120);
    expect(settlement.overrun).toBe(false);
    expect(settlement.state.observedTokens).toBe(120);
    expect(settlement.state.outstanding).toEqual([]);
    expect(settlement.state.settledIds).toEqual(['a']);
    expectCleanBound(settlement.state);

    const again = settleAddressMany(settlement.state, {
      id: 'a',
      repo: REPO,
      number: 7,
      headOid: HEAD_A,
      usage: { kind: 'known', tokens: 120 },
    });
    expect(again.kind).toBe('refused');
    if (again.kind !== 'refused') return;
    expect(again.reason).toBe('already-settled');
    expect(again.state).toBe(settlement.state);
  });

  test('refuses a settlement at another head or for an unheld id without mutating state', () => {
    const admitted = admitAddressMany(
      initialAddressManyBudget({ limitTokens: 1000 }),
      request('a', 100),
    );
    expect(admitted.kind).toBe('admitted');
    if (admitted.kind !== 'admitted') return;

    const mismatched = settleAddressMany(admitted.state, {
      id: 'a',
      repo: REPO,
      number: 7,
      headOid: HEAD_B,
      usage: { kind: 'known', tokens: 10 },
    });
    expect(mismatched.kind).toBe('refused');
    if (mismatched.kind !== 'refused') return;
    expect(mismatched.reason).toBe('identity-mismatch');
    expect(mismatched.state).toBe(admitted.state);

    const unknownId = settleAddressMany(admitted.state, {
      id: 'ghost',
      repo: REPO,
      number: 7,
      headOid: HEAD_A,
      usage: { kind: 'unknown' },
    });
    expect(unknownId.kind).toBe('refused');
    if (unknownId.kind !== 'refused') return;
    expect(unknownId.reason).toBe('unknown-reservation');
    expect(unknownId.state).toBe(admitted.state);
  });

  test('holds an unknown-usage allocation, stops admission once, and lets siblings settle', () => {
    const first = admitAddressMany(
      initialAddressManyBudget({ limitTokens: 1000 }),
      request('a', 300),
    );
    expect(first.kind).toBe('admitted');
    if (first.kind !== 'admitted') return;
    const second = admitAddressMany(first.state, request('b', 200, { number: 8, headOid: HEAD_B }));
    expect(second.kind).toBe('admitted');
    if (second.kind !== 'admitted') return;

    const unknown = settleAddressMany(second.state, {
      id: 'a',
      repo: REPO,
      number: 7,
      headOid: HEAD_A,
      usage: { kind: 'unknown' },
    });
    expect(unknown.kind).toBe('unknown-usage');
    if (unknown.kind !== 'unknown-usage') return;
    // The allocation stays visibly held, at full size, and is never refunded.
    expect(unknown.state.outstanding).toHaveLength(2);
    expect(unknown.state.outstanding.find((entry) => entry.id === 'a')).toMatchObject({
      tokens: 300,
      state: 'unresolved',
    });
    expect(unknown.state.observedTokens).toBe(0);
    expect(unknown.state.stop).toBe('unknown-usage');
    expect(unknown.state.settledIds).toEqual([]);

    const blocked = admitAddressMany(
      unknown.state,
      request('c', 1, { number: 9, headOid: HEAD_C }),
    );
    expect(blocked.kind).toBe('refused');
    if (blocked.kind !== 'refused') return;
    expect(blocked.reason).toBe('stopped');

    const sibling = settleAddressMany(unknown.state, {
      id: 'b',
      repo: REPO,
      number: 8,
      headOid: HEAD_B,
      usage: { kind: 'known', tokens: 100 },
    });
    expect(sibling.kind).toBe('settled');
    if (sibling.kind !== 'settled') return;
    expect(sibling.state.observedTokens).toBe(100);
    expect(sibling.state.outstanding.map((entry) => entry.id)).toEqual(['a']);
    expect(sibling.state.stop).toBe('unknown-usage');

    const repeated = settleAddressMany(sibling.state, {
      id: 'a',
      repo: REPO,
      number: 7,
      headOid: HEAD_A,
      usage: { kind: 'unknown' },
    });
    expect(repeated.kind).toBe('refused');
    if (repeated.kind !== 'refused') return;
    expect(repeated.reason).toBe('already-settled');
    expect(repeated.state).toBe(sibling.state);
  });

  test('accepts a known zero-usage settlement without stopping admission', () => {
    const admitted = admitAddressMany(
      initialAddressManyBudget({ limitTokens: 1000 }),
      request('a', 300),
    );
    expect(admitted.kind).toBe('admitted');
    if (admitted.kind !== 'admitted') return;
    const settled = settleAddressMany(admitted.state, {
      id: 'a',
      repo: REPO,
      number: 7,
      headOid: HEAD_A,
      usage: { kind: 'known', tokens: 0 },
    });
    expect(settled.kind).toBe('settled');
    if (settled.kind !== 'settled') return;
    expect(settled.state.observedTokens).toBe(0);
    expect(settled.state.stop).toBeNull();
    expectCleanBound(settled.state);
    expect(admitAddressMany(settled.state, request('b', 1000)).kind).toBe('admitted');
  });

  test('stops admission when actual usage exceeds the reservation allocation', () => {
    const admitted = admitAddressMany(
      initialAddressManyBudget({ limitTokens: 1000 }),
      request('a', 100),
    );
    expect(admitted.kind).toBe('admitted');
    if (admitted.kind !== 'admitted') return;
    const settled = settleAddressMany(admitted.state, {
      id: 'a',
      repo: REPO,
      number: 7,
      headOid: HEAD_A,
      usage: { kind: 'known', tokens: 150 },
    });
    expect(settled.kind).toBe('settled');
    if (settled.kind !== 'settled') return;
    expect(settled.overrun).toBe(true);
    expect(settled.state.observedTokens).toBe(150);
    expect(settled.state.stop).toBe('overrun');
    const blocked = admitAddressMany(
      settled.state,
      request('b', 1, { number: 8, headOid: HEAD_B }),
    );
    expect(blocked.kind).toBe('refused');
    if (blocked.kind !== 'refused') return;
    expect(blocked.reason).toBe('stopped');
  });

  test('stops admission when a hand-built ledger overruns the total cap', () => {
    // Arm two of the overrun rule: the caller handed in a state whose observed
    // count is inconsistent with its hold, so the cap check (not the
    // reservation check) is the one that fires.
    const handBuilt: AddressManyBudgetState = {
      limitTokens: 1000,
      observedTokens: 600,
      outstanding: [
        { id: 'a', repo: REPO, number: 7, headOid: HEAD_A, tokens: 500, state: 'reserved' },
      ],
      settledIds: [],
      stop: null,
    };
    const settled = settleAddressMany(handBuilt, {
      id: 'a',
      repo: REPO,
      number: 7,
      headOid: HEAD_A,
      usage: { kind: 'known', tokens: 500 },
    });
    expect(settled.kind).toBe('settled');
    if (settled.kind !== 'settled') return;
    expect(settled.overrun).toBe(true);
    expect(settled.state.observedTokens).toBe(1100);
    expect(settled.state.stop).toBe('overrun');
  });

  test('records a factual initial breach as a stop instead of claiming the bound', () => {
    const state = initialAddressManyBudget({ limitTokens: 100, observedTokens: 150 });
    expect(state.stop).toBe('overrun');
    expect(state.observedTokens + 0).toBeGreaterThan(state.limitTokens);
    const admission = admitAddressMany(state, request('a', 1));
    expect(admission.kind).toBe('refused');
    if (admission.kind !== 'refused') return;
    expect(admission.reason).toBe('stopped');
    expect(admission.state).toBe(state);
  });

  test('rejects malformed ledger inputs as programmer errors', () => {
    for (const limit of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 2])
      expect(() => initialAddressManyBudget({ limitTokens: limit })).toThrow(/limitTokens/);
    expect(() => initialAddressManyBudget({ limitTokens: 10, observedTokens: -1 })).toThrow(
      /observedTokens/,
    );
  });
});

// ---------------------------------------------------------------------------
// aggregate
// ---------------------------------------------------------------------------

describe('aggregateAddressMany coverage', () => {
  const candidates = selected([
    facts({ number: 5, headOid: HEAD_A }),
    facts({ number: 6, headOid: HEAD_B }),
  ]);
  const budget = initialAddressManyBudget({ limitTokens: 1000 });
  const clean = makeReport({ rounds: [{ round: 1, record: record(HEAD_A), runs: [] }] });

  test('refuses an empty candidate set instead of reporting ok', () => {
    expect(
      aggregateAddressMany({ repo: REPO, budget, candidates: [], outcomes: [] }),
    ).toMatchObject({
      ok: false,
      refusal: { kind: 'empty-coverage' },
    });
  });

  test('refuses duplicate selection coverage and foreign-repo candidates', () => {
    const duplicated = [...candidates, candidates[0]!];
    expect(
      aggregateAddressMany({ repo: REPO, budget, candidates: duplicated, outcomes: [] }),
    ).toEqual({
      ok: false,
      refusal: { kind: 'duplicate-coverage', numbers: [5] },
    });
    const foreign = [{ ...candidates[0]!, repo: 'other/repo' }];
    expect(
      aggregateAddressMany({ repo: REPO, budget, candidates: foreign, outcomes: [] }),
    ).toMatchObject({
      ok: false,
      refusal: { kind: 'repo-mismatch' },
    });
  });

  test('refuses missing, extra, duplicate and self-contradictory outcomes', () => {
    const both = { result: okResult(clean), exception: 'boom' };
    const cases: Array<[unknown, string]> = [
      // #5 is supplied and well formed; #6 is absent from the outcome set.
      [[{ number: 5, headOid: HEAD_A, result: okResult(clean) }], 'missing-outcome'],
      [
        [
          { number: 5, headOid: HEAD_A, result: okResult(clean) },
          { number: 9, headOid: HEAD_C, result: okResult(clean) },
        ],
        'extra-outcome',
      ],
      [
        [
          { number: 5, headOid: HEAD_A, result: okResult(clean) },
          { number: 5, headOid: HEAD_A, result: okResult(clean) },
        ],
        'duplicate-outcome',
      ],
      [
        [
          { number: 5, headOid: HEAD_A },
          { number: 6, headOid: HEAD_B, ...both },
        ],
        'malformed-outcome',
      ],
    ];
    for (const [value, kind] of cases) {
      const outcomes = Array.isArray(value)
        ? (value as readonly AddressManyOutcomeInput[])
        : [value as AddressManyOutcomeInput];
      const result = aggregateAddressMany({ repo: REPO, budget, candidates, outcomes });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.refusal.kind).toBe(kind);
    }
  });
});

describe('aggregateAddressMany truth', () => {
  const candidates = selected([
    facts({ number: 5, headOid: HEAD_A }),
    facts({ number: 6, headOid: HEAD_B }),
  ]);
  const cleanBudget = () => initialAddressManyBudget({ limitTokens: 1000 });

  test('refuses ok results without trusted head evidence and keeps the original result', () => {
    const atOtherHead = makeReport({
      rounds: [{ round: 1, record: record(HEAD_C), runs: [] }],
      findings: [finding('F-1')],
      fixesPerRun: 3,
    });
    const noRounds = makeReport({ rounds: [] });
    const mismatch = okResult(atOtherHead);
    const result = aggregateAddressMany({
      repo: REPO,
      budget: cleanBudget(),
      candidates: [candidates[0]!],
      outcomes: [{ number: 5, headOid: HEAD_A, result: mismatch }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [row] = result.aggregate.rows;
    expect(row).toMatchObject({
      status: 'unattributed',
      attribution: 'unattributed',
      fixesPerRun: 0,
    });
    expect(row!.result).toBe(mismatch);
    expect(result.aggregate.findings).toEqual([]);
    expect(result.aggregate.status).toBe('needs-human');
    expect(result.aggregate.totals).toMatchObject({ unattributed: 1, fixesPerRun: 0 });
    expect(result.aggregate.reasons.join(' ')).toContain('not the admitted head');

    // A successful result is value-only in the producer's shape, so a report
    // with zero rounds is still a report: unattributed, not absent.
    const noRoundsOutcome = aggregateAddressMany({
      repo: REPO,
      budget: cleanBudget(),
      candidates: [candidates[0]!],
      outcomes: [{ number: 5, headOid: HEAD_A, result: { status: 'ok', value: noRounds } }],
    });
    expect(noRoundsOutcome.ok).toBe(true);
    if (!noRoundsOutcome.ok) return;
    expect(noRoundsOutcome.aggregate.rows[0]).toMatchObject({
      status: 'unattributed',
      attribution: 'unattributed',
      fixesPerRun: 0,
    });

    // A non-ok result that carries no report at all has no evidence source.
    const reportless = aggregateAddressMany({
      repo: REPO,
      budget: cleanBudget(),
      candidates: [candidates[0]!],
      outcomes: [{ number: 5, headOid: HEAD_A, result: failedResult('fixer crashed') }],
    });
    expect(reportless.ok).toBe(true);
    if (!reportless.ok) return;
    expect(reportless.aggregate.rows[0]).toMatchObject({
      status: 'settled-failed',
      attribution: 'absent',
      deferredVendorDebt: 'absent',
    });
  });

  test('consumes the value-only report a real successful result carries', () => {
    const report = makeReport({
      rounds: [{ round: 1, record: record(HEAD_A), runs: [] }],
      findings: [finding('F-5'), finding('F-6', { status: 'fixed' })],
      fixesPerRun: 2,
      verifiedHead: HEAD_B,
      deferredVendorDebt: deferredDebt(HEAD_A, 'req-5', 'cycle-5'),
    });
    // Exactly the producer's public shape: no `report` field beside `value`.
    const success: ReviewAddressResult = { status: 'ok', value: report };
    const result = aggregateAddressMany({
      repo: REPO,
      budget: cleanBudget(),
      candidates: [candidates[0]!],
      outcomes: [{ number: 5, headOid: HEAD_A, result: success }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.aggregate.rows[0]).toMatchObject({
      status: 'settled-ok',
      attribution: 'trusted',
      fixesPerRun: 2,
      deferredVendorDebt: 'present',
      publication: 'unknown',
    });
    expect(result.aggregate.rows[0]!.result).toEqual({ status: 'ok', value: report });
    expect(result.aggregate.findings.map((entry) => entry.finding.id)).toEqual(['F-5', 'F-6']);
    expect(result.aggregate.totals).toMatchObject({ settledOk: 1, fixesPerRun: 2 });
    expect(result.aggregate.status).toBe('ok');
  });

  test('classifies a structured budget stop on a needs-human leg as budget-stopped', () => {
    const report = makeReport({
      rounds: [{ round: 1, record: record(HEAD_A), runs: [] }],
      stop: 'budget',
      reasons: ['token or wall budget exhausted'],
    });
    const stopped = needHumanResult('token or wall budget exhausted', report);
    const result = aggregateAddressMany({
      repo: REPO,
      budget: cleanBudget(),
      candidates: [candidates[0]!],
      outcomes: [{ number: 5, headOid: HEAD_A, result: stopped }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.aggregate.rows[0]).toMatchObject({
      status: 'settled-budget-exhausted',
      reason: 'token or wall budget exhausted',
      attribution: 'trusted',
      publication: 'unknown',
    });
    expect(result.aggregate.rows[0]!.result).toBe(stopped);
    expect(result.aggregate.totals).toMatchObject({
      budgetExhausted: 1,
      needsHuman: 0,
      settledOk: 0,
    });
    expect(result.aggregate.status).toBe('budget-exhausted');
    expect(result.aggregate.reasons.join(' ')).toContain('structured budget marker');

    // Without the structured marker the same status stays an ordinary
    // needs-human refusal: no reason text is parsed.
    const plain = aggregateAddressMany({
      repo: REPO,
      budget: cleanBudget(),
      candidates: [candidates[0]!],
      outcomes: [
        {
          number: 5,
          headOid: HEAD_A,
          result: needHumanResult(
            'token or wall budget exhausted',
            makeReport({ rounds: [{ round: 1, record: record(HEAD_A), runs: [] }] }),
          ),
        },
      ],
    });
    expect(plain.ok).toBe(true);
    if (!plain.ok) return;
    expect(plain.aggregate.rows[0]).toMatchObject({ status: 'settled-needs-human' });
    expect(plain.aggregate.status).toBe('needs-human');
  });

  test('scopes duplicate finding ids by PR and never merges them', () => {
    const shared = finding('F-1');
    const first = makeReport({
      rounds: [{ round: 1, record: record(HEAD_A), runs: [] }],
      findings: [shared, shared],
    });
    const second = makeReport({
      rounds: [{ round: 1, record: record(HEAD_B), runs: [] }],
      findings: [shared],
    });
    const result = aggregateAddressMany({
      repo: REPO,
      budget: cleanBudget(),
      candidates,
      outcomes: [
        { number: 5, headOid: HEAD_A, result: okResult(first) },
        { number: 6, headOid: HEAD_B, result: okResult(second) },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.aggregate.findings).toHaveLength(3);
    expect(
      result.aggregate.findings.map((entry) => [
        entry.scope.number,
        entry.scope.headOid,
        entry.finding.id,
      ]),
    ).toEqual([
      [5, HEAD_A, 'F-1'],
      [5, HEAD_A, 'F-1'],
      [6, HEAD_B, 'F-1'],
    ]);
    expect(result.aggregate.status).toBe('ok');
  });

  test('counts fixes only from attributed heads and never turns an advanced head into publication', () => {
    const report = makeReport({
      rounds: [{ round: 1, record: record(HEAD_A), runs: [] }],
      fixesPerRun: 2,
      verifiedHead: HEAD_B,
    });
    const result = aggregateAddressMany({
      repo: REPO,
      budget: cleanBudget(),
      candidates: [candidates[0]!],
      outcomes: [{ number: 5, headOid: HEAD_A, result: okResult(report) }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.aggregate.rows[0]).toMatchObject({
      fixesPerRun: 2,
      publication: 'unknown',
      attribution: 'trusted',
    });
    expect(result.aggregate.totals.fixesPerRun).toBe(2);
    expect(result.aggregate.status).toBe('ok');
  });

  test('keeps an unclean PR beside a clean one without losing either report', () => {
    const clean = makeReport({ rounds: [{ round: 1, record: record(HEAD_A), runs: [] }] });
    const uncleanReport = makeReport({
      rounds: [{ round: 1, record: record(HEAD_B), runs: [] }],
      findings: [finding('F-9')],
      fixesPerRun: 1,
    });
    const unclean = needHumanResult('review round cap reached with open findings', uncleanReport);
    const result = aggregateAddressMany({
      repo: REPO,
      budget: cleanBudget(),
      candidates,
      outcomes: [
        { number: 5, headOid: HEAD_A, result: okResult(clean) },
        { number: 6, headOid: HEAD_B, result: unclean },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.aggregate.status).toBe('needs-human');
    expect(result.aggregate.totals).toMatchObject({ settledOk: 1, needsHuman: 1, fixesPerRun: 1 });
    expect(result.aggregate.rows[1]).toMatchObject({
      status: 'settled-needs-human',
      reason: 'review round cap reached with open findings',
      attribution: 'trusted',
    });
    expect(result.aggregate.rows[1]!.result).toBe(unclean);
    expect(result.aggregate.findings.map((entry) => entry.finding.id)).toEqual(['F-9']);
  });

  test('cannot report ok while a sibling is not admitted or an allocation stays held', () => {
    const clean = makeReport({ rounds: [{ round: 1, record: record(HEAD_A), runs: [] }] });
    const notAdmitted = aggregateAddressMany({
      repo: REPO,
      budget: cleanBudget(),
      candidates,
      outcomes: [
        { number: 5, headOid: HEAD_A, result: okResult(clean) },
        { number: 6, headOid: HEAD_B, notAdmitted: 'budget' },
      ],
    });
    expect(notAdmitted.ok).toBe(true);
    if (!notAdmitted.ok) return;
    expect(notAdmitted.aggregate.status).toBe('budget-exhausted');
    expect(notAdmitted.aggregate.totals.notAdmitted).toBe(1);
    expect(notAdmitted.aggregate.rows[0]).toMatchObject({ status: 'settled-ok' });

    const otherHead = makeReport({ rounds: [{ round: 1, record: record(HEAD_C), runs: [] }] });
    const admitted = admitAddressMany(cleanBudget(), {
      id: 'held',
      repo: REPO,
      number: 8,
      headOid: HEAD_C,
      tokens: 250,
    });
    expect(admitted.kind).toBe('admitted');
    if (admitted.kind !== 'admitted') return;
    const heldState = settleAddressMany(admitted.state, {
      id: 'held',
      repo: REPO,
      number: 8,
      headOid: HEAD_C,
      usage: { kind: 'unknown' },
    });
    expect(heldState.kind).toBe('unknown-usage');
    if (heldState.kind !== 'unknown-usage') return;

    const unresolved = aggregateAddressMany({
      repo: REPO,
      budget: heldState.state,
      candidates: [candidates[0]!],
      outcomes: [{ number: 5, headOid: HEAD_A, result: okResult(clean) }],
    });
    expect(unresolved.ok).toBe(true);
    if (!unresolved.ok) return;
    expect(unresolved.aggregate.status).toBe('budget-exhausted');
    expect(unresolved.aggregate.accounting).toMatchObject({
      heldTokens: 250,
      unresolved: ['held'],
      stop: 'unknown-usage',
    });
    expect(unresolved.aggregate.reasons.join(' ')).toContain('is still held');
    expect(otherHead.rounds[0]!.record.head).toBe(HEAD_C);
  });

  test('a definitive failure outranks a budget stop', () => {
    const result = aggregateAddressMany({
      repo: REPO,
      budget: initialAddressManyBudget({ limitTokens: 100, observedTokens: 400 }),
      candidates: [candidates[0]!],
      outcomes: [{ number: 5, headOid: HEAD_A, result: failedResult('fixer exploded') }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.aggregate.status).toBe('failed');
    expect(result.aggregate.rows[0]).toMatchObject({
      status: 'settled-failed',
      reason: 'fixer exploded',
    });
    expect(result.aggregate.accounting.stop).toBe('overrun');
  });

  test('treats exceptions and cancelled legs as non-success with their own totals', () => {
    const thrown = aggregateAddressMany({
      repo: REPO,
      budget: cleanBudget(),
      candidates: [candidates[0]!],
      outcomes: [{ number: 5, headOid: HEAD_A, exception: 'driver crashed' }],
    });
    expect(thrown.ok).toBe(true);
    if (!thrown.ok) return;
    expect(thrown.aggregate.status).toBe('failed');
    expect(thrown.aggregate.totals).toMatchObject({ exceptions: 1, settledOk: 0 });
    expect(thrown.aggregate.rows[0]).toMatchObject({
      status: 'exception',
      reason: 'driver crashed',
    });

    const cancelled = aggregateAddressMany({
      repo: REPO,
      budget: cleanBudget(),
      candidates,
      outcomes: [
        { number: 5, headOid: HEAD_A, result: budgetResult() },
        { number: 6, headOid: HEAD_B, notAdmitted: 'cancel' },
      ],
    });
    expect(cancelled.ok).toBe(true);
    if (!cancelled.ok) return;
    expect(cancelled.aggregate.status).toBe('budget-exhausted');
    expect(cancelled.aggregate.totals).toMatchObject({ budgetExhausted: 1, notAdmitted: 1 });
  });

  test('reports enrollment as advisory metadata, separate from the settled outcome', () => {
    const debt = deferredDebt(HEAD_A, 'req-1', 'cycle-1');
    const withDebt = makeReport({
      rounds: [{ round: 1, record: record(HEAD_B), runs: [] }],
      deferredVendorDebt: debt,
    });
    const result = aggregateAddressMany({
      repo: REPO,
      budget: cleanBudget(),
      candidates,
      outcomes: [
        {
          number: 5,
          headOid: HEAD_A,
          result: okResult(
            makeReport({ rounds: [{ round: 1, record: record(HEAD_A), runs: [] }] }),
          ),
          enrollment: { state: 'unavailable', reason: 'queue endpoint unreachable' },
        },
        { number: 6, headOid: HEAD_B, result: okResult(withDebt) },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Both legs are genuinely complete; advisory metadata never changes that.
    expect(result.aggregate.status).toBe('ok');
    expect(result.aggregate.rows[0]).toMatchObject({
      enrollment: { state: 'unavailable', reason: 'queue endpoint unreachable' },
      deferredVendorDebt: 'absent',
    });
    expect(result.aggregate.rows[1]).toMatchObject({
      enrollment: { state: 'not-requested' },
      deferredVendorDebt: 'present',
    });
    expect(result.aggregate.reasons.join(' ')).toContain('enrollment unavailable');
    expect(result.aggregate.reasons.join(' ')).toContain('deferred vendor debt');
  });

  test('reports debt as unknown when the report head is not attributable', () => {
    const debt = deferredDebt(HEAD_C, 'req-2', 'cycle-2');
    const report = makeReport({
      rounds: [{ round: 1, record: record(HEAD_C), runs: [] }],
      fixesPerRun: 4,
      deferredVendorDebt: debt,
    });
    const result = aggregateAddressMany({
      repo: REPO,
      budget: cleanBudget(),
      candidates: [candidates[0]!],
      outcomes: [{ number: 5, headOid: HEAD_A, result: okResult(report) }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.aggregate.rows[0]).toMatchObject({
      status: 'unattributed',
      deferredVendorDebt: 'unknown',
      fixesPerRun: 0,
      publication: 'unknown',
    });
  });
});
