import { coordinationRoot } from './addressMany.helpers.js';
// Split provenance: test/ops/review/addressMany.test.ts was split into this
// file plus addressMany.helpers.ts, addressMany.registry.test.ts,
// addressMany.dispatch.test.ts, addressMany.guards.test.ts,
// addressMany.budget.test.ts, addressMany.query.test.ts,
// addressMany.enrollment.test.ts, addressMany.accounting.test.ts,
// addressMany.concurrency.test.ts and addressMany.isolation.test.ts.
import { expect, test, vi } from 'vitest';
import { makeReviewAddressMany } from '../../../src/ops/review/addressMany.js';
import { gh, head, input, metadata, report } from './addressMany.helpers.js';

test('M7-many nominal evidence', async () => {
  const address = vi.fn(async () => ({ status: 'ok' as const, value: report() }));
  const result = await makeReviewAddressMany({
    coordinationRoot: coordinationRoot(),
    isolate: async (root) => root,
    gh,
    address,
  })(input);
  expect(result.status).toBe('ok');
  if (result.status !== 'ok') throw new Error('expected success');
  // Two legs, each with measured usage 10: success retains settled usage once.
  expect(result.value.usageSummary).toEqual({
    usage: { input: 20, output: 0, cacheRead: 0, cacheWrite: 0 },
    knownCount: 2,
    unknownCount: 0,
    unpricedCount: 2,
  });
  expect(result.value.accounting.observedTokens).toBe(20);
});

test('M7-many missing evidence', async () => {
  // A dispatched leg whose settled report carries no usage measurement is
  // explicit unknown spend, never measured zero, and never dropped; its
  // measured sibling is retained once.
  const noUsage = report();
  delete (noUsage as { usage?: unknown }).usage;
  const address = vi.fn(async ({ source }: { source: string }) =>
    source === 'pr:1'
      ? { status: 'ok' as const, value: noUsage }
      : { status: 'ok' as const, value: report() },
  );
  const result = await makeReviewAddressMany({
    coordinationRoot: coordinationRoot(),
    isolate: async (root) => root,
    gh,
    address,
  })({ ...input, pulls: [1, 2, 3], tokensPerPr: 25, concurrency: 2 });
  expect(result.report?.accounting.stop).toBe('unknown-usage');
  expect(result.report?.usageSummary).toEqual({
    usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 },
    knownCount: 1,
    unknownCount: 1,
    unpricedCount: 2,
  });
});

test('M7-many failure evidence', async () => {
  // The first leg settles with measured usage, the second THROWS: failure and
  // thrown exits retain the first leg's usage exactly once, and parent totals
  // do not double count it. The later failed-result case retains a failed
  // leg's OWN usage; this one covers the thrown path.
  let calls = 0;
  const address = vi.fn(async () => {
    if (++calls === 1) return { status: 'ok' as const, value: report() };
    throw new Error('leg two lost');
  });
  const result = await makeReviewAddressMany({
    coordinationRoot: coordinationRoot(),
    isolate: async (root) => root,
    gh,
    address,
  })(input);
  expect(result.status).toBe('failed');
  expect(result.report?.usageSummary).toEqual({
    usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 },
    knownCount: 1,
    unknownCount: 1,
    unpricedCount: 2,
  });
  expect(result.report?.accounting.observedTokens).toBe(10);
});

test('M7-many exhaustion evidence', async () => {
  // Two measured legs exhaust the allocation: the budget-exhausted exit
  // retains both legs' settled usage exactly once, and the third candidate is
  // a not-admitted refusal that invents no spend.
  const address = vi.fn(async ({ source }: { source: string }) => {
    const n = Number(source.split(':')[1]);
    return {
      status: 'ok' as const,
      value: { ...report(), usage: { input: 40, output: 0, cacheRead: 0, cacheWrite: 0 } },
      source: `pr:${n}`,
    };
  });
  const result = await makeReviewAddressMany({
    coordinationRoot: coordinationRoot(),
    isolate: async (root) => root,
    gh,
    address,
  })({ ...input, pulls: [1, 2, 3], maxTokens: 100, tokensPerPr: 50 });
  expect(result.status).toBe('budget-exhausted');
  expect(result.report?.usageSummary).toEqual({
    usage: { input: 80, output: 0, cacheRead: 0, cacheWrite: 0 },
    knownCount: 2,
    unknownCount: 0,
    unpricedCount: 2,
  });
  expect(result.report?.accounting.observedTokens).toBe(80);
});

test('M7-many failed-result evidence', async () => {
  // The first leg settles with a definitive NON-THROWN failure and its OWN
  // measured usage; the second succeeds: the failed leg's spend is retained
  // exactly once beside the successful sibling's, and parent totals do not
  // double count either. The earlier thrown-sibling case retains usage across
  // an exception; this one across a failed result.
  let calls = 0;
  const address = vi.fn(async () =>
    ++calls === 1
      ? {
          status: 'failed' as const,
          error: 'verification failed',
          report: { ...report(), usage: { input: 30, output: 0, cacheRead: 0, cacheWrite: 0 } },
        }
      : { status: 'ok' as const, value: report() },
  );
  const result = await makeReviewAddressMany({
    coordinationRoot: coordinationRoot(),
    isolate: async (root) => root,
    gh,
    address,
  })(input);
  expect(result.status).toBe('failed');
  expect(result.report?.usageSummary).toEqual({
    usage: { input: 40, output: 0, cacheRead: 0, cacheWrite: 0 },
    knownCount: 2,
    unknownCount: 0,
    unpricedCount: 2,
  });
  expect(result.report?.accounting.observedTokens).toBe(40);
});

