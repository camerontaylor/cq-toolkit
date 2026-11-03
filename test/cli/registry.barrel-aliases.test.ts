// Split provenance: test/cli/registry.test.ts was split into the
// registry.*.test.ts siblings in this directory; shared fixtures and helpers
// live in registry.helpers.ts, which carries the full I1 contract header.
// This file carries the root-barrel alias surface (invariant 8).
import { describe, expect, test } from 'vitest';
import { get, list } from '../../src/registry/index.js';

describe('root barrel aliases (src/index.js)', () => {
  test('the root barrel exposes the ratchet surface (review-debt #66)', async () => {
    // The ratchet family index was an empty placeholder, so the barrel's
    // `export *` line exported nothing — installed-package consumers could
    // not reach any ratchet functionality. The populated family index now
    // delivers the factories, helpers, guard, adapter registry, and the
    // shipped adapters through the SAME star-export line.
    const barrel = await import('../../src/index.js');
    for (const name of [
      'createCaptureBaseline',
      'pruneBaselines',
      'resolveBaselinesDir',
      'createCheckRatchet',
      'createProposeBaselineUpdate',
      'DEFAULT_PR_TOKEN',
      'renderBaseline',
      'parseBaseline',
      'baselineRelPath',
      'tightens',
      'loosens',
      'isIso8601Instant',
      'checkDiffMonotonicity',
      'formatViolations',
      'registerAdapter',
      'getAdapter',
      'listAdapters',
      'complexity',
      'coverage',
      'typecheckCount',
    ]) {
      expect(Object.hasOwn(barrel, name), name).toBe(true);
    }
  });

  test('exposes listOps/getOp; the generic list/get names never sit on the barrel', async () => {
    const barrel = await import('../../src/index.js');
    // Aliases of the same registry seam, not re-implementations.
    expect(barrel.listOps).toBe(list);
    expect(barrel.getOp).toBe(get);
    // The bare generic names would collide (star-export ambiguity) with the
    // first family barrel that ever exports them — they must stay absent.
    expect(Object.hasOwn(barrel, 'list')).toBe(false);
    expect(Object.hasOwn(barrel, 'get')).toBe(false);
  });
});
