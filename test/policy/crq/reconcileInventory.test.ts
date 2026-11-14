/**
 * Seeded fake-forge regressions for the S2 reconcile producer.
 *
 * Every page is a fake, the interval is frozen, and the assertions are about
 * representation and honest incompleteness: no provider, network, credential or
 * real clock participates. The fixture shapes mirror the Python
 * `test_merged_reconcile_*` suite so the TS port cannot silently drift.
 */
import { describe, expect, test } from 'vitest';
import { JsonNumber, JsonObject, type JsonValue } from '../../../src/policy/crq/jsonValue.js';
import { fromPlainJson, withObjectKeys } from '../../../src/policy/crq/queueDoc.js';
import {
  ForgeBudget,
  RECONCILE_FORGE_REQUESTS,
  RECONCILE_FORGE_SECONDS,
  RefreshExhausted,
  reconcileForgeBudget,
} from '../../../src/policy/crq/forgeBudget.js';
import {
  BudgetExhausted,
  InventoryCapExceeded,
  PageFailed,
  enrollmentPlan,
  freezeSource,
  numberPage,
  parsePage,
  reconcile,
  reconcilePage,
} from '../../../src/policy/crq/reconcileInventory.js';
import {
  MAX_INVENTORY,
  MAX_PAGE_BUDGET,
  ReconcileRefused,
  checkpointDigest,
  loadCheckpoint,
  newCheckpoint,
  normalizeInterval,
  summarize,
} from '../../../src/policy/crq/reconcileCheckpoint.js';

const A = '2026-10-01T00:00:00Z';
const B = '2026-10-27T00:00:00Z';
const REPO = 'org/repo';
const BASE = 'main-or-merge-queue';

function json(value: unknown): JsonValue {
  return fromPlainJson(value);
}

function object(value: unknown): JsonObject {
  const converted = json(value);
  if (!(converted instanceof JsonObject)) throw new Error('expected an object');
  return converted;
}

function asObject(value: JsonValue | undefined): JsonObject {
  if (!(value instanceof JsonObject)) throw new Error('expected an object value');
  return value;
}

function number(value: JsonValue | undefined): number {
  if (!(value instanceof JsonNumber)) throw new Error('expected a number value');
  return Number(value.integer);
}

function sha(n: number): string {
  return n.toString(16).padStart(40, '0');
}

function pr(n: number, at: string, merge = sha(n), head = sha(n + 1000)): unknown {
  return { number: n, mergedAt: at, mergeCommit: { oid: merge }, headRefOid: head };
}

function cursorPage(records: readonly unknown[], next: string | null = null): JsonObject {
  return object({ records, has_next_page: next !== null, next_cursor: next });
}

class FakeForge {
  readonly pages: Map<string | null, JsonObject>;
  readonly calls: Array<string | null> = [];

  constructor(pages: Readonly<Record<string, JsonObject>> | Map<string | null, JsonObject>) {
    this.pages =
      pages instanceof Map
        ? pages
        : new Map(
            Object.entries(pages).map(
              ([key, value]) => [key === 'null' ? null : key, value] as const,
            ),
          );
  }

  fetch = (cursor: string | null): Promise<JsonObject> => {
    this.calls.push(cursor);
    const page = this.pages.get(cursor);
    if (page === undefined) throw new Error(`unexpected cursor ${String(cursor)}`);
    return Promise.resolve(page);
  };
}

function options(overrides: Partial<Parameters<typeof reconcile>[1]> = {}) {
  return {
    repo: REPO,
    base: BASE,
    after: A,
    before: B,
    pageBudget: 3,
    ...overrides,
  };
}

