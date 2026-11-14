import { describe, expect, it } from 'vitest';
import {
  StartAuthorRefused,
  StartNotReady,
  StartNothingToReview,
  startOne,
  type StartRecord,
  type PlanOutcome,
  type StartOneEffects,
  type StartPlan,
} from '../../src/queue-runner/startOne.js';

const NOW = 1_700_000_000_000_000n; // 2023-11-14T22:13:20Z
const PLAN: StartPlan = {
  label: 'full',
  base: 'a'.repeat(40),
  head: 'b'.repeat(40),
  target: 'main',
  notes: [],
};

interface Harness {
  readonly effects: StartOneEffects;
  readonly planned: string[];
  readonly launched: string[];
  readonly coverage: Array<{ ordinaryEligible?: boolean }>;
  readonly events: Array<Record<string, string>>;
  starts: number;
}

function harness(
  planner: (item: StartRecord) => PlanOutcome | Promise<PlanOutcome>,
  options: { coverage?: Array<{ started: string | null; hasCoverage: boolean }> } = {},
): Harness {
  const h: Harness = {
    planned: [],
    launched: [],
    coverage: [],
    events: [],
    starts: 0,
    effects: undefined as unknown as StartOneEffects,
  };
  const answers = [...(options.coverage ?? [])];
  (h as { effects: StartOneEffects }).effects = {
    context: {
      config: { primaryRepo: 'acme/widgets', repos: [], localReviewAgingMinutes: 60 },
      nowMicros: NOW,
    },
    startsCount: () => h.starts,
    planItem: async (item) => {
      h.planned.push(String(item.id));
      return planner(item);
    },
    launch: async (item) => {
      h.launched.push(String(item.id));
      h.starts += 1;
      return `run-${String(item.id)}`;
    },
    coverageFallback: async (options) => {
      h.coverage.push(options);
      return answers.shift() ?? { started: null, hasCoverage: false };
    },
    event: async (_kind, data) => {
      h.events.push(data);
    },
    nowIso: () => '2023-11-14T22:13:20Z',
  };
  return h;
}

const ok = (): PlanOutcome => ({ outcome: 'plan', plan: PLAN });
const open = (id: string, extra: StartRecord = {}): StartRecord => ({
  id,
  kind: 'open',
  state: 'pending',
  order: 1,
  ...extra,
});
const queueOf = (...items: StartRecord[]): StartRecord => ({ items });