test('M7-many cancellation evidence', async () => {
  // A non-dispatched admitted leg (changed head before dispatch) settles with
  // an EXPLICIT UNKNOWN observation, never a measured zero: it is not an
  // invocation, so knownCount must not inflate. This is the deliberate
  // admitted-leg-as-unit model, not an inconsistency: the leg's ledger
  // OBSERVATION records {} (usageSummary unknownCount 1) while its BUDGET
  // settlement is a measured zero, because a budget hold and a usage
  // observation answer different questions — the hold reserves capacity for a
  // leg that was admitted as a unit, the observation records only real
  // invocations.
  let calls = 0;
  const changingGh = async (args: string[]) => ({
    code: 0,
    stderr: '',
    stdout:
      args[0] === 'repo'
        ? JSON.stringify({ nameWithOwner: 'owner/repo' })
        : JSON.stringify({
            ...metadata(1),
            head: { ...metadata(1).head, sha: ++calls === 1 ? head : 'b'.repeat(40) },
          }),
  });
  const address = vi.fn(async () => ({ status: 'ok' as const, value: report() }));
  const result = await makeReviewAddressMany({
    coordinationRoot: coordinationRoot(),
    isolate: async (root) => root,
    gh: changingGh,
    address,
  })({ ...input, pulls: [1] });
  expect(result.status).toBe('needs-human');
  expect(result.report?.usageSummary).toEqual({
    knownCount: 0,
    unknownCount: 1,
    unpricedCount: 1,
  });
});

test('M7-many malformed evidence degrades to unknown without losing settlement', async () => {
  // A malformed usage measurement is unmeasurable telemetry: it settles
  // through the unknown-usage path, so the held reservations settle as
  // unresolved and are retained in outstanding at their full allocations
  // (never released, never refunded), the sticky unknown-usage stop is set,
  // the aggregate never spuriously reports settled-ok accounting, and the
  // observation degrades to explicit unknown instead of throwing out of the
  // leg.
  const badUsage = report();
  (badUsage.usage as unknown as { input: number }).input = -5;
  const address = vi.fn(async () => ({ status: 'ok' as const, value: badUsage }));
  const result = await makeReviewAddressMany({
    coordinationRoot: coordinationRoot(),
    isolate: async (root) => root,
    gh,
    address,
  })(input);
  expect(result.report?.usageSummary).toEqual({
    knownCount: 0,
    unknownCount: 1,
    unpricedCount: 1,
  });
  // The malformed leg's reservation is retained in outstanding marked
  // unresolved at its full allocation (the pure planner's carrier: an
  // unpriceable hold is visible, never refunded and never dropped), the
  // ledger is stopped, and no raw -5 token total ever folded in.
  expect(result.report?.accounting).toEqual({
    limitTokens: 100,
    observedTokens: 0,
    heldTokens: 50,
    unresolved: ['1'],
    stop: 'unknown-usage',
  });
});

test('M7-many post-dispatch exit retains the envelope through a thrown settlement', async () => {
  // Leg 1 settles with measured usage; leg 2's settlement arithmetic leaves
  // the safe integer range and throws. The guard settles it as unknown with
  // a named fault, and the post-dispatch budget-exhausted exit still carries
  // leg 1's retained spend on its report envelope — nothing is lost.
  let calls = 0;
  const address = vi.fn(async () =>
    ++calls === 1
      ? { status: 'ok' as const, value: report() }
      : {
          status: 'ok' as const,
          value: {
            ...report(),
            usage: { input: Number.MAX_SAFE_INTEGER, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        },
  );
  const result = await makeReviewAddressMany({
    coordinationRoot: coordinationRoot(),
    isolate: async (root) => root,
    gh,
    address,
  })(input);
  expect(result.status).toBe('budget-exhausted');
  // Leg 1's measured spend and leg 2's normalized (safe) measurement are both
  // retained; the fold clamps at the safe bound (float rounding makes the
  // saturated sum land one below the literal maximum, which is still >= each
  // individual measurement and far above any real spend).
  expect(result.report?.usageSummary.usage?.input).toBeGreaterThan(Number.MAX_SAFE_INTEGER - 100);
  expect(result.report?.reasons.join(';')).toContain('settlement threw and was settled as unknown');
});

test('M7-many clamp saturation at the safe integer bound', async () => {
  // A leg at MAX_SAFE_INTEGER plus a sibling saturates the summary fold at
  // the bound instead of silently wrapping to a plausible wrong number.
  const address = vi.fn(async () => ({
    status: 'ok' as const,
    value: {
      ...report(),
      usage: { input: Number.MAX_SAFE_INTEGER, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
  }));
  const result = await makeReviewAddressMany({
    coordinationRoot: coordinationRoot(),
    isolate: async (root) => root,
    gh,
    address,
  })(input);
  expect(result.report?.usageSummary.usage?.input).toBe(Number.MAX_SAFE_INTEGER);
});

test('M7-many report-less refusal carries a top-level usage summary', async () => {
  // A report-less exit (here: remote mismatch before dispatch) still carries
  // its I1 top-level usageSummary envelope, never silently dropping spend.
  const result = await makeReviewAddressMany({
    coordinationRoot: coordinationRoot(),
    isolate: async (root) => root,
    gh: async () => ({ code: 1, stderr: 'nope', stdout: '' }),
    address: vi.fn(),
  })(input);
  expect(result.status).toBe('needs-human');
  expect(result.usageSummary).toEqual({
    knownCount: 0,
    unknownCount: 0,
    unpricedCount: 0,
  });
});
