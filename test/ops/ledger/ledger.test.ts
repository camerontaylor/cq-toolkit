// Ledger lane C4 — decision-table test evidence over an IN-MEMORY fake
// store (Map-free structuredClone-backed; no fs): every record/query
// outcome row of the ledger, including the escalation that maps the record
// op onto the FROZEN `needs-human` status, the read-only query, and the
// store-fault rows. Threshold validation has two layers: the registry
// schema rejects an override pair that contradicts itself, and the op
// rejects the RESOLVED pair (a lone suppressAt above the default
// escalateAt) — both pinned here.
import { describe, expect, test } from 'vitest';
import type { LedgerEntry, LedgerFile } from '../../../src/ops/ledger/store.js';
import type { LedgerRecordInput, LedgerStore } from '../../../src/ops/ledger/ledger.js';
import { DEFAULT_THRESHOLD, makeLedgerQuery, makeLedgerRecord } from '../../../src/ops/ledger/ledger.js';
import { LedgerQueryInputSchema, LedgerRecordInputSchema } from '../../../src/ops/ledger/registry.js';

/**
 * An in-memory LedgerStore over a deep-cloned file, counting saves (the
 * read-only query must never bump the counter) and optionally faulting.
 */
function memoryStore(entries: LedgerEntry[] = []): LedgerStore & { saves: () => number; faultSave: () => void } {
  let file: LedgerFile = { version: 1, entries };
  let saveCount = 0;
  let saveFaults = false;
  return {
    load: () => structuredClone(file),
    save: (next) => {
      if (saveFaults) throw new Error('disk full');
      saveCount++;
      file = structuredClone(next);
    },
    saves: () => saveCount,
    faultSave: () => {
      saveFaults = true;
    },
  };
}

/** A store whose load always throws (the corrupt/unreadable-ledger row). */
function brokenStore(): LedgerStore {
  return {
    load: () => {
      throw new Error('EACCES: unreadable ledger');
    },
    save: () => {
      throw new Error('unreachable');
    },
  };
}

function record(store: LedgerStore, input: Omit<LedgerRecordInput, 'root' | 'storePath'>) {
  return makeLedgerRecord(() => store)({ ...input, root: 'unused-root', storePath: 'unused-by-the-fake' });
}

