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
} from '../../../src/ops/crq/internal/deliverPending.js';
import {
  DeliveryKeyTypeError,
  deliverPendingReviewRefreshes,
  type RefreshEffects,
} from '../../../src/ops/crq/internal/deliverRefreshes.js';

const doc = (v: unknown): JsonObject => parseJsonValue(JSON.stringify(v)) as JsonObject;
const out = (q: JsonObject): unknown => toPlainJson(q.get('items') as JsonValue);
const REQUEST = { run_id: 'r1', base: 'b', head: 'h', pr: 7 };
const ITERATE = { verdict: 'ITERATE', whole_pr_scan: true };
const item = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  kind: 'open',
  pr_review: ITERATE,
  pr_review_request: REQUEST,
  ...extra,
});
type Rows = Array<Record<string, Record<string, unknown>>>;
const field = (r: Rows, key: string): Record<string, unknown> => r[0]?.[key] ?? {};
const NOW = '2026-11-15T00:00:00Z';

function effects(
  refresh: RefreshEffects['refresh'] = async () => doc({ state: 'created' }),
  calls: string[] = [],
): RefreshEffects {
  return {
    refresh: async (input) => {
      calls.push(`${input.repo}#${String(toPlainJson(input.pr))}`);
      return refresh(input);
    },
    now: () => NOW,
    primaryRepo: 'o/primary',
    checkpoint: async () => {},
  };
}

