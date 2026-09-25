// W1.2 slice A — tests for the PURE settle ledger
// (src/selfhost/settle-state.ts, the RS-3 decision).
//
// Pinned here:
//   1. observe: the same tuple appends; a head change, a base change, and a
//      force-push epoch bump with the SAME head SHA each REPLACE the record
//      (every prior observation invalidated); the input is never mutated.
//   2. Compaction over MAX_OBSERVATIONS_PER_PR keeps the first observation
//      (the settle anchor) plus the newest ones.
//   3. settleStatus: every not-settled reason; the exactly-settleMs
//      boundary settles, settleMs-1 does not; a future-stamped observation
//      fails closed.
//   4. parseSettleState: wrong version / repo / shape → empty + reason;
//      each malformed record dropped individually; never throws.
//   5. serializeSettleState is deterministic (numeric key order, trailing
//      newline) and round-trips through parse.
import { describe, expect, test } from 'vitest';
import {
  MAX_OBSERVATIONS_PER_PR,
  SETTLE_STATE_VERSION,
  emptySettleState,
  observe,
  parseSettleState,
  pruneToOpen,
  sameTuple,
  serializeSettleState,
  settleStatus,
} from '../../src/selfhost/settle-state.js';
import type { SettleState, SettleTuple } from '../../src/selfhost/settle-state.js';

const REPO = 'octo/widget';
const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const BASE_1 = '1'.repeat(40);
const BASE_2 = '2'.repeat(40);
const T0 = Date.parse('2026-09-25T00:00:00.000Z');
const MIN = 60_000;
const SETTLE_MS = 30 * MIN;

const tuple = (over: Partial<SettleTuple> = {}): SettleTuple => ({
  head: HEAD_A,
  base: BASE_1,
  forcePushEpoch: 0,
  ...over,
});

/** Observe `pr` with `t` at each given ms, starting from `state`. */
const observeAt = (state: SettleState, pr: number, t: SettleTuple, ...times: number[]) =>
  times.reduce((s, ms) => observe(s, pr, t, ms, 'self-merge-prs:observe'), state);

describe('observe', () => {
  test('the same tuple appends an observation', () => {
    const s = observeAt(emptySettleState(REPO), 7, tuple(), T0, T0 + MIN);
    expect(s.prs['7']?.observations).toEqual([
      { observedAt: new Date(T0).toISOString(), by: 'self-merge-prs:observe' },
      { observedAt: new Date(T0 + MIN).toISOString(), by: 'self-merge-prs:observe' },
    ]);
  });

  test('a head change resets the record to the new tuple', () => {
    const s1 = observeAt(emptySettleState(REPO), 7, tuple(), T0, T0 + MIN);
    const s2 = observeAt(s1, 7, tuple({ head: HEAD_B }), T0 + 2 * MIN);
    expect(s2.prs['7']?.tuple.head).toBe(HEAD_B);
    expect(s2.prs['7']?.observations).toHaveLength(1);
  });

  test('a base change resets the record to the new tuple', () => {
    const s1 = observeAt(emptySettleState(REPO), 7, tuple(), T0, T0 + MIN);
    const s2 = observeAt(s1, 7, tuple({ base: BASE_2 }), T0 + 2 * MIN);
    expect(s2.prs['7']?.tuple.base).toBe(BASE_2);
    expect(s2.prs['7']?.observations).toHaveLength(1);
  });

  test('force-push epoch bump invalidates prior settle observations', () => {
    // Settled on (HEAD_A, BASE_1, 0) …
    const s1 = observeAt(emptySettleState(REPO), 7, tuple(), T0, T0 + SETTLE_MS);
    expect(settleStatus(s1.prs['7'], tuple(), T0 + SETTLE_MS, SETTLE_MS).settled).toBe(true);
    // … then force-pushed away and back to the SAME head SHA: epoch 1.
    const bumped = tuple({ forcePushEpoch: 1 });
    expect(bumped.head).toBe(HEAD_A);
    const now = T0 + SETTLE_MS + MIN;
    const s2 = observeAt(s1, 7, bumped, now);
    expect(s2.prs['7']?.observations).toHaveLength(1);
    expect(settleStatus(s2.prs['7'], bumped, now, SETTLE_MS)).toEqual({
      settled: false,
      reason: 'single_observation',
    });
    // The old tuple no longer matches the record either.
    expect(settleStatus(s2.prs['7'], tuple(), now, SETTLE_MS)).toEqual({
      settled: false,
      reason: 'tuple_changed',
    });
  });

  test('observe never mutates its input state', () => {
    const s1 = observeAt(emptySettleState(REPO), 7, tuple(), T0);
    const snapshot = structuredClone(s1);
    observeAt(s1, 7, tuple(), T0 + MIN);
    observeAt(s1, 7, tuple({ head: HEAD_B }), T0 + MIN);
    observeAt(s1, 8, tuple(), T0 + MIN);
    expect(s1).toEqual(snapshot);
  });

  test('compaction keeps the first observation plus the newest ones', () => {
    const times = Array.from({ length: MAX_OBSERVATIONS_PER_PR + 3 }, (_, i) => T0 + i * MIN);
    const s = observeAt(emptySettleState(REPO), 7, tuple(), ...times);
    const kept = s.prs['7']?.observations.map((o) => Date.parse(o.observedAt));
    expect(kept).toHaveLength(MAX_OBSERVATIONS_PER_PR);
    expect(kept).toEqual([times[0], ...times.slice(-(MAX_OBSERVATIONS_PER_PR - 1))]);
  });

  test('caller bugs throw (bad pr, bad sha, empty by)', () => {
    const s = emptySettleState(REPO);
    expect(() => observe(s, 0, tuple(), T0, 'x')).toThrow(RangeError);
    expect(() => observe(s, 7, tuple({ head: 'A'.repeat(40) }), T0, 'x')).toThrow(/head/);
    expect(() => observe(s, 7, tuple({ forcePushEpoch: -1 }), T0, 'x')).toThrow(/epoch/i);
    expect(() => observe(s, 7, tuple(), T0, ' ')).toThrow(/by/);
  });
});