describe('ledger.record — the decision table (default thresholds: suppress 2, escalate 3)', () => {
  test('first record → ok, count 1, escalated false; the ledger was persisted', async () => {
    const store = memoryStore();
    await expect(record(store, { signature: 'sig-a' })).resolves.toEqual({
      status: 'ok',
      value: { signature: 'sig-a', count: 1, escalated: false },
    });
    expect(store.saves()).toBe(1);
  });

  test('count 1 (suppressAt − 1) → ok; a second record reaches suppressAt → still ok', async () => {
    const store = memoryStore();
    await record(store, { signature: 'sig-a' });
    await expect(record(store, { signature: 'sig-a' })).resolves.toEqual({
      status: 'ok',
      value: { signature: 'sig-a', count: 2, escalated: false },
    });
  });

  test('a record at suppressAt is ok AND the signature appears in knownNoise (the suppression view)', async () => {
    const store = memoryStore();
    await record(store, { signature: 'sig-a' });
    await record(store, { signature: 'sig-a' });
    const query = await makeLedgerQuery(() => store)({ root: 'unused-root', storePath: 'ignored' });
    expect(query).toEqual({
      status: 'ok',
      value: {
        entries: [{ signature: 'sig-a', count: 2 }],
        knownNoise: ['sig-a'],
        needsHuman: [],
      },
    });
  });

  test('reaching escalateAt → needs-human, reason naming signature, count, and threshold', async () => {
    const store = memoryStore();
    await record(store, { signature: 'sig-a' });
    await record(store, { signature: 'sig-a' });
    await expect(record(store, { signature: 'sig-a' })).resolves.toEqual({
      status: 'needs-human',
      reason: 'error signature exceeded escalation threshold: sig-a (count 3 ≥ 3)',
    });
  });

  test('further records stay needs-human (the escalation is sticky, counts keep growing)', async () => {
    const store = memoryStore();
    for (let i = 0; i < 5; i++) await record(store, { signature: 'sig-a' });
    await expect(record(store, { signature: 'sig-a' })).resolves.toEqual({
      status: 'needs-human',
      reason: 'error signature exceeded escalation threshold: sig-a (count 6 ≥ 3)',
    });
  });

  test('new signatures insert in canonical order; existing ones keep their slot', async () => {
    const store = memoryStore();
    await record(store, { signature: 'sig-mmm' });
    await record(store, { signature: 'sig-aaa' });
    const query = await makeLedgerQuery(() => store)({ root: 'unused-root', storePath: 'ignored' });
    expect(query.status === 'ok' && query.value.entries.map((e) => e.signature)).toEqual([
      'sig-aaa',
      'sig-mmm',
    ]);
  });

  test('component/note are backfilled when absent and never overwritten once present', async () => {
    const store = memoryStore([{ signature: 'sig-b', count: 1 }]);
    const first = await record(store, { signature: 'sig-b', component: 'core', note: 'first sighting' });
    expect(first.status).toBe('ok'); // count 2
    const second = await record(store, { signature: 'sig-b', component: 'other', note: 'other' });
    expect(second.status).toBe('needs-human'); // count 3 — escalation rides along, fields intact
    const query = await makeLedgerQuery(() => store)({ root: 'unused-root', storePath: 'ignored' });
    expect(query.status === 'ok' && query.value.entries).toEqual([
      { signature: 'sig-b', count: 3, component: 'core', note: 'first sighting' },
    ]);
    expect(query.status === 'ok' && query.value.needsHuman).toEqual(['sig-b']);
  });

  test('component/note are stamped on a brand-new entry', async () => {
    const store = memoryStore();
    await record(store, { signature: 'sig-c', component: 'review', note: 'gh thread 12' });
    const query = await makeLedgerQuery(() => store)({ root: 'unused-root', storePath: 'ignored' });
    expect(query.status === 'ok' && query.value.entries).toEqual([
      { signature: 'sig-c', count: 1, component: 'review', note: 'gh thread 12' },
    ]);
  });
});

describe('ledger.record — threshold overrides', () => {
  test('suppressAt 1 / escalateAt 2: the first record is already known noise, the second escalates', async () => {
    const store = memoryStore();
    await expect(record(store, { signature: 'sig-a', thresholds: { suppressAt: 1, escalateAt: 2 } })).resolves.toEqual(
      { status: 'ok', value: { signature: 'sig-a', count: 1, escalated: false } },
    );
    const query = await makeLedgerQuery(() => store)({ root: 'unused-root', storePath: 'ignored', thresholds: { suppressAt: 1, escalateAt: 2 } });
    expect(query.status === 'ok' && query.value.knownNoise).toEqual(['sig-a']);
    await expect(record(store, { signature: 'sig-a', thresholds: { suppressAt: 1, escalateAt: 2 } })).resolves.toEqual({
      status: 'needs-human',
      reason: 'error signature exceeded escalation threshold: sig-a (count 2 ≥ 2)',
    });
  });

  test('the defaults are the frozen DEFAULT_THRESHOLD (2, 3)', () => {
    expect(DEFAULT_THRESHOLD).toEqual({ suppressAt: 2, escalateAt: 3 });
    expect(Object.isFrozen(DEFAULT_THRESHOLD)).toBe(true);
  });

  test('an override pair with escalateAt ≤ suppressAt is rejected by the registry schema AND the op', async () => {
    expect(LedgerRecordInputSchema.safeParse({ root: 'unused-root', storePath: 'l.json', signature: 's', thresholds: { suppressAt: 3, escalateAt: 3 } }).success).toBe(false);
    expect(LedgerRecordInputSchema.safeParse({ root: 'unused-root', storePath: 'l.json', signature: 's', thresholds: { suppressAt: 1, escalateAt: 2 } }).success).toBe(true);
    const store = memoryStore();
    await expect(
      record(store, { signature: 'sig-a', thresholds: { suppressAt: 3, escalateAt: 3 } }),
    ).resolves.toEqual({
      status: 'failed',
      error: 'ledger: invalid thresholds — escalateAt (3) must be greater than suppressAt (3)',
    });
    expect(store.saves()).toBe(0);
  });

  test('a lone suppressAt above the default escalateAt fails on the RESOLVED pair', async () => {
    const store = memoryStore();
    await expect(record(store, { signature: 'sig-a', thresholds: { suppressAt: 5 } })).resolves.toEqual({
      status: 'failed',
      error: 'ledger: invalid thresholds — escalateAt (3) must be greater than suppressAt (5)',
    });
  });

  test('bounds: suppressAt ≥ 1, escalateAt ≥ 2, integers only (schema and op agree)', async () => {
    const bad = [
      { suppressAt: 0, escalateAt: 2 },
      { suppressAt: 1, escalateAt: 1 },
      { suppressAt: 1.5, escalateAt: 3 },
      { suppressAt: 1, escalateAt: 2.5 },
    ];
    for (const thresholds of bad) {
      expect(
        LedgerRecordInputSchema.safeParse({ root: 'unused-root', storePath: 'l.json', signature: 's', thresholds }).success,
      ).toBe(false);
      const store = memoryStore();
      await expect(record(store, { signature: 'sig-a', thresholds })).resolves.toEqual({
        status: 'failed',
        error: expect.stringContaining('ledger: invalid thresholds'),
      });
    }
  });
});