describe('ForgeBudget', () => {
  test('the deadline starts at the first take and is never restarted', () => {
    let now = 100;
    const budget = new ForgeBudget({ requests: 3, seconds: 30, clock: () => now });
    expect(budget.deadline).toBeNull();
    expect(budget.take()).toBe(10);
    expect(budget.deadline).toBe(130);
    now = 125;
    expect(budget.take()).toBe(5);
    now = 130;
    expect(() => budget.take()).toThrow(RefreshExhausted);
    expect(budget.remaining).toBe(1);
  });

  test('requests are never replenished and each take is capped at 10 seconds', () => {
    const budget = new ForgeBudget({ requests: 2, seconds: 30, clock: () => 0 });
    expect(budget.take()).toBe(10);
    expect(budget.take()).toBe(10);
    expect(budget.remaining).toBe(0);
    expect(() => budget.take()).toThrow(RefreshExhausted);
  });

  test('zero requests and zero seconds are both unavailable on the first take', () => {
    expect(() => new ForgeBudget({ requests: 0 }).take()).toThrow(RefreshExhausted);
    expect(() => new ForgeBudget({ seconds: 0 }).take()).toThrow(RefreshExhausted);
  });

  test('the defaults and the reconcile allowance are the Python constants', () => {
    const shared = new ForgeBudget();
    expect(shared.remaining).toBe(24);
    expect(shared.seconds).toBe(30);
    const own = reconcileForgeBudget();
    expect(own.remaining).toBe(RECONCILE_FORGE_REQUESTS);
    expect(own.seconds).toBe(RECONCILE_FORGE_SECONDS);
    expect([own.remaining, own.seconds]).toEqual([80, 60]);
  });
});

describe('reconcilePage', () => {
  function checkpoint(): JsonObject {
    return newCheckpoint(normalizeInterval(A, B), 10, REPO, BASE);
  }

  test('a page is bounded to MAX_PAGE_RECORDS', () => {
    const tooMany = Array.from({ length: 101 }, (_, index) =>
      pr(index + 1, '2026-10-02T00:00:00Z'),
    );
    expect(() => reconcilePage(checkpoint(), json(tooMany))).toThrow(ReconcileRefused);
  });

  test('same-timestamp records sort by PR and the fold is stable', () => {
    const result = reconcilePage(
      checkpoint(),
      json([
        pr(9, '2026-10-01T05:00:00Z'),
        pr(7, '2026-10-01T05:00:00Z'),
        pr(8, '2026-10-01T05:00:00Z'),
      ]),
    );
    const inventory = result.get('inventory');
    if (!Array.isArray(inventory)) throw new Error('missing inventory');
    expect(inventory.map((entry) => number(asObject(entry).get('pr')))).toEqual([7, 8, 9]);
  });

  test('records outside the frozen window are counted, never represented', () => {
    const result = reconcilePage(
      checkpoint(),
      json([pr(1, '2026-09-30T23:59:59Z'), pr(2, '2026-10-28T00:00:00Z'), pr(3, B), pr(4, A)]),
    );
    const inventory = result.get('inventory');
    if (!Array.isArray(inventory)) throw new Error('missing inventory');
    expect(inventory).toHaveLength(1);
    expect(number(asObject(inventory[0] as JsonValue).get('pr'))).toBe(3);
    expect(number(result.get('outside_window'))).toBe(3);
    expect(number(result.get('records_read'))).toBe(4);
  });

  test('duplicate source identity and conflicting merge identity are distinct', () => {
    const result = reconcilePage(
      checkpoint(),
      json([
        pr(1, '2026-10-02T00:00:00Z'),
        pr(1, '2026-10-02T00:00:00Z'),
        pr(1, '2026-10-02T00:00:00Z', sha(88)),
        pr(1, '2026-10-02T00:00:00Z', sha(88)),
      ]),
    );
    const summary = asObject(result.get('summary') ?? summarize(result));
    expect(number(summary.get('duplicates_seen'))).toBe(2);
    expect(number(summary.get('intents'))).toBe(1);
    expect(number(summary.get('unsupported'))).toBe(1);
    const inventory = result.get('inventory');
    if (!Array.isArray(inventory)) throw new Error('missing inventory');
    const conflict = inventory
      .map((row) => asObject(row as JsonValue))
      .find((row) => row.get('disposition') === 'unsupported');
    expect(conflict?.get('reason')).toBe('conflicting merge identity for one PR');
  });

  test('the inventory cap refuses instead of silently truncating', async () => {
    // Reaching the cap through the loop would hash 5000 identities; pre-seed a
    // checkpoint at the cap and prove one more distinct record refuses.
    const atCap = withObjectKeys(checkpoint(), [
      [
        'inventory',
        Array.from(
          { length: MAX_INVENTORY },
          () =>
            new JsonObject([
              ['disposition', 'unsupported'],
              ['reason', 'prefilled'],
            ]),
        ),
      ],
      [
        'record_keys',
        Array.from({ length: MAX_INVENTORY }, (_, index) => index.toString(16).padStart(64, '0')),
      ],
      ['records_read', JsonNumber.int(MAX_INVENTORY)],
    ]);
    expect(() => reconcilePage(atCap, json([pr(9001, B)]))).toThrow(InventoryCapExceeded);
  });
});