describe('deliverPendingReviewRefreshes', () => {
  it('refreshes an ITERATE whole-PR scan and logs a created PASS', async () => {
    const calls: string[] = [];
    const r = await deliverPendingReviewRefreshes(
      doc({ items: [item('a')] }),
      effects(undefined, calls),
    );
    expect(calls).toEqual(['o/primary#7']);
    expect(r.log).toEqual(['PASS refresh on PR #7 (created)']);
    expect(out(r.queue)).toEqual([
      {
        ...item('a'),
        pr_review_refresh_attempt_at: NOW,
        pr_review_refresh: { state: 'created', head: 'h', scan_run: 'r1', attempts: 0 },
      },
    ]);
  });

  it('skips non-ITERATE, partial-scan, body-major, wrong-kind and non-dict records', async () => {
    const calls: string[] = [];
    const q = doc({
      items: [
        item('p', { pr_review: { verdict: 'PASS', whole_pr_scan: true } }),
        item('s', { pr_review: { verdict: 'ITERATE', whole_pr_scan: false } }),
        item('m', { pr_review: { ...ITERATE, body_major: true } }),
        item('k', { kind: 'main' }),
        item('x', { pr_review_request: 'nope' }),
        item('promo', { kind: 'promotion' }),
      ],
    });
    const r = await deliverPendingReviewRefreshes(q, effects(undefined, calls));
    expect(calls).toEqual([]);
    expect(out(r.queue)).toEqual(out(q));
  });

  it('abandons a malformed request without calling refresh', async () => {
    const calls: string[] = [];
    const bad = [
      { ...REQUEST, head: '' },
      { ...REQUEST, pr: true },
      { ...REQUEST, pr: '7' },
      { run_id: 'r', base: 'b', pr: 7 },
    ];
    for (const request of bad) {
      const r = await deliverPendingReviewRefreshes(
        doc({ items: [item('a', { pr_review_request: request })] }),
        effects(undefined, calls),
      );
      const [a] = out(r.queue) as Array<Record<string, unknown>>;
      expect(a?.['pr_review_refresh']).toEqual({
        state: 'abandoned',
        error: 'malformed CRQ refresh request',
      });
      expect(a).not.toHaveProperty('pr_review_refresh_attempt_at');
    }
    expect(calls).toEqual([]);
  });

  it('skips a settled refresh of the same head and run, but retries a stale one', async () => {
    const calls: string[] = [];
    const settled = (state: string, head = 'h', scan = 'r1') => ({
      pr_review_refresh: { state, head, scan_run: scan, attempts: 1 },
    });
    const q = doc({
      items: [
        item('c', settled('created')),
        item('e', settled('existing')),
        item('a', settled('abandoned')),
        item('h', settled('skipped-head')),
        item('g', settled('skipped-range')),
        item('b', settled('body-major')),
        item('retry', settled('retry')),
        item('waiting', settled('waiting-threads')),
        item('newhead', settled('created', 'old')),
        item('newrun', settled('created', 'h', 'old-run')),
      ],
    });
    const r = await deliverPendingReviewRefreshes(q, effects(undefined, calls));
    expect(calls.length).toBe(2); // capped at two of retry/waiting/newhead/newrun
    expect(r.log.length).toBe(2);
    const all = await deliverPendingReviewRefreshes(
      doc({ items: [item('newrun', settled('created', 'h', 'old-run'))] }),
      effects(undefined, calls),
    );
    expect(all.log).toEqual(['PASS refresh on PR #7 (created)']);
  });

  it('takes the two least-recently-attempted, empty first', async () => {
    const calls: string[] = [];
    const seen: string[] = [];
    const q = doc({
      items: [
        item('late', { pr_review_refresh_attempt_at: '2026-11-14T09:00:00Z', repo: 'o/late' }),
        item('never', { repo: 'o/never' }),
        item('early', { pr_review_refresh_attempt_at: '2026-11-14T01:00:00Z', repo: 'o/early' }),
      ],
    });
    await deliverPendingReviewRefreshes(
      q,
      effects(async (input) => {
        seen.push(input.repo);
        return doc({ state: 'existing' });
      }, calls),
    );
    expect(seen).toEqual(['o/never', 'o/early']);
    const quiet = await deliverPendingReviewRefreshes(
      q,
      effects(async () => doc({ state: 'existing' })),
    );
    expect(quiet.log).toEqual([]);
  });

  it('handles both prefixes of one item and reports the clean refresh too', async () => {
    const seen: string[] = [];
    const q = doc({
      items: [
        item('a', {
          clean_review: ITERATE,
          clean_review_request: { ...REQUEST, run_id: 'r2', pr: 9 },
        }),
      ],
    });
    const r = await deliverPendingReviewRefreshes(
      q,
      effects(async (input) => {
        seen.push(input.runId);
        return doc({ state: 'created' });
      }),
    );
    expect(seen).toEqual(['r1', 'r2']);
    const rows = out(r.queue) as Rows;
    expect(field(rows, 'pr_review_refresh')['scan_run']).toBe('r1');
    expect(field(rows, 'clean_review_refresh')['scan_run']).toBe('r2');
    expect(r.log).toEqual(['PASS refresh on PR #7 (created)', 'PASS refresh on PR #9 (created)']);
  });

  it('records waiting-threads without spending an attempt', async () => {
    const r = await deliverPendingReviewRefreshes(
      doc({
        items: [
          item('a', {
            pr_review_refresh: { state: 'retry', head: 'h', scan_run: 'r1', attempts: 3 },
          }),
        ],
      }),
      effects(async () => {
        throw new ThreadsNotVisibleError('threads not visible yet');
      }),
    );
    const [a] = out(r.queue) as Rows;
    expect(a?.['pr_review_refresh']).toEqual({
      state: 'waiting-threads',
      error: 'threads not visible yet',
      head: 'h',
      scan_run: 'r1',
      attempts: 3,
    });
    expect(r.log).toEqual([]);
  });

  it('counts retries, truncates the error, and abandons on the fifth attempt', async () => {
    const boom = (): Promise<JsonObject> => {
      throw new DeliveryRuntimeError('x'.repeat(400));
    };
    let q = doc({ items: [item('a')] });
    const states: unknown[] = [];
    for (let i = 0; i < 5; i += 1) {
      q = (await deliverPendingReviewRefreshes(q, effects(boom))).queue;
      const f = field(out(q) as Rows, 'pr_review_refresh');
      states.push([f['state'], f['attempts'], String(f['error']).length]);
    }
    expect(states).toEqual([
      ['retry', 1, 300],
      ['retry', 2, 300],
      ['retry', 3, 300],
      ['retry', 4, 300],
      ['abandoned', 5, 300],
    ]);
  });

  it('resets attempts when the head or scan run changed', async () => {
    const r = await deliverPendingReviewRefreshes(
      doc({
        items: [
          item('a', {
            pr_review_refresh: { state: 'retry', head: 'old', scan_run: 'r1', attempts: 4 },
          }),
        ],
      }),
      effects(async () => {
        throw new DeliveryValueError('bad');
      }),
    );
    const [a] = out(r.queue) as Rows;
    expect(a?.['pr_review_refresh']).toEqual({
      state: 'retry',
      error: 'bad',
      head: 'h',
      scan_run: 'r1',
      attempts: 1,
    });
  });

  it('lets KeyError/TypeError and unknown errors propagate', async () => {
    for (const error of [new DeliveryKeyTypeError("'k'"), new Error('boom')]) {
      await expect(
        deliverPendingReviewRefreshes(
          doc({ items: [item('a')] }),
          effects(async () => {
            throw error;
          }),
        ),
      ).rejects.toBe(error);
    }
  });

  it('passes identity fields and the checkpoint through', async () => {
    const cp: string[] = [];
    const base = effects(async (input) => {
      await input.checkpoint('login', 'why');
      expect(input.postingIdentity).toBe('me');
      expect(input.identityReason).toBe(null);
      return doc({ state: 'existing' });
    });
    await deliverPendingReviewRefreshes(
      doc({ items: [item('a', { pr_review_request: { ...REQUEST, posting_identity: 'me' } })] }),
      {
        ...base,
        checkpoint: async (id, l, r) => void cp.push(`${String(toPlainJson(id))}:${l}:${r}`),
      },
    );
    expect(cp).toEqual(['a:login:why']);
  });
});
