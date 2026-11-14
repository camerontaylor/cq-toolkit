/**
 * Route/adapter regressions for `crq reconcile-merged`.
 *
 * The forge is a seeded GraphQL fake (freeze response plus numeric windows),
 * state is in-memory, and the clock is frozen. The tests prove the durable
 * contract: canonical wrapper bytes, resume without repeating a page, no forge
 * read when a completed checkpoint revalidates, enrollment before the summary,
 * partial reports on transport failure, and durable-write ordering.
 */
import { describe, expect, test } from 'vitest';
import { JsonObject, parseJsonValue, toPlainJson } from '../../../src/policy/crq/jsonValue.js';
import { fromPlainJson } from '../../../src/policy/crq/queueDoc.js';
import { PageFailed, BudgetExhausted } from '../../../src/policy/crq/reconcileInventory.js';
import {
  RECONCILE_METHOD_CLOSED_UPDATED,
  checkpointDigest,
  normalizeInterval,
  reconcileWrapperKey,
} from '../../../src/policy/crq/reconcileCheckpoint.js';
import {
  parseReconcileArgv,
  reconcileMerged,
  runReconcileMerged,
  type ReconcileMergedEffects,
} from '../../../src/ops/crq/reconcileMerged.js';

const A = '2026-10-01T00:00:00Z';
const B = '2026-11-14T11:59:59Z';
const NOW = '2026-11-14T12:00:00Z';
const REPO = 'org/repo';

function sha(n: number): string {
  return n.toString(16).padStart(40, '0');
}

interface Pr {
  readonly mergedAt: string;
  readonly mergeSha?: string;
  readonly head?: string;
}

interface HarnessOptions {
  readonly prs?: ReadonlyMap<number, Pr>;
  /** Throw a transport failure whenever this slot is requested. */
  readonly failAtNumber?: number;
  /** Fail the second numeric page (or the given page number). */
  readonly failOnPage?: number;
  readonly busyTickLock?: boolean;
  /** Fail the Nth queue save (1-based). */
  readonly failQueueSave?: number;
  /** Fail the Nth wrapper write (1-based). */
  readonly failWrapperWrite?: number;
  readonly writeWrapperError?: Error;
}

interface Harness {
  readonly effects: ReconcileMergedEffects;
  readonly wrappers: Map<string, string>;
  queue(): unknown;
  readonly forgeCalls: string[];
  readonly saves: number;
  readonly wrapperWrites: number;
}

function harness(options: HarnessOptions = {}): Harness {
  const prs = options.prs ?? new Map<number, Pr>();
  const ceilings = [...prs.keys()];
  const ceiling = ceilings.length === 0 ? 0 : Math.max(...ceilings);
  const wrappers = new Map<string, string>();
  const forgeCalls: string[] = [];
  let queuePlain: unknown = { items: [], merged_current_requests: {} };
  let saves = 0;
  let wrapperWrites = 0;
  let page = 0;

  const response = (fields: Record<string, unknown>, id = 'R'): unknown =>
    fromPlainJson({ data: { repository: { id, nameWithOwner: REPO, ...fields } } });

  const effects: ReconcileMergedEffects = {
    repo: REPO,
    nowIso: () => NOW,
    async readWrapperText(path) {
      return wrappers.get(path) ?? null;
    },
    async writeWrapperText(path, text) {
      wrapperWrites += 1;
      if (options.failWrapperWrite === wrapperWrites) {
        throw options.writeWrapperError ?? new Error('disk full');
      }
      wrappers.set(path, text);
    },
    reconcilePath: (key) => `/state/reconcile/${key}.json`,
    async forgeQuery(query) {
      forgeCalls.push(query);
      if (query.includes('issues(last:1')) {
        return response({
          issues: { totalCount: 0, nodes: [] },
          pullRequests: {
            totalCount: ceiling,
            nodes: ceiling === 0 ? [] : [{ number: ceiling }],
          },
        });
      }
      page += 1;
      if (options.failOnPage !== undefined && page >= options.failOnPage) {
        throw new PageFailed('forge read unavailable; cursor retained');
      }
      const fields: Record<string, unknown> = {};
      for (const match of query.matchAll(/issueOrPullRequest\(number:(\d+)\)/g)) {
        const number = Number(match[1]);
        if (number === options.failAtNumber) {
          throw new PageFailed('forge read unavailable; cursor retained');
        }
        const record = prs.get(number);
        fields[`n${String(number)}`] = record
          ? {
              __typename: 'PullRequest',
              number,
              baseRefName: 'main',
              mergedAt: record.mergedAt,
              headRefOid: record.head ?? sha(number + 1000),
              mergeCommit: { oid: record.mergeSha ?? sha(number) },
            }
          : { __typename: 'Issue', number };
      }
      return response(fields);
    },
    loadQueue: async () => fromPlainJson(queuePlain) as JsonObject,
    async saveQueue(queue) {
      saves += 1;
      if (options.failQueueSave === saves) throw new Error('queue write failed');
      queuePlain = toPlainJson(queue);
    },
    async withTickLock(work) {
      if (options.busyTickLock === true) return null;
      return work();
    },
  };
  return {
    effects,
    wrappers,
    queue: () => queuePlain,
    forgeCalls,
    get saves() {
      return saves;
    },
    get wrapperWrites() {
      return wrapperWrites;
    },
  };
}

