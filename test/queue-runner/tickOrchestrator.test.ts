import { describe, expect, it } from 'vitest';
import { JsonNumber, JsonObject, type JsonValue } from '../../src/policy/crq/jsonValue.js';
import { withObjectKeys } from '../../src/policy/crq/queueDoc.js';
import {
  RUNNER_DISABLED_LOG,
  runTick,
  runTickLocked,
  type CoverageObservation,
  type TickInput,
  type TickLock,
  type TickPhases,
} from '../../src/queue-runner/tickOrchestrator.js';

const LIVE: TickInput = {
  dry: false,
  only: null,
  ignoreQuiet: false,
  staleAlarmMin: 36,
  statusPath: '/state/status.md',
};
const int = (n: number) => JsonNumber.int(n);
const item = (state: string, kind = 'open') =>
  new JsonObject([
    ['kind', kind],
    ['state', state],
  ]);
const baseQueue = (extra: Array<[string, JsonValue]> = []) =>
  withObjectKeys(
    new JsonObject([
      ['items', [item('reviewing')]],
      ['starts', []],
      ['n', int(0)],
    ]),
    extra,
  );
const seenN = (q: JsonObject) => {
  const n = q.get('n');
  return n instanceof JsonNumber ? Number(n.integer) : -1;
};
const bump = (q: JsonObject) => withObjectKeys(q, [['n', int(seenN(q) + 1)]]);

interface Harness {
  readonly p: TickPhases;
  readonly calls: string[];
  /** The `n` counter each phase saw, proving the queue is threaded in call order. */
  readonly seen: Map<string, number>;
  readonly events: Array<[string, Record<string, unknown>]>;
  readonly notices: string[];
  readonly coverage: CoverageObservation[];
  readonly admitRequests: Array<{ only: string | null; dry: boolean; log: readonly string[] }>;
  readonly health: boolean[];
  readonly loads: boolean[];
  readonly saved: JsonObject[];
}

function harness(over: Partial<TickPhases> = {}, queue: JsonObject = baseQueue()): Harness {
  const calls: string[] = [];
  const seen = new Map<string, number>();
  const events: Array<[string, Record<string, unknown>]> = [];
  const notices: string[] = [];
  const coverage: CoverageObservation[] = [];
  const admitRequests: Harness['admitRequests'] = [];
  const health: boolean[] = [];
  const loads: boolean[] = [];
  const saved: JsonObject[] = [];
  const step = (name: string, q: JsonObject): JsonObject => {
    calls.push(name);
    seen.set(name, seenN(q));
    return bump(q);
  };
  const result = (name: string, q: JsonObject, log: string[] = []) => ({
    queue: step(name, q),
    log,
  });
  const p: TickPhases = {
    runnerDisabled: async () => (calls.push('runnerDisabled'), false),
    loadQueue: async (persist) => (calls.push('loadQueue'), loads.push(persist), queue),
    fetch: async () => void calls.push('fetch'),
    backfillPublish: async (q) => step('backfillPublish', q),
    backfillInventoryMode: async () => (calls.push('backfillInventoryMode'), null),
    backfillInventory: async (q) => step('backfillInventory', q),
    discovery: async (q) => result('discovery', q, ['D']),
    harvestItems: async (q) => result('harvestItems', q, ['H']),
    reconcileCompleted: async (q) => step('reconcileCompleted', q),
    deliverIssues: async (q) => result('deliverIssues', q, ['I']),
    deliverPrReviews: async (q) => result('deliverPrReviews', q, ['R']),
    deliverCleanReviews: async (q) => result('deliverCleanReviews', q, ['C']),
    deliverReviewRefreshes: async (q) => result('deliverReviewRefreshes', q, ['F']),
    repairBackfill: async (q) => step('repairBackfill', q),
    archiveLegacy: async (q) => step('archiveLegacy', q),
    reconcile: async (q) => result('reconcile', q, ['X']),
    parseIso: (v) => (typeof v === 'string' ? Date.parse(v) : null),
    nowMs: () => Date.parse('2026-11-15T12:00:00Z'),
    nowIso: () => '2026-11-15T12:00:00Z',
    event: async (k, d) => void (calls.push('event:' + k), events.push([k, { ...d }])),
    notifyOwner: async (m) => void (calls.push('notifyOwner'), notices.push(m)),
    enrollPrimary: async (q) => result('enrollPrimary', q, ['E1']),
    enrollOthers: async (q) => result('enrollOthers', q, ['E2']),
    readSlotUsage: async (q) => (
      calls.push('readSlotUsage'),
      seen.set('readSlotUsage', seenN(q)),
      { usage: 'U', reserved: ['r'] }
    ),
    admit: async (q, req) => (
      admitRequests.push({ only: req.only, dry: req.dry, log: [...req.log] }),
      {
        ...result('admit', q, ['A']),
        hasCoverage: true,
        globalGate: null,
        remaining: 7,
      }
    ),
    recordCoverage: async (q, o) => (coverage.push(o), step('recordCoverage', q)),
    saveQueue: async (q) =>
      void (calls.push('saveQueue'),
      saved.push(q),
      seen.set('save' + String(saved.length), seenN(q))),
    refreshSlotDeadline: async (q, usage, remaining, gate) => {
      expect([usage, remaining, gate]).toEqual(['U', 7, null]);
      return step('refreshSlotDeadline', q);
    },
    writeStatus: async (q) => void (calls.push('writeStatus'), seen.set('writeStatus', seenN(q))),
    writeHeartbeat: async (q) =>
      void (calls.push('writeHeartbeat'), seen.set('writeHeartbeat', seenN(q))),
    publishLocalReviewPr: async (q) => step('publishLocalReviewPr', q),
    recordClientHealth: async (q, enabled) => (
      health.push(enabled),
      result('recordClientHealth', q, ['K'])
    ),
    mergedDiscoveryEnabled: () => true,
    ...over,
  };
  return { p, calls, seen, events, notices, coverage, admitRequests, health, loads, saved };
}