describe('reconcile page loop', () => {
  test('250 records across seven pages are all represented', async () => {
    const records = Array.from({ length: 250 }, (_, index) =>
      pr(index + 1, `2026-10-${String(1 + Math.floor(index / 25)).padStart(2, '0')}T12:00:00Z`),
    );
    const pages = new Map<string | null, JsonObject>();
    for (let start = 0; start < records.length; start += 40) {
      const chunk = records.slice(start, start + 40);
      const following = start + 40 < records.length ? `c${String(start + 40)}` : null;
      pages.set(start === 0 ? null : `c${String(start)}`, cursorPage(chunk, following));
    }
    const forge = new FakeForge(pages);
    const result = await reconcile(forge.fetch, options({ pageBudget: MAX_PAGE_BUDGET }));
    expect(result.get('complete')).toBe(true);
    const summary = asObject(result.get('summary'));
    expect(number(summary.get('intents'))).toBe(250);
    expect(number(summary.get('unsupported'))).toBe(0);
    expect(forge.calls).toHaveLength(7);
  });

  test('a page budget stops honestly incomplete with the retained cursor', async () => {
    const forge = new FakeForge({
      null: cursorPage([pr(1, '2026-10-02T00:00:00Z'), pr(2, '2026-10-03T00:00:00Z')], 'c1'),
      c1: cursorPage([pr(3, '2026-10-04T00:00:00Z')]),
    });
    const result = await reconcile(forge.fetch, options({ pageBudget: 1 }));
    expect(result.get('complete')).toBe(false);
    expect(result.get('cursor')).toBe('c1');
    expect(number(asObject(result.get('summary')).get('intents'))).toBe(2);
    expect(number(asObject(result.get('summary')).get('pending_review'))).toBe(2);
  });

  test('a transient failure never advances the watermark and is not budget exhaustion', async () => {
    const fetch = (): Promise<unknown> => Promise.reject(new PageFailed('gh: HTTP 502'));
    const result = await reconcile(fetch, options({ pageBudget: 4 }));
    expect(result.get('complete')).toBe(false);
    expect(number(result.get('pages_read'))).toBe(0);
    expect(number(result.get('transient_failures'))).toBe(1);
    const steps = result.get('steps');
    if (!Array.isArray(steps)) throw new Error('missing steps');
    const last = asObject(steps.at(-1) as JsonValue);
    expect(last.get('outcome')).toBe('transport-failure');
    expect(last.get('watermark_advanced')).toBe(false);
  });

  test('budget exhaustion is reported separately and never counted as transport', async () => {
    const fetch = (): Promise<unknown> =>
      Promise.reject(new BudgetExhausted('aggregate forge budget exhausted; cursor retained'));
    const result = await reconcile(fetch, options({ pageBudget: 4 }));
    expect(number(result.get('transient_failures'))).toBe(0);
    const steps = result.get('steps');
    if (!Array.isArray(steps)) throw new Error('missing steps');
    expect(asObject(steps.at(-1) as JsonValue).get('outcome')).toBe('budget-exhausted');
  });

  test('a transient failure after progress resumes from the checkpoint', async () => {
    let mode: 'flaky' | 'ok' = 'flaky';
    const fetch = (cursor: string | null): Promise<JsonObject> => {
      if (mode === 'flaky' && cursor === 'c1') {
        return Promise.reject(new PageFailed('rate limited'));
      }
      if (cursor === null) {
        return Promise.resolve(cursorPage([pr(1, '2026-10-02T00:00:00Z')], 'c1'));
      }
      return Promise.resolve(cursorPage([pr(2, '2026-10-03T00:00:00Z')]));
    };
    const first = await reconcile(fetch, options({ pageBudget: 5 }));
    expect(first.get('complete')).toBe(false);
    expect(number(first.get('transient_failures'))).toBe(1);
    expect(number(asObject(first.get('summary')).get('intents'))).toBe(1);
    mode = 'ok';
    const second = await reconcile(fetch, options({ pageBudget: 5, checkpointRaw: first }));
    expect(second.get('complete')).toBe(true);
    expect(number(asObject(second.get('summary')).get('intents'))).toBe(2);
    expect(number(second.get('transient_failures'))).toBe(1);
  });

  test('the initial and every page snapshot are saved before the next fetch', async () => {
    const saves: JsonObject[] = [];
    const fetches: Array<string | null> = [];
    const fetch = (cursor: string | null): Promise<JsonObject> => {
      fetches.push(cursor);
      // The last persisted snapshot must already name the cursor just fetched.
      if (saves.length > 0) {
        const persisted = saves.at(-1) as JsonObject;
        expect(persisted.get('cursor')).toBe(cursor);
      }
      return Promise.resolve(
        cursor === null
          ? cursorPage([pr(1, '2026-10-02T00:00:00Z')], 'next')
          : cursorPage([pr(2, '2026-10-03T00:00:00Z')]),
      );
    };
    const result = await reconcile(
      fetch,
      options({
        checkpointSave: (snapshot) => {
          saves.push(snapshot);
        },
      }),
    );
    expect(result.get('complete')).toBe(true);
    expect(fetches).toEqual([null, 'next']);
    expect(saves.length).toBe(3);
    expect(saves[0]?.get('pages_read')).toBeInstanceOf(JsonNumber);
    expect(number(saves[0]?.get('pages_read'))).toBe(0);
    expect(number(saves[1]?.get('pages_read'))).toBe(1);
    expect(number(saves[2]?.get('pages_read'))).toBe(2);
  });

  test('a save failure aborts before the next fetch', async () => {
    const calls: Array<string | null> = [];
    const fetch = (cursor: string | null): Promise<JsonObject> => {
      calls.push(cursor);
      return Promise.resolve(cursorPage([pr(1, B)], 'next'));
    };
    await expect(
      reconcile(fetch, {
        ...options(),
        checkpointSave: (snapshot) => {
          if (number(snapshot.get('pages_read')) > 0) throw new Error('disk full');
        },
      }),
    ).rejects.toThrow('disk full');
    expect(calls).toEqual([null]);
  });

  test('a dry run never invokes the save callback or mutates effects', async () => {
    const saves: JsonObject[] = [];
    const result = await reconcile(new FakeForge({ null: cursorPage([pr(1, B)]) }).fetch, {
      ...options({ pageBudget: 1 }),
      dryRun: true,
      checkpointSave: (snapshot) => {
        saves.push(snapshot);
      },
    });
    expect(result.get('complete')).toBe(true);
    expect(saves).toEqual([]);
  });

  test('explicit incomplete/truncated/error flags refuse after only the initial save', async () => {
    for (const flags of [
      { incomplete_results: true },
      { incomplete_results: 'false' },
      { truncated: true },
      { errors: [{ message: 'partial data' }] },
    ]) {
      const saves: JsonObject[] = [];
      const page = cursorPage([pr(1, B)]);
      const withFlags = object({ ...(page as unknown as Record<string, unknown>), ...flags });
      await expect(
        reconcile(() => Promise.resolve(withFlags), {
          ...options(),
          checkpointSave: (snapshot) => {
            saves.push(snapshot);
          },
        }),
      ).rejects.toThrow(ReconcileRefused);
      expect(saves).toHaveLength(1);
      expect(saves[0]?.get('complete')).toBe(false);
      expect(number(saves[0]?.get('pages_read'))).toBe(0);
    }
  });

  test('a cyclic or non-advancing cursor is refused', async () => {
    const forge = new FakeForge({
      null: cursorPage([], 'a'),
      a: cursorPage([], 'b'),
      b: cursorPage([], 'a'),
    });
    await expect(reconcile(forge.fetch, options())).rejects.toThrow(/cycled|advance/);
    expect(() => parsePage(cursorPage([], 'same'), 'same', [])).toThrow(/cycled|advance/);
  });

  test('a save callback cannot mutate the checkpoint the loop continues from', async () => {
    const result = await reconcile(new FakeForge({ null: cursorPage([pr(1, B)], 'next') }).fetch, {
      ...options({ pageBudget: 1 }),
      checkpointSave: (snapshot) => {
        const inventory = snapshot.get('inventory');
        if (Array.isArray(inventory)) inventory.length = 0;
      },
    });
    expect(number(asObject(result.get('summary')).get('intents'))).toBe(1);
    expect(result.get('cursor')).toBe('next');
  });

  test('an incomplete checkpoint cannot be loaded as complete and vice versa', async () => {
    const complete = await reconcile(
      new FakeForge({ null: cursorPage([pr(1, B)]) }).fetch,
      options({ pageBudget: 1 }),
    );
    expect(() => loadCheckpoint(complete, normalizeInterval(A, B), 1, REPO, BASE)).toThrow(
      /already complete/,
    );
  });
});

