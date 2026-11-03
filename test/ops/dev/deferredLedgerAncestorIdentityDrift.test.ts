import { expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { loadCurrentDeferredVendorDebt } from '../../../src/ops/dev/internal/deferredLedger.js';
import { devLedgerPath } from '../../../src/ops/dev/record.js';
import type { DeferredQueueClient } from '../../../src/ops/review/internal/queueProtocol.js';
import { successorWithPendingAncestor } from './deferredLedgerHelpers.js';

for (const status of ['awaiting-pr', 'vendor-blocked'] as const) {
  for (const field of ['branch', 'head', 'base', 'dirty'] as const) {
    for (const expires of [false, true]) {
      test(`nonterminal ${status} ancestor changed ${field} rejects, final-command expiry=${String(expires)}`, async () => {
        const t = await successorWithPendingAncestor();
        let refreshed = false;
        let exhausted = false;
        let finalCommand = false;
        const path = devLedgerPath(t.f.repo.root, t.f.state.branch);
        const bytes = await readFile(path);
        const client: DeferredQueueClient = {
          ...t.f.client,
          status: async (reference) => {
            if (reference.requestId !== t.predecessor.reference.requestId) return t.successorStatus;
            refreshed = true;
            return status === 'awaiting-pr'
              ? t.successorStatus
              : {
                  ...t.successorStatus,
                  state: 'blocked',
                  enqueued: true,
                  reason: {
                    source: 'vendor',
                    category: 'vendor-rate-limited',
                    code: 'rate_limited',
                  },
                };
          },
        };
        const effects = {
          ...t.f.effects,
          runCommand: async (...call: Parameters<typeof t.f.effects.runCommand>) => {
            const result = await t.f.effects.runCommand(...call);
            if (!refreshed || call[0] !== 'git') return result;
            if (field === 'branch' && call[1].includes('symbolic-ref'))
              result.stdout = 'refs/heads/drifted\n';
            if (field === 'head' && call[1].includes('rev-parse') && call[1].at(-1) === 'HEAD')
              result.stdout = 'a'.repeat(40) + '\n';
            if (field === 'base' && call[1].at(-1) === `${t.read.state.base}^{commit}`)
              result.stdout = 'b'.repeat(40) + '\n';
            if (call[1].includes('ls-files')) {
              finalCommand = true;
              if (field === 'dirty') result.stdout = 'drifted.ts\0';
              if (expires) exhausted = true;
            }
            return result;
          },
        };
        await expect(
          loadCurrentDeferredVendorDebt(
            effects,
            'main',
            t.read.state,
            t.f.effects.openLedger(t.f.state.branch).load(),
            client,
            undefined,
            { remainingMs: () => (exhausted ? 0 : 5_000) },
          ),
        ).rejects.toThrow('identity changed');
        expect(refreshed).toBe(true);
        expect(finalCommand).toBe(true);
        expect(exhausted).toBe(expires);
        expect(await readFile(path)).toEqual(bytes);
      });
    }
  }
}
test('a matching pending ancestor at identity-read expiry retains debt without an append', async () => {
  const t = await successorWithPendingAncestor();
  let refreshed = false;
  let exhausted = false;
  let verified = false;
  const path = devLedgerPath(t.f.repo.root, t.f.state.branch);
  const bytes = await readFile(path);
  const effects = {
    ...t.f.effects,
    runCommand: async (...call: Parameters<typeof t.f.effects.runCommand>) => {
      const result = await t.f.effects.runCommand(...call);
      if (refreshed && call[0] === 'git' && call[1].includes('ls-files')) {
        verified = true;
        exhausted = true;
      }
      return result;
    },
  };
  const client: DeferredQueueClient = {
    ...t.f.client,
    status: async (reference) => {
      if (reference.requestId === t.predecessor.reference.requestId) refreshed = true;
      return t.successorStatus;
    },
  };
  const before = t.f.effects.openLedger(t.f.state.branch).load();
  const debt = await loadCurrentDeferredVendorDebt(
    effects,
    'main',
    t.read.state,
    before,
    client,
    undefined,
    { remainingMs: () => (exhausted ? 0 : 5_000) },
  );
  expect(verified).toBe(true);
  expect(debt?.reference).toEqual(t.successor.reference);
  expect(await readFile(path)).toEqual(bytes);
});
