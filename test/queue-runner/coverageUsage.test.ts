import { describe, expect, it } from 'vitest';
import {
  CoverageIdentityError,
  coverageFallback,
  pyPrefix,
  usageAge,
  usageContext,
  type CoverageEffects,
  type Item,
  type Queue,
} from '../../src/queue-runner/coverageUsage.js';

const T0 = Date.parse('2026-11-15T12:00:00Z');
const ms = (s: string): number => {
  const v = Date.parse(s);
  if (Number.isNaN(v)) throw new RangeError('bad timestamp');
  return v;
};
const usageFx = { iso: () => '2026-11-15T12:00:00Z', timestampMs: ms };

function cov(over: Item = {}): Item {
  return { id: 'cov-1', kind: 'coverage', state: 'pending', ...over };
}
function harness(over: Partial<CoverageEffects> = {}, items: Item[] = [cov()]) {
  const q: Queue = { items };
  const log: string[] = [];
  const calls: string[] = [];
  const fx: CoverageEffects = {
    select: async () => ({ started: null, available: false }),
    backfillDispatchConfigured: () => false,
    mergeQueueSha: async () => 'mq1',
    liveItems: (queue) => queue.items.filter((i) => i.kind !== 'promotion'),
    compareItems: (a, b) => String(a.id).localeCompare(String(b.id)),
    measureMerged: async () => ({ m: 1 }),
    coverageCandidate: () => null,
    nowMs: () => T0,
    parseIsoMs: ms,
    depsMet: () => true,
    legacyOrigins: () => ({ source: { pr: 7 }, origins: ['o1'] }),
    legacyRetryAllowed: () => true,
    buildSynthetic: async () => ({ base: 'b', head: 'h', paths: 1 }),
    diffNameOnly: async () => 'a.ts\n',
    rank4Gate: async () => true,
    launch: async (_q, item) => {
      calls.push('launch');
      item.state = 'reviewing';
      return 'run-1';
    },
    bindRun: () => calls.push('bind'),
    cancelBeforeVendor: () => calls.push('cancel'),
    ...over,
  };
  return { q, log, calls, fx };
}