describe('ledger.record — boundary validation and store faults', () => {
  test('an empty or oversized signature is failed without touching the store', async () => {
    const store = memoryStore();
    await expect(record(store, { signature: '' })).resolves.toEqual({
      status: 'failed',
      error: 'ledger: signature must be a non-empty string',
    });
    await expect(record(store, { signature: 's'.repeat(501) })).resolves.toEqual({
      status: 'failed',
      error: `ledger: signature exceeds 500 characters (501)`,
    });
    expect(store.saves()).toBe(0);
  });

  test('a 500-char signature is accepted', async () => {
    const store = memoryStore();
    await expect(record(store, { signature: 's'.repeat(500) })).resolves.toEqual({
      status: 'ok',
      value: { signature: 's'.repeat(500), count: 1, escalated: false },
    });
  });

  test('a throwing load → failed, naming the cause', async () => {
    const op = makeLedgerRecord(() => brokenStore());
    await expect(op({ root: 'unused-root', storePath: 'l.json', signature: 'sig-a' })).resolves.toEqual({
      status: 'failed',
      error: 'ledger: could not load the error ledger — EACCES: unreadable ledger',
    });
  });

  test('a throwing save → failed, even on the record that would escalate', async () => {
    const store = memoryStore();
    await record(store, { signature: 'sig-a' });
    await record(store, { signature: 'sig-a' });
    store.faultSave();
    await expect(record(store, { signature: 'sig-a' })).resolves.toEqual({
      status: 'failed',
      error: 'ledger: could not save the error ledger — disk full',
    });
  });

  test('a throwing selector is failed too (the registry-bound path can fault)', async () => {
    const op = makeLedgerRecord(() => {
      throw new Error('bad path');
    });
    await expect(op({ root: 'unused-root', storePath: 'l.json', signature: 'sig-a' })).resolves.toEqual({
      status: 'failed',
      error: 'ledger: could not load the error ledger — bad path',
    });
  });
});

