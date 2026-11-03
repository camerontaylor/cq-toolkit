import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { relative } from 'node:path';
import { followUpCommand, makeDevCycle } from '../../../src/ops/dev/cycle.js';
import type { DevEffects } from '../../../src/ops/dev/effects.js';
import type { PrOpenInput } from '../../../src/ops/pr/open.js';
import { makeTestRepo, repoEffects, seed, type TestRepo } from './repo.js';
import {
  bindCycleRepo,
  cleanAddress,
  cleanReview,
  greenCheck,
  openFake,
  seedReadyLedger,
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
  test('a relative repoRoot publishes and verifies the reviewed head with the production Git runner', async () => {
    const state = await seed(repo);
    await seedReadyLedger(state);
    const opens: PrOpenInput[] = [];
    const repoRoot = relative(process.cwd(), repo.root);
    expect(repoRoot).not.toBe(repo.root);
    expect(repo.git('ls-remote', 'origin', 'refs/heads/feature/x')).toBe('');
    const op = makeDevCycle({
      effects: effects(),
      check: greenCheck(),
      review: cleanReview(state),
      address: cleanAddress(state),
      open: openFake(opens),
      // No git override: exercise cwd and -C together against the local origin.
    });

    const result = await op({ repoRoot });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value.pushed).toBe(true);
    expect(result.value.head).toBe(state.head);
    expect(repo.git('ls-remote', 'origin', 'refs/heads/feature/x').trim()).toBe(
      `${state.head}\trefs/heads/feature/x`,
    );
    expect(opens).toEqual([{ repoRoot: repo.root, target: 'main' }]);
    expect(result.value.followUp).toBe(followUpCommand(42, repo.root));
  });

  test('the clean loop: check → review → address → final check → push → ready PR (ok)', async () => {
    const state = await seed(repo);
    await seedReadyLedger(state);
    const checkCalls: string[] = [];
    const opens: PrOpenInput[] = [];
    const op = makeDevCycle({
      effects: effects(),
      check: greenCheck(checkCalls),
      review: cleanReview(state),
      address: cleanAddress(state),
      open: openFake(opens),
      git: async () => ({ code: 0, stdout: `${state.head}\trefs/heads/feature/x\n`, stderr: '' }),
    });
    const result = await op({ repoRoot: repo.root });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value.branch).toBe('feature/x');
    expect(result.value.head).toBe(state.head);
    expect(result.value.pushed).toBe(true);
    expect(result.value.followUp).toBe(followUpCommand(42, repo.root));
    expect(result.value.pr.number).toBe(42);
    expect(result.value.pr.ready).toBe(true);
    // TWO check legs: before the review and after the address.
    expect(checkCalls).toEqual(['check:main', 'check:main']);
    // The PR opened ready (no draft flags), at the intended target.
    expect(opens).toEqual([{ repoRoot: repo.root, target: 'main' }]);
  });

  test('includeIntegration=true reaches BOTH check legs', async () => {
    const state = await seed(repo);
    await seedReadyLedger(state);
    const seen: boolean[] = [];
    const opens: PrOpenInput[] = [];
    const op = makeDevCycle({
      effects: effects(),
      check: async (input) => {
        seen.push(input.includeIntegration === true);
        return greenCheck([])(input);
      },
      review: cleanReview(state),
      address: cleanAddress(state),
      open: openFake(opens),
      git: async () => ({ code: 0, stdout: `${state.head}\trefs/heads/feature/x\n`, stderr: '' }),
    });
    const result = await op({ repoRoot: repo.root, includeIntegration: true });
    expect(result.status, JSON.stringify(result)).toBe('ok');
    expect(seen).toEqual([true, true]);
  });

  test('testFiles reaches BOTH check legs; absent keeps them automatic', async () => {
    const state = await seed(repo);
    await seedReadyLedger(state);
    const seen: Array<string[] | undefined> = [];
    const files = ['test/ops/dev/cycle.test.ts', 'test/ops/dev/check.test.ts'];
    const op = makeDevCycle({
      effects: effects(),
      check: async (input) => {
        seen.push(input.testFiles);
        return greenCheck([])(input);
      },
      review: cleanReview(state),
      address: cleanAddress(state),
      open: openFake([]),
      git: async () => ({ code: 0, stdout: `${state.head}\trefs/heads/feature/x\n`, stderr: '' }),
    });
    const named = await op({ repoRoot: repo.root, testFiles: files });
    expect(named.status, JSON.stringify(named)).toBe('ok');
    expect(seen).toEqual([files, files]);
    seen.length = 0;
    const bare = await op({ repoRoot: repo.root });
    expect(bare.status, JSON.stringify(bare)).toBe('ok');
    expect(seen).toEqual([undefined, undefined]);
  });

  test('includeIntegration absent keeps the check legs bare', async () => {
    const state = await seed(repo);
    await seedReadyLedger(state);
    const seen: Array<boolean | undefined> = [];
    const op = makeDevCycle({
      effects: effects(),
      check: async (input) => {
        seen.push(input.includeIntegration);
        return greenCheck([])(input);
      },
      review: cleanReview(state),
      address: cleanAddress(state),
      open: openFake([]),
      git: async () => ({ code: 0, stdout: `${state.head}\trefs/heads/feature/x\n`, stderr: '' }),
    });
    const result = await op({ repoRoot: repo.root });
    expect(result.status, JSON.stringify(result)).toBe('ok');
    expect(seen).toEqual([undefined, undefined]);
  });

  test('push:false skips the verified push (the branch stays local; pr.open still runs)', async () => {
    const state = await seed(repo);
    await seedReadyLedger(state);
    let pushCalls = 0;
    const op = makeDevCycle({
      effects: effects(),
      check: greenCheck(),
      review: cleanReview(state),
      address: cleanAddress(state),
      open: openFake([]),
      git: async () => {
        pushCalls++;
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    const result = await op({ repoRoot: repo.root, push: false });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') expect(result.value.pushed).toBe(false);
    expect(pushCalls).toBe(0);
  });
});