describe('coverageFallback', () => {
  it('returns the backfill selection untouched when it started or found something', async () => {
    const h = harness({ select: async () => ({ started: 'r9', available: true }) });
    expect(await coverageFallback(h.q, h.log, false, null, true, h.fx)).toEqual({
      started: 'r9',
      available: true,
    });
    const h2 = harness({ select: async () => ({ started: null, available: true }) });
    expect(await coverageFallback(h2.q, h2.log, false, null, true, h2.fx)).toEqual({
      started: null,
      available: true,
    });
    expect(h2.calls).toEqual([]);
  });

  it('yields to a configured dispatch and to an `only` filter', async () => {
    const a = harness({ backfillDispatchConfigured: () => true });
    expect(await coverageFallback(a.q, a.log, false, null, true, a.fx)).toEqual({
      started: null,
      available: false,
    });
    const b = harness();
    expect(await coverageFallback(b.q, b.log, false, 'cov-1', true, b.fx)).toEqual({
      started: null,
      available: false,
    });
    expect(b.calls).toEqual([]);
  });

  it('pins coverage_sha with setdefault semantics', async () => {
    const h = harness({}, [cov(), cov({ id: 'cov-2', coverage_sha: 'keep' })]);
    await coverageFallback(h.q, h.log, true, null, true, h.fx);
    expect(h.q.items[0]?.coverage_sha).toBe('mq1');
    expect(h.q.items[1]?.coverage_sha).toBe('keep');
  });

  it('dry-run reports the first eligible candidate and launches nothing', async () => {
    const h = harness();
    expect(await coverageFallback(h.q, h.log, true, null, true, h.fx)).toEqual({
      started: null,
      available: true,
    });
    expect(h.log).toEqual(['DRY-RUN would cut coverage cov-1']);
    expect(h.calls).toEqual([]);
  });

  it('launches, binds the run and logs the state', async () => {
    const h = harness();
    expect(await coverageFallback(h.q, h.log, false, null, true, h.fx)).toEqual({
      started: 'run-1',
      available: true,
    });
    expect(h.calls).toEqual(['launch', 'bind']);
    expect(h.log).toEqual(['coverage cov-1: reviewing']);
  });

  it('passes the lowest-priority plan to launch', async () => {
    let seen: Record<string, unknown> = {};
    const h = harness({
      launch: async (_q, item, plan) => {
        seen = plan;
        item.state = 'reviewing';
        return 'r';
      },
    });
    await coverageFallback(h.q, h.log, false, null, true, h.fx);
    expect(seen).toEqual({
      base: 'b',
      head: 'h',
      target: 'mq1',
      cycle: null,
      branch: null,
      notes: [],
      label: 'lowest-priority coverage review',
    });
  });

  it('cancels before vendor when launch leaves a non-reviewing item without a run', async () => {
    const h = harness({
      launch: async (_q, item) => {
        item.state = 'pending';
        return 'r';
      },
    });
    expect(await coverageFallback(h.q, h.log, false, null, true, h.fx)).toEqual({
      started: null,
      available: true,
    });
    expect(h.calls).toEqual(['cancel']);
    const k = harness({
      launch: async (_q, item) => {
        item.state = 'pending';
        item.run = { run_id: 'x' };
        return 'r';
      },
    });
    await coverageFallback(k.q, k.log, false, null, true, k.fx);
    expect(k.calls).toEqual([]);
  });

  it('marks an empty coverage range skipped and moves to the next candidate', async () => {
    const h = harness({ diffNameOnly: async (_b, _h) => '' }, [cov(), cov({ id: 'cov-2' })]);
    const r = await coverageFallback(h.q, h.log, false, null, true, h.fx);
    expect(h.q.items.map((i) => [i.state, i.last_error])).toEqual([
      ['skipped', 'empty coverage range'],
      ['skipped', 'empty coverage range'],
    ]);
    expect(r).toEqual({ started: null, available: true });
  });

  it('a rank-4 refusal skips the candidate but still reports availability', async () => {
    const h = harness({ rank4Gate: async () => false });
    expect(await coverageFallback(h.q, h.log, false, null, true, h.fx)).toEqual({
      started: null,
      available: true,
    });
    expect(h.calls).toEqual([]);
  });

  it('records a planning failure truncated to 200 code points and continues', async () => {
    const h = harness({
      buildSynthetic: async () => {
        throw new Error('😀'.repeat(300));
      },
    });
    const r = await coverageFallback(h.q, h.log, false, null, true, h.fx);
    expect(h.q.items[0]?.wait_reason).toBe('coverage planning failed: ' + '😀'.repeat(200));
    expect(r).toEqual({ started: null, available: true });
  });

  it('skips a future not_before and unmet dependencies without marking availability', async () => {
    const h = harness({}, [cov({ not_before: '2026-11-15T13:00:00Z' })]);
    expect(await coverageFallback(h.q, h.log, false, null, true, h.fx)).toEqual({
      started: null,
      available: false,
    });
    const d = harness({ depsMet: () => false });
    expect(await coverageFallback(d.q, d.log, false, null, true, d.fx)).toEqual({
      started: null,
      available: false,
    });
    const past = harness({}, [cov({ not_before: '2026-11-15T11:00:00Z' })]);
    expect((await coverageFallback(past.q, past.log, true, null, true, past.fx)).available).toBe(
      true,
    );
  });

  it('a not_before equal to now is already due', async () => {
    const h = harness({}, [cov({ not_before: '2026-11-15T12:00:00Z' })]);
    expect((await coverageFallback(h.q, h.log, true, null, true, h.fx)).available).toBe(true);
  });

  it('considers candidates in sort order, not queue order', async () => {
    const h = harness({}, [cov({ id: 'cov-b' }), cov({ id: 'cov-a' })]);
    await coverageFallback(h.q, h.log, true, null, true, h.fx);
    expect(h.log).toEqual(['DRY-RUN would cut coverage cov-a']);
  });

  it('holds a candidate whose legacy origins are empty or not retryable', async () => {
    const empty = harness({ legacyOrigins: () => ({ source: { pr: 1 }, origins: [] }) });
    await coverageFallback(empty.q, empty.log, false, null, true, empty.fx);
    expect(empty.q.items[0]?.wait_reason).toBe(
      'legacy coverage retry history or cooldown unresolved',
    );
    const blocked = harness({
      legacyOrigins: () => ({ source: { pr: 1 }, origins: ['a', 'b'] }),
      legacyRetryAllowed: (_q, _pr, o) => o === 'a',
    });
    const r = await coverageFallback(blocked.q, blocked.log, false, null, true, blocked.fx);
    expect(blocked.q.items[0]?.wait_reason).toBe(
      'legacy coverage retry history or cooldown unresolved',
    );
    expect(r.available).toBe(false);
    expect(blocked.calls).toEqual([]);
  });

  it('maps identity errors to the unresolved reason but lets other errors escape', async () => {
    const h = harness({
      legacyOrigins: () => {
        throw new CoverageIdentityError('x');
      },
    });
    await coverageFallback(h.q, h.log, false, null, true, h.fx);
    expect(h.q.items[0]?.wait_reason).toBe('legacy coverage retry identity unresolved');
    const bad = harness({
      legacyOrigins: () => {
        throw new Error('boom');
      },
    });
    await expect(coverageFallback(bad.q, bad.log, false, null, true, bad.fx)).rejects.toThrow(
      'boom',
    );
  });

  it('returns quietly while a coverage review is already running', async () => {
    const h = harness({}, [cov({ state: 'reviewing' })]);
    expect(await coverageFallback(h.q, h.log, false, null, true, h.fx)).toEqual({
      started: null,
      available: false,
    });
  });

  it('measures merged items, truncates a failure to 150 and appends the new candidate', async () => {
    const merged: Item = { id: 'm1', kind: 'merged', state: 'merged', merge_commit: 'abc' };
    const noCommit: Item = { id: 'm2', kind: 'merged', state: 'merged' };
    const promo: Item = { id: 'p', kind: 'promotion', merge_commit: 'z' };
    const measured: string[] = [];
    const fresh = cov({ id: 'cov-new' });
    const h = harness(
      {
        measureMerged: async (item) => {
          measured.push(String(item.id));
          return { m: 1 };
        },
        coverageCandidate: () => fresh,
      },
      [merged, noCommit, promo],
    );
    const r = await coverageFallback(h.q, h.log, true, null, true, h.fx);
    expect(measured).toEqual(['m1']);
    expect(merged.measure).toEqual({ m: 1 });
    expect(h.q.items).toContain(fresh);
    expect(fresh.coverage_sha).toBe(undefined);
    expect(r).toEqual({ started: null, available: true });
    expect(h.log).toEqual(['DRY-RUN would cut coverage cov-new']);

    const f = harness(
      {
        measureMerged: async () => {
          throw new Error('x'.repeat(400));
        },
      },
      [{ id: 'm1', kind: 'merged', merge_commit: 'abc' }],
    );
    await coverageFallback(f.q, f.log, false, null, true, f.fx);
    expect(f.log).toEqual(['coverage measurement failed: ' + 'x'.repeat(150)]);
  });

  it('exposes backfill_ordinary_exhausted during the call and restores it after', async () => {
    let during: unknown;
    const h = harness({
      select: async (q) => {
        during = q.backfill_ordinary_exhausted;
        return { started: null, available: false };
      },
    });
    await coverageFallback(h.q, h.log, true, null, false, h.fx);
    expect(during).toBe(true);
    expect(h.q.backfill_ordinary_exhausted).toBe(false);

    const keep = harness({
      select: async (q) => {
        during = q.backfill_ordinary_exhausted;
        return { started: null, available: false };
      },
    });
    keep.q.backfill_ordinary_exhausted = 'prior';
    await coverageFallback(keep.q, keep.log, true, null, true, keep.fx);
    expect(during).toBe('prior');
    expect(keep.q.backfill_ordinary_exhausted).toBe('prior');
  });

  it('restores the flag even when a seam throws', async () => {
    const h = harness({
      select: async () => {
        throw new Error('select down');
      },
    });
    h.q.backfill_ordinary_exhausted = true;
    await expect(coverageFallback(h.q, h.log, false, null, false, h.fx)).rejects.toThrow(
      'select down',
    );
    expect(h.q.backfill_ordinary_exhausted).toBe(true);
  });
});

