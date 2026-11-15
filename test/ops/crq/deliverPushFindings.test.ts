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
} from '../../../src/ops/crq/internal/deliverPending.js';
import {
  deliverPendingPushFindings,
  type PushFindingsEffects,
} from '../../../src/ops/crq/internal/deliverPushFindings.js';

const doc = (v: unknown): JsonObject => parseJsonValue(JSON.stringify(v)) as JsonObject;
type Rows = Array<Record<string, unknown>>;
const rows = (q: JsonObject): Rows => toPlainJson(q.get('items') as JsonValue) as Rows;
const NOW = '2026-11-15T00:00:00Z';
const REQUEST = {
  run_id: 'r1',
  base: 'b',
  head: 'h',
  findings_md: '/x/findings.md',
  severity_counts: { high: 1 },
};
const pending = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  kind: 'push-current',
  issue_pending: true,
  issue_request: REQUEST,
  ...extra,
});

function harness(over: Partial<PushFindingsEffects> = {}): {
  effects: PushFindingsEffects;
  filed: Array<Record<string, unknown>>;
  events: Array<[string, Record<string, unknown>]>;
} {
  const filed: Array<Record<string, unknown>> = [];
  const events: Array<[string, Record<string, unknown>]> = [];
  return {
    filed,
    events,
    effects: {
      repoMode: async () => ({ enabled: true }),
      readFindings: async () => '# findings',
      fileIssue: async (input) => {
        filed.push({
          repo: input.repo,
          base: input.base,
          head: input.head,
          md: input.findingsMd,
          meta: toPlainJson(input.meta),
          counts: toPlainJson(input.severityCounts),
        });
        return doc({ issue_url: 'u', issue_number: 12, created: true });
      },
      now: () => NOW,
      primaryRepo: 'o/primary',
      event: async (kind, data) => {
        events.push([
          kind,
          toPlainJson(new JsonObject(Object.entries(data))) as Record<string, unknown>,
        ]);
      },
      ...over,
    },
  };
}
const run = (items: unknown[], over: Partial<PushFindingsEffects> = {}) => {
  const h = harness(over);
  return deliverPendingPushFindings(doc({ items }), h.effects).then((r) => ({ ...r, ...h }));
};

