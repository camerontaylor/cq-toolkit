import { describe, expect, it } from 'vitest';
import {
  JsonObject,
  parseJsonValue,
  toPlainJson,
  type JsonValue,
} from '../../../src/policy/crq/jsonValue.js';
import {
  DeliveryRuntimeError,
  DeliveryValueError,
  ThreadsNotVisibleError,
  deliverPendingCleanReviews,
  type CleanReviewEffects,
} from '../../../src/ops/crq/internal/deliverPending.js';

const doc = (v: unknown): JsonObject => parseJsonValue(JSON.stringify(v)) as JsonObject;
const out = (q: JsonObject): unknown => toPlainJson(q.get('items') as JsonValue);
const REQUEST = { run_id: 'r1', base: 'b', head: 'h', pr: 7, ndjson: '/x/review.ndjson' };
const pending = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  kind: 'open',
  clean_review_pending: true,
  clean_review_request: REQUEST,
  ...extra,
});

function effects(deliver: CleanReviewEffects['deliver'], calls: string[] = []): CleanReviewEffects {
  return {
    deliver: async (input) => {
      calls.push(`${input.repo}#${String(toPlainJson(input.pr))}`);
      return deliver(input);
    },
    now: () => '2026-11-15T00:00:00Z',
    primaryRepo: 'o/primary',
    checkpoint: async () => {},
  };
}
const ok = async (): Promise<JsonObject> => doc({ state: 'created' });

describe('deliverPendingCleanReviews', () => {
  it('delivers, records the result and clears pending/error', async () => {
    const calls: string[] = [];
    const q = doc({ items: [pending('a', { clean_review_error: 'old' })] });
    const r = await deliverPendingCleanReviews(q, effects(ok, calls));
    expect(calls).toEqual(['o/primary#7']);
    expect(r.log).toEqual(['clean review on PR #7 (created)']);
    expect(out(r.queue)).toEqual([
      {
        id: 'a',
        kind: 'open',
        clean_review_pending: false,
        clean_review_request: REQUEST,
        clean_review_attempt_at: '2026-11-15T00:00:00Z',
        clean_review_attempts: 1,
        clean_review: { state: 'created' },
      },
    ]);
  });

  it('skips non-open/delta kinds, retired promotions and non-pending items', async () => {
    const calls: string[] = [];
    const q = doc({
      items: [
        pending('p', { kind: 'promotion' }),
        pending('m', { kind: 'main' }),
        pending('n', { clean_review_pending: false }),
        pending('d', { kind: 'delta', repo: 'o/other' }),
      ],
    });
    await deliverPendingCleanReviews(q, effects(ok, calls));
    expect(calls).toEqual(['o/other#7']);
  });

  it('takes the two least recently attempted, never-attempted first', async () => {
    const calls: string[] = [];
    const q = doc({
      items: [
        pending('late', { clean_review_attempt_at: '2026-11-14T00:00:00Z', repo: 'o/late' }),
        pending('new', { repo: 'o/new' }),
        pending('early', { clean_review_attempt_at: '2026-11-13T00:00:00Z', repo: 'o/early' }),
      ],
    });
    await deliverPendingCleanReviews(q, effects(ok, calls));
    expect(calls).toEqual(['o/new#7', 'o/early#7']);
  });

  it('refunds the attempt and keeps pending when threads are not visible', async () => {
    const q = doc({ items: [pending('a', { clean_review_attempts: 2 })] });
    const r = await deliverPendingCleanReviews(
      q,
      effects(async () => {
        throw new ThreadsNotVisibleError('threads lag');
      }),
    );
    const [item] = out(r.queue) as Array<Record<string, unknown>>;
    expect(item).toMatchObject({
      clean_review_attempts: 2,
      clean_review_pending: true,
      clean_review_error: 'threads lag',
    });
    expect(r.log).toEqual([]);
  });

  it('settles a value error at once, truncating the message to 300 characters', async () => {
    const q = doc({ items: [pending('a')] });
    const r = await deliverPendingCleanReviews(
      q,
      effects(async () => {
        throw new DeliveryValueError('x'.repeat(400));
      }),
    );
    const [item] = out(r.queue) as Array<Record<string, unknown>>;
    expect(item?.clean_review_pending).toBe(false);
    expect(item?.clean_review_error).toBe('x'.repeat(300));
    expect(item?.clean_review_attempts).toBe(1);
  });

  it('retries a runtime error until the fifth attempt', async () => {
    const boom = effects(async () => {
      throw new DeliveryRuntimeError('gh down');
    });
    const fourth = await deliverPendingCleanReviews(
      doc({ items: [pending('a', { clean_review_attempts: 3 })] }),
      boom,
    );
    expect((out(fourth.queue) as Array<Record<string, unknown>>)[0]).toMatchObject({
      clean_review_attempts: 4,
      clean_review_pending: true,
      clean_review_error: 'gh down',
    });
    const fifth = await deliverPendingCleanReviews(
      doc({ items: [pending('a', { clean_review_attempts: 4 })] }),
      boom,
    );
    expect((out(fifth.queue) as Array<Record<string, unknown>>)[0]).toMatchObject({
      clean_review_attempts: 5,
      clean_review_pending: false,
    });
  });

  it('settles a request missing a key with the KeyError text, never calling deliver', async () => {
    const calls: string[] = [];
    const q = doc({
      items: [
        pending('a', { clean_review_request: { run_id: 'r', base: 'b' } }),
        pending('b', { clean_review_request: null }),
      ],
    });
    const r = await deliverPendingCleanReviews(q, effects(ok, calls));
    expect(calls).toEqual([]);
    const items = out(r.queue) as Array<Record<string, unknown>>;
    expect(items[0]).toMatchObject({ clean_review_error: "'head'", clean_review_pending: false });
    expect(items[1]).toMatchObject({
      clean_review_error: "'NoneType' object is not subscriptable",
      clean_review_pending: false,
    });
  });

  it('settles a non-string ndjson with the Python 3.14 Path() TypeError text', async () => {
    const r = await deliverPendingCleanReviews(
      doc({ items: [pending('a', { clean_review_request: { ...REQUEST, ndjson: 5 } })] }),
      effects(ok),
    );
    expect((out(r.queue) as Array<Record<string, unknown>>)[0]).toMatchObject({
      clean_review_error:
        "argument should be a str or an os.PathLike object where __fspath__ returns a str, not 'int'",
      clean_review_pending: false,
    });
  });

  it('propagates an unexpected error class', async () => {
    await expect(
      deliverPendingCleanReviews(
        doc({ items: [pending('a')] }),
        effects(async () => {
          throw new Error('bug');
        }),
      ),
    ).rejects.toThrow('bug');
  });

  it('passes the request identity through and checkpoints against the item', async () => {
    const seen: string[] = [];
    const eff = effects(async (input) => {
      await input.checkpoint('login', 'reason');
      seen.push(`${String(input.postingIdentity)}/${String(input.identityReason)}`);
      return doc({ state: 'existing' });
    });
    const withIdentity = doc({
      items: [
        pending('a', {
          clean_review_request: { ...REQUEST, posting_identity: 'bot', identity_reason: 'why' },
        }),
      ],
    });
    const checkpoints: string[] = [];
    await deliverPendingCleanReviews(withIdentity, {
      ...eff,
      checkpoint: async (id, login, reason) => {
        checkpoints.push(`${String(id)}:${login}:${reason}`);
      },
    });
    expect(seen).toEqual(['bot/why']);
    expect(checkpoints).toEqual(['a:login:reason']);
  });
});