function prs(count: number, mergedAt = '2026-10-02T00:00:00Z'): Map<number, Pr> {
  return new Map(
    Array.from({ length: count }, (_, index) => [index + 1, { mergedAt } satisfies Pr]),
  );
}

function argv(budget = 4, extra: readonly string[] = []): string[] {
  return ['--after', A, '--before', B, '--page-budget', String(budget), ...extra];
}

function wrapperPath(method?: string): string {
  return `/state/reconcile/${reconcileWrapperKey(REPO, normalizeInterval(A, B), method)}.json`;
}

function asObject(value: unknown): JsonObject {
  if (!(value instanceof JsonObject)) throw new Error('expected an object');
  return value;
}

function artifactValue(result: Awaited<ReturnType<typeof runReconcileMerged>>): unknown {
  if (result.artifact.status !== 'ok') {
    throw new Error(`expected ok, got ${result.artifact.error}`);
  }
  return fromPlainJson(result.artifact.value);
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('expected an object');
  }
  return value as Record<string, unknown>;
}

describe('reconcile-merged route', () => {
  test('a complete scan enrolls every represented PR and writes canonical wrapper bytes', async () => {
    const h = harness({ prs: prs(3) });
    const result = await runReconcileMerged(argv(), h.effects);
    expect(result.exitCode).toBe(0);
    expect(result.artifact.status).toBe('ok');
    // The runner prints `result.artifact` with `JSON.stringify`.
    expect(() => JSON.stringify(result.artifact)).not.toThrow();
    const summary = toPlainJson(asObject(artifactValue(result)));
    expect(summary).toMatchObject({
      version: 1,
      complete: true,
      represented: 3,
      intents: 3,
      unsupported: 0,
      reviewed: 0,
      pending_review: 3,
      complete_through: B,
      checkpoint_key: reconcileWrapperKey(REPO, normalizeInterval(A, B)),
    });
    const queue = h.queue() as {
      items: Array<Record<string, unknown>>;
      merged_current_requests: Record<string, unknown>;
      merged_reconcile: Record<string, unknown>;
    };
    expect(queue.items).toHaveLength(3);
    expect(queue.items.every((item) => item['state'] === 'pending')).toBe(true);
    expect(Object.keys(queue.merged_current_requests)).toHaveLength(3);
    expect(queue.merged_reconcile).toMatchObject({ complete: true, represented: 3 });

    const text = h.wrappers.get(wrapperPath());
    expect(text).toBeDefined();
    expect(text?.endsWith('\n')).toBe(true);
    const wrapper = asObject(parseJsonValue(text as string));
    expect([...wrapper.entries.map(([key]) => key)]).toEqual(['source', 'checkpoint', 'digest']);
    expect(wrapper.get('digest')).toBe(checkpointDigest(wrapper));
    const source = asObject(wrapper.get('source'));
    expect(source.get('method')).toBe('all-number-slots-v1');
    expect(asObject(wrapper.get('checkpoint')).get('complete')).toBe(true);
  });

  test('a resumed scan does not repeat a page and completes the remaining window', async () => {
    const h = harness({ prs: prs(60) });
    const first = await runReconcileMerged(argv(1), h.effects);
    expect(first.exitCode).toBe(0);
    const firstSummary = plainRecord(toPlainJson(asObject(artifactValue(first))));
    expect(firstSummary['complete']).toBe(false);
    expect(firstSummary['represented']).toBe(50);
    const firstCalls = h.forgeCalls.length;
    // freeze + page one; nothing is enrolled before completeness.
    expect(firstCalls).toBe(2);
    expect((h.queue() as { items: unknown[] }).items).toEqual([]);

    const second = await runReconcileMerged(argv(1), h.effects);
    expect(second.exitCode).toBe(0);
    const secondSummary = plainRecord(toPlainJson(asObject(artifactValue(second))));
    expect(secondSummary['complete']).toBe(true);
    expect(secondSummary['represented']).toBe(60);
    // No second freeze; exactly the next numeric page.
    expect(h.forgeCalls.length).toBe(firstCalls + 1);
    expect((h.queue() as { items: unknown[] }).items).toHaveLength(60);
  });

  test('a completed wrapper revalidates with no forge read and retries enrollment idempotently', async () => {
    const h = harness({ prs: prs(2) });
    await runReconcileMerged(argv(), h.effects);
    const calls = h.forgeCalls.length;
    const saved = h.queue() as {
      items: unknown[];
      merged_current_requests: Record<string, unknown>;
    };
    const requestIds = Object.keys(saved.merged_current_requests);

    // Simulate a queue write that never reached disk after the wrapper did.
    let resetQueue: unknown = { items: [], merged_current_requests: {} };
    const retry: ReconcileMergedEffects = {
      ...h.effects,
      loadQueue: async () => fromPlainJson(resetQueue) as JsonObject,
      saveQueue: async (queue) => {
        resetQueue = toPlainJson(queue);
      },
    };
    const result = await runReconcileMerged(argv(), retry);
    expect(result.exitCode).toBe(0);
    expect(h.forgeCalls.length).toBe(calls);
    const queue = resetQueue as {
      items: unknown[];
      merged_current_requests: Record<string, unknown>;
    };
    expect(queue.items).toHaveLength(2);
    expect(Object.keys(queue.merged_current_requests)).toEqual(requestIds);
  });

  test('a dry run writes nothing and enrolls nothing', async () => {
    const h = harness({ prs: prs(2) });
    const result = await runReconcileMerged(argv(4, ['--dry-run']), h.effects);
    expect(result.exitCode).toBe(0);
    expect(plainRecord(toPlainJson(asObject(artifactValue(result))))['complete']).toBe(true);
    expect(h.wrapperWrites).toBe(0);
    expect(h.saves).toBe(0);
    expect((h.queue() as { items: unknown[] }).items).toEqual([]);
  });

  test('a transport failure is a partial report, not a lost checkpoint', async () => {
    const h = harness({ prs: prs(60), failOnPage: 2 });
    const result = await runReconcileMerged(argv(2), h.effects);
    expect(result.exitCode).toBe(0);
    const summary = plainRecord(toPlainJson(asObject(artifactValue(result))));
    expect(summary).toMatchObject({
      complete: false,
      represented: 50,
      reason: 'transport-failure',
      transient_failures: 1,
    });
    const wrapper = asObject(parseJsonValue(h.wrappers.get(wrapperPath()) as string));
    const checkpoint = asObject(wrapper.get('checkpoint'));
    expect(checkpoint.get('complete')).toBe(false);
    expect(checkpoint.get('pages_read')).toBeDefined();
    const queue = h.queue() as { items: unknown[]; merged_reconcile: Record<string, unknown> };
    expect(queue.items).toEqual([]);
    expect(queue.merged_reconcile).toMatchObject({ complete: false, reason: 'transport-failure' });
  });

  test('an exhausted budget is reported as a refusal before any wrapper write', async () => {
    const h = harness({ prs: prs(1) });
    const exhausted: ReconcileMergedEffects = {
      ...h.effects,
      forgeQuery: () =>
        Promise.reject(new BudgetExhausted('aggregate forge budget exhausted; cursor retained')),
    };
    const result = await runReconcileMerged(argv(), exhausted);
    expect(result).toEqual({
      artifact: {
        status: 'failed',
        error: 'reconcile-merged refused: aggregate forge budget exhausted; cursor retained',
      },
      exitCode: 3,
    });
    expect(h.wrappers.size).toBe(0);
  });

  test('a wrapper save failure stops before the next fetch and before enrollment', async () => {
    const h = harness({ prs: prs(3), failWrapperWrite: 2 });
    const result = await runReconcileMerged(argv(), h.effects);
    expect(result.exitCode).toBe(3);
    expect(result.artifact).toEqual({
      status: 'failed',
      error:
        'merged discovery storage failure: wrapper-save; tick aborted; persisted progress must be revalidated',
    });
    expect(h.saves).toBe(0);
    // Only the initial source-only wrapper was written; no page snapshot.
    expect(h.wrapperWrites).toBe(2);
    const wrapper = asObject(parseJsonValue(h.wrappers.get(wrapperPath()) as string));
    expect(wrapper.get('checkpoint')).toBeNull();
  });

  test('a queue save failure leaves the complete wrapper for an enrollment retry', async () => {
    const h = harness({ prs: prs(2), failQueueSave: 1 });
    const first = await runReconcileMerged(argv(), h.effects);
    expect(first.exitCode).toBe(3);
    expect(first.artifact.status).toBe('failed');
    if (first.artifact.status === 'failed')
      expect(first.artifact.error).toContain('enrollment-save');
    const calls = h.forgeCalls.length;
    const wrapper = asObject(parseJsonValue(h.wrappers.get(wrapperPath()) as string));
    expect(asObject(wrapper.get('checkpoint')).get('complete')).toBe(true);

    // Retry with a working queue save: no forge read at all.
    const retry = harness({ prs: prs(2) });
    for (const [path, text] of h.wrappers) retry.wrappers.set(path, text);
    const second = await runReconcileMerged(argv(), retry.effects);
    expect(second.exitCode).toBe(0);
    expect(retry.forgeCalls.length).toBe(0);
    expect((retry.queue() as { items: unknown[] }).items).toHaveLength(2);
    expect(h.forgeCalls.length).toBe(calls);
  });

  test('a malformed wrapper is refused by the schema check', async () => {
    const h = harness({ prs: prs(1) });
    h.wrappers.set(wrapperPath(), '{"source": {}}');
    const result = await runReconcileMerged(argv(), h.effects);
    expect(result.exitCode).toBe(3);
    expect(result.artifact).toEqual({
      status: 'failed',
      error: 'reconcile-merged refused: wrapper-schema: required fields malformed',
    });
  });

  test('a busy tick lock is the operator exit-3 refusal', async () => {
    const h = harness({ prs: prs(1), busyTickLock: true });
    const result = await runReconcileMerged(argv(), h.effects);
    expect(result).toEqual({
      artifact: { status: 'failed', error: 'another crq tick holds the lock; exiting' },
      exitCode: 3,
    });
  });

  test('an upper bound at or after the scan clock is refused', async () => {
    const h = harness({ prs: prs(1) });
    const result = await runReconcileMerged(
      ['--after', A, '--before', NOW, '--page-budget', '1'],
      h.effects,
    );
    expect(result.exitCode).toBe(3);
    expect(result.artifact).toEqual({
      status: 'failed',
      error: 'reconcile-merged refused: upper bound must precede scan startup',
    });
  });

  test('the rolling method uses its own key and its unported adapter refuses', async () => {
    const h = harness();
    const interval = normalizeInterval(A, B);
    expect(reconcileWrapperKey(REPO, interval, RECONCILE_METHOD_CLOSED_UPDATED)).not.toBe(
      reconcileWrapperKey(REPO, interval),
    );
    await expect(
      reconcileMerged(
        { after: A, before: B, pageBudget: 1, recent: true, dryRun: true },
        h.effects,
      ),
    ).rejects.toThrow(/closed-updated-v1 discovery page adapter is not ported/);

    const page = fromPlainJson({
      records: [
        {
          number: 1,
          mergedAt: '2026-10-02T00:00:00Z',
          mergeCommit: { oid: sha(1) },
          headRefOid: sha(1001),
        },
      ],
      has_next_page: false,
      next_cursor: null,
    });
    const result = await reconcileMerged(
      {
        after: A,
        before: B,
        pageBudget: 1,
        recent: true,
        pageFetch: () => Promise.resolve(page),
      },
      h.effects,
    );
    expect(result.get('complete')).toBe(true);
    const path = `/state/reconcile/${reconcileWrapperKey(
      REPO,
      interval,
      RECONCILE_METHOD_CLOSED_UPDATED,
    )}.json`;
    expect(h.wrappers.has(path)).toBe(true);
    const wrapper = asObject(parseJsonValue(h.wrappers.get(path) as string));
    expect(asObject(wrapper.get('source')).get('method')).toBe(RECONCILE_METHOD_CLOSED_UPDATED);
    expect((h.queue() as { items: unknown[] }).items).toHaveLength(1);
  });
});

describe('reconcile-merged argv', () => {
  test('accepts --flag=value and --flag value, matching argparse', () => {
    expect(parseReconcileArgv(['--after', A, '--before', B, '--page-budget', '3'])).toEqual({
      after: A,
      before: B,
      pageBudget: 3,
      dryRun: false,
    });
    expect(
      parseReconcileArgv([`--after=${A}`, `--before=${B}`, '--page-budget=3', '--dry-run']),
    ).toEqual({ after: A, before: B, pageBudget: 3, dryRun: true });
  });

  test('missing, unknown and non-integer arguments are usage errors', () => {
    expect(() => parseReconcileArgv(['--after', A])).toThrow(/required/);
    expect(() => parseReconcileArgv(['--after', A, '--before', B])).toThrow(/required/);
    expect(() => parseReconcileArgv(['--after', A, '--before', B, '--page-budget', 'x'])).toThrow(
      /invalid int/,
    );
    expect(() =>
      parseReconcileArgv(['--after', A, '--before', B, '--page-budget', '1', '--wat']),
    ).toThrow(/unrecognized/);
  });
});
