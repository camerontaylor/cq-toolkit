import { describe, expect, it } from 'vitest';
import {
  makeCoverageEffects,
  type InjectedCoverageSeams,
} from '../../../src/adapters/crq/coverageEffects.js';
import { CoverageIdentityError, type Queue } from '../../../src/queue-runner/coverageUsage.js';
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
  rank4Gate: unbound('rank4Gate'),
  bindRun: unbound('bindRun'),
  cancelBeforeVendor: unbound('cancelBeforeVendor'),
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
    expect(() => effects.rank4Gate({} as never, {} as never, false)).toThrow(
      'rank4Gate is not bound',
    );
  });

  it('maps a Python ValueError/KeyError/TypeError from legacyOrigins onto CoverageIdentityError', () => {
    const { effects } = build();
    const queue = { items: [] } as unknown as Queue;
    expect(() => effects.legacyOrigins(queue, {} as never)).toThrow(CoverageIdentityError);
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
