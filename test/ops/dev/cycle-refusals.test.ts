import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { makeDevCycle } from '../../../src/ops/dev/cycle.js';
import type { DevEffects } from '../../../src/ops/dev/effects.js';
import type { PrOpenInput } from '../../../src/ops/pr/open.js';
import { makeTestRepo, repoEffects, seed, type TestRepo } from './repo.js';
import {
  addressReport,
  bindCycleRepo,
  capFinding,
  cleanAddress,
  cleanReview,
  greenCheck,
  okPush,
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
  test('an unreadable cq.json (EISDIR) refuses the policy read instead of default reviewers', async () => {
    await mkdir(join(repo.root, 'cq.json')); // present-but-unreadable; only ENOENT means "no config"
    const op = makeDevCycle({
      effects: effects(),
      check: async () => {
        throw new Error('check must not run');
      },
      review: async () => {
        throw new Error('review must not run');
      },
      address: async () => {
        throw new Error('address must not run');
      },
      open: openFake([]),
    });
    const result = await op({ repoRoot: repo.root });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human')
      expect(result.reason).toContain('dev.cycle: cq.json could not be read (EISDIR)');
  });

  test('a red FIRST check stops verbatim before any review leg', async () => {
    const op = makeDevCycle({
      effects: effects(),
      check: async () => ({
        status: 'failed',
        error: 'dev.check: 1 gate(s) red (check:static)',
      }),
      review: async () => {
        throw new Error('review must not run');
      },
      address: async () => {
        throw new Error('address must not run');
      },
      open: openFake([]),
    });
    const result = await op({ repoRoot: repo.root });
    expect(result).toEqual({
      status: 'failed',
      error: 'dev.cycle (dev.check): dev.check: 1 gate(s) red (check:static)',
      report: { usageSummary: { knownCount: 0, unknownCount: 0, unpricedCount: 0 } },
    });
  });

  test('a red FINAL check after a clean address stops verbatim (never a draft, never bypassed)', async () => {
    const state = await seed(repo);
    await seedReadyLedger(state);
    let checkRuns = 0;
    const op = makeDevCycle({
      effects: effects(),
      check: async (input) => {
        checkRuns++;
        if (checkRuns === 1) return greenCheck()({ ...input });
        return { status: 'failed', error: 'dev.check: the final gates went red' };
      },
      review: cleanReview(state),
      address: cleanAddress(state),
      open: openFake([]),
      git: okPush,
    });
    const result = await op({ repoRoot: repo.root });
    expect(result.status).toBe('failed');
    if (result.status === 'failed')
      expect(result.error).toBe(
        'dev.cycle (dev.check (final)): dev.check: the final gates went red',
      );
  });

  test('a blocked review source stops verbatim with zero pr calls', async () => {
    const opens: PrOpenInput[] = [];
    const op = makeDevCycle({
      effects: effects(),
      check: greenCheck(),
      review: async () => ({
        status: 'needs-human',
        reason: 'review.run: not every configured reviewer completed a terminal cycle',
      }),
      address: async () => {
        throw new Error('address must not run');
      },
      open: openFake(opens),
    });
    const result = await op({ repoRoot: repo.root });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human')
      expect(result.reason).toBe(
        'dev.cycle (review.run): review.run: not every configured reviewer completed a terminal cycle',
      );
    expect(opens).toEqual([]);
  });

  test('an address refusal WITHOUT a report stops verbatim (no draft, no PR)', async () => {
    const state = await seed(repo);
    const opens: PrOpenInput[] = [];
    const op = makeDevCycle({
      effects: effects(),
      check: greenCheck(),
      review: cleanReview(state),
      address: async () => ({
        status: 'needs-human',
        reason: 'review.address: no findings record; run review.run or pass --record',
      }),
      open: openFake(opens),
    });
    const result = await op({ repoRoot: repo.root });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human')
      expect(result.reason).toContain(
        'dev.cycle (review.address): review.address: no findings record',
      );
    expect(opens).toEqual([]);
  });

  test('a budget-like REASON without the structured marker still propagates verbatim (no string matching)', async () => {
    const state = await seed(repo);
    await seedReadyLedger(state);
    const opens: PrOpenInput[] = [];
    let pushCalls = 0;
    const op = makeDevCycle({
      effects: effects(),
      check: greenCheck(),
      review: cleanReview(state),
      address: async () => ({
        status: 'needs-human',
        reason: 'review.address: token or wall budget exhausted; report: /tmp/r.json',
        report: addressReport(state, [capFinding], []),
      }),
      open: openFake(opens),
      git: async (args) => {
        if (args.includes('push')) pushCalls++;
        return { code: 0, stdout: `${state.head}\trefs/heads/feature/x\n`, stderr: '' };
      },
    });
    const result = await op({ repoRoot: repo.root });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') {
      expect(result.reason).not.toContain('NOT READY');
      expect(result.reason).toBe(
        'dev.cycle (review.address): review.address: token or wall budget exhausted; report: /tmp/r.json',
      );
    }
    expect(pushCalls).toBe(0);
    expect(opens).toEqual([]);
  });

  test('a push failure after a clean loop is needs-human naming the branch (nothing opens)', async () => {
    const state = await seed(repo);
    await seedReadyLedger(state);
    const opens: PrOpenInput[] = [];
    const op = makeDevCycle({
      effects: effects(),
      check: greenCheck(),
      review: cleanReview(state),
      address: cleanAddress(state),
      open: openFake(opens),
      git: async () => ({ code: 128, stdout: '', stderr: 'remote: permission denied' }),
    });
    const result = await op({ repoRoot: repo.root });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') {
      expect(result.reason).toContain('dev.cycle (push)');
      expect(result.reason).toContain("the push of 'feature/x' failed");
      expect(result.reason).toContain('permission denied');
    }
    expect(opens).toEqual([]);
  });

  test('a forge failure AFTER the push is a failed op naming the pr.open leg (the branch IS published)', async () => {
    const state = await seed(repo);
    await seedReadyLedger(state);
    let pushCalls = 0;
    const op = makeDevCycle({
      effects: effects(),
      check: greenCheck(),
      review: cleanReview(state),
      address: cleanAddress(state),
      open: async () => ({
        status: 'failed',
        error: 'pr.open: the PR could not be opened — gh: 502',
      }),
      git: async (args) => {
        if (args.includes('push')) {
          pushCalls++;
          return { code: 0, stdout: '', stderr: '' };
        }
        return { code: 0, stdout: `${state.head}\trefs/heads/feature/x\n`, stderr: '' };
      },
    });
    const result = await op({ repoRoot: repo.root });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error).toContain('dev.cycle (pr.open)');
    expect(pushCalls).toBe(1);
  });

  test('a schema-bypassing input fails at the boundary with zero effects', async () => {
    const dev = repoEffects(repo, () => {
      throw new Error('no command may run');
    });
    const op = makeDevCycle({ effects: dev });
    const result = await op({ repoRoot: '' } as never);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error).toContain('invalid input');
  });
});
