import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { makeSubprocessDevEffects } from '../../../src/ops/dev/effects.js';
import { cycleRecord, stubScanner } from './fakes.js';
import { cycleReview, ran, reviewer, reviewerCalls } from './reviewTestKit.js';
import { makeTestRepo, repoEffects, seed, type TestRepo } from './repo.js';

let repo: TestRepo;
beforeEach(async () => {
  repo = await makeTestRepo();
});
afterEach(async () => {
  await repo.cleanup();
});

describe('dev.review cycle', () => {
  // --- Q4 (#485): exact-terminal reuse before vendor dispatch --------------

  test('rate limits remain blocked without creating vendor-deferral authority', async () => {
    const effects = repoEffects(
      repo,
      reviewer(
        ran(
          1,
          JSON.stringify({
            type: 'error',
            errorType: 'rate_limit',
            recoverable: true,
          }),
        ),
      ),
    );
    expect((await cycleReview(effects, stubScanner())({ repoRoot: repo.root })).status).toBe(
      'needs-human',
    );
    expect(
      effects
        .openLedger('feature/x')
        .load()
        .records.find((entry) => entry.kind === 'cycle'),
    ).toMatchObject({
      completion: { kind: 'blocked' },
    });
    const record = effects
      .openLedger('feature/x')
      .load()
      .records.find((entry) => entry.kind === 'cycle');
    expect(record?.kind === 'cycle' ? record.vendorFailure : undefined).toBeUndefined();
  });
  const literalVendor = { type: 'error', errorType: 'rate_limit', recoverable: true };
  const scanWithVendorProse = {
    type: 'error',
    errorType: 'scan',
    message: 'Review failed: con_err: fixture',
  };
  test.each([
    [scanWithVendorProse],
    [literalVendor, scanWithVendorProse],
    [scanWithVendorProse, literalVendor],
    [{ type: 'error', errorType: 'unknown', message: 'Review failed: rate_limited: fixture' }],
    [{ type: 'error', errorType: 'rate_limit', recoverable: false }],
    [literalVendor, { type: 'status', status: 'budget_exhausted' }],
    [literalVendor, { type: 'status', status: 'cancelled' }],
    [literalVendor, { type: 'finding', severity: 'major', comment: 'defect' }],

    [
      { type: 'error', message: 'Review failed: con_err: fixture' },
      { type: 'error', message: 'Review failed: scan_err: fixture' },
    ],
    [{ type: 'error', message: 'please login again' }],
    [{ type: 'error', message: 'Review failed: auth: fixture' }, { type: 'action_required' }],
    [
      { type: 'error', message: 'Review failed: auth: fixture' },
      { type: 'complete', status: 'review_skipped' },
    ],
  ])(
    'mixed/unknown vendor stream keeps the blocker without outage authority: %j',
    async (...events) => {
      const effects = repoEffects(
        repo,
        reviewer(ran(1, events.map((event) => JSON.stringify(event)).join('\n'))),
      );
      expect((await cycleReview(effects, stubScanner())({ repoRoot: repo.root })).status).toBe(
        'needs-human',
      );
      const cycle = effects
        .openLedger('feature/x')
        .load()
        .records.find((entry) => entry.kind === 'cycle');
      expect(cycle?.kind === 'cycle' ? cycle.vendorFailure : undefined).toBeUndefined();
    },
  );

  const NO_FRESH_REASON =
    "reviewer completed 'review_completed' with an AFFIRMATIVE no-fresh/skipped notice " +
    '("No fresh detailed file review was performed in this run.") — a fresh detailed review never ran';

  test.each([false, true])('fresh cycles survive hash failure=%s', async (fails) => {
    const effects = repoEffects(repo, reviewer(ran(0)));
    effects.reviewLogSha256 = async () => {
      if (fails) throw new Error('log temporarily unreadable');
      return 'a'.repeat(64);
    };
    const result = await cycleReview(effects, stubScanner())({ repoRoot: repo.root });
    expect(result.status).toBe('ok');
    const cycle = effects
      .openLedger('feature/x')
      .load()
      .records.find((r) => r.kind === 'cycle');
    expect(cycle?.completion.kind).toBe('terminal');
    expect(cycle?.logSha256).toBe(fails ? undefined : 'a'.repeat(64));
  });

  test('legacy cycles without a digest still validate readability before reuse', async () => {
    await seed(repo);
    const effects = repoEffects(repo);
    await effects.openLedger('feature/x').mutate((ledger) => ({
      ledger: {
        ...ledger,
        records: ledger.records.map((record) => {
          if (record.kind !== 'cycle') return record;
          const { logSha256: _digest, ...legacy } = record;
          return legacy;
        }),
      },
      value: undefined,
    }));
    let reads = 0;
    effects.reviewLogSha256 = async () => {
      reads += 1;
      return 'a'.repeat(64);
    };
    const result = await cycleReview(effects, stubScanner())({ repoRoot: repo.root });
    expect(result.status).toBe('ok');
    expect(reads).toBe(1);
    expect(reviewerCalls(effects)).toHaveLength(0);
    if (result.status === 'ok') expect(result.value.reuse?.basis).toBe('exact-terminal');
  });

  test('current scan policy refuses reuse of a previously allowed cycle', async () => {
    await seed(repo);
    const effects = repoEffects(repo);
    const result = await cycleReview(effects, async (components) =>
      components.map(({ component }) => ({
        component,
        hits: [{ ruleId: 'new-policy-rule', lines: [1] }],
      })),
    )({ repoRoot: repo.root });
    expect(result.status).toBe('needs-human');
    expect(reviewerCalls(effects)).toHaveLength(0);
    expect(
      effects
        .openLedger('feature/x')
        .load()
        .records.some((r) => r.kind === 'reuse'),
    ).toBe(false);
  });

  test.each(['missing', 'unreadable', 'unavailable', 'altered'])(
    'retained %s log does not reuse',
    async (fault) => {
      await seed(repo);
      let vendorCalls = 0;
      const effects = repoEffects(repo, (command) => {
        if (command === 'coderabbit') vendorCalls += 1;
        return reviewer(ran(0))(command, []);
      });
      if (fault === 'missing') {
        const path = join(dirname(repo.root), 'retained-review.log');
        await writeFile(path, 'retained review');
        await effects.openLedger('feature/x').mutate((ledger) => ({
          ledger: {
            ...ledger,
            records: ledger.records.map((record) =>
              record.kind === 'cycle' ? { ...record, logPath: path } : record,
            ),
          },
          value: undefined,
        }));
        await unlink(path);
        effects.reviewLogSha256 = makeSubprocessDevEffects(repo.root).reviewLogSha256!;
      } else if (fault === 'unreadable')
        effects.reviewLogSha256 = async () => {
          throw new Error('unreadable log');
        };
      else if (fault === 'unavailable') delete effects.reviewLogSha256;
      else {
        await effects.openLedger('feature/x').mutate((ledger) => ({
          ledger: {
            ...ledger,
            records: ledger.records.map((record) =>
              record.kind === 'cycle' ? { ...record, logSha256: 'b'.repeat(64) } : record,
            ),
          },
          value: undefined,
        }));
      }
      const result = await cycleReview(effects, stubScanner())({ repoRoot: repo.root });
      expect(result.status).toBe(fault === 'altered' ? 'needs-human' : 'ok');
      expect(vendorCalls).toBe(fault === 'altered' ? 0 : 1);
      expect(
        effects
          .openLedger('feature/x')
          .load()
          .records.some((r) => r.kind === 'reuse'),
      ).toBe(false);
    },
  );

  test('an unchanged rerun over an exact terminal record makes ZERO vendor calls and returns reuse evidence', async () => {
    const state = await seed(repo);
    // The reuse id derives the head8 of the CURRENT HEAD (review.ts).
    const reuseId = `r001-${state.head.slice(0, 8)}`;
    let coderabbitRuns = 0;
    const effects = repoEffects(repo, (command) => {
      if (command === 'coderabbit') coderabbitRuns += 1;
      return reviewer(ran(0))(command, []);
    });
    const result = await cycleReview(effects, stubScanner())({ repoRoot: repo.root });
    expect(result.status).toBe('ok');
    expect(coderabbitRuns).toBe(0);
    if (result.status !== 'ok') return;
    expect(result.value.reuse).toMatchObject({
      reuseId,
      basis: 'exact-terminal',
    });
    expect(result.value.cycleId).toBe('c001-aaaaaaaa');
    expect(result.value.base).toBe(state.base);
    expect(result.value.head).toBe(state.head);
    expect(result.value.completion).toEqual({ kind: 'terminal' });
    const ledger = effects.openLedger('feature/x').load();
    // APPEND-ONLY: the terminal cycle and the green check are intact, and
    // exactly one reuse record was added. No new cycle was appended.
    expect(ledger.records.filter((r) => r.kind === 'cycle')).toHaveLength(1);
    expect(ledger.records.filter((r) => r.kind === 'check')).toHaveLength(1);
    const reuse = ledger.records.find((r) => r.kind === 'reuse');
    expect(reuse).toMatchObject({
      kind: 'reuse',
      reuseId,
      cycleId: 'c001-aaaaaaaa',
      basis: 'exact-terminal',
      base: state.base,
      head: state.head,
      reviewer: 'coderabbit',
      scope: 'full',
    });
    expect(effects.logs.at(-1)).toContain('# dev.review reuse log');
  });

  test('a same-identity no-fresh BLOCKED tail is explicitly resolved by reuse; the tail stays verbatim', async () => {
    const state = await seed(repo, (current) => [
      cycleRecord({
        cycleId: 'c002-bbbbbbbb',
        completion: { kind: 'blocked', reason: NO_FRESH_REASON },
        base: current.base,
        head: current.head,
        dirtySha256: current.dirtySha256,
      }),
    ]);
    // The reuse id derives the head8 of the CURRENT HEAD (review.ts).
    const reuseId = `r001-${state.head.slice(0, 8)}`;
    const effects = repoEffects(repo, reviewer(ran(0)));
    const result = await cycleReview(effects, stubScanner())({ repoRoot: repo.root });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value.reuse).toMatchObject({
      basis: 'no-fresh-tail',
      resolvesCycleId: 'c002-bbbbbbbb',
    });
    const ledger = effects.openLedger('feature/x').load();
    const tail = ledger.records.find((r) => r.kind === 'cycle' && r.cycleId === 'c002-bbbbbbbb');
    // The blocked tail is NOT overwritten, deleted, or relabeled.
    expect(tail).toMatchObject({
      kind: 'cycle',
      completion: { kind: 'blocked', reason: NO_FRESH_REASON },
    });
    const reuse = ledger.records.find((r) => r.kind === 'reuse');
    expect(reuse).toMatchObject({
      reuseId,
      cycleId: 'c001-aaaaaaaa',
      basis: 'no-fresh-tail',
      resolvesCycleId: 'c002-bbbbbbbb',
      base: state.base,
    });
    expect(effects.logs.at(-1)).toContain('resolves blocked attempt: c002-bbbbbbbb');
  });

  test('a genuine later blocker (CLI error tail) refuses reuse and dispatches a fresh cycle', async () => {
    await seed(repo, (current) => [
      cycleRecord({
        cycleId: 'c002-bbbbbbbb',
        completion: { kind: 'blocked', reason: 'reviewer stream carried an error event' },
        base: current.base,
        head: current.head,
        dirtySha256: current.dirtySha256,
      }),
    ]);
    let coderabbitRuns = 0;
    const effects = repoEffects(repo, (command) => {
      if (command === 'coderabbit') coderabbitRuns += 1;
      return reviewer(ran(0))(command, []);
    });
    const result = await cycleReview(effects, stubScanner())({ repoRoot: repo.root });
    expect(result.status).toBe('ok');
    expect(coderabbitRuns).toBe(1);
    if (result.status === 'ok') expect(result.value.reuse).toBeUndefined();
    const ledger = effects.openLedger('feature/x').load();
    expect(ledger.records.some((r) => r.kind === 'reuse')).toBe(false);
    expect(ledger.records.filter((r) => r.kind === 'cycle')).toHaveLength(3);
  });

  test('a changed identity (new commit) never reuses and dispatches a fresh cycle', async () => {
    await seed(repo);
    await repo.write('src/a.ts', 'export const a = 2;\n');
    repo.commitAll('more work');
    let coderabbitRuns = 0;
    const effects = repoEffects(repo, (command) => {
      if (command === 'coderabbit') coderabbitRuns += 1;
      return reviewer(ran(0))(command, []);
    });
    const result = await cycleReview(effects, stubScanner())({ repoRoot: repo.root });
    expect(result.status).toBe('ok');
    expect(coderabbitRuns).toBe(1);
    if (result.status === 'ok') expect(result.value.reuse).toBeUndefined();
  });

  test('a reuse record-store fault refuses honestly and never dispatches the vendor', async () => {
    await seed(repo);
    const effects = repoEffects(repo, undefined, {
      openLedger: () => {
        throw new Error('dev-record: ledger unreadable');
      },
    });
    const result = await cycleReview(effects, stubScanner())({ repoRoot: repo.root });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') {
      expect(result.reason).toContain('reuse check could not complete');
      expect(result.reason).toContain('ledger unreadable');
    }
    expect(reviewerCalls(effects)).toEqual([]);
  });

  test('drift while the reuse ledger is read refuses before any vendor call or append', async () => {
    await seed(repo);
    // The tree changes while the reuse selection holds the host lock: the
    // in-lock re-read must see it and refuse before the vendor (which this
    // fixture makes fatal) or any append can happen.
    const effects = repoEffects(
      repo,
      reviewer(() => {
        throw new Error('fixture: the vendor must never run on a reuse path');
      }),
      {
        withHostLock: async (fn) => {
          await repo.write('src/a.ts', 'export const a = 3;\n');
          return fn();
        },
      },
    );
    const result = await cycleReview(effects, stubScanner())({ repoRoot: repo.root });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human')
      expect(result.reason).toContain('while the reuse ledger was read');
    const ledger = effects.openLedger('feature/x').load();
    expect(ledger.records.some((r) => r.kind === 'reuse')).toBe(false);
    expect(reviewerCalls(effects)).toEqual([]);
  });

  test('a reuse selection preserves the source cycle findings verbatim in the report', async () => {
    await seed(repo);
    const effects = repoEffects(repo);
    const ledgerStore = effects.openLedger('feature/x');
    const ledger = ledgerStore.load();
    ledgerStore.save({
      ...ledger,
      records: ledger.records.map((record) =>
        record.kind === 'cycle'
          ? {
              ...record,
              findings: [
                {
                  id: 'c001-aaaaaaaa#f1',
                  severity: 'major',
                  fileName: 'src/a.ts',
                  excerpt: 'handle the null case',
                },
              ],
            }
          : record,
      ),
    });
    const result = await cycleReview(effects, stubScanner())({ repoRoot: repo.root });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.value.findings).toEqual([
        {
          id: 'c001-aaaaaaaa#f1',
          severity: 'major',
          fileName: 'src/a.ts',
          excerpt: 'handle the null case',
        },
      ]);
    }
  });
});
