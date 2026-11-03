// Split provenance: test/ops/review/addressDeferred.test.ts was split into
// addressDeferred.{admission,fixLoop,cachedFindings,realEngine,queueOwnership,
// importProvenance,emptyFileAdmission}.test.ts. This file holds the deferred
// vendor admission and refusal decisions.
import { expect, test } from 'vitest';
import { makeReviewAddress } from '../../../src/ops/review/address.js';
import { config, fixture } from './addressDeferred.helpers.js';

test.each(['pending', 'vendor-rate-limited', 'vendor-needs-action'] as const)(
  'address admits genuine current full agent coverage with visible debt: %s',
  async (category) => {
    const f = await fixture();
    try {
      if (category !== 'pending') {
        f.status.state = 'blocked';
        f.status.enqueued = true;
        f.status.reason = {
          source: 'vendor',
          category,
          code: category === 'vendor-needs-action' ? 'auth' : 'rate_limited',
        };
      }
      const result = await makeReviewAddress({
        config,
        initialRecord: f.record(),
        resolveDeferredVendorContext: f.resolver,
      })({ repoRoot: f.repo.root, source: 'local', journalDir: f.journalDir });
      expect(result.status, JSON.stringify(result)).toBe('ok');
      expect(result.status === 'ok' && result.value.deferredVendorDebt).toMatchObject({
        vendorCompleted: false,
      });
      expect(f.queueReads()).toBeGreaterThan(0);
      expect(f.effects.calls.some((call) => call.command === 'coderabbit')).toBe(false);
    } finally {
      await f.cleanup();
    }
  },
);

test.each([
  'queue-auth',
  'partial-agent',
  'stale-agent',
  'missing-source',
  'wrong-base',
  'unknown-vendor',
  'drift-after-await',
] as const)('address refuses %s without vendor completion credit', async (scenario) => {
  const f = await fixture();
  try {
    const record = f.record();
    if (scenario === 'queue-auth')
      f.client.status = async () => {
        throw new Error('queue authorization unavailable');
      };
    if (scenario === 'partial-agent') record.sources[1]!.coverage!.scope = 'uncommitted';
    if (scenario === 'stale-agent') record.sources[1]!.coverage!.head = 'a'.repeat(40);
    if (scenario === 'missing-source') record.sources.splice(1, 1);
    if (scenario === 'wrong-base') record.reviewed!.base = 'a'.repeat(40);
    if (scenario === 'unknown-vendor')
      f.status.reason = { source: 'vendor', category: 'unknown', code: 'unknown' };
    if (scenario === 'drift-after-await')
      f.client.status = async () => {
        await f.repo.write('src/a.ts', 'changed while reading queue\n');
        f.repo.commitAll('drift');
        return f.status;
      };
    const result = await makeReviewAddress({
      config,
      initialRecord: record,
      resolveDeferredVendorContext: f.resolver,
    })({ repoRoot: f.repo.root, source: 'local', journalDir: f.journalDir });
    expect(result.status).toBe('needs-human');
    expect(
      f.effects
        .openLedger(f.state.branch)
        .load()
        .records.filter((entry) => entry.kind === 'vendor-debt'),
    ).toHaveLength(1);
  } finally {
    await f.cleanup();
  }
});
