import { describe, expect, test } from 'vitest';
import {
  BackfillCoverageError,
  COVERAGE_SNAPSHOT_VERSION,
  coveragePrefixDigest,
  coverageRequestFrame,
  coverageSnapshotExtends,
  coverageSnapshotTarget,
  liveTargets,
  loadCoverageSnapshot,
  pendingTargets,
  readCoverageSnapshot,
  type CoverageSnapshot,
} from '../../../src/policy/crq/backfillCoverage.js';

const TARGET = 'a'.repeat(40);

/** One independent creditable review, as the ledger records it. */
function creditable(id: string): Record<string, unknown> {
  return {
    id,
    event_type: 'review',
    payload: {
      outcome: 'completed',
      source: { type: 'crq-run', producer: 'crq-runner-app', authenticated: true },
      completion: {
        terminal: true,
        skipped: false,
        scope_verified: true,
        exit_code: 0,
        errors: [],
      },
    },
  };
}

function event(id: string): Record<string, unknown> {
  return { id, event_type: 'queue-mutation', payload: {} };
}

function snapshot(events: Array<Record<string, unknown>>, covered: Record<string, unknown[]>) {
  return {
    version: COVERAGE_SNAPSHOT_VERSION,
    target: TARGET,
    events: events.length,
    prefix: coveragePrefixDigest(events, events.length),
    covered,
    gaps: [],
  };
}

describe('coverage snapshots', () => {
  test('a full object id is required, because a short id names no tree', () => {
    expect(coverageSnapshotTarget(TARGET)).toBe(TARGET);
    expect(coverageSnapshotTarget('f'.repeat(64))).toBe('f'.repeat(64));
    expect(() => coverageSnapshotTarget('abc')).toThrow(BackfillCoverageError);
    expect(() => coverageSnapshotTarget('A'.repeat(40))).toThrow('full object ID');
    expect(() => coverageSnapshotTarget(7)).toThrow('full object ID');
  });

  test('a stored snapshot reads back with interval sets, and a bad one reads as stale', () => {
    const stored = snapshot([event('a'), event('b')], {
      'src/a.py': [
        [1, 2],
        [5, 5],
      ],
    });
    const read = readCoverageSnapshot(stored, TARGET);
    expect(read?.events).toBe(2);
    expect([...(read?.covered.get('src/a.py') ?? [])]).toEqual([1, 2, 5]);
    // A snapshot is only usable for the target it was taken over.
    expect(readCoverageSnapshot(stored, 'b'.repeat(40))).toBeNull();
    expect(readCoverageSnapshot({ ...stored, version: 2 }, TARGET)).toBeNull();
    expect(readCoverageSnapshot({ ...stored, events: 1.5 }, TARGET)).toBeNull();
    expect(
      readCoverageSnapshot({ ...stored, covered: { 'src/a.py': [[2, 1]] } }, TARGET),
    ).toBeNull();
    expect(readCoverageSnapshot({ ...stored, gaps: {} }, TARGET)).toBeNull();
    expect(readCoverageSnapshot({ ...stored, covered: null }, TARGET)).toBeNull();
    expect(readCoverageSnapshot(null, TARGET)).toBeNull();
  });

  test('a snapshot extends only a sequence it is a prefix digest of', () => {
    const events = [event('a'), event('b')];
    const stored = readCoverageSnapshot(snapshot(events, {}), TARGET) as CoverageSnapshot;
    expect(coverageSnapshotExtends(stored, events)).toBe(true);
    expect(coverageSnapshotExtends(stored, [event('a')])).toBe(false);
    const other = readCoverageSnapshot(
      { ...snapshot(events, {}), prefix: '0'.repeat(64) },
      TARGET,
    ) as CoverageSnapshot;
    expect(coverageSnapshotExtends(other, events)).toBe(false);
  });

  test('an appended non-creditable event keeps the fold; a creditable one invalidates it', () => {
    const events = [event('a'), event('b')];
    const folds = snapshot(events, { 'src/a.py': [[1, 4]] });
    const digests = new Map<number, string>();
    expect(loadCoverageSnapshot(readCoverageSnapshot(folds, TARGET), events, digests)).toEqual({
      covered: new Map([['src/a.py', new Set([1, 2, 3, 4])]]),
      gaps: [],
    });
    expect(digests.size).toBe(1);
    // A queue-mutation no longer counts: coverage is only what a review credited.
    expect(
      loadCoverageSnapshot(readCoverageSnapshot(folds, TARGET), [...events, event('c')]),
    ).not.toBeNull();
    expect(
      loadCoverageSnapshot(readCoverageSnapshot(folds, TARGET), [...events, creditable('c')]),
    ).toBeNull();
    expect(loadCoverageSnapshot(null, events)).toBeNull();
  });

  test('the refresher request names every target once', () => {
    expect(
      coverageRequestFrame('head-1', ['b'.repeat(40), 'a'.repeat(40), 'b'.repeat(40)]),
    ).toEqual({
      head: 'head-1',
      targets: ['a'.repeat(40), 'b'.repeat(40)],
    });
  });
});

describe('queue targets', () => {
  const queue = {
    items: [
      { kind: 'backfill', state: 'pending', target: '1'.repeat(40) },
      { kind: 'backfill', state: 'leased', target: '2'.repeat(40) },
      { kind: 'backfill', state: 'done', target: '3'.repeat(40) },
      { kind: 'backfill', state: 'quarantined', target: '4'.repeat(40) },
      { kind: 'coverage', state: 'pending', target: '5'.repeat(40) },
    ],
  };

  test('pending targets are pending backfill jobs only', () => {
    expect([...pendingTargets(queue)]).toEqual(['1'.repeat(40)]);
  });

  test('live targets are the jobs that may still be dispatched', () => {
    expect([...liveTargets(queue)]).toEqual(['1'.repeat(40), '2'.repeat(40)]);
  });

  test('a malformed snapshot refuses instead of reporting an empty backlog', () => {
    expect(() => pendingTargets({ items: {} })).toThrow('queue items must be an array');
    expect(() => pendingTargets('queue')).toThrow('queue snapshot must be an object');
    expect(() => pendingTargets({ items: [1] })).toThrow('queue item must be an object');
    expect([...pendingTargets({})]).toEqual([]);
  });
});