const FULL_ORDER = [
  'runnerDisabled',
  'loadQueue',
  'fetch',
  'backfillPublish',
  'backfillInventoryMode',
  'discovery',
  'harvestItems',
  'reconcileCompleted',
  'deliverIssues',
  'deliverPrReviews',
  'deliverCleanReviews',
  'deliverReviewRefreshes',
  'repairBackfill',
  'archiveLegacy',
  'reconcile',
  'enrollPrimary',
  'enrollOthers',
  'readSlotUsage',
  'admit',
  'recordCoverage',
  'saveQueue',
  'refreshSlotDeadline',
  'writeStatus',
  'writeHeartbeat',
  'publishLocalReviewPr',
  'recordClientHealth',
  'saveQueue',
];

describe('runTick ordering', () => {
  it('runs every phase of a live unrestricted tick in the exact Python order, threading the queue', async () => {
    const h = harness();
    const log = await runTick(LIVE, h.p);
    expect(h.calls).toEqual(FULL_ORDER);
    expect(h.loads).toEqual([true]);
    // Each queue-returning phase saw the output of the one before it.
    const threaded = [
      'backfillPublish',
      'discovery',
      'harvestItems',
      'reconcileCompleted',
      'deliverIssues',
      'deliverPrReviews',
      'deliverCleanReviews',
      'deliverReviewRefreshes',
      'repairBackfill',
      'archiveLegacy',
      'reconcile',
      'enrollPrimary',
      'enrollOthers',
      'readSlotUsage',
    ];
    threaded.forEach((name, index) => expect(h.seen.get(name), name).toBe(index));
    expect(h.seen.get('admit')).toBe(13);
    expect(h.seen.get('recordCoverage')).toBe(14);
    expect(h.seen.get('save1')).toBe(15);
    expect(h.seen.get('refreshSlotDeadline')).toBe(15);
    expect(h.seen.get('writeStatus')).toBe(16);
    expect(h.seen.get('writeHeartbeat')).toBe(16);
    expect(h.seen.get('publishLocalReviewPr')).toBe(16);
    expect(h.seen.get('recordClientHealth')).toBe(17);
    expect(h.seen.get('save2')).toBe(18);
    expect(log).toEqual(['D', 'H', 'I', 'R', 'C', 'F', 'X', 'E1', 'E2', 'A', 'K']);
  });

  it('stamps last_tick before enrollment and passes it to the coverage ledger', async () => {
    const h = harness();
    await runTick(LIVE, h.p);
    expect(h.coverage[0]?.at).toBe('2026-11-15T12:00:00Z');
    expect(h.saved[0]?.get('last_tick')).toBe('2026-11-15T12:00:00Z');
  });

  it('gives admission the log accumulated so far', async () => {
    const h = harness();
    await runTick(LIVE, h.p);
    expect(h.admitRequests[0]?.log).toEqual(['D', 'H', 'I', 'R', 'C', 'F', 'X', 'E1', 'E2']);
  });

  it('records coverage from start growth, pending items at selection and the gate', async () => {
    const pendingQueue = baseQueue([['items', [item('pending', 'promotion'), item('reviewing')]]]);
    const a = harness({}, pendingQueue);
    await runTick(LIVE, a.p);
    expect(a.coverage[0]).toMatchObject({
      pending: false,
      started: false,
      candidateExists: true,
      blockedReason: null,
    });

    const b = harness(
      {
        admit: async (q) => ({
          queue: withObjectKeys(q, [['starts', [int(1)]]]),
          log: [],
          hasCoverage: false,
          globalGate: 'quiet',
          remaining: 7,
        }),
        refreshSlotDeadline: async (q) => q,
      },
      baseQueue([['items', [item('pending')]]]),
    );
    await runTick({ ...LIVE, only: 'pr1' }, b.p);
    expect(b.coverage[0]).toMatchObject({
      pending: true,
      started: true,
      candidateExists: false,
      blockedReason: 'quiet',
    });
  });
});

