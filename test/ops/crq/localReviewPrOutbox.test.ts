// Ports of `local_review_pr.observe` / `summary` / `write_summary` / `publish`:
// version-keyed enqueue, the two-rows-per-tick bound, the exponential retry delay,
// and the marker-keyed edit-or-create of the one summary comment.
import { describe, expect, it } from 'vitest';
import {
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_ROWS_PER_TICK,
  OutboxRuntimeError,
  SUMMARY_MARKER,
  observeOutbox,
  outboxSummary,
  publishLocalReviewPr,
  writeOutboxSummary,
  type OutboxEffects,
} from '../../../src/ops/crq/localReviewPrOutbox.js';
import {
  JsonNumber,
  JsonObject,
  parseJsonValue,
  toPlainJson,
  type JsonValue,
} from '../../../src/policy/crq/jsonValue.js';
import { GhTimeoutError, type GhPort } from '../../../src/policy/crq/prReviewFindings.js';

const doc = (v: unknown): JsonObject => parseJsonValue(JSON.stringify(v)) as JsonObject;
const plain = (v: JsonValue | undefined): unknown => (v === undefined ? undefined : toPlainJson(v));
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const RUN = 'run-20261115T000000Z-abcdef12';

interface Call {
  readonly argv: readonly string[];
  readonly input: string | null;
}

interface Script {
  login?: string;
  comments?: string; // stdout of the paginated comment list
  failList?: boolean;
  timeoutOnUser?: boolean;
  prHead?: string;
}

function scriptedGh(script: Script = {}): { gh: GhPort; calls: Call[] } {
  const calls: Call[] = [];
  const gh: GhPort = (argv, { inputText }) => {
    calls.push({ argv, input: inputText });
    const joined = argv.join(' ');
    const ok = (stdout: string) => ({ returncode: JsonNumber.int(0), stdout, stderr: '' });
    if (joined === 'gh api user --jq .login') {
      if (script.timeoutOnUser === true) throw new GhTimeoutError('t');
      return ok(`${script.login ?? 'bot-login'}\n`);
    }
    if (
      argv.includes('--paginate') &&
      joined.includes('/issues/') &&
      joined.includes('/comments')
    ) {
      if (script.failList === true)
        return { returncode: JsonNumber.int(1), stdout: '', stderr: 'boom' };
      return ok(script.comments ?? '');
    }
    if (joined.includes('/pulls/') && argv.includes('--jq') && !argv.includes('--paginate')) {
      return ok(
        JSON.stringify({ state: 'open', merged: false, base: BASE, head: script.prHead ?? HEAD }),
      );
    }
    return ok('');
  };
  return { gh, calls };
}

const link = (extra: Record<string, unknown> = {}) => ({
  item: 'i1',
  repo: 'o/r',
  pr: 5,
  head: HEAD,
  base: BASE,
  ...extra,
});

const queueOf = (
  items: unknown[],
  links: Record<string, unknown>,
  more: Record<string, unknown> = {},
): JsonObject => doc({ items, review_pr_links: links, ...more });

