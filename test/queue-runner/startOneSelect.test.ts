import { describe, expect, it } from 'vitest';
import {
  LaunchAuthorRefused,
  NothingToReview,
  NotReady,
  startOne,
  type Item,
  type Plan,
  type Queue,
  type StartOneEffects,
  type StartOneInput,
} from '../../src/queue-runner/startOneSelect.js';

const NOW = 1_800_000_000_000_000n;
const PLAN: Plan = {
  notes: ['note one'],
  label: 'open review',
  base: 'b'.repeat(40),
  head: 'h'.repeat(40),
  target: 'main',
};
const INPUT: StartOneInput = { dry: false, only: null, ignoreQuiet: false, captureCurrent: true };

interface Harness {
  effects: StartOneEffects;
  calls: string[];
  events: Array<[string, Record<string, string>]>;
  coverageFlags: unknown[];
}

function harness(over: Partial<StartOneEffects> = {}): Harness {
  const calls: string[] = [];
  const events: Array<[string, Record<string, string>]> = [];
  const coverageFlags: unknown[] = [];
  const effects: StartOneEffects = {
    context: {
      config: { primaryRepo: 'o/primary', repos: [], localReviewAgingMinutes: 60 },
      nowMicros: NOW,
    },
    iso: () => '2027-01-15T08:00:00Z',
    coverageSelect: async (q) => {
      calls.push('coverage');
      coverageFlags.push(q.backfill_ordinary_exhausted);
      return { started: null, hasCoverage: false };
    },
    prepareLocalReview: async () => PLAN,
    planAuthor: async () => PLAN,
    prepareCurrent: async () => PLAN,
    preparePush: async () => PLAN,
    planMerged: async () => PLAN,
    prInfo: async () => ({ state: 'OPEN' }),
    quietReason: () => null,
    planOpen: async (item) => {
      calls.push(`planOpen:${String(item.id)}`);
      return PLAN;
    },
    planDelta: async (item) => {
      calls.push(`planDelta:${String(item.id)}`);
      return PLAN;
    },
    launch: async (_q, item) => {
      calls.push(`launch:${String(item.id)}`);
      return 'run-1';
    },
    event: async (kind, data) => {
      events.push([kind, data]);
    },
    ...over,
  };
  return { effects, calls, events, coverageFlags };
}

const open = (id: string, extra: Item = {}): Item => ({
  id,
  kind: 'open',
  state: 'pending',
  pr: 1,
  order: 1,
  ...extra,
});
const queue = (...items: Item[]): Queue => ({ items, starts: [] });
const run = async (
  q: Queue,
  h: Harness,
  input: Partial<StartOneInput> = {},
): Promise<{ log: string[]; started: string | null; hasCoverage: boolean }> => {
  const log: string[] = [];
  const result = await startOne(q, log, { ...INPUT, ...input }, h.effects);
  return { log, ...result };
};
const get = (q: Queue, id: string): Item =>
  (q.items as Item[]).find((i) => i.id === id) as Item;