describe('usageAge', () => {
  it('is the seconds since the observation', () => {
    expect(usageAge({ observed_at: '2026-11-15T11:59:00Z' }, usageFx)).toBe(60);
  });
  it('is null for a missing, non-string or unparsable observation', () => {
    expect(usageAge(null, usageFx)).toBeNull();
    expect(usageAge({}, usageFx)).toBeNull();
    expect(usageAge({ observed_at: 5 }, usageFx)).toBeNull();
    expect(usageAge({ observed_at: 'nope' }, usageFx)).toBeNull();
  });
});

describe('usageContext', () => {
  const usage = { remaining: 5, reflected_reservations: ['k0'] };

  it('records a fresh read minus unrepresented reservations', () => {
    const q: Queue = { items: [] };
    usageContext(q, usage, ['s1', 's2'], usageFx);
    expect(q.backfill_usage).toEqual({
      successful: true,
      remaining: 3,
      observed_at: '2026-11-15T12:00:00Z',
      reflected_reservations: ['k0'],
    });
  });

  it('does not charge reservations already represented by an item', () => {
    const q: Queue = {
      items: [
        { attempt_id: 'k1', run: { started_at: 's1' } },
        { attempt_id: 'zz', run: { started_at: 's2' } },
      ],
      backfill_reservations: { k1: {} },
    };
    usageContext(q, usage, ['s1', 's2'], usageFx);
    expect((q.backfill_usage as Item).remaining).toBe(4);
  });

  it('clamps remaining at zero and reports an unsuccessful read as zero', () => {
    const q: Queue = { items: [] };
    usageContext(q, { remaining: 1 }, ['a', 'b', 'c'], usageFx);
    expect((q.backfill_usage as Item).remaining).toBe(0);
    usageContext(q, null, ['a'], usageFx);
    expect(q.backfill_usage).toEqual({
      successful: false,
      remaining: 0,
      observed_at: '2026-11-15T12:00:00Z',
      reflected_reservations: [],
    });
  });

  it('reflects a terminal hold once, and not when released or expired', () => {
    const q: Queue = {
      items: [],
      backfill_reservations: {
        due: { terminal_at: '2026-11-15T11:30:00Z', quota_state: 'held' },
        future: { terminal_at: '2026-11-15T12:30:00Z', quota_state: 'held' },
        released: { terminal_at: '2026-11-15T11:30:00Z', quota_state: 'released' },
        already: { terminal_at: '2026-11-15T11:30:00Z', quota_state: 'held' },
        open: { quota_state: 'held' },
      },
    };
    usageContext(q, { remaining: 9, reflected_reservations: ['already'] }, [], usageFx);
    expect((q.backfill_usage as Item).reflected_reservations).toEqual(['already', 'due']);
  });

  it('expires a hold once the rolling window has passed, honouring rollingWindowMs', () => {
    const mk = (): Queue => ({
      items: [],
      backfill_reservations: { old: { terminal_at: '2026-11-15T10:59:59Z', quota_state: 'held' } },
    });
    const a = mk();
    usageContext(a, { remaining: 1 }, [], usageFx);
    expect((a.backfill_reservations as Record<string, Item>).old?.quota_state).toBe('expired');
    expect((a.backfill_usage as Item).reflected_reservations).toEqual([]);
    const edge: Queue = {
      items: [],
      backfill_reservations: { e: { terminal_at: '2026-11-15T11:00:00Z', quota_state: 'held' } },
    };
    usageContext(edge, { remaining: 1 }, [], usageFx);
    expect((edge.backfill_reservations as Record<string, Item>).e?.quota_state).toBe('expired');
    const wide = mk();
    usageContext(wide, { remaining: 1, rollingWindowMs: 7200000 }, [], usageFx);
    expect((wide.backfill_reservations as Record<string, Item>).old?.quota_state).toBe('held');
    expect((wide.backfill_usage as Item).reflected_reservations).toEqual(['old']);
  });

  it('leaves holds untouched when the usage read failed', () => {
    const q: Queue = {
      items: [],
      backfill_reservations: { old: { terminal_at: '2026-11-15T09:00:00Z', quota_state: 'held' } },
    };
    usageContext(q, null, [], usageFx);
    expect((q.backfill_reservations as Record<string, Item>).old?.quota_state).toBe('held');
  });
});

describe('pyPrefix', () => {
  it('counts code points', () => {
    expect(pyPrefix('a😀b', 2)).toBe('a😀');
  });
});
