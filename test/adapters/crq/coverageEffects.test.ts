import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  makeCoverageEffects,
  type InjectedCoverageSeams,
} from '../../../src/adapters/crq/coverageEffects.js';
import { CoverageIdentityError, type Queue } from '../../../src/queue-runner/coverageUsage.js';
import { PyError } from '../../../src/policy/crq/pyCompat.js';
import type { MeasureGit } from '../../../src/queue-runner/measureMerged.js';

const unbound = (name: string) => () => {
  throw new Error(`${name} is not bound in this test`);
};

const injected = {
  nowMs: () => Date.parse('2026-11-20T12:00:00Z'),
  select: unbound('select'),
  backfillDispatchConfigured: unbound('backfillDispatchConfigured'),
  liveItems: unbound('liveItems'),
  compareItems: unbound('compareItems'),
  parseIsoMs: unbound('parseIsoMs'),
  depsMet: unbound('depsMet'),
  buildSynthetic: unbound('buildSynthetic'),
} as unknown as InjectedCoverageSeams;

function build(coverageConfig: Record<string, unknown> = {}) {
  const calls: string[][] = [];
  const git: MeasureGit = {
    git: (args) => {
      calls.push([...args]);
      return Promise.resolve('abc123');
    },
    pathExists: () => Promise.resolve(true),
  };
  const effects = makeCoverageEffects({
    git,
    measure: { defaultRef: 'origin/main', minFileFocus: 0.25, iso: () => '2026-11-20T12:00:00Z' },
    coverageConfig,
    rank4: {
      iso: () => '2026-11-20T12:00:00Z',
      ordinaryEligible: unbound('ordinaryEligible'),
      stateEvent: unbound('stateEvent') as never,
      saveQueue: unbound('saveQueue') as never,
    },
    injected,
  });
  return { effects, calls };
}