describe('startOne selection', () => {
  it('launches the first eligible item in policy order and stops', async () => {
    const q = queueOf(
      { id: 'later', kind: 'delta', state: 'pending', order: 1 },
      open('first', { order: 2 }),
    );
    const h = harness(ok);
    const log: string[] = [];
    const result = await startOne({ queue: q, log, dry: false }, h.effects);
    expect(h.planned).toEqual(['first']);
    expect(result.started).toBe('run-first');
    expect(log.at(-1)).toBe('started first [full] run run-first');
    expect(h.coverage).toEqual([]);
  });

  it('operator priority outranks rank', async () => {
    const q = queueOf(open('plain'), {
      id: 'pri',
      kind: 'coverage-free',
      state: 'pending',
      operator_priority: true,
    });
    const h = harness(ok);
    await startOne({ queue: q, log: [], dry: false }, h.effects);
    expect(h.planned[0]).toBe('pri');
  });

  it('skips non-pending items and honours only', async () => {
    const q = queueOf(open('a'), open('b'), { ...open('c'), state: 'done' });
    const h = harness(ok);
    await startOne({ queue: q, log: [], dry: false, only: 'b' }, h.effects);
    expect(h.planned).toEqual(['b']);
    const h2 = harness(ok);
    await startOne(
      { queue: queueOf(open('a'), open('b')), log: [], dry: false, only: '' },
      h2.effects,
    );
    expect(h2.planned).toEqual(['a']);
  });

  it('backs off until not_before but preserves a completed-evidence wait reason', async () => {
    const future = '2023-11-14T23:00:00Z';
    const q = queueOf(
      open('a', { not_before: future }),
      open('b', { not_before: future, wait_reason: 'completed-evidence-unavailable: x' }),
      open('c', { not_before: '2023-11-14T22:00:00Z' }),
    );
    const h = harness(ok);
    await startOne({ queue: q, log: [], dry: false }, h.effects);
    const items = q.items as StartRecord[];
    expect(items[0]!.wait_reason).toBe(`backoff until ${future}`);
    expect(items[1]!.wait_reason).toBe('completed-evidence-unavailable: x');
    expect(h.planned).toEqual(['c']);
  });

  it('waits on an unmet dependency', async () => {
    const q = queueOf(open('dep'), open('child', { depends_on: 'dep', order: 0 }));
    const h = harness(ok);
    await startOne({ queue: q, log: [], dry: false }, h.effects);
    expect((q.items as StartRecord[])[1]!.wait_reason).toBe('waiting for dep');
    expect(h.planned).toEqual(['dep']);
  });

  it('parks an optional cycle while rank<=3 work waits, after trying coverage first', async () => {
    const q = queueOf(
      open('opt', { cycles: [{}], order: 0 }),
      open('blocker', { not_before: '2023-11-14T23:00:00Z' }),
    );
    const h = harness(ok);
    await startOne({ queue: q, log: [], dry: false }, h.effects);
    expect((q.items as StartRecord[])[0]!.wait_reason).toBe(
      'optional cycle waits until no rank <=3 work is pending',
    );
  });

  it('gives an additional cycle coverage first refusal and stops when it starts', async () => {
    const q = queueOf(open('opt', { cycles: [{}] }));
    const h = harness(ok, { coverage: [{ started: 'run-cov', hasCoverage: true }] });
    const result = await startOne({ queue: q, log: [], dry: false }, h.effects);
    expect(result).toEqual({ started: 'run-cov', hasCoverage: true });
    expect(h.planned).toEqual([]);
    expect(h.coverage).toEqual([{}]);
  });

  it('parks merged rows linked to a current receipt', async () => {
    const q = queueOf(
      { id: 'm', kind: 'merged', state: 'pending', pr: 7 },
      { id: 'r', kind: 'merged-current', state: 'blocked', pr: 7 },
    );
    const h = harness(ok);
    await startOne({ queue: q, log: [], dry: false }, h.effects);
    expect((q.items as StartRecord[])[0]!.wait_reason).toMatch(/linked merged-current intent/);
    expect(h.planned).toEqual([]);
  });

  it('defers a first current capture off the fetching tick and refuses selective author starts', async () => {
    const q = queueOf({ id: 'r', kind: 'merged-current', state: 'pending' });
    const h = harness(ok);
    await startOne({ queue: q, log: [], dry: false, captureCurrent: false }, h.effects);
    expect((q.items as StartRecord[])[0]!.wait_reason).toBe(
      'first current capture waits for fetching maintenance tick',
    );
    const q2 = queueOf({ id: 'au', kind: 'author', state: 'pending' }, open('o'));
    const h2 = harness(ok);
    const log: string[] = [];
    const res = await startOne({ queue: q2, log, dry: false, only: 'au' }, h2.effects);
    expect(log[0]).toMatch(/selective start refused/);
    expect(h2.planned).toEqual([]);
    expect(h2.coverage).toEqual([]);
    expect(res.started).toBeNull();
    const dryLog: string[] = [];
    const h3 = harness(ok);
    await startOne({ queue: q2, log: dryLog, dry: true, only: 'au' }, h3.effects);
    expect(h3.planned).toEqual(['au']);
  });

  it('routes rank-4 rows to coverage fallback only with operator priority', async () => {
    const plain = harness(ok);
    await startOne(
      { queue: queueOf({ id: 'c', kind: 'coverage', state: 'pending' }), log: [], dry: false },
      plain.effects,
    );
    expect(plain.coverage).toEqual([{}]); // the loop's else branch, not a per-item call
    const pri = harness(ok, { coverage: [{ started: 'run-c', hasCoverage: true }] });
    const r = await startOne(
      {
        queue: queueOf({ id: 'c', kind: 'coverage', state: 'pending', operator_priority: true }),
        log: [],
        dry: false,
      },
      pri.effects,
    );
    expect(r.started).toBe('run-c');
    expect(pri.coverage).toHaveLength(1);
  });

  it('falls back to coverage and logs when nothing is eligible', async () => {
    const q = queueOf(open('a', { not_before: '2023-11-14T23:00:00Z' }));
    const h = harness(ok);
    const log: string[] = [];
    const result = await startOne({ queue: q, log, dry: false }, h.effects);
    expect(result.started).toBeNull();
    expect(q.backfill_ordinary_exhausted).toBe(true);
    expect(log).toContain('no eligible item this tick');
    const sel = harness(ok);
    const q2 = queueOf(open('a', { not_before: '2023-11-14T23:00:00Z' }));
    await startOne({ queue: q2, log: [], dry: false, only: 'a' }, sel.effects);
    expect(q2.backfill_ordinary_exhausted).toBe(false);
  });

  it('background turn tries rank 2-3 work before interactive work, then flips to coverage', async () => {
    const q = queueOf(
      open('inter'),
      { id: 'back', kind: 'delta', followup: 'merged', state: 'pending', order: 5 },
      {
        id: 'hist',
        kind: 'open',
        state: 'done',
        attempts: [
          { run_id: 'x-1', started_at: '2023-11-14T20:00:00Z', band: 'interactive' },
          { run_id: 'x-2', started_at: '2023-11-14T21:00:00Z', band: 'interactive' },
        ],
      },
    );
    const h = harness(() => ({ outcome: 'none', logNoStart: false }));
    await startOne({ queue: q, log: [], dry: false }, h.effects);
    // Rank 2-3 first; reaching rank 0 after the lane ended gives coverage its single turn.
    expect(h.planned).toEqual(['back', 'inter']);
    expect(h.coverage[0]).toEqual({ ordinaryEligible: false });
  });

  it('records planner outcomes: skipped, wait, none', async () => {
    const q = queueOf(open('a', { order: 1 }), open('b', { order: 2 }), open('c', { order: 3 }));
    const h = harness((item) =>
      item.id === 'a'
        ? {
            outcome: 'skipped',
            state: 'skipped',
            lastError: 'PR closed before review',
            log: 'PR CLOSED → skipped',
          }
        : item.id === 'b'
          ? { outcome: 'wait', waitReason: 'quiet' }
          : { outcome: 'none', logNoStart: true },
    );
    const log: string[] = [];
    await startOne({ queue: q, log, dry: false }, h.effects);
    const items = q.items as StartRecord[];
    expect(items[0]).toMatchObject({ state: 'skipped', last_error: 'PR closed before review' });
    expect(items[1]!.wait_reason).toBe('quiet');
    expect(log).toContain('c: pending (no vendor start)');
    const dry = queueOf(open('a'));
    await startOne(
      { queue: dry, log: [], dry: true },
      harness(() => ({ outcome: 'skipped', state: 'skipped', lastError: 'e', log: 'l' })).effects,
    );
    expect((dry.items as StartRecord[])[0]!.state).toBe('pending');
  });

  it('skips on NothingToReview with an event, but not in a dry run', async () => {
    const throwing = () => {
      throw new StartNothingToReview('empty range');
    };
    const q = queueOf(open('a'));
    const h = harness(throwing);
    const log: string[] = [];
    await startOne({ queue: q, log, dry: false }, h.effects);
    expect((q.items as StartRecord[])[0]).toMatchObject({
      state: 'skipped',
      last_error: 'nothing to review: empty range',
    });
    expect(h.events).toEqual([{ item: 'a', reason: 'nothing to review: empty range' }]);
    expect(log[0]).toBe('a: nothing to review (empty range) → skipped');
    const dry = queueOf(open('a'));
    const hd = harness(throwing);
    await startOne({ queue: dry, log: [], dry: true }, hd.effects);
    expect((dry.items as StartRecord[])[0]!.state).toBe('pending');
    expect(hd.events).toEqual([]);
  });

  it('NotReady and planning errors set the wait reason; only a journaled reservation stops the pass', async () => {
    const q = queueOf(open('a', { order: 1 }), open('b', { order: 2 }));
    const h = harness((item) => {
      if (item.id === 'a') throw new StartNotReady('not ready yet');
      throw new Error('boom');
    });
    const log: string[] = [];
    await startOne({ queue: q, log, dry: false }, h.effects);
    const items = q.items as StartRecord[];
    expect(items[0]!.wait_reason).toBe('not ready yet');
    expect(items[1]!.wait_reason).toBe('planning error: boom');
    expect(log).toContain('b: planning error boom');
    expect(h.planned).toEqual(['a', 'b']);

    const q2 = queueOf(open('a', { order: 1 }), open('b', { order: 2 }));
    const h2 = harness((item) => {
      if (item.id === 'a') {
        h2.starts += 1; // unknown delivery journaled a start before failing
        throw new StartNotReady('unknown delivery');
      }
      return ok();
    });
    const res = await startOne({ queue: q2, log: [], dry: false }, h2.effects);
    expect(h2.planned).toEqual(['a']);
    expect(res.started).toBeNull();
    expect(h2.coverage).toEqual([]);
  });

  it('truncates planning errors to 300 code points', async () => {
    const q = queueOf(open('a'));
    const h = harness(() => {
      throw new Error('😀'.repeat(400));
    });
    await startOne({ queue: q, log: [], dry: false }, h.effects);
    const reason = (q.items as StartRecord[])[0]!.wait_reason as string;
    expect(Array.from(reason)).toHaveLength(300);
  });

  it('notes, dry-run line and a refused author launch', async () => {
    const withNotes = (): PlanOutcome => ({
      outcome: 'plan',
      plan: { ...PLAN, notes: ['careful'] },
    });
    const q = queueOf(open('a'));
    const log: string[] = [];
    await startOne({ queue: q, log, dry: false }, harness(withNotes).effects);
    expect((q.items as StartRecord[])[0]!.notes).toEqual(['2023-11-14T22:13:20Z careful']);
    const dq = queueOf(open('a', { not_before: '2023-11-14T23:00:00Z' }), open('b', { order: 2 }));
    const dlog: string[] = [];
    const hd = harness(withNotes);
    await startOne({ queue: dq, log: dlog, dry: true }, hd.effects);
    expect(dlog).toContain(
      `DRY-RUN would start b [full] base ${'a'.repeat(12)} head ${'b'.repeat(12)} target main`,
    );
    expect(dlog).toContain('  waiting a: backoff until 2023-11-14T23:00:00Z');
    expect(hd.launched).toEqual([]);
    expect((dq.items as StartRecord[])[1]!.notes).toBeUndefined();

    const aq = queueOf(
      { id: 'au', kind: 'author', state: 'pending', operator_priority: true },
      open('o', { order: 2 }),
    );
    const ha = harness(ok);
    (ha.effects as { launch: StartOneEffects['launch'] }).launch = async (item) => {
      if (item.id === 'au') throw new StartAuthorRefused('no grant');
      return 'run-o';
    };
    const alog: string[] = [];
    const res = await startOne({ queue: aq, log: alog, dry: false }, ha.effects);
    expect((aq.items as StartRecord[])[0]!.wait_reason).toBe('no grant');
    expect(alog).toContain('au: author launch refused: no grant');
    expect(res.started).toBe('run-o');
  });

  it('a launch that leaves the item blocked logs and moves on', async () => {
    const q = queueOf(open('a', { order: 1 }), open('b', { order: 2 }));
    const h = harness(ok);
    (h.effects as { launch: StartOneEffects['launch'] }).launch = async (item) => {
      h.launched.push(String(item.id));
      if (item.id === 'a') item.state = 'blocked';
      return `run-${String(item.id)}`;
    };
    const log: string[] = [];
    const res = await startOne({ queue: q, log, dry: false }, h.effects);
    expect(h.launched).toEqual(['a', 'b']);
    expect(log).toContain('a: blocked before vendor start');
    expect(res.started).toBe('run-b');
  });

  it('propagates non-refusal launch errors', async () => {
    const h = harness(ok);
    (h.effects as { launch: StartOneEffects['launch'] }).launch = async () => {
      throw new Error('disk');
    };
    await expect(
      startOne({ queue: queueOf(open('a')), log: [], dry: false }, h.effects),
    ).rejects.toThrow('disk');
  });
});