describe('startOne selection', () => {
  it('launches the first pending item in policy order, with notes and a log line', async () => {
    const h = harness();
    const q = queue(open('b', { order: 2 }), open('a', { order: 1 }));
    const r = await run(q, h);
    expect(r.started).toBe('run-1');
    expect(h.calls).toEqual(['planOpen:a', 'launch:a']);
    expect(r.log).toEqual(['a: note one', 'started a [open review] run run-1']);
    expect(get(q, 'a').notes).toEqual(['2027-01-15T08:00:00Z note one']);
    expect(get(q, 'b')).not.toHaveProperty('notes');
    expect(q.backfill_ordinary_exhausted).toBe(false);
  });

  it('dry-run logs the plan and the waiting reasons and launches nothing', async () => {
    const h = harness();
    const q = queue(open('a'), open('w', { order: 5, depends_on: 'a' }));
    const r = await run(q, h, { dry: true });
    expect(h.calls).toEqual(['planOpen:a']);
    expect(r.log[0]).toBe('a: note one');
    expect(r.log[1]).toBe(
      `DRY-RUN would start a [open review] base ${'b'.repeat(12)} head ${'h'.repeat(12)} target main`,
    );
    expect(r.log).toContain('  waiting w: waiting for a');
    expect(get(q, 'a')).not.toHaveProperty('notes');
    expect(r.started).toBeNull();
  });

  it('skips a closed PR (state and error only when not dry)', async () => {
    const closed = { prInfo: async () => ({ state: 'CLOSED' }) };
    const q = queue(open('a'));
    const r = await run(q, harness(closed));
    expect(get(q, 'a')).toMatchObject({ state: 'skipped', last_error: 'PR closed before review' });
    expect(r.log).toContain('a: PR CLOSED → skipped');
    const dryQ = queue(open('a'));
    await run(dryQ, harness(closed), { dry: true });
    expect(get(dryQ, 'a').state).toBe('pending');
  });

  it('lets a merged delta through without a quiet gate', async () => {
    const h = harness({
      prInfo: async () => ({ state: 'MERGED' }),
      quietReason: () => 'busy',
    });
    const q = queue(open('d', { kind: 'delta' }));
    await run(q, h);
    expect(h.calls).toEqual(['planDelta:d', 'launch:d']);
  });

  it('records a quiet reason and moves on', async () => {
    const h = harness({ quietReason: (item) => (item.id === 'a' ? 'agent active' : null) });
    const q = queue(open('a'), open('b', { order: 2 }));
    await run(q, h);
    expect(get(q, 'a').wait_reason).toBe('agent active');
    expect(h.calls).toEqual(['planOpen:b', 'launch:b']);
  });

  it('NotReady continues, but stops when a journaled reservation grew', async () => {
    const q = queue(open('a'), open('b', { order: 2 }));
    const h = harness({
      planOpen: async (item) => {
        h.calls.push(`planOpen:${String(item.id)}`);
        if (item.id === 'a') throw new NotReady('not ready yet');
        return PLAN;
      },
    });
    await run(q, h);
    expect(get(q, 'a').wait_reason).toBe('not ready yet');
    expect(h.calls).toEqual(['planOpen:a', 'planOpen:b', 'launch:b']);

    const q2 = queue(open('a'), open('b', { order: 2 }));
    const h2 = harness({
      planOpen: async (item, _info, _dry, queueDoc) => {
        h2.calls.push(`planOpen:${String(item.id)}`);
        (queueDoc.starts as unknown[]).push('2027-01-15T08:00:00Z');
        throw new NotReady('unknown delivery');
      },
    });
    const r = await run(q2, h2);
    expect(h2.calls).toEqual(['planOpen:a']);
    expect(r.started).toBeNull();
    expect(r.log).not.toContain('no eligible item this tick');
  });

  it('NothingToReview skips with an event, except when dry', async () => {
    const throwing = {
      planOpen: async () => {
        throw new NothingToReview('empty range');
      },
    };
    const q = queue(open('a'));
    const h = harness(throwing);
    const r = await run(q, h);
    expect(get(q, 'a')).toMatchObject({ state: 'skipped', last_error: 'nothing to review: empty range' });
    expect(h.events).toEqual([['skipped', { item: 'a', reason: 'nothing to review: empty range' }]]);
    expect(r.log).toContain('a: nothing to review (empty range) → skipped');
    const dryQ = queue(open('a'));
    const dh = harness(throwing);
    await run(dryQ, dh, { dry: true });
    expect(get(dryQ, 'a').state).toBe('pending');
    expect(dh.events).toEqual([]);
  });

  it('truncates a planning error to 300 characters', async () => {
    const q = queue(open('a'));
    const h = harness({
      planOpen: async () => {
        throw new Error('x'.repeat(400));
      },
    });
    const r = await run(q, h);
    expect(String(get(q, 'a').wait_reason)).toHaveLength(300);
    expect(r.log.find((l) => l.startsWith('a: planning error'))).toHaveLength(300);
  });

  it('honours not_before backoff, keeping completed-evidence reasons', async () => {
    const future = '2027-01-15T08:00:00Z';
    const q = queue(
      open('a', { not_before: future }),
      open('b', { order: 2, not_before: future, wait_reason: 'completed-evidence-unavailable: x' }),
    );
    await run(q, harness());
    expect(get(q, 'a').wait_reason).toBe(`backoff until ${future}`);
    expect(get(q, 'b').wait_reason).toBe('completed-evidence-unavailable: x');
    const past = queue(open('a', { not_before: '2020-01-01T00:00:00Z' }));
    const h = harness();
    await run(past, h);
    expect(h.calls).toEqual(['planOpen:a', 'launch:a']);
  });

  it('waits for an unmet dependency', async () => {
    const q = queue(open('a', { depends_on: 'z' }), open('z', { order: 2, state: 'reviewing' }));
    const h = harness();
    await run(q, h);
    expect(get(q, 'a').wait_reason).toBe('waiting for z');
    expect(h.calls).toEqual(['coverage']);
  });

  it('with no eligible item runs the coverage fallback with exhausted set, then restores', async () => {
    const h = harness();
    const q = queue();
    const r = await run(q, h);
    expect(h.coverageFlags).toEqual([true]);
    expect(q.backfill_ordinary_exhausted).toBe(true);
    expect(r.log).toEqual(['no eligible item this tick']);
    const onlyQ = queue();
    const oh = harness();
    await run(onlyQ, oh, { only: 'x' });
    expect(oh.coverageFlags).toEqual([false]);
  });

  it('returns a coverage run without the no-eligible line', async () => {
    const h = harness({ coverageSelect: async () => ({ started: 'cov-run', hasCoverage: true }) });
    const r = await run(queue(), h);
    expect(r).toMatchObject({ started: 'cov-run', hasCoverage: true });
    expect(r.log).toEqual([]);
  });

  it('refuses a selective author start unless dry', async () => {
    const author = { id: 'au', kind: 'author', state: 'pending', order: 1 };
    const q = queue(author);
    const r = await run(q, harness(), { only: 'au' });
    expect(r.log[0]).toContain('au: selective start refused');
    expect(r.started).toBeNull();
    const h = harness();
    await run(queue({ ...author }), h, { only: 'au', dry: true });
    expect(h.calls).toEqual([]);
  });

  it('restricts to the only item and ignores non-pending ones', async () => {
    const h = harness();
    const q = queue(open('a'), open('b', { order: 2 }), open('c', { order: 3, state: 'done' }));
    await run(q, h, { only: 'b' });
    expect(h.calls).toEqual(['planOpen:b', 'launch:b']);
    const h2 = harness();
    await run(queue(open('c', { state: 'done' })), h2, { only: 'c' });
    expect(h2.calls).toEqual(['coverage']);
  });

  it('continues past an author launch refusal and a blocked launch', async () => {
    const q = queue(open('a'), open('b', { order: 2 }), open('c', { order: 3 }));
    const h = harness({
      launch: async (_q, item) => {
        h.calls.push(`launch:${String(item.id)}`);
        if (item.id === 'a') throw new LaunchAuthorRefused('quota');
        if (item.id === 'b') {
          item.state = 'blocked';
          return 'r';
        }
        return 'run-c';
      },
    });
    const r = await run(q, h);
    expect(r.started).toBe('run-c');
    expect(get(q, 'a').wait_reason).toBe('quota');
    expect(r.log).toContain('a: author launch refused: quota');
    expect(r.log).toContain('b: blocked before vendor start');
    expect(r.log.at(-1)).toBe('started c [open review] run run-c');
  });

  it('propagates an unexpected launch failure', async () => {
    const h = harness({
      launch: async () => {
        throw new Error('boom');
      },
    });
    await expect(run(queue(open('a')), h)).rejects.toThrow('boom');
  });

  it('gates a first current capture and logs a plan-less receipt', async () => {
    const receipt = { id: 'rc', kind: 'merged-current', state: 'pending', pr: 7 };
    const q = queue(receipt);
    const h = harness();
    await run(q, h, { captureCurrent: false });
    expect(get(q, 'rc').wait_reason).toBe('first current capture waits for fetching maintenance tick');
    const none = harness({ prepareCurrent: async () => null });
    const r = await run(queue({ ...receipt }), none);
    expect(r.log).toContain('rc: pending (no vendor start)');
  });

  it('lets a linked merged-current intent own a merged item', async () => {
    const q = queue(
      { id: 'm', kind: 'merged', state: 'pending', pr: 7, order: 1 },
      { id: 'rc', kind: 'merged-current', state: 'reviewing', pr: 7, order: 2 },
    );
    const h = harness();
    await run(q, h);
    expect(get(q, 'm').wait_reason).toContain('linked merged-current intent owns');
  });

  it('on a background turn tries rank 2-3 work before rank 0-1 work', async () => {
    const launch = (n: string, at: string) => ({
      run_id: n,
      started_at: at,
      band: 'interactive',
    });
    const done = (id: string, at: string): Item => ({
      id,
      kind: 'open',
      state: 'done',
      pr: 9,
      order: 9,
      attempts: [launch(id, at)],
    });
    const q = queue(
      open('hi'),
      { id: 'bg', kind: 'merged', state: 'pending', pr: 5, order: 5 },
      done('d1', '2027-01-15T07:00:00Z'),
      done('d2', '2027-01-15T07:30:00Z'),
    );
    const h = harness({ planMerged: async () => PLAN });
    await run(q, h);
    expect(h.calls).toEqual(['launch:bg']);
    const normal = queue(open('hi'), { id: 'bg', kind: 'merged', state: 'pending', pr: 5, order: 5 });
    const h2 = harness();
    await run(normal, h2);
    expect(h2.calls).toEqual(['planOpen:hi', 'launch:hi']);
  });
});
