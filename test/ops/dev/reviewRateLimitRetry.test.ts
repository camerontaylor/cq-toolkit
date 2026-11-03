import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { makeDevReview } from '../../../src/ops/dev/review.js';
import { stubScanner } from './fakes.js';
import { ran, reviewer, reviewerCalls } from './reviewTestKit.js';
import { makeTestRepo, repoEffects, type TestRepo } from './repo.js';

let repo: TestRepo;
beforeEach(async () => {
  repo = await makeTestRepo();
});
afterEach(async () => {
  await repo.cleanup();
});
describe('CodeRabbit bounded rate-limit retry (#551)', () => {
  const rateLimited = (waitTime = '2 seconds') =>
    ran(
      1,
      JSON.stringify({
        type: 'error',
        errorType: 'rate_limit',
        recoverable: true,
        metadata: { waitTime },
      }),
    );

  test('waits once, re-scans, retries and records both attempts in one cycle', async () => {
    let calls = 0;
    const effects = repoEffects(
      repo,
      reviewer(() => (++calls === 1 ? rateLimited() : ran(0))),
    );
    const scanner = vi.fn(stubScanner());
    const sleep = vi.fn(async () => undefined);
    const result = await makeDevReview({
      effects,
      scanSecrets: scanner,
      sleep,
      remainingWallMs: () => 60_000,
    })({ repoRoot: repo.root });
    expect(result.status).toBe('ok');
    expect(calls).toBe(2);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(17_000, undefined);
    expect(scanner).toHaveBeenCalledTimes(2);
    expect(effects.logs.join(' ')).toContain('retry 1');
    expect(effects.logs.join(' ')).toContain('rate_limit');
    expect(effects.openLedger('feature/x').load().records).toHaveLength(1);
  });

  test('the retry shares the first dispatch timeout, including run and backoff time', async () => {
    let now = 1_000;
    let calls = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const effects = repoEffects(
        repo,
        reviewer(() => {
          if (++calls === 1) {
            now += 10_000;
            return rateLimited();
          }
          return ran(0);
        }),
      );
      const run = effects.runCommand;
      const timeouts: number[] = [];
      effects.runCommand = async (command, args, opts) => {
        if (command === 'coderabbit') timeouts.push(opts.timeoutMs);
        return run(command, args, opts);
      };
      const result = await makeDevReview({
        effects,
        scanSecrets: stubScanner(),
        sleep: async (ms) => {
          now += ms;
        },
        remainingWallMs: () => 60_000,
      })({ repoRoot: repo.root });
      expect(result.status).toBe('ok');
      expect(timeouts).toEqual([60_000, 33_000]);
    } finally {
      clock.mockRestore();
    }
  });

  test('a newly flagged retry scan prevents a second upload', async () => {
    const effects = repoEffects(repo, reviewer(rateLimited()));
    let scans = 0;
    const result = await makeDevReview({
      effects,
      scanSecrets: async (components) =>
        components.map((component) => ({
          component: component.component,
          hits: ++scans > 1 ? [{ ruleId: 'deny', lines: [1] }] : [],
        })),
      sleep: async () => undefined,
      remainingWallMs: () => 60_000,
    })({ repoRoot: repo.root });
    expect(result.status).toBe('needs-human');
    expect(result).toMatchObject({ reason: expect.stringContaining('secret scan') as unknown });
    expect(reviewerCalls(effects)).toHaveLength(1);
    expect(effects.openLedger('feature/x').load().records).toHaveLength(0);
  });

  test.each([
    ['wall', '10 minutes', 1000],
    ['reviewer timeout', '30 minutes', 3_600_000],
  ] as const)('blocks immediately if wait exceeds %s', async (_mode, waitTime, wall) => {
    const effects = repoEffects(repo, reviewer(rateLimited(waitTime)));
    const sleep = vi.fn(async () => undefined);
    const result = await makeDevReview({
      effects,
      scanSecrets: stubScanner(),
      sleep,
      remainingWallMs: () => wall,
    })({ repoRoot: repo.root });
    expect(result.status).toBe('needs-human');
    expect(result).toMatchObject({ reason: expect.stringContaining(waitTime) as unknown });
    expect(reviewerCalls(effects)).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(result).not.toMatchObject({ report: { budgetStopped: true } });
  });

  test('a second rate limit blocks after exactly one retry', async () => {
    const effects = repoEffects(repo, reviewer(rateLimited()));
    const sleep = vi.fn(async () => undefined);
    const result = await makeDevReview({
      effects,
      scanSecrets: stubScanner(),
      sleep,
      remainingWallMs: () => 60_000,
    })({ repoRoot: repo.root });
    expect(result.status).toBe('needs-human');
    expect(result).toMatchObject({ reason: expect.stringContaining('2 seconds') as unknown });
    expect(reviewerCalls(effects)).toHaveLength(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  test.each([
    { errorType: 'auth', recoverable: true, metadata: { waitTime: '2 seconds' } },
    { errorType: 'rate_limit', recoverable: false, metadata: { waitTime: '2 seconds' } },
    { errorType: 'rate_limit', recoverable: true, metadata: {} },
    { errorType: 'billing', recoverable: false },
  ])('other refusals never retry: %j', async (event) => {
    const effects = repoEffects(
      repo,
      reviewer(ran(1, JSON.stringify({ type: 'error', ...event }))),
    );
    const sleep = vi.fn(async () => undefined);
    const result = await makeDevReview({
      effects,
      scanSecrets: stubScanner(),
      sleep,
      remainingWallMs: () => 60_000,
    })({ repoRoot: repo.root });
    expect(result.status).toBe('needs-human');
    expect(reviewerCalls(effects)).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  test('drift during backoff refuses the retry upload', async () => {
    const effects = repoEffects(repo, reviewer(rateLimited()));
    const result = await makeDevReview({
      effects,
      scanSecrets: stubScanner(),
      sleep: async () => {
        await repo.write('src/a.ts', 'changed during wait');
      },
      remainingWallMs: () => 60_000,
    })({ repoRoot: repo.root });
    expect(result.status).toBe('needs-human');
    expect(result).toMatchObject({ reason: expect.stringContaining('stable tree') as unknown });
    expect(reviewerCalls(effects)).toHaveLength(1);
    expect(effects.openLedger('feature/x').load().records).toHaveLength(0);
  });

  test('cancellation during backoff keeps the refusal and prevents a retry', async () => {
    const controller = new AbortController();
    const effects = repoEffects(repo, reviewer(rateLimited()));
    const result = await makeDevReview({
      effects,
      scanSecrets: stubScanner(),
      signal: controller.signal,
      sleep: async (_ms, signal) => {
        controller.abort(new Error('cancelled during backoff'));
        signal?.throwIfAborted();
      },
      remainingWallMs: () => 60_000,
    })({ repoRoot: repo.root });
    expect(result.status).toBe('needs-human');
    expect(reviewerCalls(effects)).toHaveLength(1);
    expect(effects.logs.join(' ')).toContain('rate_limit');
    expect(result).not.toMatchObject({ report: { budgetStopped: true } });
  });
});