describe('observeOutbox', () => {
  it('enqueues one pending row for a new version and records the link version', () => {
    const next = observeOutbox(queueOf([{ id: 'i1', state: 'pending' }], { k1: link() }));
    const links = plain(next.get('review_pr_links')) as Record<string, Record<string, unknown>>;
    expect(links.k1?.state).toBe('in progress');
    expect(links.k1?.version).toEqual(['i1', HEAD, BASE, 'in progress', null]);
    const outbox = plain(next.get('review_pr_outbox')) as Record<string, Record<string, unknown>>;
    expect(outbox.k1).toMatchObject({ pending: true, attempts: 0, state: 'in progress' });
  });

  it('does nothing when the version is unchanged', () => {
    const first = observeOutbox(queueOf([{ id: 'i1', state: 'pending' }], { k1: link() }));
    expect(observeOutbox(first)).toBe(first);
  });

  it('enqueues a fresh row when the item state changes', () => {
    const first = observeOutbox(queueOf([{ id: 'i1', state: 'pending' }], { k1: link() }));
    const done = doc({
      ...(plain(first) as Record<string, unknown>),
      items: [{ id: 'i1', state: 'findings', scope_adequate: true, receipt_id: 'r1' }],
    });
    const next = observeOutbox(done);
    const outbox = plain(next.get('review_pr_outbox')) as Record<string, Record<string, unknown>>;
    expect(outbox.k1).toMatchObject({ state: 'completed', pending: true, attempts: 0 });
    const links = plain(next.get('review_pr_links')) as Record<string, Record<string, unknown>>;
    expect(links.k1?.version).toEqual(['i1', HEAD, BASE, 'completed', 'r1']);
  });

  it('prefers stale over completed and marks a cancelled replaced item superseded', () => {
    const stale = observeOutbox(
      queueOf([{ id: 'i1', state: 'findings', scope_adequate: true }], {
        k1: link({ stale: true }),
      }),
    );
    expect(plain(stale.get('review_pr_links'))).toMatchObject({
      k1: { state: 'stale; prior coverage only' },
    });
    const superseded = observeOutbox(
      queueOf(
        [
          { id: 'i1', state: 'cancelled' },
          { id: 'i2', state: 'pending' },
        ],
        { k1: link() },
        { review_requests: { old: { item: 'i1' }, new: { supersedes: 'old', item: 'i2' } } },
      ),
    );
    expect(plain(superseded.get('review_pr_links'))).toMatchObject({
      k1: { state: 'superseded' },
    });
  });

  it('keeps a cancelled item with no replacement as its own state', () => {
    const next = observeOutbox(queueOf([{ id: 'i1', state: 'cancelled' }], { k1: link() }));
    expect(plain(next.get('review_pr_links'))).toMatchObject({ k1: { state: 'cancelled' } });
  });

  it('skips links whose item is gone and queues with no links', () => {
    const noItem = queueOf([{ id: 'other', state: 'pending' }], { k1: link() });
    expect(observeOutbox(noItem)).toBe(noItem);
    const noLinks = doc({ items: [] });
    expect(observeOutbox(noLinks)).toBe(noLinks);
  });

  it('raises a malformed queue as the Python TypeError would', () => {
    expect(() => observeOutbox(doc({ items: 'x' }))).toThrow(/items must be an array/);
    expect(() => observeOutbox(queueOf([{ state: 'pending' }], { k1: link() }))).toThrow("'id'");
  });
});

describe('outboxSummary', () => {
  const row = doc({ head: HEAD, base: BASE, state: 'completed', repo: 'o/r', pr: 5 });

  it('links only a review url on this very pull request', () => {
    const own = outboxSummary(row, doc({ review_url: 'https://github.com/o/r/pull/5/x#1' }));
    expect(own).toContain('[Inline findings](https://github.com/o/r/pull/5/x#1)');
    const foreign = outboxSummary(row, doc({ review_url: 'https://evil.example/o/r/pull/5/x' }));
    expect(foreign).not.toContain('Inline findings');
  });

  it('starts with the marker and the disclaimer', () => {
    const body = outboxSummary(row, doc({}));
    expect(
      body.startsWith(`${SUMMARY_MARKER}\nCodeRabbit CLI via crq; not an independent PASS\n`),
    ).toBe(true);
    expect(body).toContain(`Reviewed head: \`${HEAD}\`.`);
    expect(body).toContain('State: completed.');
  });
});

describe('writeOutboxSummary', () => {
  const row = doc({ head: HEAD, base: BASE, state: 'completed', repo: 'o/r', pr: 5 });
  const body = outboxSummary(row, doc({}));

  it('creates the comment when this login has none', () => {
    const { gh, calls } = scriptedGh();
    writeOutboxSummary(row, body, gh);
    const write = calls[calls.length - 1];
    expect(write?.argv).toEqual([
      'gh',
      'api',
      '--method',
      'POST',
      'repos/o/r/issues/5/comments',
      '--input',
      '-',
    ]);
    expect(JSON.parse(write?.input ?? '')).toEqual({ body });
  });

  it('filters the list by this login and the marker prefix', () => {
    const { gh, calls } = scriptedGh({ login: 'bot-x' });
    writeOutboxSummary(row, body, gh);
    const list = calls.find((call) => call.argv.includes('--paginate'));
    expect(list?.argv[3]).toBe('repos/o/r/issues/5/comments?per_page=100');
    const jq = list?.argv[5] ?? '';
    expect(jq).toContain('.user.login == "bot-x"');
    expect(jq).toContain(`startswith("${SUMMARY_MARKER}")`);
  });

  it('edits the existing comment in place when the body differs', () => {
    const { gh, calls } = scriptedGh({ comments: `{"id": 77, "body": "old"}\n` });
    writeOutboxSummary(row, body, gh);
    const write = calls[calls.length - 1];
    expect(write?.argv.slice(2, 5)).toEqual(['--method', 'PATCH', 'repos/o/r/issues/comments/77']);
  });

  it('writes nothing when the existing comment already holds the body', () => {
    const { gh, calls } = scriptedGh({ comments: `${JSON.stringify({ id: 77, body })}\n` });
    writeOutboxSummary(row, body, gh);
    expect(calls.some((call) => call.argv.includes('--input'))).toBe(false);
  });

  it('turns a failed list into a retryable runtime error', () => {
    const { gh } = scriptedGh({ failList: true });
    expect(() => writeOutboxSummary(row, body, gh)).toThrow(/exit 1: boom/);
  });
});

