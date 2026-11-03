import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { DevCycleInput } from '../../../src/ops/dev/review.js';
import { makeFakeEffects, stubScanner } from './fakes.js';
import { capturingScanner, cycleReview, ran, reviewer, reviewerCalls } from './reviewTestKit.js';
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
    const effects = repoEffects(repo, reviewer(ran(0)));
    const result = await cycleReview(effects, stubScanner())({ repoRoot: repo.root });
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
    expect(reviewerCalls(effects)[0]?.args).toEqual(['review', '--agent', '--base-commit', base]);
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
    )({ repoRoot: repo.root, base: base.slice(0, 10) });
    expect(ok.status === 'ok' && ok.value.base).toBe(base);

    const missing = repoEffects(repo, reviewer(ran(0)));
    const result = await cycleReview(
      missing,
      stubScanner(),
    )({ repoRoot: repo.root, base: 'deadbeef' });
    expect(result.status).toBe('needs-human');
    expect(reviewerCalls(missing)).toEqual([]);
  });

  test.each([
    ['a non-zero exit', ran(2), 'exited 2'],
    ['a malformed stream', ran(0, 'garbage\n'), 'MALFORMED'],
    ['a timeout', ran(null, '', { timedOut: true }), 'timed out'],
  ])(
    '%s is a BLOCKED cycle: recorded with the reason, never ok',
    async (_label, outcome, reason) => {
      const effects = repoEffects(repo, reviewer(outcome));
      const result = await cycleReview(effects, stubScanner())({ repoRoot: repo.root });
      expect(result.status).toBe('needs-human');
      if (result.status === 'needs-human') expect(result.reason).toContain(reason);
      const [cycle] = effects.openLedger('feature/x').load().records;
      expect(cycle?.kind === 'cycle' && cycle.completion.kind).toBe('blocked');
    },
  );

  test('a TIMED-OUT run is blocked but keeps the findings it emitted before the kill', async () => {
    const partial = `${JSON.stringify({ type: 'finding', severity: 'critical', comment: 'early' })}\n`;
    const effects = repoEffects(repo, reviewer(ran(null, partial, { timedOut: true })));
    const result = await cycleReview(effects, stubScanner())({ repoRoot: repo.root });
    expect(result.status).toBe('needs-human');
    const [cycle] = effects.openLedger('feature/x').load().records;
    expect(cycle?.kind === 'cycle' && cycle.findings.map((f) => f.severity)).toEqual(['critical']);
  });

  test('a reviewer spawn fault is a blocked cycle naming the fault, not a crash', async () => {
    const effects = repoEffects(repo, (command) => {
      if (command === 'coderabbit') throw new Error('coderabbit could not be spawned — ENOENT');
      return undefined;
    });
    const result = await cycleReview(effects, stubScanner())({ repoRoot: repo.root });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') expect(result.reason).toContain('ENOENT');
  });

  test('drift DURING the run refuses the cycle and records nothing', async () => {
    const effects = repoEffects(
      repo,
      reviewer(async () => {
        await repo.write('src/a.ts', 'export const a = 99;\n');
        return ran(0);
      }),
    );
    const result = await cycleReview(effects, stubScanner())({ repoRoot: repo.root });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') expect(result.reason).toContain('during the review run');
    expect(effects.openLedger('feature/x').load().records).toEqual([]);
  });

  test('the uncommitted scope reads no committed leg and passes --uncommitted', async () => {
    await repo.write('README.md', '# edited\n');
    const scanner = capturingScanner();
    const effects = repoEffects(repo, reviewer(ran(0)));
    const result = await cycleReview(effects, scanner)({ repoRoot: repo.root, uncommitted: true });
    expect(result.status === 'ok' && result.value.scope).toBe('uncommitted');
    expect(scanner.seen.map((c) => c.component)).toEqual(['unstaged:README.md']);
    expect(reviewerCalls(effects)[0]?.args.at(-1)).toBe('--uncommitted');
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
