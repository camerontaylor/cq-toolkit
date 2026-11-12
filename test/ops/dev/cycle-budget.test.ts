import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { DEV_CYCLE_PUBLICATION_RESERVE_MS, makeDevCycle } from '../../../src/ops/dev/cycle.js';
import { makeReviewAddress } from '../../../src/ops/review/address.js';
import { createEscalationState } from '../../../src/ops/fix/escalation.js';
import type { DevEffects } from '../../../src/ops/dev/effects.js';
import type { DriverFactory, DriverRequest } from '../../../src/driver/factory.js';
import type { FindingsRecord } from '../../../src/ops/review/findings.js';
import type { ReviewRunInput } from '../../../src/ops/review/run.js';
import type { PrOpenInput } from '../../../src/ops/pr/open.js';
import type { ReviewAddressInput } from '../../../src/ops/review/address.js';
import { makeTestRepo, repoEffects, seed, type TestRepo } from './repo.js';
import { stubScanner } from './fakes.js';
import {
  addressReport,
  bindCycleRepo,
  capFinding,
  cleanReview,
  ghFake,
  greenCheck,
  openFake,
  seedReadyLedger,
  structuredStopAddress,
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
  test.each(['budget', 'rereview-blocked'] as const)(
    '#532: %s publication refuses a changed head, dirty tree, or missing verified head',
    async (stop) => {
      for (const mode of [
        'head',
        'staged',
        'unstaged',
        'untracked',
        'missing',
        'final-gate',
      ] as const) {
        const state = await seed(repo);
        const opens: PrOpenInput[] = [];
        let pushes = 0;
        const reason = 'review.address: stopped after verified fixes';
        let checks = 0;
        const result = await makeDevCycle({
          effects: effects(),
          check: async (input) => {
            const checked = await greenCheck()(input);
            if (++checks === 2 && mode === 'final-gate')
              repo.git('commit', '--allow-empty', '-m', 'changed during final gates');
            return checked;
          },
          review: cleanReview(state),
          address: async () => {
            if (mode === 'head') repo.git('commit', '--allow-empty', '-m', 'concurrent head');
            if (mode === 'staged' || mode === 'unstaged') {
              await repo.write('src/a.ts', 'changed after addressing');
              if (mode === 'staged') repo.git('add', 'src/a.ts');
            }
            if (mode === 'untracked') await repo.write('unexpected.txt', 'unverified');
            const report = { ...addressReport(state, [capFinding], []), stop };
            if (mode === 'missing') delete report.verifiedHead;
            return { status: 'needs-human', reason, report };
          },
          open: openFake(opens),
          git: async (args) => {
            // Count ONLY pushes (the adjacent publication test's
            // args.includes('push') filter): publishHead drives BOTH the push
            // and its ls-remote verification through this one transport, so
            // an unfiltered counter would let any non-push git call inflate
            // `pushes` and fail expect(pushes).toBe(0) spuriously — and a
            // blanket empty-success answer could itself masquerade as the
            // gate's refusal instead of the verified-head/dirty-tree one.
            // Non-push calls get the same honest ls-remote answer the
            // adjacent test's fake returns.
            if (args.includes('push')) {
              pushes++;
              return { code: 0, stdout: '', stderr: '' };
            }
            return { code: 0, stdout: `${state.head}\trefs/heads/feature/x\n`, stderr: '' };
          },
        })({ repoRoot: repo.root });
        expect(result).toEqual({
          status: 'needs-human',
          reason: `dev.cycle (review.address): ${reason}`,
          report: { usageSummary: { knownCount: 0, unknownCount: 0, unpricedCount: 0 } },
        });
        expect(pushes).toBe(0);
        expect(opens).toEqual([]);
        // The refusal came from the verified-head gate INSIDE the publication
        // path — not from a vacuous verbatim propagation of an unrecognized
        // stop: BOTH check legs ran, because the cycle only runs the final
        // gates (the second check) after the discriminator accepts a
        // structured stop for publication. A stop that never took the
        // publication path would refuse verbatim after the FIRST check alone,
        // so this count is what proves the 'budget' and 'rereview-blocked'
        // iterations of this matrix actually reach the gate (cycle.ts keeps
        // the gate two-legged: capCheck, then finishNotReady's re-read).
        expect(checks).toBe(2);
        // Restore only fixture changes so the next named case has a clean seed.
        if (mode === 'staged' || mode === 'unstaged') {
          await repo.write('src/a.ts', 'export const a = 1;\n');
          repo.git('add', 'src/a.ts');
          repo.git('commit', '--allow-empty', '-m', 'restore fixture');
        }
        if (mode === 'untracked') await rm(`${repo.root}/unexpected.txt`);
      }
    },
  );

  test.each(['identity', 'admission', 'scan', 'thrown', 'wall'] as const)(
    '#532: a real address %s exit at its deadline publishes only a budget-attributed block',
    async (mode) => {
      const state = await seed(repo);
      const originalNow = Date.now;
      let clock = originalNow();
      const opens: PrOpenInput[] = [];
      let pushes = 0;
      try {
        Date.now = () => clock;
        const record: FindingsRecord = {
          schemaVersion: 1,
          branch: state.branch,
          head: state.head,
          reviewed: { base: state.base, scope: 'full' },
          sources: [{ kind: 'agent', status: 'terminal' }],
          findings: [capFinding],
        };
        const role = { provider: 'mock', model: 'mock' };
        const address = makeReviewAddress({
          config: {
            schemaVersion: 2,
            roles: { worker: role, reviewer: role },
            budgets: { run: { maxTokens: 1000 } },
            checks: [{ adapter: 'tsc-lines', command: { command: process.execPath, args: [] } }],
            review: { reviewers: ['agent'] },
          },
          initialRecord:
            mode === 'admission'
              ? {
                  ...record,
                  get head() {
                    clock += 1001;
                    return 'b'.repeat(40);
                  },
                }
              : record,
          disposition: async () => ({ status: 'ok', value: {} }),
          workerFactory: () => ({
            escalation: createEscalationState,
            fix: async (item) => ({
              finding: { ...item, status: 'fixed', reason: 'verified' },
              commit: state.head,
              observedHead: state.head,
              reason: 'verified',
              validation: [],
            }),
          }),
          review: async () => {
            clock += 1001;
            if (mode === 'thrown') throw new Error('unexpected reviewer fault');
            if (mode === 'identity') {
              repo.git('commit', '--allow-empty', '-m', 'concurrent head');
              return { status: 'ok', value: record };
            }
            return {
              status: 'needs-human',
              reason: mode === 'scan' ? 'denylist scan refused' : 'agent wall budget exhausted',
              report: { ...record, ...(mode === 'wall' ? { blockedBudget: true as const } : {}) },
            };
          },
        });
        const result = await makeDevCycle({
          effects: effects(),
          check: greenCheck(),
          review: cleanReview(state),
          address: (input) =>
            address({ ...input, wallMs: 1000, journalDir: `${repo.root}/.cq/test-journal` }),
          open: openFake(opens),
          gh: ghFake().gh,
          publicationScanner: stubScanner(),
          git: async (args) => {
            if (args.includes('push')) pushes++;
            return { code: 0, stdout: `${state.head}\trefs/heads/feature/x\n`, stderr: '' };
          },
        })({ repoRoot: repo.root });
        expect(result.status).toBe('needs-human');
        expect(pushes).toBe(mode === 'wall' ? 1 : 0);
        expect(opens).toHaveLength(mode === 'wall' ? 1 : 0);
      } finally {
        Date.now = originalNow;
      }
    },
  );

  test('S7 H (D1): a red FINAL gate on the budget path refuses verbatim — NO push, NO PR', async () => {
    const state = await seed(repo);
    await seedReadyLedger(state);
    const opens: PrOpenInput[] = [];
    let pushCalls = 0;
    let checkRuns = 0;
    const op = makeDevCycle({
      effects: effects(),
      check: async (input) => {
        checkRuns++;
        if (checkRuns === 1) return greenCheck()({ ...input });
        return { status: 'failed', error: 'dev.check: the addressed head broke format:check' };
      },
      review: cleanReview(state),
      address: structuredStopAddress(
        state,
        'budget',
        'review.address: token or wall budget exhausted; report: /tmp/r.json',
      ),
      open: openFake(opens),
      git: async (args) => {
        if (args.includes('push')) pushCalls++;
        return { code: 0, stdout: `${state.head}\trefs/heads/feature/x\n`, stderr: '' };
      },
    });
    const result = await op({ repoRoot: repo.root });
    expect(result.status).toBe('failed');
    if (result.status === 'failed')
      expect(result.error).toBe(
        'dev.cycle (dev.check (final)): dev.check: the addressed head broke format:check',
      );
    expect(pushCalls).toBe(0);
    expect(opens).toEqual([]);
  });

  test('S7 H (D2): one run deadline — the review and address legs get the remaining wall minus the publication reserve', async () => {
    await repo.write(
      'cq.json',
      JSON.stringify({
        schemaVersion: 2,
        checks: [{ adapter: 'tsc-lines', command: { command: 'tsc', args: [] } }],
        roles: { reviewer: { provider: 'mock', model: 'mock' } },
        budgets: { run: { maxTokens: 1000, wallMs: 3_600_000 } },
        review: { reviewers: ['coderabbit'] },
      }),
    );
    repo.commitAll('budgeted cq.json');
    const state = await seed(repo);
    await seedReadyLedger(state);
    // Controlled clock: the test asserts an exact 50 ms transfer between the
    // legs, so the review leg advances a stubbed Date.now by exactly 50 ms
    // instead of sleeping a real 50 ms (a real timer races the same-ms
    // boundary: a 49 ms Date.now delta makes the asserted invariant off by
    // one). Same stub-and-restore pattern as the #532 deadline test above;
    // no production code changes.
    const originalNow = Date.now;
    let clock = originalNow();
    const reviewInputs: ReviewRunInput[] = [];
    const addressInputs: ReviewAddressInput[] = [];
    const review = cleanReview(state);
    const op = makeDevCycle({
      effects: effects(),
      check: greenCheck(),
      review: async (input) => {
        reviewInputs.push(input);
        // The review leg spends exactly 50 ms of the shared run wall.
        clock += 50;
        return review(input);
      },
      address: async (input) => {
        addressInputs.push(input);
        return { status: 'ok', value: addressReport(state, [], []) };
      },
      open: openFake([]),
      git: async () => ({ code: 0, stdout: `${state.head}\trefs/heads/feature/x\n`, stderr: '' }),
    });
    let result: Awaited<ReturnType<typeof op>>;
    try {
      Date.now = () => clock;
      result = await op({ repoRoot: repo.root });
    } finally {
      Date.now = originalNow;
    }
    // Pin the cycle outcome before the budget assertions: if a leg refuses
    // (failed gate, review failure), fail on the actual status/reason —
    // serialized into the message — instead of undefined comparisons
    // against leg inputs that were never recorded.
    expect(result.status, JSON.stringify(result)).toBe('ok');
    if (result.status === 'ok') expect(result.value.pushed).toBe(true);
    const budget = 3_600_000 - DEV_CYCLE_PUBLICATION_RESERVE_MS;
    expect(reviewInputs[0]?.wallMs).toBeLessThanOrEqual(budget);
    expect(reviewInputs[0]?.wallMs).toBeGreaterThan(budget - 10_000);
    expect(reviewInputs[0]?.maxTokens).toBe(1000);
    // The address leg gets what the review leg left, not a fresh run budget.
    // The controlled clock makes the 50 ms transfer exact: the address wall
    // is the review wall minus exactly 50 (not shrunk further, e.g. by
    // subtracting the publication reserve a second time), and no scheduling
    // slop bound is needed.
    expect(addressInputs[0]?.wallMs).toBe((reviewInputs[0]?.wallMs ?? 0) - 50);
    expect(addressInputs[0]?.maxTokens).toBe(1000);
  });

  test("S7 H (D2): tokens the review leg spent through the cycle's drivers are gone from the address leg's budget", async () => {
    const scanner = await stubM7Scanner();
    try {
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
      await repo.write('src/a.ts', 'export const a = 1;\n');
      repo.commitAll('budgeted review fixture');
      await seed(repo);
      const addressInputs: ReviewAddressInput[] = [];
      // The session engine's delivery evidence is the request hook carrying
      // the exact prompt, so the fake calls it the way the ai-sdk lane does.
      const drivers = {
        resolve: (request: DriverRequest) => ({
          lane: 'ai-sdk',
          modelSpec: { provider: 'mock', model: 'mock' },
          driver: {
            run: async (invocation: { prompt: string }) => {
              await request.beforeRequest?.(
                JSON.stringify({
                  prompt: [{ role: 'user', content: [{ type: 'text', text: invocation.prompt }] }],
                }),
                [{ text: invocation.prompt }],
                { kind: 'model-request' },
              );
              return {
                stopReason: 'complete' as const,
                structuredOutput: { findings: [] },
                usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
                steps: 1,
                denials: [],
              };
            },
          },
        }),
      } as unknown as DriverFactory;
      const op = makeDevCycle({
        effects: effects(),
        check: greenCheck(),
        drivers,
        address: async (input) => {
          addressInputs.push(input);
          return { status: 'failed', error: 'stop after the address input is observed' };
        },
        open: openFake([]),
      });
      await op({ repoRoot: repo.root });
      expect(addressInputs).toHaveLength(1);
      // One reviewer request per session, 150 tokens each.
      const spent = 10_000 - (addressInputs[0]?.maxTokens ?? 10_000);
      expect(spent).toBeGreaterThanOrEqual(150);
      expect(spent % 150).toBe(0);
    } finally {
      vi.unstubAllEnvs();
      await scanner();
    }
  });

  test('S7 H (D2): a short run budget keeps a proportional reserve (a quarter) so the legs still get time', async () => {
    await repo.write(
      'cq.json',
      JSON.stringify({
        schemaVersion: 2,
        checks: [{ adapter: 'tsc-lines', command: { command: 'tsc', args: [] } }],
        roles: { reviewer: { provider: 'mock', model: 'mock' } },
        budgets: { run: { maxTokens: 1000, wallMs: 20_000 } },
        review: { reviewers: ['agent'] },
      }),
    );
    repo.commitAll('short budget');
    await seed(repo);
    const reviewInputs: ReviewRunInput[] = [];
    const op = makeDevCycle({
      effects: effects(),
      check: greenCheck(),
      review: async (input) => {
        reviewInputs.push(input);
        return { status: 'failed', error: 'stop here' };
      },
      open: openFake([]),
    });
    await op({ repoRoot: repo.root });
    expect(reviewInputs[0]?.wallMs).toBeLessThanOrEqual(15_000);
    expect(reviewInputs[0]?.wallMs).toBeGreaterThan(10_000);
  });
});
