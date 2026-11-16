import { describe, expect, test } from 'vitest';
import {
  CheckpointLog,
  bindDeliveryPhases,
  mapDeliveryError,
  type DeliveryEnv,
} from '../../../src/adapters/crq/deliveryWiring.js';
import {
  DeliveryKeyTypeError,
  DeliveryRuntimeError,
  DeliveryValueError,
  ThreadsNotVisibleError,
} from '../../../src/ops/crq/internal/deliverPending.js';
import {
  JsonNumber,
  JsonObject,
  parseJsonValue,
  toPlainJson,
  type JsonValue,
} from '../../../src/policy/crq/jsonValue.js';
import {
  PrReviewKeyError,
  PrReviewRuntimeError,
  PrReviewTypeError,
  PrReviewValueError,
  type GhPort,
} from '../../../src/policy/crq/prReviewFindings.js';
import { ThreadsNotVisible } from '../../../src/policy/crq/receiptEvidence.js';
import { ReceiptOsError } from '../../../src/policy/crq/receiptPrepare.js';

const doc = (v: unknown): JsonObject => parseJsonValue(JSON.stringify(v)) as JsonObject;
const plain = (v: JsonValue): unknown => toPlainJson(v);
const RUN = 'run-20261115T000000Z-abcdef12';
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
type Rows = Array<Record<string, unknown>>;

describe('mapDeliveryError', () => {
  test('maps each receipt-layer error to the class the passes dispatch on', () => {
    expect(mapDeliveryError(new ThreadsNotVisible('t'))).toBeInstanceOf(ThreadsNotVisibleError);
    expect(mapDeliveryError(new PrReviewKeyError('k'))).toBeInstanceOf(DeliveryKeyTypeError);
    expect(mapDeliveryError(new PrReviewTypeError('t'))).toBeInstanceOf(DeliveryKeyTypeError);
    expect(mapDeliveryError(new PrReviewValueError('v'))).toBeInstanceOf(DeliveryValueError);
    expect(mapDeliveryError(new PrReviewRuntimeError('r'))).toBeInstanceOf(DeliveryRuntimeError);
    expect(mapDeliveryError(new ReceiptOsError('FileNotFoundError', '[Errno 2] x'))).toBeInstanceOf(
      DeliveryRuntimeError,
    );
    const other = new Error('boom');
    expect(mapDeliveryError(other)).toBe(other);
  });

  test('ThreadsNotVisible is not downgraded to a plain runtime error', () => {
    expect(mapDeliveryError(new ThreadsNotVisible('t'))).not.toBeInstanceOf(DeliveryRuntimeError);
  });

  test('a changed key/type error stays distinct from a value error', () => {
    expect(mapDeliveryError(new PrReviewValueError('v'))).not.toBeInstanceOf(DeliveryKeyTypeError);
  });
});

