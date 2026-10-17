// Phase 1.4 — the one Forge interface's composition pins: makeForge() binds
// the adapter's production capabilities under one value, construction is
// INERT (closures only — no spawn, no env read beyond the runner's own
// CQ_GH_BIN lookup at invocation time), and each member is exactly the
// shipped implementation the ops families consume through their own seams.
// The wiring the Phase 1.6 deps bag will consume is pinned here so the
// umbrella cannot silently drift from the members it composes.
import { describe, expect, expectTypeOf, it } from 'vitest';
import { makeForge } from '../../../src/adapters/forge-github/forge.js';
import { fetchReviewState } from '../../../src/adapters/forge-github/fetchReviewState.js';
import { snapshotPrState } from '../../../src/adapters/forge-github/snapshotPrState.js';
import { makeSubprocessPrEffects } from '../../../src/adapters/forge-github/ghEffects.js';
import { realMergeEffects } from '../../../src/adapters/forge-github/mergeEffects.js';
import type {
  MergeEffects,
  RealMergeEffectsOpts,
} from '../../../src/adapters/forge-github/mergeEffects.js';
import type { PrEffects } from '../../../src/ops/pr/assemblePrs.js';
import type { GhFn } from '../../../src/adapters/forge-github/gh.js';

describe('makeForge (the one Forge binding)', () => {
  it('constructs inertly and binds the shipped implementations', () => {
    const before = process.env['CQ_GH_BIN'];
    delete process.env['CQ_GH_BIN'];
    try {
      const forge = makeForge();
      expect(typeof forge.run).toBe('function');
      expect(forge.fetchReviewState).toBe(fetchReviewState);
      expect(forge.snapshotPrState).toBe(snapshotPrState);
      expect(forge.prEffects).toBe(makeSubprocessPrEffects);
      // mergeEffects is a factory, not a singleton: the member IS the
      // production factory, and a binding produces a real MergeEffects.
      expect(forge.mergeEffects).toBe(realMergeEffects);
      const merge = forge.mergeEffects({ repoRoot: '/tmp/forge-nonexistent' });
      expectTypeOf(merge).toEqualTypeOf<MergeEffects>();
      expect(Object.keys(merge).sort()).toEqual(
        [
          'fetchRef',
          'mergePr',
          'pushRef',
          'readBaseRef',
          'retargetBase',
          'validateRef',
          'worktreePrepare',
          'worktreeRemove',
        ].sort(),
      );
    } finally {
      if (before !== undefined) process.env['CQ_GH_BIN'] = before;
    }
  });

  it('binds the PrEffects shape and keeps BaselinePrEffects argv-safe at construction', () => {
    const forge = makeForge();
    const pr: PrEffects = forge.prEffects('/tmp/forge-nonexistent');
    expect(Object.keys(pr).sort()).toEqual(
      ['comment', 'createPr', 'editPrBody', 'getPrBody', 'getPrReadiness', 'searchPrByHead'].sort(),
    );
    // The ratchet effects validate their (head, base) pair BEFORE any
    // subprocess can spawn — construction refuses an unsafe base outright.
    expect(() => forge.baselinePrEffects('/tmp/forge-nonexistent', '../escape')).toThrow(
      /unsafe base/,
    );
  });

  it('keeps the gh transport type-compatible with every consumer seam', () => {
    const forge = makeForge();
    expectTypeOf(forge.run).toEqualTypeOf<GhFn>();
    // Members stay individually usable where a family consumes only one.
    const opts: RealMergeEffectsOpts = { repoRoot: '/tmp', run: forge.run };
    expect(opts.run).toBe(forge.run);
  });
});