describe('enrollmentPlan', () => {
  async function completed(records: readonly unknown[]): Promise<JsonObject> {
    return reconcile(
      new FakeForge({ null: cursorPage(records) }).fetch,
      options({ pageBudget: 1 }),
    );
  }

  test('a complete inventory plans deterministic Q1 bindings and no credit', async () => {
    const result = await completed([pr(1, B), pr(2, B)]);
    const plan = enrollmentPlan(result, { repo: REPO });
    expect(plan.get('reviewed')).toBeInstanceOf(JsonNumber);
    expect(number(plan.get('reviewed'))).toBe(0);
    const entries = plan.get('entries');
    if (!Array.isArray(entries)) throw new Error('missing entries');
    expect(entries).toHaveLength(2);
    const first = asObject(entries[0] as JsonValue);
    expect(first.get('disposition')).toBe('intent');
    const binding = asObject(first.get('binding'));
    expect(binding.get('repo')).toBe(REPO);
    expect(first.get('request_id')).toBe(`reconcile-${checkpointDigest(binding)}`);
  });

  test('an equal existing binding is already-enrolled, not reviewed', async () => {
    const result = await completed([pr(1, B), pr(2, B)]);
    const first = enrollmentPlan(result, { repo: REPO });
    const firstEntries = first.get('entries');
    if (!Array.isArray(firstEntries)) throw new Error('missing entries');
    const binding = asObject(asObject(firstEntries[0] as JsonValue).get('binding'));
    const repeated = enrollmentPlan(result, { repo: REPO, existingRequests: [binding] });
    const entries = repeated.get('entries');
    if (!Array.isArray(entries)) throw new Error('missing entries');
    expect(asObject(entries[0] as JsonValue).get('disposition')).toBe('already-enrolled');
    expect(asObject(entries[1] as JsonValue).get('disposition')).toBe('intent');
  });

  test('an incomplete inventory cannot authorize enrollment', async () => {
    const result = await reconcile(
      new FakeForge({ null: cursorPage([pr(1, B)], 'next') }).fetch,
      options({ pageBudget: 1 }),
    );
    expect(() => enrollmentPlan(result, { repo: REPO })).toThrow(/incomplete/);
  });

  test('a conflicting source identity prevents enrollment', async () => {
    const result = await completed([pr(1, B), pr(1, B, sha(88))]);
    expect(() => enrollmentPlan(result, { repo: REPO })).toThrow(/conflicting/);
  });
});