describe('CheckpointLog', () => {
  const queue = (extra: Record<string, unknown> = {}): JsonObject =>
    doc({
      items: [
        { id: 'a', pr_review_request: { run_id: 'r', head: 'h', ...extra } },
        { id: 'b', pr_review_request: { run_id: 'r', head: 'h' } },
      ],
    });
  const saves: JsonObject[] = [];
  const make = (q: JsonObject): CheckpointLog =>
    new CheckpointLog(q, ['pr_review_request'], (saved) => saves.push(saved));
  const requestOf = (q: JsonObject, index: number): unknown =>
    (plain(q) as { items: Array<{ pr_review_request: unknown }> }).items[index]?.pr_review_request;

  test('saves the checkpointed input queue before returning and touches only the named item', () => {
    saves.length = 0;
    const log = make(queue());
    log.record({ itemId: 'a', runId: 'r', head: 'h' }, 'cq-review[bot]', 'why');
    expect(saves).toHaveLength(1);
    expect(requestOf(saves[0] as JsonObject, 0)).toEqual({
      run_id: 'r',
      head: 'h',
      posting_identity: 'cq-review[bot]',
      identity_reason: 'why',
    });
    expect(requestOf(saves[0] as JsonObject, 1)).toEqual({ run_id: 'r', head: 'h' });
  });

  test('a repeated or already-selected identity saves nothing', () => {
    saves.length = 0;
    const log = make(queue());
    const target = { itemId: 'a', runId: 'r', head: 'h' };
    log.record(target, 'x', null);
    log.record(target, 'x', null);
    expect(saves).toHaveLength(1);
    make(queue({ posting_identity: 'x' })).record(target, 'x', null);
    expect(saves).toHaveLength(1);
  });

  test('a different already-selected identity is the Python ValueError', () => {
    expect(() =>
      make(queue({ posting_identity: 'x' })).record(
        { itemId: 'a', runId: 'r', head: 'h' },
        'y',
        null,
      ),
    ).toThrow('changed CRQ posting identity');
  });

  test('only a request with the same run and head is checkpointed', () => {
    saves.length = 0;
    const log = make(queue());
    log.record({ itemId: 'a', runId: 'other', head: 'h' }, 'x', null);
    log.record({ itemId: 'a', runId: 'r', head: 'other' }, 'x', null);
    expect(saves).toHaveLength(0);
  });

  test('an undefined item id matches any item', () => {
    saves.length = 0;
    make(queue()).record({ itemId: undefined, runId: 'r', head: 'h' }, 'x', null);
    expect(requestOf(saves[0] as JsonObject, 0)).toMatchObject({ posting_identity: 'x' });
    expect(requestOf(saves[0] as JsonObject, 1)).toMatchObject({ posting_identity: 'x' });
  });

  test('finish re-applies the recorded checkpoints to the pass output', () => {
    saves.length = 0;
    const log = make(queue());
    log.record({ itemId: 'a', runId: 'r', head: 'h' }, 'x', 'why');
    const output = doc({
      kept: 1,
      items: [
        { id: 'a', n: 2, pr_review_request: { run_id: 'r', head: 'h' } },
        { id: 'b', pr_review_request: { run_id: 'r', head: 'h' } },
      ],
    });
    const done = log.finish(output) as JsonObject;
    expect(plain(done)).toMatchObject({
      kept: 1,
      items: [
        { id: 'a', n: 2, pr_review_request: { posting_identity: 'x', identity_reason: 'why' } },
        { id: 'b', pr_review_request: { run_id: 'r', head: 'h' } },
      ],
    });
    expect(requestOf(done, 1)).toEqual({ run_id: 'r', head: 'h' });
  });

  test('finish with nothing recorded returns the output untouched', () => {
    const output = queue();
    expect(make(queue()).finish(output)).toBe(output);
  });
});