describe('ledger.query — read-only, deterministic, canonical', () => {
  test('the query never saves: the save spy stays at zero through any number of queries', async () => {
    const store = memoryStore();
    await record(store, { signature: 'sig-a' });
    const savesAfterRecord = store.saves();
    const query = makeLedgerQuery(() => store);
    await query({ root: 'unused-root', storePath: 'ignored' });
    await query({ root: 'unused-root', storePath: 'ignored' });
    expect(store.saves()).toBe(savesAfterRecord);
  });

  test('a query on a fresh store sees the empty ledger and still never saves', async () => {
    const store = memoryStore();
    await expect(makeLedgerQuery(() => store)({ root: 'unused-root', storePath: 'ignored' })).resolves.toEqual({
      status: 'ok',
      value: { entries: [], knownNoise: [], needsHuman: [] },
    });
    expect(store.saves()).toBe(0);
  });

  test('view determinism: the same store state yields deep-equal views across calls', async () => {
    const store = memoryStore();
    await record(store, { signature: 'sig-b', component: 'core' });
    await record(store, { signature: 'sig-a' });
    await record(store, { signature: 'sig-a' });
    await record(store, { signature: 'sig-a' });
    const query = makeLedgerQuery(() => store);
    const first = await query({ root: 'unused-root', storePath: 'ignored' });
    const second = await query({ root: 'unused-root', storePath: 'ignored' });
    expect(first).toEqual(second);
    expect(first).toEqual({
      status: 'ok',
      value: {
        entries: [
          { signature: 'sig-a', count: 3 },
          { signature: 'sig-b', count: 1, component: 'core' },
        ],
        knownNoise: ['sig-a'],
        needsHuman: ['sig-a'],
      },
    });
  });

  test('entries, knownNoise, and needsHuman are canonically sorted; needsHuman ⊆ knownNoise', async () => {
    const store = memoryStore([
      { signature: 'sig-z', count: 5 },
      { signature: 'sig-m', count: 2 },
      { signature: 'sig-a', count: 1 },
    ]);
    const query = await makeLedgerQuery(() => store)({ root: 'unused-root', storePath: 'ignored' });
    expect(query.status === 'ok' && query.value.entries.map((e) => e.signature)).toEqual([
      'sig-a',
      'sig-m',
      'sig-z',
    ]);
    expect(query.status === 'ok' && query.value.knownNoise).toEqual(['sig-m', 'sig-z']);
    expect(query.status === 'ok' && query.value.needsHuman).toEqual(['sig-z']);
    if (query.status === 'ok') {
      for (const signature of query.value.needsHuman) {
        expect(query.value.knownNoise).toContain(signature);
      }
    }
  });

  test('threshold overrides reshape the same store state (and stay deterministic)', async () => {
    const store = memoryStore([{ signature: 'sig-a', count: 2 }]);
    const query = makeLedgerQuery(() => store);
    const strict = await query({ root: 'unused-root', storePath: 'ignored', thresholds: { suppressAt: 1, escalateAt: 2 } });
    expect(strict.status === 'ok' && strict.value.knownNoise).toEqual(['sig-a']);
    expect(strict.status === 'ok' && strict.value.needsHuman).toEqual(['sig-a']);
    const lax = await query({ root: 'unused-root', storePath: 'ignored', thresholds: { suppressAt: 5, escalateAt: 9 } });
    expect(lax.status === 'ok' && lax.value.knownNoise).toEqual([]);
    expect(lax.status === 'ok' && lax.value.needsHuman).toEqual([]);
  });

  test('a throwing load → failed; invalid thresholds → failed without touching the store', async () => {
    await expect(makeLedgerQuery(() => brokenStore())({ root: 'unused-root', storePath: 'l.json' })).resolves.toEqual({
      status: 'failed',
      error: 'ledger: could not load the error ledger — EACCES: unreadable ledger',
    });
    const store = memoryStore();
    await expect(
      makeLedgerQuery(() => store)({ root: 'unused-root', storePath: 'ignored', thresholds: { suppressAt: 4, escalateAt: 4 } }),
    ).resolves.toEqual({
      status: 'failed',
      error: 'ledger: invalid thresholds — escalateAt (4) must be greater than suppressAt (4)',
    });
    expect(LedgerQueryInputSchema.safeParse({ root: 'unused-root', storePath: 'l.json', thresholds: { escalateAt: 1 } }).success).toBe(
      false,
    );
  });
});