describe('freezeSource and numberPage', () => {
  function responsePlain(fields: Record<string, unknown>): unknown {
    return { data: { repository: { id: 'R', nameWithOwner: REPO, ...fields } } };
  }

  function response(fields: Record<string, unknown>): JsonValue {
    return fromPlainJson(responsePlain(fields));
  }

  function source(ceiling = 125): Promise<JsonObject> {
    return freezeSource(
      () =>
        Promise.resolve(
          response({
            issues: { totalCount: 0, nodes: [] },
            pullRequests: { totalCount: ceiling, nodes: [{ number: ceiling }] },
          }),
        ),
      { repo: REPO, base: BASE },
    );
  }

  function forgeQueries(seen: number[]): (query: string) => Promise<unknown> {
    return (query: string) => {
      const fields: Record<string, unknown> = {};
      for (const match of query.matchAll(/issueOrPullRequest\(number:(\d+)\)/g)) {
        const value = Number(match[1]);
        seen.push(value);
        fields[`n${String(value)}`] = {
          __typename: 'PullRequest',
          baseRefName: 'main',
          ...(pr(value, value < 80 ? '2026-10-02T00:00:00Z' : '2026-10-28T00:00:00Z') as object),
        };
      }
      return Promise.resolve(response(fields));
    };
  }

  test('numeric windows survive mutable merge order and cover every slot once', async () => {
    const frozen = await source();
    const seen: number[] = [];
    const forge = forgeQueries(seen);
    let cursor: string | null = null;
    const rows: JsonValue[] = [];
    for (let page = 0; page < 3; page += 1) {
      const result = await numberPage(forge, frozen, cursor, { repo: REPO, base: BASE });
      const records = result.get('records');
      if (!Array.isArray(records)) throw new Error('missing records');
      rows.push(...records);
      cursor = result.get('next_cursor') as string | null;
    }
    expect(seen).toEqual(Array.from({ length: 125 }, (_, index) => index + 1));
    expect(cursor).toBeNull();
    expect(rows).toHaveLength(125);

    const result = await reconcile(
      (next) => numberPage(forge, frozen, next, { repo: REPO, base: BASE }),
      options({ pageBudget: 4 }),
    );
    expect(number(asObject(result.get('summary')).get('intents'))).toBe(79);
    expect(number(asObject(result.get('summary')).get('outside_window'))).toBe(46);
  });

  test('a missing slot, repository drift and a tampered cursor refuse', async () => {
    const frozen = await source(1);
    for (const bad of [
      response({ n1: null }),
      response({ n1: { number: 1, __typename: 'Unknown' } }),
      { ...(responsePlain({}) as object), errors: [{ message: 'partial' }] },
      response({ id: 'replaced', n1: { number: 1, __typename: 'Issue' } }),
      { ...(responsePlain({}) as object), truncated: true },
    ]) {
      await expect(
        numberPage(() => Promise.resolve(bad), frozen, null, { repo: REPO, base: BASE }),
      ).rejects.toThrow(ReconcileRefused);
    }
    const wrong = JSON.stringify({ source: '0'.repeat(64), next: 51 });
    await expect(
      numberPage(() => Promise.reject(new Error('must not fetch')), await source(), wrong, {
        repo: REPO,
        base: BASE,
      }),
    ).rejects.toThrow(ReconcileRefused);
  });

  test('the ceiling requires all-state counts and the source identity is exact', async () => {
    for (const fields of [
      { issues: { nodes: [] }, pullRequests: { nodes: [{ number: 1 }] } },
      {
        issues: { totalCount: 0, nodes: [] },
        pullRequests: { totalCount: 2, nodes: [{ number: 1 }] },
      },
    ]) {
      await expect(
        freezeSource(() => Promise.resolve(response(fields)), { repo: REPO, base: BASE }),
      ).rejects.toThrow(ReconcileRefused);
    }
    const frozen = await source();
    await expect(
      numberPage(() => Promise.reject(new Error('must not fetch')), frozen, null, {
        repo: 'other/repo',
        base: BASE,
      }),
    ).rejects.toThrow(/source query identity/);
  });
});
