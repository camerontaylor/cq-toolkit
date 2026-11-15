import { describe, expect, it } from 'vitest';
import {
  JsonObject,
  parseJsonValue,
  toPlainJson,
  type JsonValue,
} from '../../../src/policy/crq/jsonValue.js';
import {
  DeliveryKeyTypeError,
  DeliveryRuntimeError,
  DeliveryValueError,
  ThreadsNotVisibleError,
} from '../../../src/ops/crq/internal/deliverPending.js';
import {
  deliverPendingPrReviews,
  reviewNdjsonBeside,
  type PrReviewEffects,
} from '../../../src/ops/crq/internal/deliverPrReviews.js';

const doc = (v: unknown): JsonObject => parseJsonValue(JSON.stringify(v)) as JsonObject;
type Rows = Array<Record<string, unknown>>;
const rows = (q: JsonObject): Rows => toPlainJson(q.get('items') as JsonValue) as Rows;
const NOW = '2026-11-15T00:00:00Z';
const REQUEST = { run_id: 'r1', base: 'b', head: 'h', pr: 7, ndjson: '/x/review.ndjson' };
const pending = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  kind: 'open',
  pr_review_pending: true,
  pr_review_request: REQUEST,
  ...extra,
});

interface Harness {
  readonly effects: PrReviewEffects;
  readonly calls: string[];
  readonly events: Array<[string, Record<string, unknown>]>;
}
function harness(
  deliver: (input: Parameters<PrReviewEffects['deliver']>[0]) => Promise<JsonObject>,
): Harness {
  const calls: string[] = [];
  const events: Harness['events'] = [];
  return {
    calls,
    events,
    effects: {
      deliver: async (input) => {
        calls.push(`${input.repo}#${String(toPlainJson(input.pr))}`);
        return deliver(input);
      },
      now: () => NOW,
      primaryRepo: 'o/primary',
      checkpoint: async () => {},
      event: async (kind, data) => {
        events.push([
          kind,
          toPlainJson(new JsonObject(Object.entries(data))) as Record<string, unknown>,
        ]);
      },
    },
  };
}
const ok = async (): Promise<JsonObject> =>
  doc({ state: 'created', review_id: 99, inline: 2, body_only: 1 });
const run = (items: unknown[], h: Harness) => deliverPendingPrReviews(doc({ items }), h.effects);

describe('reviewNdjsonBeside (differential against Python 3.14 Path.with_name)', () => {
  const cases: Array<[string, string | undefined]> = [
    ['a/b/findings.md', 'a/b/review.ndjson'],
    ['/a//b/./c.md', '/a/b/review.ndjson'],
    ['//a/b', '//a/review.ndjson'],
    ['///a/b', '/a/review.ndjson'],
    ['findings.md', 'review.ndjson'],
    ['a/..', 'a/review.ndjson'],
    ['./x/', 'review.ndjson'],
    ['a/b/', 'a/review.ndjson'],
    ['/', undefined],
    ['', undefined],
    ['./', undefined],
  ];
  for (const [input, expected] of cases)
    it(`${JSON.stringify(input)}`, () => expect(reviewNdjsonBeside(input)).toBe(expected));
  it('rejects a non-string', () =>
    expect(reviewNdjsonBeside(5 as unknown as JsonValue)).toBeUndefined());
});

