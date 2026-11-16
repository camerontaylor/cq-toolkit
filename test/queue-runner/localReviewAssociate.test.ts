import { describe, expect, it } from 'vitest';
import { associateLocalReview } from '../../src/queue-runner/localReviewAssociate.js';
import { JsonNumber, JsonObject, parseJsonValue } from '../../src/policy/crq/jsonValue.js';

const inputs = (head: string) => ({
  repo: 'o/r',
  base_commit: 'b'.repeat(40),
  head_commit: head,
  scope: 's',
  projection: 'p',
  config_digest: 'd',
  profile: { a: 1 },
});
const H1 = '1'.repeat(40);
const H2 = '2'.repeat(40);
const B = 'b'.repeat(40);
const mk = (value: unknown): JsonObject => parseJsonValue(JSON.stringify(value)) as JsonObject;
const item = (id: string, state: string, head = H1, extra: object = {}) => ({
  id,
  kind: 'local-review',
  state,
  identity_inputs: inputs(head),
  ...extra,
});
const wanted = (head = H1) => mk(inputs(head));
const effects = (retained: string[] = [], w: JsonObject | null = wanted()) => ({
  facts: async () => w,
  retained: async (i: JsonObject) => retained.includes(String(i.get('id'))),
});
function toPlain(v: unknown): unknown {
  if (v instanceof JsonObject)
    return Object.fromEntries(v.entries.map(([k, x]) => [k, toPlain(x)]));
  if (Array.isArray(v)) return v.map(toPlain);
  if (v instanceof JsonNumber) return Number(v.kind === 'int' ? v.integer : v.float);
  return v;
}
const run = (q: unknown, dry = false, e = effects(), head = H1) =>
  associateLocalReview(mk(q), 'o/r', 7, B, head, dry, e);

type Plain = {
  review_pr_links: Record<string, Record<string, unknown>>;
  items: Array<Record<string, unknown>>;
};

describe('associateLocalReview', () => {
  it('is false without any local-review item and leaves the queue alone', async () => {
    const q = mk({ items: [{ id: 'x', kind: 'fix' }] });
    const r = await associateLocalReview(q, 'o/r', 7, B, H1, false, effects());
    expect(r.associated).toBe(false);
    expect(r.queue).toBe(q);
  });

  it('is false when the facts read fails', async () => {
    const r = await run({ items: [item('a', 'pending')] }, false, effects([], null));
    expect(r.associated).toBe(false);
    expect(r.queue.has('review_pr_links')).toBe(false);
  });

  it('links an active equivalent item and records the observer', async () => {
    const r = await run({ items: [item('a', 'pending')] });
    expect(r.associated).toBe(true);
    const plain = toPlain(r.queue) as Plain;
    expect(plain.review_pr_links['o/r#7']).toEqual({
      repo: 'o/r',
      pr: 7,
      item: 'a',
      head: H1,
      base: B,
    });
    expect(plain.items[0]?.pr_observers).toEqual(['o/r#7']);
  });

  it('prefers the last retained candidate, else the last active one', async () => {
    const q = { items: [item('a', 'done'), item('b', 'pending'), item('c', 'reviewing')] };
    expect((toPlain((await run(q)).queue) as Plain).review_pr_links['o/r#7']?.item).toBe('c');
    expect(
      (toPlain((await run(q, false, effects(['a', 'b']))).queue) as Plain).review_pr_links['o/r#7']
        ?.item,
    ).toBe('b');
    const done = await run({ items: [item('a', 'done')] });
    expect(done.associated).toBe(false);
  });

  it('ignores items that are not equivalent or not local-review', async () => {
    const q = {
      items: [
        item('a', 'pending', H2),
        { id: 'z', kind: 'fix', state: 'pending', identity_inputs: inputs(H1) },
      ],
    };
    expect((await run(q)).associated).toBe(false);
  });

  it('dry run reports the match but writes nothing', async () => {
    const q = mk({ items: [item('a', 'pending')] });
    const r = await associateLocalReview(q, 'o/r', 7, B, H1, true, effects());
    expect(r.associated).toBe(true);
    expect(r.queue).toBe(q);
  });

  it('clears stale on a matching link and does not duplicate the observer', async () => {
    const link = { repo: 'o/r', pr: 7, item: 'a', head: H1, base: B, stale: true };
    const r = await run({
      items: [item('a', 'pending', H1, { pr_observers: ['o/r#7'] })],
      review_pr_links: { 'o/r#7': link },
    });
    const plain = toPlain(r.queue) as Plain;
    expect(plain.review_pr_links['o/r#7']).not.toHaveProperty('stale');
    expect(plain.items[0]?.pr_observers).toEqual(['o/r#7']);
  });

  it('replaces a link that points at another item', async () => {
    const link = { repo: 'o/r', pr: 7, item: 'old', head: H1, base: B };
    const r = await run({ items: [item('a', 'pending')], review_pr_links: { 'o/r#7': link } });
    expect((toPlain(r.queue) as Plain).review_pr_links['o/r#7']?.item).toBe('a');
  });

  it('marks the previous link stale when nothing matches and its head moved', async () => {
    const link = { repo: 'o/r', pr: 7, item: 'a', head: H2, base: B };
    const r = await run({ items: [item('a', 'done')], review_pr_links: { 'o/r#7': link } });
    expect(r.associated).toBe(false);
    expect((toPlain(r.queue) as Plain).review_pr_links['o/r#7']?.stale).toBe(true);
    const same = await run({
      items: [item('a', 'done')],
      review_pr_links: { 'o/r#7': { ...link, head: H1 } },
    });
    expect((toPlain(same.queue) as Plain).review_pr_links['o/r#7']).not.toHaveProperty('stale');
  });

  it('creates an empty review_pr_links when nothing links', async () => {
    const r = await run({ items: [item('a', 'done')] });
    expect((toPlain(r.queue) as Plain).review_pr_links).toEqual({});
    expect(r.queue.has('review_pr_links')).toBe(true);
  });

  it('treats an integral float profile value as equal to the int (Python 1 == 1.0)', async () => {
    const stored = {
      ...item('a', 'pending'),
      identity_inputs: { ...inputs(H1), profile: { a: 1.0 } },
    };
    expect((await run({ items: [stored] })).associated).toBe(true);
    const other = { ...stored, identity_inputs: { ...inputs(H1), profile: { a: 2 } } };
    expect((await run({ items: [other] })).associated).toBe(false);
  });
});
