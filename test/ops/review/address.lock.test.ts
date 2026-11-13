// Split provenance: test/ops/review/address.test.ts was split into this file
// plus address.{helpers.ts,composition,reviewRounds,admission,blockedRereview,vendorBoundary,m5b3Correlation}.test.ts.
import { expect, test } from 'vitest';
import { acquireSlot } from '../../../src/adapters/lock/slotLock.js';
import { makeReviewAddress } from '../../../src/ops/review/address.js';
import { fixture } from './address.helpers.js';

test('plain and isolated address calls share the caller per-PR lock', async () => {
  const f = await fixture();
  try {
    const domain = f.repo.git('rev-parse', '--path-format=absolute', '--git-common-dir').trim();
    const held = await acquireSlot(domain, 7);
    let result;
    try {
      result = await (async () => {
        return makeReviewAddress({ ...f.deps, coordinationRoot: domain })({
          ...f.input,
          source: 'pr:7',
        });
      })();
    } finally {
      await held.close();
    }
    expect(result.status).toBe('needs-human');
    expect(f.calls).toEqual([]);
    expect(result.status === 'needs-human' && result.reason).toMatch(/lock|locked/i);
  } finally {
    await f.cleanup();
  }
});