describe('deliverPendingPushFindings', () => {
  it('files the issue, clears the debt and logs', async () => {
    const r = await run([pending('a', { issue_error: 'old', receipt_id: 'rc' })]);
    const [item] = rows(r.queue);
    expect(item).toMatchObject({
      issue: { issue_number: 12 },
      issue_pending: false,
      issue_attempt_at: NOW,
    });
    expect(item).not.toHaveProperty('issue_error');
    expect(r.log).toEqual(['findings issue #12 (created)']);
    expect(r.filed[0]).toEqual({
      repo: 'o/primary',
      base: 'b',
      head: 'h',
      md: '# findings',
      meta: {
        repo: 'o/primary',
        item_id: 'a',
        run_id: 'r1',
        base: 'b',
        head: 'h',
        receipt_id: 'rc',
      },
      counts: { high: 1 },
    });
    expect(r.events).toEqual([['findings_delivered', { item: 'a', issue: 12, state: 'created' }]]);
  });

  it('reports an existing issue', async () => {
    const r = await run([pending('a')], {
      fileIssue: async () => doc({ issue_number: 3, created: false }),
    });
    expect(r.log).toEqual(['findings issue #3 (existing)']);
  });

  it('skips items without a request, with an issue, or not pending', async () => {
    const r = await run([
      pending('a', { issue_request: null }),
      pending('b', { issue: { issue_number: 1 } }),
      pending('c', { issue_pending: false }),
      { id: 'd', kind: 'open', issue_pending: true, issue_request: REQUEST },
      { id: 'e', kind: 'promotion', issue_pending: true, issue_request: REQUEST },
    ]);
    expect(r.filed).toEqual([]);
    expect(rows(r.queue)[0]).toMatchObject({ issue_attempt_at: NOW });
    expect(rows(r.queue)[3]).not.toHaveProperty('issue_attempt_at');
    expect(rows(r.queue)[4]).not.toHaveProperty('issue_attempt_at');
  });

  it('drops the debt when the repo is disabled or unconfigured', async () => {
    for (const mode of [null, { enabled: false }]) {
      const r = await run([pending('a')], { repoMode: async () => mode });
      expect(rows(r.queue)[0]).toMatchObject({ issue_pending: false });
      expect(rows(r.queue)[0]).not.toHaveProperty('issue_error');
      expect(r.filed).toEqual([]);
    }
  });

  it('uses the item repo when set', async () => {
    const seen: string[] = [];
    const r = await run([pending('a', { repo: 'o/other' })], {
      repoMode: async (repo) => {
        seen.push(repo);
        return { enabled: true };
      },
    });
    expect(seen).toEqual(['o/other']);
    expect(r.filed[0]).toMatchObject({ repo: 'o/other' });
  });

  it('records an unreadable findings file and keeps the debt', async () => {
    const r = await run([pending('a')], {
      readFindings: async () => {
        throw new DeliveryRuntimeError('[Errno 2] No such file or directory');
      },
    });
    expect(rows(r.queue)[0]).toMatchObject({
      issue_pending: true,
      issue_error: 'findings markdown unavailable: [Errno 2] No such file or directory',
    });
  });

  it('falls back to the subject range, and flags a missing range', async () => {
    const lacking = { ...REQUEST, base: '', head: undefined };
    const ok = await run([
      pending('a', { issue_request: lacking, subject: { base: 'sb', head: 'sh' } }),
    ]);
    expect(ok.filed[0]).toMatchObject({ base: 'sb', head: 'sh' });
    const bad = await run([pending('a', { issue_request: lacking })]);
    expect(rows(bad.queue)[0]).toMatchObject({
      issue_error: 'findings request lacks a review range',
      issue_pending: true,
    });
  });

  it('truncates a RuntimeError message to 300 chars and keeps the debt', async () => {
    const r = await run([pending('a')], {
      fileIssue: async () => {
        throw new DeliveryRuntimeError('x'.repeat(400));
      },
    });
    expect(String(rows(r.queue)[0]?.issue_error)).toHaveLength(300);
    expect(rows(r.queue)[0]).toMatchObject({ issue_pending: true });
    expect(r.log).toEqual([]);
  });

  it('settles a mode-disabled result without an issue', async () => {
    const r = await run([pending('a')], {
      fileIssue: async () => doc({ issue_number: null, created: false }),
    });
    expect(rows(r.queue)[0]).toMatchObject({
      issue_error: 'findings mode disabled for repository',
      issue_pending: false,
    });
    expect(r.events).toEqual([]);
  });

  it('propagates a request missing findings_md or run_id as KeyError', async () => {
    const { findings_md: _drop, ...noPath } = REQUEST;
    await expect(run([pending('a', { issue_request: noPath })])).rejects.toBeInstanceOf(
      DeliveryKeyTypeError,
    );
    const { run_id: _r, ...noRun } = REQUEST;
    await expect(run([pending('a', { issue_request: noRun })])).rejects.toThrow("'run_id'");
  });

  it('propagates the Python 3.14 Path() TypeError for a non-string path', async () => {
    await expect(
      run([pending('a', { issue_request: { ...REQUEST, findings_md: 5 } })]),
    ).rejects.toThrow(
      "argument should be a str or an os.PathLike object where __fspath__ returns a str, not 'int'",
    );
  });

  it('delivers the two least-recently-attempted, empty stamps first', async () => {
    const r = await run([
      pending('a', { issue_attempt_at: '2026-11-14T00:00:00Z' }),
      pending('b'),
      pending('c', { issue_attempt_at: '2026-11-13T00:00:00Z' }),
    ]);
    expect(r.events.map(([, d]) => d.item)).toEqual(['b', 'c']);
    expect(rows(r.queue)[0]).toMatchObject({ issue_pending: true });
  });
});
