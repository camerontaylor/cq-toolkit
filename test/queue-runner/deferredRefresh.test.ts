import { describe, expect, it } from 'vitest';
import { JsonNumber, JsonObject, parseJsonValue } from '../../src/policy/crq/jsonValue.js';
import { RefreshExhausted } from '../../src/policy/crq/forgeBudget.js';
import {
  refreshDeferred,
  runDeferredRefresh,
  DeferredUnavailableError,
  type DeferredRefreshEffects,
} from '../../src/queue-runner/deferredRefresh.js';

const head = 'a'.repeat(40);
const merge = 'b'.repeat(40);
const binding = {
  kind: 'deferred-author',
  repo: 'owner/repo',
  producer: 'author',
  head,
  target: 'merge-queue',
  targetSelector: 'promoted-main',
};
function obj(value: unknown): JsonObject {
  return parseJsonValue(JSON.stringify(value)) as JsonObject;
}
function initial() {
  return obj({
    items: [],
    unknown: { value: 1.5 },
    queue_client_requests: {
      'request-1': {
        binding,
        state: 'awaiting-pr',
        principal: 'server',
        deliveries: { old: { next: 1 } },
      },
    },
  });
}
function entry(queue: JsonObject): JsonObject {
  const entries = queue.get('queue_client_requests') as JsonObject;
  return entries.get('request-1') as JsonObject;
}
function actual(state: string): JsonObject {
  return obj({ ...binding, pr: 12, state, mergeSha: state === 'MERGED' ? merge : null });
}
function effects(overrides: Partial<DeferredRefreshEffects> = {}): DeferredRefreshEffects {
  return {
    verify: async () => actual('OPEN'),
    find: async () => [actual('OPEN')],
    mayContinue: () => true,
    ...overrides,
  };
}

describe('deferred author refresh', () => {
  it('recovers a publication and binds one merged review without mutating the original queue', async () => {
    const original = initial();
    const open = await refreshDeferred(original, 'now', effects());
    expect(entry(open.queue).get('state')).toBe('awaiting-merge');
    expect(entry(original).get('state')).toBe('awaiting-pr');
    const merged = await refreshDeferred(
      open.queue,
      'later',
      effects({ verify: async () => actual('MERGED') }),
    );
    expect(entry(merged.queue).get('state')).toBe('ready-current');
    expect(merged.queue.get('items') as unknown[]).toHaveLength(1);
    expect(original.get('items') as unknown[]).toHaveLength(0);
    expect(entry(merged.queue).get('deliveries')).toBeInstanceOf(JsonObject);
    expect(merged.queue.get('unknown')).toBe(original.get('unknown'));
  });
  it('rotates fairly, retains ambiguity and keeps private errors out of state', async () => {
    const one = entry(initial());
    const queue = obj({
      items: [],
      queue_client_requests: {
        a: { binding, state: 'awaiting-pr' },
        b: { binding, state: 'awaiting-pr' },
      },
    });
    const first = await refreshDeferred(queue, 'now', effects({ find: async () => [] }), 1);
    const second = await refreshDeferred(
      first.queue,
      'later',
      effects({
        find: async () => {
          throw new DeferredUnavailableError('secret');
        },
      }),
      1,
    );
    expect(first.refreshed).toEqual(['a']);
    expect(second.refreshed).toEqual(['b']);
    expect(
      JSON.stringify((second.queue.get('queue_client_requests') as JsonObject).entries),
    ).not.toContain('secret');
    const ambiguous = await refreshDeferred(
      initial(),
      'now',
      effects({ find: async () => [actual('OPEN'), actual('OPEN')] }),
    );
    expect((entry(ambiguous.queue).get('reason') as JsonObject).get('category')).toBe('identity');
    expect(one.get('state')).toBe('awaiting-pr');
  });
  it('retains cursor on exhaustion and saves only completed progress', async () => {
    let saved = 0;
    const base = initial();
    const exhausted = await runDeferredRefresh('now', {
      ...effects({
        find: async () => {
          throw new RefreshExhausted('budget');
        },
      }),
      loadQueue: async () => base,
      saveQueue: async () => {
        saved++;
      },
    });
    expect(exhausted.refreshed).toEqual([]);
    expect(exhausted.queue).toBe(base);
    expect(saved).toBe(0);
    await expect(
      runDeferredRefresh('now', {
        ...effects(),
        loadQueue: async () => base,
        saveQueue: async () => {
          throw new Error('disk failed');
        },
      }),
    ).rejects.toThrow('disk failed');
  });
  it('rejects wrong forge identity and records closed PR cancellation', async () => {
    const wrong = await refreshDeferred(
      initial(),
      'now',
      effects({
        find: async () => [obj({ ...binding, producer: 'other', pr: 12, state: 'OPEN' })],
      }),
    );
    expect((entry(wrong.queue).get('reason') as JsonObject).get('code')).toBe('forge-identity');
    const closed = await refreshDeferred(
      initial(),
      'now',
      effects({ find: async () => [actual('CLOSED')] }),
    );
    expect(entry(closed.queue).get('state')).toBe('cancelled');
  });
  it('retains the discovered PR if merged enrollment fails', async () => {
    const queue = obj({
      items: [],
      queue_client_requests: {
        'request-1': { binding: { ...binding, targetSelector: '' }, state: 'awaiting-pr' },
      },
    });
    const result = await refreshDeferred(
      queue,
      'now',
      effects({ find: async () => [actual('MERGED')] }),
    );
    expect(entry(result.queue).get('pr')).toEqual(JsonNumber.int(12));
    expect(entry(result.queue).get('state')).toBe('awaiting-pr');
    expect((entry(result.queue).get('reason') as JsonObject).get('category')).toBe('identity');
    expect(result.queue.get('items')).toEqual([]);
  });
});
