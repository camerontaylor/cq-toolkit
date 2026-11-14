import { describe, expect, it } from 'vitest';
import { JsonNumber, JsonObject } from '../../src/policy/crq/jsonValue.js';
import {
  prepareOrdinaryReview,
  type ReviewPreparationEffects,
} from '../../src/queue-runner/reviewPreparation.js';

const at = '2026-11-14T17:00:00Z';
function fixture(kind = 'open') {
  const item = new JsonObject([
    ['id', 'pr-1'],
    ['kind', kind],
    ['state', 'pending'],
    ['pr', JsonNumber.int(1)],
    ['repo', 'o/r'],
    ['unknown', JsonNumber.int('90071992547409930')],
  ]);
  const queue = new JsonObject([
    ['items', [item]],
    ['unknown', JsonNumber.float(1.5)],
  ]);
  const plan = new JsonObject([
    ['base', 'a'.repeat(40)],
    ['head', 'b'.repeat(40)],
    ['label', 'review'],
    ['target', 'origin/main'],
    ['cycle', JsonNumber.int(1)],
    ['branch', 'feature'],
    ['range_policy', 'full-range-once-v1'],
  ]);
  const calls: string[] = [];
  let saved: JsonObject | undefined;
  let written: JsonObject | undefined;
  const effects: ReviewPreparationEffects = {
    allocate: async () => {
      calls.push('allocate');
      return 'pr-1-20261114T170000Z';
    },
    scan: async () => {
      calls.push('scan');
      return {
        clean: true,
        denylistHits: 0,
        gitleaksHits: 0,
        artifactPath: '/state/runs/pr-1/secret-scan.json',
      };
    },
    blocked: async () => {
      calls.push('blocked');
    },
    checkout: async () => {
      calls.push('checkout');
      return { path: '/wt', branch: 'crq/wt-pr-1' };
    },
    nowIso: () => at,
    launch: {
      writeMeta: async (_id, meta) => {
        calls.push('meta');
        written = meta;
      },
      workStarted: async () => {
        calls.push('work');
      },
      saveQueue: async (q) => {
        calls.push('save');
        saved = q;
      },
      spawn: async () => {
        calls.push('spawn');
        return 123;
      },
      event: async () => {
        calls.push('event');
      },
      nowIso: () => at,
    },
  };
  return { queue, plan, effects, calls, saved: () => saved, written: () => written };
}
describe('inactive ordinary review preparation', () => {
  it('orders scan and checkout before durable reservation and spawn, preserving unknown values', async () => {
    const f = fixture();
    const result = await prepareOrdinaryReview(
      f.queue,
      { itemIndex: 0, plan: f.plan, repo: 'o/r', band: 'background' },
      f.effects,
    );
    expect(f.calls).toEqual([
      'allocate',
      'scan',
      'checkout',
      'meta',
      'work',
      'save',
      'spawn',
      'save',
      'event',
    ]);
    expect(f.written()?.get('cmd')).toEqual([
      'coderabbit',
      'review',
      '--agent',
      '--deep',
      '--committed',
      '--base-commit',
      'a'.repeat(40),
    ]);
    expect(result.queue.get('unknown')).toBe(f.queue.get('unknown'));
    const items = result.queue.get('items');
    expect(Array.isArray(items) && items[0] instanceof JsonObject && items[0].get('unknown')).toBe(
      (f.queue.get('items') as JsonObject[])[0]?.get('unknown'),
    );
    expect(f.saved()).toBe(result.queue);
  });
  it.each(['author', 'current', 'push', 'backfill', 'coverage', 'local-review'])(
    'refuses unsupported %s before effects',
    async (kind) => {
      const f = fixture(kind);
      await expect(
        prepareOrdinaryReview(
          f.queue,
          { itemIndex: 0, plan: f.plan, repo: 'o/r', band: 'background' },
          f.effects,
        ),
      ).rejects.toThrow('unsupported');
      expect(f.calls).toEqual([]);
    },
  );
  it('fails closed on scanner refusal before checkout or reservation', async () => {
    const f = fixture();
    f.effects.scan = async () => {
      f.calls.push('scan');
      return {
        clean: false,
        denylistHits: 1,
        gitleaksHits: 0,
        artifactPath: '/state/runs/pr-1/secret-scan.json',
      };
    };
    const result = await prepareOrdinaryReview(
      f.queue,
      { itemIndex: 0, plan: f.plan, repo: 'o/r', band: 'background' },
      f.effects,
    );
    expect(result.outcome).toBe('blocked');
    const items = result.queue.get('items');
    expect(Array.isArray(items) && items[0] instanceof JsonObject && items[0].get('state')).toBe(
      'blocked',
    );
    expect(f.calls).toEqual(['allocate', 'scan', 'blocked']);
  });
  it('rejects inconsistent scan decisions before checkout', async () => {
    const f = fixture();
    f.effects.scan = async () => ({
      clean: true,
      denylistHits: 1,
      gitleaksHits: 0,
      artifactPath: '/state/runs/pr-1/secret-scan.json',
    });
    await expect(
      prepareOrdinaryReview(
        f.queue,
        { itemIndex: 0, plan: f.plan, repo: 'o/r', band: 'background' },
        f.effects,
      ),
    ).rejects.toThrow('invalid review scan decision');
    expect(f.calls).toEqual(['allocate']);
  });
  it('awaits a blocked event and propagates its failure without starting a review', async () => {
    const f = fixture();
    f.effects.scan = async () => ({
      clean: false,
      denylistHits: 1,
      gitleaksHits: 0,
      artifactPath: '/state/runs/pr-1/secret-scan.json',
    });
    let rejectEvent: (error: Error) => void = () => {
      throw new Error('blocked event not reached');
    };
    let signalEvent: () => void = () => {};
    const reachedEvent = new Promise<void>((resolve) => {
      signalEvent = resolve;
    });
    f.effects.blocked = async () => {
      f.calls.push('blocked');
      signalEvent();
      await new Promise<void>((_resolve, reject) => {
        rejectEvent = reject;
      });
    };
    let settled = false;
    const pending = prepareOrdinaryReview(
      f.queue,
      { itemIndex: 0, plan: f.plan, repo: 'o/r', band: 'background' },
      f.effects,
    ).finally(() => {
      settled = true;
    });
    await reachedEvent;
    expect(settled).toBe(false);
    expect(f.calls).toEqual(['allocate', 'blocked']);
    rejectEvent(new Error('event failed'));
    await expect(pending).rejects.toThrow('event failed');
    expect(f.calls).toEqual(['allocate', 'blocked']);
  });
  it('does not reserve or spawn after checkout fails', async () => {
    const f = fixture('delta');
    f.effects.checkout = async () => {
      f.calls.push('checkout');
      throw new Error('checkout failed');
    };
    await expect(
      prepareOrdinaryReview(
        f.queue,
        { itemIndex: 0, plan: f.plan, repo: 'o/r', band: 'background' },
        f.effects,
      ),
    ).rejects.toThrow('checkout failed');
    expect(f.calls).toEqual(['allocate', 'scan', 'checkout']);
  });
  it('does not spawn when the reservation save fails', async () => {
    const f = fixture();
    f.effects.launch.saveQueue = async () => {
      f.calls.push('save');
      throw new Error('save failed');
    };
    await expect(
      prepareOrdinaryReview(
        f.queue,
        { itemIndex: 0, plan: f.plan, repo: 'o/r', band: 'background' },
        f.effects,
      ),
    ).rejects.toThrow('save failed');
    expect(f.calls).toEqual(['allocate', 'scan', 'checkout', 'meta', 'work', 'save']);
  });
  it('retains durable reservation when spawn outcome is unknown', async () => {
    const f = fixture();
    f.effects.launch.spawn = async () => {
      f.calls.push('spawn');
      throw new Error('unknown');
    };
    await expect(
      prepareOrdinaryReview(
        f.queue,
        { itemIndex: 0, plan: f.plan, repo: 'o/r', band: 'background' },
        f.effects,
      ),
    ).rejects.toThrow('unknown');
    const items = f.saved()?.get('items');
    expect(Array.isArray(items) && items[0] instanceof JsonObject && items[0].get('state')).toBe(
      'reviewing',
    );
    expect(f.calls).toEqual(['allocate', 'scan', 'checkout', 'meta', 'work', 'save', 'spawn']);
  });
});