describe('bindDeliveryPhases', () => {
  const NOW = '2026-11-15T00:00:00Z';
  const ok = (stdout: string) => ({
    returncode: JsonNumber.int(0n),
    stdout,
    stderr: '',
  });
  function env(over: Partial<DeliveryEnv> = {}) {
    const calls: string[][] = [];
    const saves: JsonObject[] = [];
    const events: string[] = [];
    const gh: GhPort = (argv) => {
      calls.push([...argv]);
      const path = String(argv[2] ?? '');
      if (/pulls\/\d+$/.test(path))
        return ok(JSON.stringify({ state: 'closed', merged: false, base: BASE, head: HEAD }));
      if (path.includes('/user')) return ok('cq-review[bot]\n');
      return ok('[]');
    };
    const value: DeliveryEnv = {
      gh,
      authenticate: () => gh,
      files: { readBytes: () => null },
      readText: () => '',
      saveQueue: (q) => saves.push(q),
      now: () => NOW,
      primaryRepo: 'o/r',
      event: async (kind) => {
        events.push(kind);
      },
      push: {
        repoMode: async () => null,
        readFindings: async () => '',
        fileIssue: async () => doc({}),
      },
      ...over,
    };
    return { value, calls, saves, events };
  }
  const reviewItem = (
    prefix: 'pr_review' | 'clean_review',
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    id: 'a',
    kind: 'open',
    pr: 5,
    [`${prefix}_pending`]: true,
    [`${prefix}_request`]: {
      run_id: RUN,
      pr: 5,
      base: BASE,
      head: HEAD,
      ndjson: '/runs/x/review.ndjson',
    },
    ...extra,
  });

  test('a PR review checkpoints the identity durably, then delivers and settles', async () => {
    const h = env();
    const out = await bindDeliveryPhases(h.value).deliverPrReviews(
      doc({ items: [reviewItem('pr_review')] }),
    );
    const item = (plain(out.queue) as { items: Rows }).items[0]!;
    expect(item.pr_review).toMatchObject({ state: 'skipped-closed' });
    expect(item.pr_review_pending).toBe(false);
    expect(item.pr_review_request).toMatchObject({ posting_identity: 'cq-review[bot]' });
    expect(h.saves).toHaveLength(1);
    expect(
      (plain(h.saves[0] as JsonObject) as { items: Rows }).items[0]?.pr_review_request,
    ).toMatchObject({
      posting_identity: 'cq-review[bot]',
    });
    expect(out.log).toEqual(['findings review on PR #5 (skipped-closed)']);
  });

  test('the checkpoint save happens before any pull request lookup', async () => {
    const order: string[] = [];
    const h = env();
    const gh = h.value.gh;
    const wrapped: GhPort = (argv, opts) => {
      order.push(`gh:${String(argv[2])}`);
      return gh(argv, opts);
    };
    await bindDeliveryPhases({
      ...h.value,
      gh: wrapped,
      authenticate: () => wrapped,
      saveQueue: () => order.push('save'),
    }).deliverPrReviews(doc({ items: [reviewItem('pr_review')] }));
    expect(order.indexOf('save')).toBeGreaterThanOrEqual(0);
    expect(order.findIndex((s) => /pulls\/5$/.test(s))).toBeGreaterThan(order.indexOf('save'));
  });

  test('a clean review delivers through its own request key', async () => {
    const h = env();
    const out = await bindDeliveryPhases(h.value).deliverCleanReviews(
      doc({ items: [reviewItem('clean_review')] }),
    );
    const item = (plain(out.queue) as { items: Rows }).items[0]!;
    expect(item.clean_review).toMatchObject({ state: 'skipped-closed' });
    expect(item.clean_review_request).toMatchObject({ posting_identity: 'cq-review[bot]' });
    expect(out.log).toEqual(['clean review on PR #5 (skipped-closed)']);
  });

  test('an unreadable ndjson is a retried runtime error, not a crash', async () => {
    const h = env({
      readText: () => {
        throw new ReceiptOsError('FileNotFoundError', '[Errno 2] No such file or directory');
      },
    });
    const out = await bindDeliveryPhases(h.value).deliverPrReviews(
      doc({ items: [reviewItem('pr_review')] }),
    );
    const item = (plain(out.queue) as { items: Rows }).items[0]!;
    expect(item.pr_review_pending).toBe(true);
    expect(item.pr_review_error).toContain('[Errno 2]');
    expect(h.saves).toHaveLength(0);
  });

  test('an invalid delivery identity settles before the ndjson is read', async () => {
    let read = 0;
    const h = env({
      readText: () => {
        read += 1;
        return '';
      },
    });
    const bad = reviewItem('pr_review');
    bad.pr_review_request = { ...(bad.pr_review_request as object), head: 'nothex' };
    const out = await bindDeliveryPhases(h.value).deliverPrReviews(doc({ items: [bad] }));
    const item = (plain(out.queue) as { items: Rows }).items[0]!;
    expect(item.pr_review_pending).toBe(false);
    expect(item.pr_review_error).toBe('invalid PR review delivery identity');
    expect(read).toBe(0);
  });

  test('push findings pass through the issue phase', async () => {
    const h = env();
    const out = await bindDeliveryPhases(h.value).deliverIssues(doc({ items: [] }));
    expect(out.log).toEqual([]);
  });

  test('a refresh with nothing eligible is a no-op', async () => {
    const h = env();
    const q = doc({ items: [reviewItem('pr_review')] });
    const out = await bindDeliveryPhases(h.value).deliverReviewRefreshes(q);
    expect(out.log).toEqual([]);
    expect(h.calls).toHaveLength(0);
  });

  test('a refresh of an ITERATE whole-PR receipt selects identity and checkpoints durably', async () => {
    const h = env();
    const item = reviewItem('pr_review', {
      pr_review_pending: false,
      pr_review: { state: 'created', verdict: 'ITERATE', whole_pr_scan: true },
    });
    const out = await bindDeliveryPhases(h.value).deliverReviewRefreshes(doc({ items: [item] }));
    const row = (plain(out.queue) as { items: Rows }).items[0]!;
    expect(row.pr_review_refresh).toMatchObject({
      state: 'skipped-head',
      head: HEAD,
      scan_run: RUN,
    });
    expect(row.pr_review_request).toMatchObject({ posting_identity: 'cq-review[bot]' });
    expect(h.saves).toHaveLength(1);
  });
});