describe('ledger.record — component/note bounds (mirroring the registry schema)', () => {
  test('an oversized component or note is failed without touching the store', async () => {
    const store = memoryStore();
    await expect(record(store, { signature: 'sig-a', component: 'c'.repeat(201) })).resolves.toEqual({
      status: 'failed',
      error: 'ledger: component exceeds 200 characters (201)',
    });
    await expect(record(store, { signature: 'sig-a', note: 'n'.repeat(501) })).resolves.toEqual({
      status: 'failed',
      error: 'ledger: note exceeds 500 characters (501)',
    });
    expect(store.saves()).toBe(0);
  });

  test('component at exactly 200 and note at exactly 500 are accepted', async () => {
    const store = memoryStore();
    await expect(
      record(store, { signature: 'sig-a', component: 'c'.repeat(200), note: 'n'.repeat(500) }),
    ).resolves.toEqual({
      status: 'ok',
      value: { signature: 'sig-a', count: 1, escalated: false },
    });
  });

  test('a non-string component or note is failed without touching the store (no TypeError across the seam)', async () => {
    const store = memoryStore();
    const untyped = (value: unknown) => value as string | undefined; // an untyped caller past any schema
    await expect(record(store, { signature: 'sig-a', component: untyped(42) })).resolves.toEqual({
      status: 'failed',
      error: 'ledger: component must be a string (got number)',
    });
    await expect(record(store, { signature: 'sig-a', component: untyped(null) })).resolves.toEqual({
      status: 'failed',
      error: 'ledger: component must be a string (got null)',
    });
    await expect(record(store, { signature: 'sig-a', note: untyped(false) })).resolves.toEqual({
      status: 'failed',
      error: 'ledger: note must be a string (got boolean)',
    });
    expect(store.saves()).toBe(0);
  });
});

describe('ledger.record — the store lock (concurrent records of one storePath)', () => {
  /**
   * A store whose lock queues each critical section behind the previous one
   * and delays acquisition by a tick — the async-delayed interleaving
   * window the review describes. Within a single process a sync load→save
   * batch cannot interleave anyway; the lock's lost-update value is
   * CROSS-PROCESS (pathLedgerStore binds proper-lockfile). What this pins
   * here is that the op routes the WHOLE load→mutate→save through the lock
   * and AWAITS it: every parallel record comes back with its own numeric
   * count and the file ends at exactly N.
   */
  function lockingStore(entries: LedgerEntry[] = []): LedgerStore & { lockCalls: () => number } {
    let file: LedgerFile = { version: 1, entries };
    let lockCallCount = 0;
    let tail: Promise<unknown> = Promise.resolve();
    const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    return {
      load: () => structuredClone(file),
      save: (next) => {
        file = structuredClone(next);
      },
      lock: (fn) => {
        lockCallCount++;
        const run = tail.then(async () => {
          await delay(2);
          return fn();
        });
        tail = run.catch(() => undefined);
        return run;
      },
      lockCalls: () => lockCallCount,
    };
  }

  test('8 parallel records through a locking store end at count 8, one lock call per record', async () => {
    const store = lockingStore();
    const record = makeLedgerRecord(() => store);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => record({ root: 'unused-root', storePath: 'unused-by-the-fake', signature: 'sig-a' })),
    );
    // Each record observed its OWN increment — the counts 1..8 each appear
    // exactly once (ok values for counts 1–2, the reason string above that).
    const observed = results
      .map((result) =>
        result.status === 'ok'
          ? result.value.count
          : result.status === 'needs-human'
            ? Number(/count (\d+)/.exec(result.reason)?.[1])
            : Number.NaN,
      )
      .sort((a, b) => a - b);
    expect(observed).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(results.filter((result) => result.status === 'needs-human')).toHaveLength(6);
    const query = await makeLedgerQuery(() => store)({ root: 'unused-root', storePath: 'unused-by-the-fake' });
    expect(query.status === 'ok' && query.value.entries).toEqual([{ signature: 'sig-a', count: 8 }]);
    expect(store.lockCalls()).toBe(8);
  });

  test('a throwing lock is failed (the op ran but could not enter the critical section)', async () => {
    const store: LedgerStore = {
      load: () => ({ version: 1, entries: [] }),
      save: () => undefined,
      lock: () => {
        throw new Error('lock stolen');
      },
    };
    await expect(makeLedgerRecord(() => store)({ root: 'unused-root', storePath: 'l.json', signature: 'sig-a' })).resolves.toEqual({
      status: 'failed',
      error: 'ledger: could not update the error ledger — lock stolen',
    });
  });
});
