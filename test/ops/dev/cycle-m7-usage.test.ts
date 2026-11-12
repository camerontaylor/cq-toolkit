import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { makeDevCycle } from '../../../src/ops/dev/cycle.js';
import type { DevEffects } from '../../../src/ops/dev/effects.js';
import type { OpResult } from '../../../src/kernel/types.js';
import type { WorkerResult } from '../../../src/driver/types.js';
import type { DriverFactory } from '../../../src/driver/factory.js';
import type { PrOpenInput } from '../../../src/ops/pr/open.js';
import { makeTestRepo, repoEffects, seed, type TestRepo } from './repo.js';
import { stubScanner } from './fakes.js';
import {
  addressReport,
  bindCycleRepo,
  capFinding,
  cleanAddress,
  cleanReview,
  ghFake,
  greenCheck,
  openFake,
  seedReadyLedger,
  stubM7Scanner,
} from './cycle.helpers.js';

let repo: TestRepo;
beforeEach(async () => {
  repo = await makeTestRepo();
  bindCycleRepo(repo);
});
afterEach(async () => {
  await repo.cleanup();
});

const effects: () => DevEffects = () => repoEffects(repo);

describe('dev.cycle', () => {
  // ---- M7-cycle: retain exit spend -------------------------------------
  // The cycle meters its drivers (meterDrivers feeds the ONE run budget), and
  // the usage ledger closes at EVERY exit with settled usage preserved once:
  // typed results carry the summary on their existing carrier (value/report),
  // including guard-folded faults and structured budget stops, and in-flight
  // dispatches settle once as unknown. Known usage requires an explicit
  // measured declaration (seam v3): partial/absent observed usage stays
  // explicit through unknownCount/unpricedCount. The summary is the ledger's
  // per-dispatch fold, so parent totals never double count child usage.

  /**
   * A driver that settles ONE explicitly measured review dispatch: session
   * mode plans a single session, so a cycle's known aggregate is this one
   * observation. (A second, usage-free dispatch of the same driver keeps the
   * partial/absent evidence explicit in the meter-level tests.)
   */
  const measuredDriver = (): DriverFactory => {
    let dispatched = false;
    return {
      resolve: (request: {
        beforeRequest?: (
          text: string,
          contents?: readonly { text: string }[],
          context?: { kind: 'model-request' },
        ) => void | Promise<void>;
      }) => {
        if (dispatched) throw new Error('session mode must plan exactly one dispatch');
        dispatched = true;
        return {
          lane: 'ai-sdk' as const,
          modelSpec: { provider: 'mock', model: 'mock' },
          driver: {
            run: async (invocation: { prompt: string }): Promise<WorkerResult> => {
              // The engine records delivery from the real serialized ai-sdk
              // request shape, not from the model's output.
              await request.beforeRequest?.(
                JSON.stringify({ prompt: [{ role: 'user', content: invocation.prompt }] }),
                [{ text: invocation.prompt }],
                { kind: 'model-request' },
              );
              return {
                stopReason: 'complete' as const,
                structuredOutput: { findings: [] },
                usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 0 },
                usageProvenance: 'measured' as const,
                denials: [],
              };
            },
          },
        };
      },
    } as unknown as DriverFactory;
  };

  const MEASURED_SUMMARY = {
    usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 0 },
    knownCount: 1,
    unknownCount: 0,
    unpricedCount: 1,
  };

  /**
   * The cq.json the default review leg needs (the agent-review fixture):
   * session mode plans ONE dispatch, so a cycle's known aggregate is the
   * single measured observation the M7 drivers settle.
   */
  async function seedM7Budget(): Promise<void> {
    await repo.write('package.json', JSON.stringify({ name: 'fixture-cycle' }));
    await repo.write(
      'cq.json',
      JSON.stringify({
        schemaVersion: 2,
        checks: [{ adapter: 'tsc-lines', command: { command: 'tsc', args: [] } }],
        roles: { reviewer: { provider: 'mock', model: 'mock' } },
        budgets: { run: { maxTokens: 10_000, wallMs: 3_600_000 } },
        review: { reviewers: ['agent'] },
      }),
    );
    repo.commitAll('M7 cycle usage fixture');
  }

  test('M7-cycle nominal evidence', async () => {
    const cleanup = await stubM7Scanner();
    try {
      await runNominal();
    } finally {
      await cleanup();
    }

    async function runNominal(): Promise<void> {
      await seedM7Budget();
      const state = await seed(repo);
      await seedReadyLedger(state);
      const opens: PrOpenInput[] = [];
      const op = makeDevCycle({
        effects: effects(),
        check: greenCheck(),
        drivers: measuredDriver(),
        address: cleanAddress(state),
        open: openFake(opens),
        git: async (args) =>
          args.includes('push')
            ? { code: 0, stdout: '', stderr: '' }
            : { code: 0, stdout: `${state.head}\trefs/heads/feature/x\n`, stderr: '' },
      });
      const result = await op({ repoRoot: repo.root });
      expect(result.status, JSON.stringify(result)).toBe('ok');
      if (result.status !== 'ok') return;
      // Success settles the summary ONCE, on the ok value's existing carrier:
      // the review session's one measured dispatch, folded per dispatch.
      expect(result.value.usageSummary).toEqual(MEASURED_SUMMARY);
    }
  });

  test('M7-cycle missing evidence', async () => {
    const state = await seed(repo);
    await seedReadyLedger(state);
    const opens: PrOpenInput[] = [];
    const op = makeDevCycle({
      effects: effects(),
      check: greenCheck(),
      review: cleanReview(state),
      address: async () => ({
        status: 'needs-human',
        reason: 'review.address: token or wall budget exhausted; report: /tmp/r.json',
        report: {
          ...addressReport(state, [capFinding], []),
          stop: 'budget' as const,
        },
      }),
      open: openFake(opens),
      gh: ghFake().gh,
      // The findings section composes under the publication scanner
      // (production always wires one); the envelope assertion below needs
      // the composed path, not the missing-scanner refusal.
      publicationScanner: stubScanner(),
      git: async () => ({ code: 0, stdout: `${state.head}\trefs/heads/feature/x\n`, stderr: '' }),
    });
    const result: OpResult<unknown> & {
      report?: { usageSummary?: unknown };
    } = await op({ repoRoot: repo.root });
    // The needs-human refusal keeps its existing carrier: the report envelope
    // gains the settled usageSummary and the reason is unchanged.
    expect(result.status).toBe('needs-human');
    if (result.status !== 'needs-human') return;
    expect(result.report?.usageSummary).toEqual({
      knownCount: 0,
      unknownCount: 0,
      unpricedCount: 0,
    });
    expect(result.reason).toContain('token or wall budget exhausted');
  });

  test('M7-cycle failure evidence', async () => {
    const cleanup = await stubM7Scanner();
    try {
      await runFailure();
    } finally {
      await cleanup();
    }

    async function runFailure(): Promise<void> {
      await seedM7Budget();
      const state = await seed(repo);
      await seedReadyLedger(state);
      const op = makeDevCycle({
        effects: effects(),
        check: greenCheck(),
        drivers: measuredDriver(),
        address: cleanAddress(state),
        // A failure AFTER the review leg metered its dispatches: the
        // publication leg refuses, folding the op to failed with the settled
        // usage still on the envelope.
        open: async () => ({ status: 'failed', error: 'pr.open: forge down' }),
        git: async (args) =>
          args.includes('push')
            ? { code: 0, stdout: '', stderr: '' }
            : { code: 0, stdout: `${state.head}\trefs/heads/feature/x\n`, stderr: '' },
      });
      const result: OpResult<unknown> & {
        report?: { usageSummary?: unknown };
      } = await op({ repoRoot: repo.root });
      expect(result.status, JSON.stringify(result)).toBe('failed');
      if (result.status !== 'failed') return;
      expect(result.error).toContain('pr.open');
      expect(result.report?.usageSummary).toEqual(MEASURED_SUMMARY);
    }
  });

  test('M7-cycle evidence: a fault folded by the guard keeps settled usage once (thrown markers untouched)', async () => {
    const cleanup = await stubM7Scanner();
    try {
      await runFoldedFault();
    } finally {
      await cleanup();
    }

    async function runFoldedFault(): Promise<void> {
      await seedM7Budget();
      const state = await seed(repo);
      await seedReadyLedger(state);
      const fault = Object.assign(new Error('address exploded'), { marker: 'original fault' });
      const op = makeDevCycle({
        effects: effects(),
        check: greenCheck(),
        drivers: measuredDriver(),
        // The injected address leg throws AFTER the review leg metered its
        // dispatch; guardDevOp folds the fault to needs-human naming it, and
        // the thrown object is never mutated.
        address: async () => {
          throw fault;
        },
      });
      const result: OpResult<unknown> & {
        report?: { usageSummary?: unknown };
      } = await op({ repoRoot: repo.root });
      expect(result.status).toBe('needs-human');
      if (result.status !== 'needs-human') return;
      expect(result.reason).toContain('address exploded');
      expect(fault).toHaveProperty('marker', 'original fault');
      // Only the review leg dispatched once: its measured usage folds once.
      expect(result.report?.usageSummary).toEqual(MEASURED_SUMMARY);
    }
  });

  test('M7-cycle exhaustion evidence', async () => {
    const cleanup = await stubM7Scanner();
    try {
      await runExhaustion();
    } finally {
      await cleanup();
    }

    async function runExhaustion(): Promise<void> {
      await seedM7Budget();
      // A one-dispatch token budget: the measured review dispatch spends it
      // exactly, so the address leg's remainder is <= 0 and the cycle exits
      // budget-exhausted AFTER settled usage exists.
      await repo.write(
        'cq.json',
        JSON.stringify({
          schemaVersion: 2,
          checks: [{ adapter: 'tsc-lines', command: { command: 'tsc', args: [] } }],
          roles: { reviewer: { provider: 'mock', model: 'mock' } },
          budgets: { run: { maxTokens: 160, wallMs: 3_600_000 } },
          review: { reviewers: ['agent'] },
        }),
      );
      repo.commitAll('M7 exhaustion fixture');
      const state = await seed(repo);
      await seedReadyLedger(state);
      const op = makeDevCycle({
        effects: effects(),
        check: greenCheck(),
        drivers: measuredDriver(),
        address: async () => {
          throw new Error('address must not run after token exhaustion');
        },
      });
      const result: OpResult<unknown> & {
        report?: { usageSummary?: unknown };
      } = await op({ repoRoot: repo.root });
      // The typed exhaustion carries the settled summary once: the spent
      // dispatch is KNOWN (its measured declaration), never dropped.
      expect(result, JSON.stringify(result)).toMatchObject({ status: 'budget-exhausted' });
      expect(result.report?.usageSummary).toEqual(MEASURED_SUMMARY);
    }
  });

  test('M7-cycle cancellation evidence', async () => {
    // An in-flight dispatch the wall cancels: the driver never settles, so
    // the cycle's close records it ONCE as unknown through the pending drain.
    const never = {
      resolve: () => {
        return {
          lane: 'ai-sdk' as const,
          modelSpec: { provider: 'mock', model: 'mock' },
          driver: {
            // Never settles: it ignores the abort signal on purpose, so the
            // ONLY close path is the cycle's pending drain (the reviewer's
            // wall race returns without awaiting this run).
            run: async (): Promise<WorkerResult> => new Promise(() => {}),
          },
        };
      },
    } as unknown as DriverFactory;
    await repo.write('package.json', JSON.stringify({ name: 'fixture-cycle' }));
    await repo.write(
      'cq.json',
      JSON.stringify({
        schemaVersion: 2,
        checks: [{ adapter: 'tsc-lines', command: { command: 'tsc', args: [] } }],
        roles: { reviewer: { provider: 'mock', model: 'mock' } },
        // Tokens are ample; the WALL is what cancels mid-dispatch. Search is
        // off so the driver's rg probe never consumes the tight wall before
        // the dispatch itself starts.
        budgets: { run: { maxTokens: 10_000, wallMs: 4_000 } },
        review: { reviewers: ['agent'], searchTools: false },
      }),
    );
    repo.commitAll('M7 cancellation fixture');
    const state = await seed(repo);
    await seedReadyLedger(state);
    // CI's coverage runner has no gitleaks binary: bind the SAME hermetic
    // scanner fixture the other agent-leg tests use so the pre-upload scan is
    // clean and the wall is spent by the dispatch, not the scan.
    const scanner = await stubM7Scanner();
    try {
      const op = makeDevCycle({
        effects: effects(),
        check: greenCheck(),
        drivers: never,
      });
      const result: OpResult<unknown> & {
        report?: { usageSummary?: unknown };
      } = await op({ repoRoot: repo.root });
      expect(result.status).toBe('needs-human');
      if (result.status !== 'needs-human') return;
      expect(result.reason).toContain('dev.cycle (review.run)');
      // Partial/absent observed usage stays EXPLICIT: the cancelled dispatch
      // contributes unknownCount 1, never a zero aggregate.
      expect(result.report?.usageSummary).toEqual({
        knownCount: 0,
        unknownCount: 1,
        unpricedCount: 1,
      });
    } finally {
      await scanner();
    }
  });
});
