import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { DevCycleInput } from '../../../src/ops/dev/review.js';
import type { ManagedReviewSubmit } from '../../../src/ops/dev/managedReview.js';
import { makeFakeEffects, stubScanner } from './fakes.js';
import {
  capturingScanner,
  cycleReview,
  managedBlocked,
  managedRefused,
  managedTerminal,
  ran,
  reviewer,
  reviewerCalls,
} from './reviewTestKit.js';
import { makeTestRepo, repoEffects, type TestRepo } from './repo.js';

let repo: TestRepo;
beforeEach(async () => {
  repo = await makeTestRepo();
});
afterEach(async () => {
  await repo.cleanup();
});

describe('dev.review cycle', () => {
  test('a terminal cycle: ok report with completion, pinned base, recorded ids and log', async () => {
    // S2b-i: the coderabbit path rides the managed queue leg — no CLI spawn.
    const effects = repoEffects(repo, reviewer(ran(0)));
    const result = await cycleReview(
      effects,
      stubScanner(),
      undefined,
      managedTerminal(),
    )({
      repoRoot: repo.root,
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    const base = repo.git('rev-parse', 'origin/main').trim();
    const head = repo.git('rev-parse', 'HEAD').trim();
    expect(result.value).toMatchObject({
      reviewer: 'coderabbit',
      scope: 'full',
      target: 'main',
      base,
      head,
      dirtySha256: 'clean-tree',
      completion: { kind: 'terminal' },
    });
    expect(result.value.cycleId).toBe(`c001-${head.slice(0, 8)}`);
    expect(result.value.findings.map((f) => [f.id, f.severity])).toEqual([
      [`c001-${head.slice(0, 8)}#f1`, 'major'],
      [`c001-${head.slice(0, 8)}#f2`, 'minor'],
    ]);
    expect(reviewerCalls(effects)).toEqual([]);
    expect(effects.logs[0]).toContain(`base: ${base}`);
    const ledger = effects.openLedger('feature/x').load();
    expect(ledger.records.map((r) => r.kind)).toEqual(['cycle']);
  });

  test('an explicit base resolves once; an unresolvable one is needs-human with no run', async () => {
    const base = repo.git('rev-parse', 'HEAD~1').trim();
    const pinned = repoEffects(repo, reviewer(ran(0)));
    const ok = await cycleReview(
      pinned,
      stubScanner(),
      undefined,
      managedTerminal(),
    )({ repoRoot: repo.root, base: base.slice(0, 10) });
    expect(ok.status === 'ok' && ok.value.base).toBe(base);

    const missing = repoEffects(repo, reviewer(ran(0)));
    const result = await cycleReview(
      missing,
      stubScanner(),
      undefined,
      managedTerminal(),
    )({ repoRoot: repo.root, base: 'deadbeef' });
    expect(result.status).toBe('needs-human');
    expect(reviewerCalls(missing)).toEqual([]);
  });

  test.each([
    ['a refused queue submit', managedRefused('submit — refused'), 'refused', false],
    [
      'a blocked queue receipt',
      managedBlocked('the queue returned no verdict'),
      'no verdict',
      true,
    ],
    [
      'an indeterminate queue delivery',
      managedRefused('status — delivery unknown', true),
      'delivery unknown',
      false,
    ],
  ] as const)(
    '%s is needs-human with the reason, never ok',
    async (_label, submit, reason, recorded) => {
      const effects = repoEffects(repo, reviewer(ran(0)));
      const result = await cycleReview(
        effects,
        stubScanner(),
        undefined,
        submit,
      )({
        repoRoot: repo.root,
      });
      expect(result.status).toBe('needs-human');
      if (result.status === 'needs-human') expect(result.reason).toContain(reason);
      // Only a completed queue receipt records a (blocked) cycle; a refused
      // submit stops before the record, like the CLI path's pre-run refusals.
      const [cycle] = effects.openLedger('feature/x').load().records;
      if (recorded) expect(cycle?.kind === 'cycle' && cycle.completion.kind).toBe('blocked');
      else expect(cycle).toBeUndefined();
    },
  );

  test('a blocked queue receipt keeps its findings in the recorded cycle', async () => {
    const effects = repoEffects(repo, reviewer(ran(0)));
    const result = await cycleReview(
      effects,
      stubScanner(),
      undefined,
      managedBlocked('the queue returned no countable verdict', [
        { severity: 'critical', excerpt: 'early' },
      ]),
    )({ repoRoot: repo.root });
    expect(result.status).toBe('needs-human');
    const [cycle] = effects.openLedger('feature/x').load().records;
    expect(cycle?.kind === 'cycle' && cycle.findings.map((f) => f.severity)).toEqual(['critical']);
  });

  test('a queue submit fault is needs-human naming the fault, not a crash', async () => {
    const effects = repoEffects(repo, reviewer(ran(0)));
    const result = await cycleReview(
      effects,
      stubScanner(),
      undefined,
      managedRefused('the managed review submission could not run — ENOENT'),
    )({ repoRoot: repo.root });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') expect(result.reason).toContain('ENOENT');
  });

  test('drift DURING the managed run refuses the cycle and records nothing', async () => {
    const effects = repoEffects(repo, reviewer(ran(0)));
    const submit: ManagedReviewSubmit = (async (input) => {
      await repo.write('src/a.ts', 'export const a = 99;\n');
      return managedTerminal()(input);
    }) as ManagedReviewSubmit;
    const result = await cycleReview(
      effects,
      stubScanner(),
      undefined,
      submit,
    )({
      repoRoot: repo.root,
    });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human')
      expect(result.reason).toContain('during the managed review run');
    expect(effects.openLedger('feature/x').load().records).toEqual([]);
  });

  test('a dirty tree refuses the managed submit before any queue work', async () => {
    // S2b-i: the queue attests committed objects only, so the uncommitted
    // scope (a dirty tree by definition) is refused — never over-claimed.
    await repo.write('README.md', '# edited\n');
    const scanner = capturingScanner();
    const effects = repoEffects(repo, reviewer(ran(0)));
    const result = await cycleReview(
      effects,
      scanner,
      undefined,
      managedTerminal(),
    )({
      repoRoot: repo.root,
      uncommitted: true,
    });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') expect(result.reason).toContain('uncommitted changes');
    // The secret scan still ran first and saw only the unstaged component.
    expect(scanner.seen.map((c) => c.component)).toEqual(['unstaged:README.md']);
    expect(reviewerCalls(effects)).toEqual([]);
  });

  test('an empty scope is needs-human before the scan or the run', async () => {
    const effects = repoEffects(repo, reviewer(ran(0)));
    const result = await cycleReview(
      effects,
      stubScanner(),
    )({ repoRoot: repo.root, uncommitted: true });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') expect(result.reason).toContain('no diff to review');
    expect(reviewerCalls(effects)).toEqual([]);
  });

  test('an agent reviewer is refused when the configured agent runner is unavailable', async () => {
    const effects = repoEffects(repo, reviewer(ran(0)));
    const result = await cycleReview(
      effects,
      stubScanner(),
    )({
      repoRoot: repo.root,
      reviewer: 'agent:some/model',
    });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human')
      expect(result.reason).toContain('agent reviewer is unavailable');
    expect(effects.calls).toEqual([]);
  });

  test.each([
    [{ repoRoot: '/repo', reviewer: 1 }],
    [{ repoRoot: '/repo', reviewer: 'gpt' }],
    [{ repoRoot: '' }],
    [{ repoRoot: '/repo', action: 'bogus' }],
  ])('a schema-bypassing input %j is a failed result before any effect', async (input) => {
    const effects = makeFakeEffects();
    const result = await cycleReview(effects, stubScanner())(input as unknown as DevCycleInput);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error).toContain('dev.review: invalid input');
    expect(effects.commands).toEqual([]);
  });

  test('a null input is failed, never a TypeError', async () => {
    const result = await cycleReview(
      makeFakeEffects(),
      stubScanner(),
    )(null as unknown as DevCycleInput);
    expect(result.status).toBe('failed');
  });
});
