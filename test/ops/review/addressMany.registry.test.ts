// Split provenance: test/ops/review/addressMany.test.ts was split into this
// file plus addressMany.helpers.ts, addressMany.dispatch.test.ts,
// addressMany.guards.test.ts, addressMany.budget.test.ts,
// addressMany.query.test.ts, addressMany.enrollment.test.ts,
// addressMany.accounting.test.ts, addressMany.concurrency.test.ts,
// addressMany.isolation.test.ts and addressMany.usage.test.ts.
import { expect, test } from 'vitest';
import { ReviewAddressManyInputSchema, registry } from '../../../src/ops/review/registry.js';
import { input } from './addressMany.helpers.js';

test('registry exposes strict bulk schema for generic CLI dispatch', async () => {
  const entry = registry.find((entry) => entry.name === 'review.addressMany');
  expect(entry).toBeDefined();
  expect(typeof (await entry!.importer())).toBe('function');
  expect(ReviewAddressManyInputSchema.safeParse({ ...input, typo: true }).success).toBe(false);
});