describe('runTick early exits and gating', () => {
  it('a disabled runner returns the handover line before loading anything', async () => {
    const h = harness({ runnerDisabled: async () => true });
    expect(await runTick(LIVE, h.p)).toEqual([RUNNER_DISABLED_LOG]);
    expect(h.calls).toEqual([]);
  });

  it('dry skips backfill, discovery, delivery, reconcile, stale alarm and every post-admission write', async () => {
    const stale = baseQueue([['last_tick', '2026-11-14T00:00:00Z']]);
    const h = harness({}, stale);
    const log = await runTick({ ...LIVE, dry: true }, h.p);
    expect(h.calls).toEqual([
      'runnerDisabled',
      'loadQueue',
      'fetch',
      'harvestItems',
      'enrollPrimary',
      'enrollOthers',
      'readSlotUsage',
      'admit',
    ]);
    expect(h.loads).toEqual([false]);
    expect(h.admitRequests[0]).toMatchObject({ dry: true, only: null });
    expect(log).toEqual(['H', 'E1', 'E2', 'A']);
    expect(h.saved).toEqual([]);
  });

  it('only skips discovery but still does the rest of a live tick', async () => {
    const h = harness();
    await runTick({ ...LIVE, only: 'pr7' }, h.p);
    expect(h.calls).toEqual(FULL_ORDER.filter((c) => c !== 'discovery'));
    expect(h.coverage[0]?.blockedReason).toBe('only');
    expect(h.health).toEqual([false]);
    expect(h.admitRequests[0]?.only).toBe('pr7');
  });

  it('an empty-string only skips discovery (is None) yet still allows inventory (not only)', async () => {
    const h = harness({ backfillInventoryMode: async () => 'integrated' });
    await runTick({ ...LIVE, only: '' }, h.p);
    expect(h.calls).not.toContain('discovery');
    expect(h.calls).toContain('backfillInventory');
    expect(h.coverage[0]?.blockedReason).toBeNull();
    expect(h.health).toEqual([false]);
  });

  it('runs inventory only for the integrated rollout and an unrestricted tick', async () => {
    const on = harness({ backfillInventoryMode: async () => 'integrated' });
    await runTick(LIVE, on.p);
    expect(on.calls.slice(3, 7)).toEqual([
      'backfillPublish',
      'backfillInventory',
      'discovery',
      'harvestItems',
    ]);
    const other = harness({ backfillInventoryMode: async () => 'shadow' });
    await runTick(LIVE, other.p);
    expect(other.calls).not.toContain('backfillInventory');
    const restricted = harness({ backfillInventoryMode: async () => 'integrated' });
    await runTick({ ...LIVE, only: 'pr7' }, restricted.p);
    expect(restricted.calls).not.toContain('backfillInventory');
  });

  it('passes merged-discovery enablement to client health only when unrestricted', async () => {
    const on = harness();
    await runTick(LIVE, on.p);
    expect(on.health).toEqual([true]);
    const off = harness({ mergedDiscoveryEnabled: () => false });
    await runTick(LIVE, off.p);
    expect(off.health).toEqual([false]);
  });
});