describe('makeCoverageEffects', () => {
  it('resolves the merge queue and diff names through the git port', async () => {
    const { effects, calls } = build();
    expect(await effects.mergeQueueSha()).toBe('abc123');
    expect(await effects.diffNameOnly('a', 'b')).toBe('abc123');
    expect(calls).toEqual([
      ['rev-parse', 'origin/main^{commit}'],
      ['diff', '--name-only', 'a', 'b'],
    ]);
  });

  it('keeps the unbound seams as the caller supplied them', () => {
    const { effects } = build();
    expect(() => effects.buildSynthetic({} as never, {} as never)).toThrow(
      'buildSynthetic is not bound',
    );
    expect(() => effects.select({} as never, [], false, null)).toThrow('select is not bound');
  });

  it('binds select only when its collaborators are supplied, and never touches them when dispatch is off', async () => {
    const touched: string[] = [];
    const base = {
      git: { git: () => Promise.resolve(''), pathExists: () => Promise.resolve(true) },
      measure: { defaultRef: 'origin/main', minFileFocus: 0.25, iso: () => '2026-11-20T12:00:00Z' },
      coverageConfig: {},
      rank4: {
        iso: () => '2026-11-20T12:00:00Z',
        ordinaryEligible: unbound('ordinaryEligible'),
        stateEvent: unbound('stateEvent') as never,
        saveQueue: unbound('saveQueue') as never,
      },
    };
    const live = {
      publicationFailureExists: () => {
        touched.push('probe');
        return false;
      },
      fetchLedger: () => {
        touched.push('fetch');
        return Promise.resolve({ head: 'h', events: [] });
      },
      loadCoverage: () => {
        touched.push('load');
        return Promise.resolve(null);
      },
      requestCoverage: () => {
        touched.push('request');
        return Promise.resolve();
      },
      launch: () => {
        touched.push('launch');
        return Promise.resolve('run');
      },
    };
    const queue = { items: [] } as unknown as Queue;
    // Without the input, select is whatever the caller injected (here: nothing, so it throws).
    const bare = makeCoverageEffects({ ...base, injected: {} });
    expect(() => bare.select(queue, [], false, null)).toThrow('select is not bound');
    // With the input but no dispatch switch bound or injected, it throws when called.
    const noSwitch = makeCoverageEffects({ ...base, injected: {}, select: live });
    await expect(noSwitch.select(queue, [], false, null)).rejects.toThrow(
      'backfillDispatchConfigured is not bound',
    );
    // With the switch off it answers without reaching a live effect.
    const off = makeCoverageEffects({
      ...base,
      injected: { backfillDispatchConfigured: () => false },
      select: live,
    });
    expect(await off.select(queue, [], false, null)).toEqual({ started: null, available: false });
    // The publication-failure probe runs before the dispatch switch, as in Python; nothing else does.
    expect(touched).toEqual(['probe', 'probe']);
    // An injected select is ignored once the input is supplied.
    const wins = makeCoverageEffects({
      ...base,
      injected: { select: unbound('injected') as never, backfillDispatchConfigured: () => false },
      select: live,
    });
    expect(await wins.select(queue, [], false, null)).toEqual({ started: null, available: false });
  });

  it('binds the tick seams and the dispatch switch only when their input is supplied', () => {
    const root = mkdtempSync(join(tmpdir(), 'cq-effects-bind-'));
    try {
      const effects = makeCoverageEffects({
        git: { git: () => Promise.resolve(''), pathExists: () => Promise.resolve(true) },
        measure: { defaultRef: 'origin/main', minFileFocus: 0.25, iso: () => 'x' },
        coverageConfig: {},
        rank4: {
          iso: () => 'x',
          ordinaryEligible: unbound('ordinaryEligible'),
          stateEvent: unbound('stateEvent') as never,
          saveQueue: unbound('saveQueue') as never,
        },
        tick: {
          clock: () => 1_000,
          schedule: { primaryRepo: 'owner/primary', repos: [], localReviewAgingMinutes: 60 },
        },
        dispatch: { stateRoot: root, loadLimits: unbound('loadLimits') as never },
        injected: { select: unbound('select') } as unknown as InjectedCoverageSeams,
      });
      expect(effects.nowMs()).toBe(1_000);
      expect(effects.parseIsoMs('2026-11-20T12:00:00Z')).toBe(Date.parse('2026-11-20T12:00:00Z'));
      expect(effects.liveItems({ items: [{ id: 'a', kind: 'promotion' }, { id: 'b' }] })).toEqual([
        { id: 'b' },
      ]);
      expect(effects.backfillDispatchConfigured()).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('calls an injected clock on its owner when no tick seam is bound', () => {
    const owner = {
      select: unbound('select'),
      fixedMs: Date.parse('2026-11-20T12:00:00Z'),
      nowMs(this: { fixedMs: number }) {
        return this.fixedMs;
      },
    };
    const effects = makeCoverageEffects({
      git: { git: () => Promise.resolve(''), pathExists: () => Promise.resolve(true) },
      measure: { defaultRef: 'origin/main', minFileFocus: 0.25, iso: () => 'x' },
      coverageConfig: {},
      rank4: {
        iso: () => 'x',
        ordinaryEligible: unbound('ordinaryEligible'),
        stateEvent: unbound('stateEvent') as never,
        saveQueue: unbound('saveQueue') as never,
      },
      injected: owner as unknown as InjectedCoverageSeams,
    });
    // `this` is the injected object, not a detached call.
    expect(effects.nowMs()).toBe(owner.fixedMs);
    expect(effects.coverageCandidate({ items: [] } as unknown as Queue, 'abc123')).toBeNull();
  });

  it('throws from a tick member that is neither bound nor injected', () => {
    const effects = makeCoverageEffects({
      git: { git: () => Promise.resolve(''), pathExists: () => Promise.resolve(true) },
      measure: { defaultRef: 'origin/main', minFileFocus: 0.25, iso: () => 'x' },
      coverageConfig: {},
      rank4: {
        iso: () => 'x',
        ordinaryEligible: unbound('ordinaryEligible'),
        stateEvent: unbound('stateEvent') as never,
        saveQueue: unbound('saveQueue') as never,
      },
      injected: { select: unbound('select') } as unknown as InjectedCoverageSeams,
    });
    expect(() => effects.nowMs()).toThrow('nowMs is not bound');
    expect(() => effects.liveItems({ items: [] })).toThrow('liveItems is not bound');
    expect(() => effects.backfillDispatchConfigured()).toThrow(
      'backfillDispatchConfigured is not bound',
    );
  });

  it('binds buildSynthetic over the supplied synthetic deps', async () => {
    const seen: string[] = [];
    const effects = makeCoverageEffects({
      git: { git: () => Promise.resolve(''), pathExists: () => Promise.resolve(true) },
      measure: { defaultRef: 'origin/main', minFileFocus: 0.25, iso: () => 'x' },
      coverageConfig: {},
      rank4: {
        iso: () => 'x',
        ordinaryEligible: unbound('ordinaryEligible'),
        stateEvent: unbound('stateEvent') as never,
        saveQueue: unbound('saveQueue') as never,
      },
      synthetic: {
        git: { git: () => Promise.resolve(''), pathExists: () => Promise.resolve(true) },
        accounting: {
          resolve: (target: string) => {
            seen.push(target);
            return Promise.reject(new PyError('RuntimeError', 'stop'));
          },
        } as never,
        subjects: {} as never,
      },
      injected,
    });
    await expect(effects.buildSynthetic({} as never, 'sha1')).rejects.toThrow('stop');
    expect(seen).toEqual(['sha1']);
  });

  it('binds rank4Gate, bindRun and cancelBeforeVendor, and an unbound collaborator throws', async () => {
    const { effects } = build();
    const item = { id: 'job-a', kind: 'backfill', state: 'pending', attempt_id: 'job-a:1' };
    const queue = { items: [item], backfill_reservations: {} } as unknown as Queue;
    // The gate reaches its eligibility collaborator first, and it is unbound here.
    await expect(effects.rank4Gate(queue, item, false)).rejects.toThrow(
      'ordinaryEligible is not bound',
    );
    expect(() => effects.bindRun(queue, item, 'run-1')).toThrow(/^'job-a:1'$/);
    effects.cancelBeforeVendor(queue, item);
    expect(item).toMatchObject({ vendor_state: 'terminal' });
  });

  describe('identity mapping of the exceptions Python catches', () => {
    const { effects } = build();
    const queue = { items: [] } as unknown as Queue;
    const now = Date.parse('2026-11-20T12:00:00Z');

    it('maps ValueError', () => {
      // `_path("")` raises ValueError.
      expect(() => effects.legacyRetryAllowed(queue, 1, '', now)).toThrow(CoverageIdentityError);
    });

    it('maps KeyError', () => {
      // `release["deadlines"]` on a quota release row without it.
      const keyed = {
        items: [],
        legacy_coverage_quota_releases: [{ family: 'legacy-coverage:1:src/a.py' }],
      } as unknown as Queue;
      expect(() => effects.legacyRetryAllowed(keyed, 1, 'src/a.py', now)).toThrow(
        CoverageIdentityError,
      );
    });

    it('maps TypeError', () => {
      // an unhashable `coverage_paths` member.
      expect(() => effects.legacyOrigins(queue, { coverage_paths: [[1]] } as never)).toThrow(
        CoverageIdentityError,
      );
    });

    it('lets every other class propagate', () => {
      // an explicit null history makes `.get` an AttributeError, which stops the tick.
      const nulled = { items: [], backfill_families: { 'legacy-coverage:1:src/a.py': null } };
      let caught: unknown;
      try {
        effects.legacyRetryAllowed(nulled as unknown as Queue, 1, 'src/a.py', now);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(PyError);
      expect((caught as PyError).pythonError).toBe('AttributeError');
    });
  });

  describe('[coverage] config pass-through', () => {
    const NOW = '2026-11-20T12:00:00Z';
    const queue = {
      items: [
        {
          id: 'pr-1',
          kind: 'merged',
          pr: 1,
          state: 'done',
          merge_commit: 'b'.repeat(40),
          measure: {
            merge_queue: 'a'.repeat(40),
            synthetic_paths: [],
            files: [
              { path: 'src/a.py', now: 'src/a.py', added: 10, surviving: 5, synthetic_added: 12 },
            ],
          },
        },
      ],
      coverage: {
        schema_version: 1,
        runs: {},
        observations: {},
        paths: { 'src/a.py': { last_reviewed_at: NOW, review_count: 1 } },
      },
    } as unknown as Queue;

    it('defaults to a 24 hour minimum age', () => {
      expect(build().effects.coverageCandidate(queue, 'a'.repeat(40))).toBeNull();
    });

    it('passes min_age_hours through', () => {
      const found = build({ min_age_hours: 0 }).effects.coverageCandidate(queue, 'a'.repeat(40));
      expect(found).toMatchObject({ coverage_paths: ['src/a.py'] });
    });

    it('passes max_paths through', () => {
      expect(() =>
        build({ max_paths: 0 }).effects.coverageCandidate(queue, 'a'.repeat(40)),
      ).toThrow('invalid coverage bounds');
    });

    it('passes excluded_paths through', () => {
      const config = { min_age_hours: 0, excluded_paths: ['src/a.py'] };
      expect(build(config).effects.coverageCandidate(queue, 'a'.repeat(40))).toBeNull();
    });
  });

  it('rejects an unknown [coverage] key like Python **kwargs, as a TypeError', () => {
    const { effects } = build({ bogus: 1 });
    const queue = { items: [] } as unknown as Queue;
    expect(() => effects.coverageCandidate(queue, 'abc123')).toThrow(
      /unexpected keyword argument 'bogus'/,
    );
  });

  it('finds no candidate in an empty queue', () => {
    const { effects } = build();
    const queue = { items: [] } as unknown as Queue;
    expect(effects.coverageCandidate(queue, 'abc123')).toBeNull();
  });
});
