// Split provenance: test/ops/review/address.test.ts was split into this file
// plus address.{helpers.ts,composition,reviewRounds,admission,blockedRereview,vendorBoundary,m5b3Correlation}.test.ts.
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { makeGitMutex } from '../../../src/shared/gitMutex.js';
import { makeReviewAddress } from '../../../src/ops/review/address.js';
import { fixture } from './address.helpers.js';

test('plain and isolated address calls share the caller per-PR lock', async () => {
  const f = await fixture();
  try {
    const domain = f.repo.git('rev-parse', '--path-format=absolute', '--git-common-dir').trim();
    const result = await makeGitMutex({
      lockPath: join(domain, 'cq-review-address-pr-7'),
      failFast: true,
    }).withLock(async () => {
      return makeReviewAddress({ ...f.deps, coordinationRoot: domain })({
        ...f.input,
        source: 'pr:7',
      });
    });
    expect(result.status).toBe('needs-human');
    expect(f.calls).toEqual([]);
    expect(result.status === 'needs-human' && result.reason).toMatch(/lock|locked/i);
  } finally {
    await f.cleanup();
  }
});