describe('runTickLocked', () => {
  const lock = (ran: boolean, events: string[] = []): TickLock => ({
    withLock: async (fn) => {
      events.push('acquire');
      if (!ran) return { ran: false };
      try {
        return { ran: true, value: await fn() };
      } finally {
        events.push('release');
      }
    },
  });

  it('a busy lock runs nothing and reports null', async () => {
    const h = harness();
    expect(await runTickLocked(lock(false), LIVE, h.p)).toBeNull();
    expect(h.calls).toEqual([]);
  });

  it('runs the tick under the lock and returns its log; an empty log is still a run', async () => {
    const events: string[] = [];
    const h = harness();
    const log = await runTickLocked(lock(true, events), { ...LIVE, dry: true }, h.p);
    expect(log).toEqual(['H', 'E1', 'E2', 'A']);
    expect(events).toEqual(['acquire', 'release']);
    const quiet = harness({
      runnerDisabled: async () => false,
      harvestItems: async (q) => ({ queue: q, log: [] }),
      enrollPrimary: async (q) => ({ queue: q, log: [] }),
      enrollOthers: async (q) => ({ queue: q, log: [] }),
      admit: async (q) => ({
        queue: q,
        log: [],
        hasCoverage: false,
        globalGate: null,
        remaining: 0,
      }),
    });
    expect(await runTickLocked(lock(true), { ...LIVE, dry: true }, quiet.p)).toEqual([]);
  });

  it('releases the lock and propagates a phase error', async () => {
    const events: string[] = [];
    const h = harness({
      harvestItems: async () => {
        throw new Error('boom');
      },
    });
    await expect(runTickLocked(lock(true, events), LIVE, h.p)).rejects.toThrow('boom');
    expect(events).toEqual(['acquire', 'release']);
  });
});

describe('stale gap', () => {
  const at = (iso: string) => baseQueue([['last_tick', iso]]);

  it('alarms, logs and notifies, then carries on and refreshes last_tick', async () => {
    const h = harness({}, at('2026-11-15T11:00:00Z')); // 60 minutes
    const log = await runTick(LIVE, h.p);
    expect(h.events).toEqual([['tick_gap', { last_tick: '2026-11-15T11:00:00Z', gap_min: 60 }]]);
    expect(log).toContain('tick gap: previous tick was 60m ago (> 36m) — chancellor alerted');
    expect(h.notices[0]).toBe(
      'crq RECOVERED after an outage: the previous completed tick was 2026-11-15T11:00:00Z (60m ago, > 36m). ' +
        "Schedule runs may have reported 'succeeded' meanwhile. See /state/status.md.",
    );
    expect(h.calls.indexOf('event:tick_gap')).toBe(h.calls.indexOf('reconcile') + 1);
    expect(h.calls.indexOf('enrollPrimary')).toBeGreaterThan(h.calls.indexOf('notifyOwner'));
    expect(h.calls.at(-1)).toBe('saveQueue');
    expect(h.saved[0]?.get('last_tick')).toBe('2026-11-15T12:00:00Z');
  });

  it('is silent at or under the threshold, with no previous tick, when dry, or unparseable', async () => {
    for (const q of [at('2026-11-15T11:24:00Z'), baseQueue(), at('garbage')]) {
      const h = harness({}, q);
      await runTick(LIVE, h.p);
      expect(h.events).toEqual([]);
    }
    const dry = harness({}, at('2026-11-10T00:00:00Z'));
    await runTick({ ...LIVE, dry: true }, dry.p);
    expect(dry.events).toEqual([]);
  });

  it('rounds the reported gap half to even and honours the configured threshold', async () => {
    const h = harness({}, at('2026-11-15T11:23:30Z')); // 36.5 minutes
    const log = await runTick({ ...LIVE, staleAlarmMin: 36 }, h.p);
    expect(h.events[0]?.[1].gap_min).toBe(36);
    expect(log).toContain('tick gap: previous tick was 36m ago (> 36m) — chancellor alerted');
    const tight = harness({}, at('2026-11-15T11:50:00Z'));
    await runTick({ ...LIVE, staleAlarmMin: 5 }, tight.p);
    expect(tight.events).toHaveLength(1);
  });
});