describe('settleStatus', () => {
  test('no record → no_observation', () => {
    expect(settleStatus(undefined, tuple(), T0, SETTLE_MS)).toEqual({
      settled: false,
      reason: 'no_observation',
    });
  });

  test('record for another tuple → tuple_changed', () => {
    const s = observeAt(emptySettleState(REPO), 7, tuple(), T0, T0 + SETTLE_MS);
    expect(settleStatus(s.prs['7'], tuple({ base: BASE_2 }), T0 + SETTLE_MS, SETTLE_MS)).toEqual({
      settled: false,
      reason: 'tuple_changed',
    });
  });

  test('one observation → single_observation', () => {
    const s = observeAt(emptySettleState(REPO), 7, tuple(), T0);
    expect(settleStatus(s.prs['7'], tuple(), T0 + SETTLE_MS, SETTLE_MS)).toEqual({
      settled: false,
      reason: 'single_observation',
    });
  });

  test('exactly settleMs apart settles; settleMs-1 is settle_pending', () => {
    const s = observeAt(emptySettleState(REPO), 7, tuple(), T0, T0 + SETTLE_MS);
    expect(settleStatus(s.prs['7'], tuple(), T0 + SETTLE_MS, SETTLE_MS)).toEqual({
      settled: true,
      firstObservedAt: new Date(T0).toISOString(),
      elapsedMs: SETTLE_MS,
    });
    const short = observeAt(emptySettleState(REPO), 7, tuple(), T0, T0 + SETTLE_MS - 1);
    expect(settleStatus(short.prs['7'], tuple(), T0 + SETTLE_MS, SETTLE_MS)).toEqual({
      settled: false,
      reason: 'settle_pending',
    });
  });

  test('an observation later than now fails closed → observation_in_future', () => {
    const s = observeAt(emptySettleState(REPO), 7, tuple(), T0, T0 + SETTLE_MS);
    expect(settleStatus(s.prs['7'], tuple(), T0 + SETTLE_MS - 1, SETTLE_MS)).toEqual({
      settled: false,
      reason: 'observation_in_future',
    });
  });

  test('a negative settleMs is a caller bug and throws', () => {
    expect(() => settleStatus(undefined, tuple(), T0, -1)).toThrow(RangeError);
  });
});