describe('deliverPendingPrReviews', () => {
  it('delivers, records the review, drops the error and emits the delivered event', async () => {
    const h = harness(ok);
    const r = await run([pending('a', { pr_review_error: 'old', pr_review_attempts: 2 })], h);
    expect(r.log).toEqual(['findings review on PR #7 (created)']);
    expect(rows(r.queue)).toEqual([
      {
        id: 'a',
        kind: 'open',
        pr_review_pending: false,
        pr_review_request: REQUEST,
        pr_review_attempts: 3,
        pr_review_attempt_at: NOW,
        pr_review: { state: 'created', review_id: 99, inline: 2, body_only: 1 },
      },
    ]);
    expect(h.events).toEqual([
      [
        'findings_review_delivered',
        { item: 'a', pr: 7, run: 'r1', review: 99, state: 'created', inline: 2, body_only: 1 },
      ],
    ]);
    expect(h.calls).toEqual(['o/primary#7']);
  });

  it('takes the two least-recently-attempted open/delta debts', async () => {
    const h = harness(ok);
    await run(
      [
        pending('late', { pr_review_attempt_at: '2026-11-14T09:00:00Z', repo: 'o/late' }),
        pending('never', { repo: 'o/never' }),
        pending('early', { pr_review_attempt_at: '2026-11-14T01:00:00Z', repo: 'o/early' }),
        pending('main', { kind: 'main' }),
        pending('promo', { kind: 'promotion' }),
        pending('done', { pr_review_pending: false }),
      ],
      h,
    );
    expect(h.calls).toEqual(['o/never#7', 'o/early#7']);
  });

  it('returns quietly for pending debt without a request, after stamping the attempt', async () => {
    const h = harness(ok);
    const r = await run([pending('a', { pr_review_request: null })], h);
    expect(h.calls).toEqual([]);
    expect(rows(r.queue)[0]).toMatchObject({ pr_review_attempt_at: NOW, pr_review_pending: true });
    expect(rows(r.queue)[0]).not.toHaveProperty('pr_review_attempts');
  });

  it('settles a malformed request with the Python exception repr and an abandoned event', async () => {
    const h = harness(ok);
    const r = await run(
      [
        pending('k', { pr_review_request: { run_id: 'r', base: 'b', pr: 7, ndjson: 'x' } }),
        pending('p', { pr_review_request: { run_id: 'r', base: 'b', head: 'h' } }),
      ],
      h,
    );
    const [k, p] = rows(r.queue);
    expect(k).toMatchObject({
      pr_review_error: "malformed findings review request: KeyError('head')",
      pr_review_pending: false,
      pr_review_attempts: 1,
    });
    expect(p?.['pr_review_error']).toBe("malformed findings review request: KeyError('pr')");
    expect(h.calls).toEqual([]);
    expect(r.log[0]).toBe(
      "findings review for PR #None abandoned: malformed findings review request: KeyError('head')",
    );
    expect(h.events[0]).toEqual([
      'findings_review_abandoned',
      {
        item: 'k',
        pr: null,
        run: 'r',
        attempts: 1,
        error: "malformed findings review request: KeyError('head')",
      },
    ]);
  });

  it('reproduces the TypeError text for a string and a list request', async () => {
    const r = await run(
      [pending('s', { pr_review_request: 'abc' }), pending('l', { pr_review_request: [1] })],
      harness(ok),
    );
    expect(rows(r.queue).map((row) => row['pr_review_error'])).toEqual([
      `malformed findings review request: TypeError("string indices must be integers, not 'str'")`,
      "malformed findings review request: TypeError('list indices must be integers or slices, not str')",
    ]);
  });

  it('reproduces the TypeError text for a non-string ndjson and an integer request', async () => {
    const r1 = await run(
      [pending('n', { pr_review_request: { ...REQUEST, ndjson: null } })],
      harness(ok),
    );
    expect(rows(r1.queue)[0]?.['pr_review_error']).toBe(
      `malformed findings review request: TypeError("argument should be a str or an os.PathLike object where __fspath__ returns a str, not 'NoneType'")`,
    );
    const r2 = await run([pending('i', { pr_review_request: 5 })], harness(ok));
    expect(rows(r2.queue)[0]?.['pr_review_error']).toBe(
      `malformed findings review request: TypeError("'int' object is not subscriptable")`,
    );
  });

  it('truncates the abandoned error to 300 characters', async () => {
    const r = await run(
      [pending('a')],
      harness(async () => {
        throw new DeliveryValueError('v'.repeat(400));
      }),
    );
    expect(String(rows(r.queue)[0]?.['pr_review_error']).length).toBe(300);
    expect(rows(r.queue)[0]).toMatchObject({ pr_review_pending: false });
  });

  it('refunds the attempt on ThreadsNotVisible and keeps the debt pending', async () => {
    const r = await run(
      [pending('a', { pr_review_attempts: 2 })],
      harness(async () => {
        throw new ThreadsNotVisibleError('not yet');
      }),
    );
    expect(rows(r.queue)[0]).toMatchObject({
      pr_review_attempts: 2,
      pr_review_error: 'not yet',
      pr_review_pending: true,
    });
    expect(r.log).toEqual([]);
  });

  it('retries a runtime failure until the fifth attempt, then abandons with the count', async () => {
    const h = harness(async () => {
      throw new DeliveryRuntimeError('gh down');
    });
    let q = doc({ items: [pending('a')] });
    const seen: unknown[] = [];
    for (let i = 0; i < 5; i += 1) {
      const r = await deliverPendingPrReviews(q, h.effects);
      q = r.queue;
      const row = rows(q)[0] as Record<string, unknown>;
      seen.push([
        row['pr_review_attempts'],
        row['pr_review_pending'],
        row['pr_review_error'],
        r.log.length,
      ]);
    }
    expect(seen).toEqual([
      [1, true, 'gh down', 0],
      [2, true, 'gh down', 0],
      [3, true, 'gh down', 0],
      [4, true, 'gh down', 0],
      [5, false, '5 attempts failed; last: gh down', 1],
    ]);
    expect(h.events.map(([kind]) => kind)).toEqual(['findings_review_abandoned']);
  });

  it('lets KeyError/TypeError and unknown delivery errors propagate', async () => {
    for (const error of [new DeliveryKeyTypeError("'k'"), new Error('bug')])
      await expect(
        run(
          [pending('a')],
          harness(async () => {
            throw error;
          }),
        ),
      ).rejects.toBe(error);
  });

  it('upgrades undelivered legacy issue debt into a PR-review request, then delivers it', async () => {
    const h = harness(ok);
    const r = await run(
      [
        {
          id: 'a',
          kind: 'open',
          pr: 12,
          issue_pending: true,
          issue_request: {
            findings_md: '/runs/r9/findings.md',
            run_id: 'r9',
            base: 'b9',
            head: 'h9',
            severity_counts: { major: 1 },
          },
        },
      ],
      h,
    );
    expect(rows(r.queue)[0]).toMatchObject({
      issue_pending: false,
      pr_review_pending: false,
      pr_review_attempts: 1,
      pr_review_request: {
        run_id: 'r9',
        pr: 12,
        base: 'b9',
        head: 'h9',
        ndjson: '/runs/r9/review.ndjson',
        severity_counts: { major: 1 },
      },
    });
    expect(h.calls).toEqual(['o/primary#12']);
  });

  it('upgrades malformed legacy debt with a null ndjson that then settles as malformed', async () => {
    const h = harness(ok);
    const r = await run(
      [{ id: 'a', kind: 'delta', pr: 3, issue_pending: true, issue_request: 'nope' }],
      h,
    );
    expect(rows(r.queue)[0]).toMatchObject({
      pr_review_request: {
        run_id: null,
        pr: 3,
        base: null,
        head: null,
        ndjson: null,
        severity_counts: {},
      },
      issue_pending: false,
      pr_review_pending: false,
    });
    expect(String(rows(r.queue)[0]?.['pr_review_error'])).toContain(
      'malformed findings review request',
    );
  });

  it('only clears issue_pending when an issue or a request already exists', async () => {
    const h = harness(ok);
    const r = await run(
      [
        { id: 'i', kind: 'open', issue_pending: true, issue: { n: 1 } },
        pending('q', { issue_pending: true, pr_review_pending: false }),
        { id: 'm', kind: 'main', issue_pending: true },
        { id: 'p', kind: 'promotion', issue_pending: true },
      ],
      h,
    );
    const [i, q, m, p] = rows(r.queue);
    expect(i).toEqual({ id: 'i', kind: 'open', issue_pending: false, issue: { n: 1 } });
    expect(q).toMatchObject({ issue_pending: false, pr_review_request: REQUEST });
    expect(m?.['issue_pending']).toBe(true);
    expect(p?.['issue_pending']).toBe(true);
    expect(h.calls).toEqual([]);
  });

  it('passes the request identity and checkpoints against the item', async () => {
    const cp: string[] = [];
    const h = harness(async (input) => {
      await input.checkpoint('login', 'why');
      expect([input.postingIdentity, input.identityReason]).toEqual(['me', null]);
      return doc({ state: 'existing' });
    });
    await deliverPendingPrReviews(
      doc({ items: [pending('a', { pr_review_request: { ...REQUEST, posting_identity: 'me' } })] }),
      {
        ...h.effects,
        checkpoint: async (id, l, rr) => void cp.push(`${String(toPlainJson(id))}:${l}:${rr}`),
      },
    );
    expect(cp).toEqual(['a:login:why']);
  });
});