interface Harness {
  readonly effects: OutboxEffects;
  readonly saves: JsonObject[];
  readonly calls: Call[];
}

function harness(
  options: {
    script?: Script;
    now?: number;
    retained?: (item: JsonObject) => JsonObject | null;
    findings?: string;
  } = {},
): Harness {
  const { gh, calls } = scriptedGh(options.script);
  const saves: JsonObject[] = [];
  const effects: OutboxEffects = {
    saveQueue: (queue) => {
      saves.push(queue);
    },
    iso: () => '2026-11-20T00:00:00Z',
    epochSeconds: () => options.now ?? 1000,
    retained: (item) => Promise.resolve(options.retained?.(item) ?? null),
    gh,
    findingsPath: (runId) => `/state/runs/${runId}/review.ndjson`,
    readText: () => options.findings ?? '',
  };
  return { effects, saves, calls };
}

const outboxOf = (queue: JsonObject): Record<string, Record<string, unknown>> =>
  plain(queue.get('review_pr_outbox')) as Record<string, Record<string, unknown>>;

describe('publishLocalReviewPr', () => {
  it('observes, saves, then posts the in-progress summary and clears the row', async () => {
    const h = harness();
    const next = await publishLocalReviewPr(
      queueOf([{ id: 'i1', state: 'pending' }], { k1: link() }),
      h.effects,
    );
    expect(outboxOf(next).k1).toMatchObject({
      pending: false,
      error: null,
      attempts: 1,
      attempt_at: '2026-11-20T00:00:00Z',
    });
    // One save for the observation, one after the row.
    expect(h.saves).toHaveLength(2);
    expect(outboxOf(h.saves[0] as JsonObject).k1).toMatchObject({ pending: true, attempts: 0 });
    expect(h.calls.some((call) => call.argv.includes('POST'))).toBe(true);
  });

  it('delivers a retained receipt, records its outcome and stays quiet on empty findings', async () => {
    const h = harness({ retained: () => doc({ run_id: RUN, outcome: 'clean' }) });
    const next = await publishLocalReviewPr(
      queueOf([{ id: 'i1', state: 'clean', scope_adequate: true, receipt_id: 'r1' }], {
        k1: link(),
      }),
      h.effects,
    );
    const row = outboxOf(next).k1;
    expect(row).toMatchObject({ pending: false, state: 'clean' });
    expect(row?.review).toMatchObject({ state: 'skipped-empty' });
    const summary = h.calls.find((call) => call.input?.includes(SUMMARY_MARKER));
    expect(summary).toBeDefined();
  });

  it('marks the row stale when the pull request head moved', async () => {
    const h = harness({
      script: { prHead: 'c'.repeat(40) },
      retained: () => doc({ run_id: RUN, outcome: 'findings' }),
    });
    const next = await publishLocalReviewPr(
      queueOf([{ id: 'i1', state: 'findings', scope_adequate: true }], { k1: link() }),
      h.effects,
    );
    expect(outboxOf(next).k1).toMatchObject({
      state: 'stale; prior coverage only',
      pending: false,
    });
  });

  it('records a retryable failure with an exponential delay and keeps the row pending', async () => {
    const h = harness({ script: { failList: true }, now: 1000 });
    const next = await publishLocalReviewPr(
      queueOf([{ id: 'i1', state: 'pending' }], { k1: link() }),
      h.effects,
    );
    const row = outboxOf(next).k1;
    expect(row?.pending).toBe(true);
    expect(row?.attempts).toBe(1);
    expect(row?.error).toMatch(/exit 1: boom/);
    expect(row?.retry_at).toBe(1120); // 1000 + 60 * 2**1
  });

  it('caps the delay at an hour', async () => {
    const h = harness({ script: { failList: true }, now: 0 });
    const queue = observeOutbox(queueOf([{ id: 'i1', state: 'pending' }], { k1: link() }));
    const four = doc({
      ...(plain(queue) as Record<string, unknown>),
      review_pr_outbox: { k1: { ...outboxOf(queue).k1, attempts: 4 } },
    });
    const next = await publishLocalReviewPr(four, h.effects);
    expect(outboxOf(next).k1?.retry_at).toBe(1920); // attempts 5: 60 * 32
    expect(OUTBOX_MAX_ATTEMPTS).toBe(5);
  });

  it('records a missing retained receipt as the outbox runtime error', async () => {
    const h = harness({ retained: () => null });
    const next = await publishLocalReviewPr(
      queueOf([{ id: 'i1', state: 'findings', scope_adequate: true }], { k1: link() }),
      h.effects,
    );
    expect(outboxOf(next).k1).toMatchObject({
      pending: true,
      error: new OutboxRuntimeError('retained receipt unavailable').message,
    });
  });

  it('keeps the partial state of a row that failed after the receipt was read', async () => {
    const h = harness({
      script: { failList: true },
      retained: () => doc({ run_id: RUN, outcome: 'findings' }),
    });
    const next = await publishLocalReviewPr(
      queueOf([{ id: 'i1', state: 'findings', scope_adequate: true }], { k1: link() }),
      h.effects,
    );
    const row = outboxOf(next).k1;
    expect(row?.pending).toBe(true);
    expect(row?.state).toBe('findings');
    expect(row?.review).toMatchObject({ state: 'skipped-empty' });
  });

  it('skips rows past the attempt cap, not yet due, or no longer pending', async () => {
    const h = harness({ now: 100 });
    const observed = observeOutbox(
      queueOf(
        [
          { id: 'i1', state: 'pending' },
          { id: 'i2', state: 'pending' },
          { id: 'i3', state: 'pending' },
        ],
        { k1: link(), k2: link({ item: 'i2' }), k3: link({ item: 'i3' }) },
      ),
    );
    const base = outboxOf(observed);
    const queue = doc({
      ...(plain(observed) as Record<string, unknown>),
      review_pr_outbox: {
        k1: { ...base.k1, attempts: OUTBOX_MAX_ATTEMPTS },
        k2: { ...base.k2, retry_at: 500.5 },
        k3: { ...base.k3, pending: false },
      },
    });
    const next = await publishLocalReviewPr(queue, h.effects);
    expect(outboxOf(next)).toEqual(outboxOf(queue));
    expect(h.saves).toHaveLength(1); // only the observation
    expect(h.calls).toHaveLength(0);
  });

  it('delivers at most two rows a tick, oldest attempt first', async () => {
    const h = harness();
    const ids = ['i1', 'i2', 'i3'];
    const observed = observeOutbox(
      queueOf(
        ids.map((id) => ({ id, state: 'pending' })),
        Object.fromEntries(ids.map((id) => [`k-${id}`, link({ item: id })])),
      ),
    );
    const base = outboxOf(observed);
    const queue = doc({
      ...(plain(observed) as Record<string, unknown>),
      review_pr_outbox: {
        'k-i1': { ...base['k-i1'], attempt_at: '2026-11-19T03:00:00Z' },
        'k-i2': { ...base['k-i2'], attempt_at: '2026-11-19T01:00:00Z' },
        'k-i3': { ...base['k-i3'], attempt_at: '2026-11-19T02:00:00Z' },
      },
    });
    const next = await publishLocalReviewPr(queue, h.effects);
    const out = outboxOf(next);
    expect(OUTBOX_ROWS_PER_TICK).toBe(2);
    expect(out['k-i2']?.pending).toBe(false);
    expect(out['k-i3']?.pending).toBe(false);
    expect(out['k-i1']?.pending).toBe(true);
    expect(h.saves).toHaveLength(3);
  });

  it('lets an unexpected exception escape, as an uncaught Python one would', async () => {
    const h = harness({ script: { timeoutOnUser: true } });
    // A gh timeout is a PrReviewRuntimeError (expected), so force a different class.
    const effects: OutboxEffects = {
      ...h.effects,
      gh: () => {
        throw new TypeError('not expected');
      },
    };
    await expect(
      publishLocalReviewPr(queueOf([{ id: 'i1', state: 'pending' }], { k1: link() }), effects),
    ).rejects.toThrow('not expected');
  });

  it('records a gh timeout as a retryable row error', async () => {
    const h = harness({ script: { timeoutOnUser: true } });
    const next = await publishLocalReviewPr(
      queueOf([{ id: 'i1', state: 'pending' }], { k1: link() }),
      h.effects,
    );
    expect(outboxOf(next).k1?.pending).toBe(true);
    expect(String(outboxOf(next).k1?.error)).toContain('timed out');
  });
});