describe('parseSettleState', () => {
  const good = () =>
    JSON.parse(
      serializeSettleState(observeAt(emptySettleState(REPO), 7, tuple(), T0, T0 + MIN)),
    ) as Record<string, unknown>;

  test('a valid ledger round-trips with nothing discarded', () => {
    const state = observeAt(emptySettleState(REPO), 7, tuple(), T0, T0 + MIN);
    expect(parseSettleState(JSON.parse(serializeSettleState(state)), REPO)).toEqual({
      state,
      discarded: [],
    });
  });

  test.each([
    ['non-object', 'nope'],
    ['null', null],
    ['array', []],
    ['wrong version', { version: 2, repo: REPO, prs: {} }],
    ['repo mismatch', { version: SETTLE_STATE_VERSION, repo: 'evil/fork', prs: {} }],
    ['non-object prs', { version: SETTLE_STATE_VERSION, repo: REPO, prs: [] }],
  ])('%s → empty state plus one discarded reason', (_name, raw) => {
    const { state, discarded } = parseSettleState(raw, REPO);
    expect(state).toEqual(emptySettleState(REPO));
    expect(discarded).toHaveLength(1);
  });

  const obs = (ms: number, by = 'self-merge-prs:observe') => ({
    observedAt: new Date(ms).toISOString(),
    by,
  });
  const rec = (over: Record<string, unknown>) => ({
    tuple: { head: HEAD_A, base: BASE_1, forcePushEpoch: 0 },
    observations: [obs(T0)],
    ...over,
  });

  test.each([
    ['bad head sha', rec({ tuple: { head: 'zz', base: BASE_1, forcePushEpoch: 0 } })],
    [
      'uppercase base sha',
      rec({ tuple: { head: HEAD_A, base: 'F'.repeat(40), forcePushEpoch: 0 } }),
    ],
    ['negative epoch', rec({ tuple: { head: HEAD_A, base: BASE_1, forcePushEpoch: -1 } })],
    ['fractional epoch', rec({ tuple: { head: HEAD_A, base: BASE_1, forcePushEpoch: 1.5 } })],
    ['non-array observations', rec({ observations: { 0: obs(T0) } })],
    ['empty observations', rec({ observations: [] })],
    ['unparseable observedAt', rec({ observations: [{ observedAt: 'yesterday', by: 'x' }] })],
    ['non-canonical observedAt', rec({ observations: [{ observedAt: '2026-09-25', by: 'x' }] })],
    ['empty by', rec({ observations: [obs(T0, '')] })],
    ['out-of-order observations', rec({ observations: [obs(T0 + MIN), obs(T0)] })],
    [
      'over-cap observations',
      rec({ observations: Array.from({ length: MAX_OBSERVATIONS_PER_PR + 1 }, () => obs(T0)) }),
    ],
    ['non-object record', 42],
  ])('a record with %s is dropped; its siblings survive', (_name, bad) => {
    const raw = good();
    const prs = raw['prs'] as Record<string, unknown>;
    prs['9'] = bad;
    const { state, discarded } = parseSettleState(raw, REPO);
    expect(Object.keys(state.prs)).toEqual(['7']);
    expect(discarded).toHaveLength(1);
    expect(discarded[0]).toMatch(/^pr 9: /);
  });

  test('a non-decimal PR key is dropped', () => {
    const raw = good();
    const prs = raw['prs'] as Record<string, unknown>;
    prs['07'] = prs['7'];
    prs['__proto__x'] = prs['7'];
    const { state, discarded } = parseSettleState(raw, REPO);
    expect(Object.keys(state.prs)).toEqual(['7']);
    expect(discarded).toHaveLength(2);
  });
});

describe('pruneToOpen / sameTuple / serializeSettleState', () => {
  test('pruneToOpen drops closed PRs and does not mutate', () => {
    let s = emptySettleState(REPO);
    s = observeAt(s, 1, tuple(), T0);
    s = observeAt(s, 2, tuple(), T0);
    s = observeAt(s, 3, tuple(), T0);
    const before = structuredClone(s);
    expect(Object.keys(pruneToOpen(s, new Set([1, 3])).prs)).toEqual(['1', '3']);
    expect(s).toEqual(before);
  });

  test('sameTuple compares head, base, and epoch', () => {
    expect(sameTuple(tuple(), tuple())).toBe(true);
    expect(sameTuple(tuple(), tuple({ head: HEAD_B }))).toBe(false);
    expect(sameTuple(tuple(), tuple({ base: BASE_2 }))).toBe(false);
    expect(sameTuple(tuple(), tuple({ forcePushEpoch: 1 }))).toBe(false);
  });

  test('serialize is deterministic: numeric key order, 2-space indent, trailing newline', () => {
    const a = observeAt(observeAt(emptySettleState(REPO), 100, tuple(), T0), 9, tuple(), T0);
    const b = observeAt(observeAt(emptySettleState(REPO), 9, tuple(), T0), 100, tuple(), T0);
    const text = serializeSettleState(a);
    expect(text).toBe(serializeSettleState(b));
    expect(text.endsWith('}\n')).toBe(true);
    expect(text.startsWith('{\n  "version": 1,\n  "repo": "octo/widget",')).toBe(true);
    expect(text.indexOf('"9"')).toBeLessThan(text.indexOf('"100"'));
  });
});
