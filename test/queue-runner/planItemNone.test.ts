import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PUSH_KIND } from '../../src/queue-runner/launch.js';
import { planItem, type PlanItemDeps } from '../../src/queue-runner/planItem.js';
import * as passes from '../../src/queue-runner/preparePasses.js';
import { StartNotReady } from '../../src/queue-runner/startOne.js';
import { LOCAL_REVIEW_KIND, REVIEW_RECEIPT_KIND } from '../../src/policy/crq/tickSchedule.js';

vi.mock('../../src/queue-runner/preparePasses.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/queue-runner/preparePasses.js')>();
  return {
    ...original,
    prepareCurrent: vi.fn(),
    preparePushCurrent: vi.fn(),
    prepareLocalReview: vi.fn(),
  };
});

const deps = {
  queue: { items: [], starts: [] },
  dry: false,
  ignoreQuiet: false,
} as unknown as PlanItemDeps;

/**
 * The prepare passes answer Python's `None` as `nothing-to-review`; only the
 * receipt and push-current kinds log "(no vendor start)", local-review
 * `continue`s silently. A swapped flag must fail here.
 */
const CASES = [
  { kind: REVIEW_RECEIPT_KIND, mock: vi.mocked(passes.prepareCurrent), logNoStart: true },
  { kind: PUSH_KIND, mock: vi.mocked(passes.preparePushCurrent), logNoStart: true },
  { kind: LOCAL_REVIEW_KIND, mock: vi.mocked(passes.prepareLocalReview), logNoStart: false },
];

describe('planItem prepare-pass outcome mapping', () => {
  beforeEach(() => {
    for (const { mock } of CASES) mock.mockReset();
  });

  it.each(CASES)('$kind: nothing-to-review maps to none with its log flag', async (c) => {
    c.mock.mockResolvedValue({ outcome: 'nothing-to-review', reason: 'r' } as never);
    await expect(planItem({ id: 'x', kind: c.kind }, deps)).resolves.toEqual({
      outcome: 'none',
      logNoStart: c.logNoStart,
    });
  });

  it.each(CASES)('$kind: not-ready re-raises StartNotReady with the reason', async (c) => {
    c.mock.mockResolvedValue({ outcome: 'not-ready', reason: 'head moved' } as never);
    const error = await planItem({ id: 'x', kind: c.kind }, deps).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StartNotReady);
    expect((error as Error).message).toBe('head moved');
  });

  it.each(CASES)('$kind: a plan passes through unchanged', async (c) => {
    const plan = { head: 'h' };
    c.mock.mockResolvedValue({ outcome: 'plan', plan } as never);
    await expect(planItem({ id: 'x', kind: c.kind }, deps)).resolves.toEqual({
      outcome: 'plan',
      plan,
    });
  });
});