describe('backfill fail-closed halt', () => {
  const halted = (q: JsonObject) => [q.get('backfill_halted'), q.get('backfill_halt_operation')];

  it('records a publication-request failure, logs it and runs every later phase', async () => {
    const h = harness({
      backfillPublish: async () => {
        throw new Error('no publish');
      },
      backfillInventoryMode: async () => 'integrated',
    });
    const log = await runTick(LIVE, h.p);
    expect(log[0]).toBe('backfill halted: no publish');
    expect(h.calls).not.toContain('backfillInventory');
    expect(h.calls).not.toContain('backfillInventoryMode');
    expect(h.calls.slice(-3)).toEqual(['publishLocalReviewPr', 'recordClientHealth', 'saveQueue']);
    expect(halted(h.saved[0] as JsonObject)).toEqual(['no publish', 'publication-request']);
  });

  it('attributes an inventory failure to inventory', async () => {
    const h = harness({
      backfillInventoryMode: async () => 'integrated',
      backfillInventory: async () => {
        throw new Error('no inventory');
      },
    });
    await runTick(LIVE, h.p);
    expect(halted(h.saved[0] as JsonObject)).toEqual(['no inventory', 'inventory']);
  });

  it('keeps an earlier halt from another operation but overwrites its own', async () => {
    const boom = async () => {
      throw new Error('again');
    };
    const prior = (op: string) =>
      baseQueue([
        ['backfill_halted', 'old'],
        ['backfill_halt_operation', op],
      ]);
    const other = harness({ backfillPublish: boom }, prior('inventory'));
    const otherLog = await runTick(LIVE, other.p);
    expect(halted(other.saved[0] as JsonObject)).toEqual(['old', 'inventory']);
    expect(otherLog[0]).toBe('backfill halted: again');
    const same = harness({ backfillPublish: boom }, prior('publication-request'));
    await runTick(LIVE, same.p);
    expect(halted(same.saved[0] as JsonObject)).toEqual(['again', 'publication-request']);
  });

  it('truncates the recorded message to 300 code points', async () => {
    const h = harness({
      backfillPublish: async () => {
        throw new Error('😀'.repeat(400));
      },
    });
    const log = await runTick(LIVE, h.p);
    expect(log[0]).toBe('backfill halted: ' + '😀'.repeat(300));
    expect(halted(h.saved[0] as JsonObject)[0]).toBe('😀'.repeat(300));
  });
});

describe('a phase error abandons the rest of the tick', () => {
  const phases = [
    'loadQueue',
    'fetch',
    'discovery',
    'harvestItems',
    'reconcileCompleted',
    'deliverIssues',
    'deliverPrReviews',
    'deliverCleanReviews',
    'deliverReviewRefreshes',
    'repairBackfill',
    'archiveLegacy',
    'reconcile',
    'enrollPrimary',
    'enrollOthers',
    'readSlotUsage',
    'admit',
    'recordCoverage',
    'refreshSlotDeadline',
    'writeStatus',
    'writeHeartbeat',
    'publishLocalReviewPr',
    'recordClientHealth',
  ] as const;

  it.each(phases)('%s throwing leaves every later phase unrun', async (name) => {
    const clean = harness();
    await runTick(LIVE, clean.p);
    const h = harness({
      [name]: async () => {
        throw new Error(`${name} failed`);
      },
    } as Partial<TickPhases>);
    await expect(runTick(LIVE, h.p)).rejects.toThrow(`${name} failed`);
    // Everything before the failing phase ran; nothing after it did.
    const cut = FULL_ORDER.indexOf(name);
    const expected = FULL_ORDER.slice(0, cut);
    expect(h.calls.slice(0, expected.length)).toEqual(expected);
    // The throwing stub does not record itself, so the recorded calls stop at the cut.
    expect(h.calls).toEqual(expected);
  });

  it('a failed delivery before the launch means no launch and no save', async () => {
    const h = harness({
      deliverPrReviews: async () => {
        throw new Error('gh down');
      },
    });
    await expect(runTick(LIVE, h.p)).rejects.toThrow('gh down');
    expect(h.calls).not.toContain('admit');
    expect(h.saved).toEqual([]);
  });

  it('a failure after the first save keeps that save and skips the second', async () => {
    const h = harness({
      recordClientHealth: async () => {
        throw new Error('health');
      },
    });
    await expect(runTick(LIVE, h.p)).rejects.toThrow('health');
    expect(h.saved).toHaveLength(1);
  });
});
