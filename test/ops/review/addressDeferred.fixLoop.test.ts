import { join } from 'node:path';
import { expectOpaqueIncomplete } from './slotOwnership.helpers.js';
// Split provenance: test/ops/review/addressDeferred.test.ts was split into
// addressDeferred.{admission,fixLoop,cachedFindings,realEngine,queueOwnership,
// importProvenance,emptyFileAdmission}.test.ts. This file holds the fix-loop
// ordering, dispatch and vendor-debt preservation tests.
import { expect, test } from 'vitest';
import { makeReviewAddress } from '../../../src/ops/review/address.js';
import { prepareDeferredVendorReview } from '../../../src/ops/dev/internal/deferredLedger.js';
import { readWorkState } from '../../../src/ops/dev/internal/workState.js';
import { createEscalationState } from '../../../src/ops/fix/escalation.js';
import { config, fixture } from './addressDeferred.helpers.js';

test('known substantive finding reaches fixing; changed head requires durable successor and fresh coverage', async () => {
  const f = await fixture();
  try {
    const record = f.record();
    record.findings = [
      {
        id: 'known',
        source: 'agent',
        file: 'src/a.ts',
        severity: 'major',
        text: 'fix current content',
        status: 'open',
      },
    ];
    let fixes = 0;
    let reviews = 0;
    const result = await makeReviewAddress({
      config,
      initialRecord: record,
      resolveDeferredVendorContext: f.resolver,
      disposition: async () => ({ status: 'ok', value: {} }),
      workerFactory: () => ({
        escalation: createEscalationState,
        fix: async (item) => {
          fixes++;
          const observedHead = f.record().head;
          await f.repo.write('src/a.ts', 'export const fixed = true;\n');
          const commit = f.repo.commitAll('verified fix');
          return {
            finding: { ...item, status: 'fixed' },
            commit,
            observedHead,
            reason: 'verified',
            validation: [],
          };
        },
      }),
      review: async () => {
        reviews++;
        const read = await readWorkState(f.effects, { target: 'main', base: f.state.base });
        if (!read.ok) throw new Error(read.reason);
        const successor = await prepareDeferredVendorReview(
          f.effects,
          'main',
          read.state,
          f.client,
        );
        if (!successor) throw new Error('successor debt missing');
        expect(successor?.reference.requestId).not.toBe(f.debt.reference.requestId);
        expect(successor?.predecessor).toBeDefined();
        return {
          status: 'ok',
          value: f.record(),
          report: { ...f.record(), deferredVendorDebt: successor },
        };
      },
    })({ repoRoot: f.repo.root, source: 'local', journalDir: f.journalDir });
    await expectOpaqueIncomplete(result, join(f.repo.root, '.git'));
    expect(fixes).toBe(1);
    expect(reviews).toBe(1);
    const debts = f.effects
      .openLedger(f.state.branch)
      .load()
      .records.filter((entry) => entry.kind === 'vendor-debt');
    expect(debts).toHaveLength(2);
    expect(debts[0]!.debt).toEqual(f.debt);
    expect(f.effects.calls.some((call) => call.command === 'coderabbit')).toBe(false);
  } finally {
    await f.cleanup();
  }
});

test('post-await wall stop outranks otherwise valid debt and prevents dispatch', async () => {
  const f = await fixture();
  const originalNow = Date.now;
  let clock = originalNow();
  try {
    Date.now = () => clock;
    const result = await makeReviewAddress({
      config,
      initialRecord: f.record(),
      resolveDeferredVendorContext: async (request) => {
        const context = await f.resolver(request);
        clock += 10001;
        return context;
      },
      workerFactory: () => {
        throw new Error('stop must precede dispatch');
      },
    })({ repoRoot: f.repo.root, source: 'local', journalDir: f.journalDir, wallMs: 10000 });
    expect(result.status).toBe('needs-human');
    expect(result.report?.stop).toBe('budget');
    expect(result.report?.fixes).toEqual([]);
  } finally {
    Date.now = originalNow;
    await f.cleanup();
  }
});

test('vendor debt never erases a deferred substantive finding when re-review omits it', async () => {
  const f = await fixture();
  try {
    const record = f.record();
    record.findings = [
      {
        id: 'known',
        source: 'agent',
        file: 'src/a.ts',
        severity: 'major',
        text: 'fix required',
        status: 'open',
      },
    ];
    let reviews = 0;
    const result = await makeReviewAddress({
      config,
      initialRecord: record,
      resolveDeferredVendorContext: f.resolver,
      disposition: async () => ({ status: 'ok', value: {} }),
      workerFactory: () => ({
        escalation: createEscalationState,
        fix: async (finding) => ({
          finding: { ...finding, status: 'deferred', reason: 'requires owner' },
          observedHead: record.head,
          reason: 'requires owner',
          validation: [],
        }),
      }),
      review: async () => {
        reviews++;
        return {
          status: 'needs-human',
          reason: 'vendor remains deferred',
          report: { ...f.record(), blockedTransient: true, deferredVendorDebt: f.debt },
        };
      },
    })({ repoRoot: f.repo.root, source: 'local', journalDir: f.journalDir, rounds: 1 });
    expect(result.status).toBe('needs-human');
    expect(result.report?.openBlocking).toMatchObject([{ id: 'known', status: 'deferred' }]);
    expect(reviews).toBe(1);
    expect(result.report?.reasons.join(' ')).not.toContain('retrying once');
    expect(result.report?.rounds[0]?.record).not.toHaveProperty('deferredVendorDebt');
  } finally {
    await f.cleanup();
  }
});
