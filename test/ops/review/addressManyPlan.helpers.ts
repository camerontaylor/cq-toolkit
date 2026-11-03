// Split provenance: test/ops/review/addressManyPlan.test.ts was split into
// this module plus addressManyPlan.selection.test.ts,
// addressManyPlan.admission.test.ts, addressManyPlan.admissionStop.test.ts,
// addressManyPlan.coverage.test.ts, addressManyPlan.attribution.test.ts and
// addressManyPlan.outcomes.test.ts.
import { expect } from 'vitest';
import type { ReviewAddressReport, ReviewAddressResult } from '../../../src/ops/review/address.js';
import type { Finding, FindingsRecord } from '../../../src/ops/review/findings.js';
import { DeferredVendorDebtSchema } from '../../../src/ops/dev/internal/deferredReview.js';
import {
  admitAddressMany,
  initialAddressManyBudget,
  selectAddressMany,
  type AddressManyBudgetState,
  type AddressManyCandidate,
  type AddressManyListing,
  type AddressManyPolicy,
  type AddressManyPrFacts,
} from '../../../src/ops/review/internal/addressManyPlan.js';

export const REPO = 'owner/repo';
const BASE = 'd'.repeat(40);
export const HEAD_A = 'a'.repeat(40);
export const HEAD_B = 'b'.repeat(40);
export const HEAD_C = 'c'.repeat(40);

// ---------------------------------------------------------------------------
// fixtures — scripted metadata and reports, no git, process, forge or provider
// ---------------------------------------------------------------------------

export const facts = (over: Partial<AddressManyPrFacts> = {}): AddressManyPrFacts => ({
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

export const listing = (
  pulls: readonly AddressManyPrFacts[],
  over: Partial<AddressManyListing> = {},
): AddressManyListing => ({
  complete: true,
  repo: REPO,
  pulls,
  ...over,
});

export const policy = (over: Partial<AddressManyPolicy> = {}): AddressManyPolicy => ({
  repo: REPO,
  owner: 'owner',
  ...over,
});

/** Force invalid metadata through the type boundary: facts are data, not policy. */
export const hostile = (value: unknown): AddressManyPrFacts => value as AddressManyPrFacts;

export const finding = (id: string, over: Partial<Finding> = {}): Finding => ({
  id,
  source: 'agent',
  severity: 'major',
  text: `finding ${id}`,
  status: 'open',
  ...over,
});

export const record = (head: string, findings: readonly Finding[] = []): FindingsRecord => ({
  schemaVersion: 1,
  branch: 'feat/x',
  head,
  sources: [{ kind: 'agent', status: 'terminal' }],
  findings: [...findings],
});

const usage = (input = 0, output = 0) => ({ input, output, cacheRead: 0, cacheWrite: 0 });

export function makeReport(over: Partial<ReviewAddressReport> = {}): ReviewAddressReport {
  const rounds = over.rounds ?? [{ round: 1, record: record(HEAD_A), runs: [] }];
  const firstHead = rounds[0]?.record.head;
  return {
    source: 'review',
    reportPath: 'review-address-report.json',
    rounds,
    // A real producer stamps the witness at admission; fixtures default it to
    // the first reviewed head and override it where provenance is the subject.
    ...(firstHead === undefined ? {} : { admissionHead: firstHead }),
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

/** The same report with no admission witness (a pre-admission refusal). */
export const withoutAdmissionHead = (report: ReviewAddressReport): ReviewAddressReport => {
  const copy = { ...report };
  delete copy.admissionHead;
  return copy;
};

/** The producer's real success shape: the report rides in `value`, not `report`. */
export const okResult = (report: ReviewAddressReport): ReviewAddressResult => ({
  status: 'ok',
  value: report,
});

/** A minimally valid deferred vendor debt for the head/request under test. */
export const deferredDebt = (head: string, requestId: string, cycleId: string) =>
  DeferredVendorDebtSchema.parse({
    reference: {
      requestId,
      binding: {
        kind: 'deferred-author',
        repo: REPO,
        producer: 'coderabbit',
        head,
        target: 'main',
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
      target: 'main',
      scope: 'full',
      dirtySha256: 'clean-tree',
      failure: { source: 'vendor', category: 'vendor-unavailable', codes: ['con_err'] },
    },
    deferral: { id: `deferral-${cycleId}`, base: BASE, dirtySha256: 'clean-tree' },
    vendor: 'vendor-blocked-transient',
    vendorCompleted: false,
  });

export const needHumanResult = (
  reason: string,
  report?: ReviewAddressReport,
): ReviewAddressResult =>
  report === undefined
    ? { status: 'needs-human', reason }
    : { status: 'needs-human', reason, report };

export const failedResult = (error: string): ReviewAddressResult => ({ status: 'failed', error });

export const budgetResult = (): ReviewAddressResult => ({ status: 'budget-exhausted' });

/** Only states the module returns with `stop === null` may claim the bound. */
export function expectCleanBound(state: AddressManyBudgetState): void {
  expect(state.stop).toBeNull();
  const held = state.outstanding.reduce((sum, entry) => sum + entry.tokens, 0);
  expect(state.observedTokens + held).toBeLessThanOrEqual(state.limitTokens);
}

export const held = (state: AddressManyBudgetState): AddressManyBudgetState['outstanding'] =>
  state.outstanding;

export function selected(
  pulls: readonly AddressManyPrFacts[],
  over: Partial<AddressManyPolicy> = {},
): readonly AddressManyCandidate[] {
  const selection = selectAddressMany(listing(pulls), policy(over));
  if (!selection.ok) throw new Error(`fixture selection refused: ${selection.refusal.kind}`);
  return selection.candidates;
}

export const candidates: readonly AddressManyCandidate[] = selected([
  facts({ number: 5, headOid: HEAD_A }),
  facts({ number: 6, headOid: HEAD_B }),
]);

export const cleanBudget = (): AddressManyBudgetState =>
  initialAddressManyBudget({ limitTokens: 1000 });

export const request = (
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
