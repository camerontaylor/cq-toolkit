// Split provenance: test/ops/review/address.test.ts was split into this file
// plus address.{helpers.ts,composition,reviewRounds,admission,blockedRereview,lock,m5b3Correlation}.test.ts.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import type { CqConfig } from '../../../src/ops/analyze/cqConfig.js';
import { makeReviewAddress } from '../../../src/ops/review/address.js';
import type { FindingsRecord } from '../../../src/ops/review/findings.js';
import type {
  DeferredQueueClient,
  QueueStatus,
} from '../../../src/ops/review/internal/queueProtocol.js';
import { createEscalationState } from '../../../src/ops/fix/escalation.js';
import { makeSubprocessDevEffects } from '../../../src/ops/dev/effects.js';
import {
  DEV_LEDGER_VERSION,
  devLedgerPath,
  type DevVendorDebtRecord,
} from '../../../src/ops/dev/record.js';
import { cycleRecord } from '../dev/fakes.js';
import { makeTestRepo } from '../dev/repo.js';
import { finding, reportOf, role } from './address.helpers.js';

const bothReviewerConfig: CqConfig = {
  schemaVersion: 2,
  checks: [{ adapter: 'tsc-lines', command: { command: process.execPath, args: [] } }],
  roles: { worker: role, reviewer: role },
  budgets: { run: { maxTokens: 2000 } },
  review: { reviewers: ['agent', 'coderabbit'], rounds: 1 },
};

const vendorQueueStatus = (): QueueStatus => ({
  state: 'awaiting-pr',
  pr: null,
  mergeSha: null,
  itemId: null,
  receiptId: null,
  consumed: false,
  reviewed: false,
  fixed: false,
});

/**
 * Local composition across the REAL vendor-preparation boundary: the repo's own
 * cq.json configures both reviewers, it carries a genuine blocked CodeRabbit
 * origin in the dev ledger, and the DEFAULT makeReviewRun resolves forge
 * identity through a scoped offline `gh` shim. No review stub, no effects
 * factory, no disposition override.
 */
async function vendorAddressFixture() {
  const repo = await makeTestRepo();
  await repo.write('.gitignore', '/.cq/\n');
  await repo.write('cq.json', JSON.stringify(bothReviewerConfig));
  repo.commitAll('configure both reviewers');
  const branch = 'feature/x';
  const head = repo.git('rev-parse', 'HEAD').trim();
  const base = repo.git('merge-base', 'origin/main', 'HEAD').trim();
  makeSubprocessDevEffects(repo.root)
    .openLedger(branch)
    .save({
      version: DEV_LEDGER_VERSION,
      branch,
      records: [
        cycleRecord({
          head,
          base,
          dirtySha256: 'clean-tree',
          cycleId: 'c001-origin',
          vendorFailure: {
            source: 'vendor',
            category: 'vendor-rate-limited',
            codes: ['rate_limited'],
          },
          completion: { kind: 'blocked', reason: 'structured rate limit' },
        }),
      ],
    });
  const shimDir = await mkdtemp(join(tmpdir(), 'cq-gh-shim-'));
  await writeFile(
    join(shimDir, 'gh'),
    `#!${process.execPath}\nconst args = process.argv.slice(2);\nif (args[0] === 'repo') process.stdout.write('owner/repo\\n');\nelse if (args[0] === 'api') process.stdout.write('author\\n');\nelse process.exit(1);\n`,
    { mode: 0o755 },
  );
  const journalDir = await mkdtemp(join(tmpdir(), 'cq-address-vendor-'));
  const record = (): FindingsRecord => ({
    schemaVersion: 1,
    branch,
    reviewed: { base, scope: 'full' },
    head,
    sources: [
      { kind: 'agent', status: 'terminal' },
      { kind: 'coderabbit', status: 'terminal' },
    ],
    findings: [finding('a')],
  });
  const ledger = () => makeSubprocessDevEffects(repo.root).openLedger(branch).load();
  const appendForeign = () => {
    const store = makeSubprocessDevEffects(repo.root).openLedger(branch);
    const latest = store.load();
    store.save({
      ...latest,
      records: [...latest.records, cycleRecord({ head, base, cycleId: 'c913-external-append' })],
    });
  };
  const run = (queueClient: DeferredQueueClient) =>
    makeReviewAddress({
      initialRecord: record(),
      queueClient,
      workerFactory: () => ({
        escalation: createEscalationState,
        fix: async (item) => ({
          finding: { ...item, status: 'deferred', reason: 'needs owner' },
          observedHead: head,
          reason: 'needs owner',
          validation: [],
        }),
      }),
    })({ repoRoot: repo.root, source: 'local', journalDir, rounds: 1 });
  return {
    repo,
    shimDir,
    head,
    base,
    ledger,
    appendForeign,
    run,
    cleanup: async () => {
      await repo.cleanup();
      await rm(shimDir, { recursive: true, force: true });
      await rm(journalDir, { recursive: true, force: true });
    },
  };
}

describe('review.address vendor preparation boundary', () => {
  test('external append with a returning status read refuses without owning the bytes', async () => {
    const f = await vendorAddressFixture();
    const calls: string[] = [];
    const client: DeferredQueueClient = {
      enqueue: async () => {
        calls.push('enqueue');
        return vendorQueueStatus();
      },
      bind: async () => vendorQueueStatus(),
      cancel: async () => ({ ...vendorQueueStatus(), state: 'cancelled' }),
      status: async () => {
        calls.push('status');
        f.appendForeign();
        return vendorQueueStatus();
      },
    };
    try {
      vi.stubEnv('PATH', `${f.shimDir}:${process.env['PATH'] ?? ''}`);
      const result = await f.run(client);
      // The default runner actually dispatched: both queue calls, in order.
      expect(calls).toEqual(['enqueue', 'status']);
      expect(result.status).toBe('needs-human');
      expect(reportOf(result).reasons.join(' ')).toContain(
        'deferred debt or working identity changed while verifying queue status',
      );
      const ledger = f.ledger();
      // The engine's enrollment is durably on disk; the foreign bytes stay too,
      // and neither is reported as clean completion.
      expect(ledger.records.filter((entry) => entry.kind === 'vendor-debt')).toHaveLength(1);
      expect(
        ledger.records.some(
          (entry) => entry.kind === 'cycle' && entry.cycleId === 'c913-external-append',
        ),
      ).toBe(true);
    } finally {
      vi.unstubAllEnvs();
      await f.cleanup();
    }
  });

  test('external append with a throwing status read preserves the original error', async () => {
    const f = await vendorAddressFixture();
    const calls: string[] = [];
    const client: DeferredQueueClient = {
      enqueue: async () => {
        calls.push('enqueue');
        return vendorQueueStatus();
      },
      bind: async () => vendorQueueStatus(),
      cancel: async () => ({ ...vendorQueueStatus(), state: 'cancelled' }),
      status: async () => {
        calls.push('status');
        f.appendForeign();
        throw new Error('status read failed after external append');
      },
    };
    try {
      vi.stubEnv('PATH', `${f.shimDir}:${process.env['PATH'] ?? ''}`);
      const result = await f.run(client);
      expect(calls).toEqual(['enqueue', 'status']);
      expect(result.status).toBe('needs-human');
      expect(reportOf(result).reasons.join(' ')).toContain(
        'status read failed after external append',
      );
      const ledger = f.ledger();
      expect(ledger.records.filter((entry) => entry.kind === 'vendor-debt')).toHaveLength(1);
      expect(
        ledger.records.some(
          (entry) => entry.kind === 'cycle' && entry.cycleId === 'c913-external-append',
        ),
      ).toBe(true);
    } finally {
      vi.unstubAllEnvs();
      await f.cleanup();
    }
  });

  test('valid requested enrollment with a throwing status read is the reachable control', async () => {
    const f = await vendorAddressFixture();
    const calls: string[] = [];
    const client: DeferredQueueClient = {
      enqueue: async () => {
        calls.push('enqueue');
        return vendorQueueStatus();
      },
      bind: async () => vendorQueueStatus(),
      cancel: async () => ({ ...vendorQueueStatus(), state: 'cancelled' }),
      status: async () => {
        calls.push('status');
        throw new Error('status read failed after durable enrollment');
      },
    };
    try {
      vi.stubEnv('PATH', `${f.shimDir}:${process.env['PATH'] ?? ''}`);
      const result = await f.run(client);
      expect(calls).toEqual(['enqueue', 'status']);
      expect(result.status).toBe('needs-human');
      expect(reportOf(result).reasons.join(' ')).toContain(
        'status read failed after durable enrollment',
      );
      const ledger = f.ledger();
      const debts = ledger.records.filter(
        (entry): entry is DevVendorDebtRecord => entry.kind === 'vendor-debt',
      );
      expect(debts).toHaveLength(1);
      const debt = debts[0]!.debt;
      expect(debt.vendorCompleted).toBe(false);
      expect(debt.reference.binding).toMatchObject({
        kind: 'deferred-author',
        repo: 'owner/repo',
        producer: 'author',
        target: 'main',
        head: f.head,
      });
      expect(debt.deferral).toMatchObject({
        id: debt.reference.requestId,
        base: f.base,
        dirtySha256: 'clean-tree',
      });
      expect(debt.originAttempt).toMatchObject({
        cycleId: 'c001-origin',
        head: f.head,
        base: f.base,
        target: 'main',
      });
      // The real durable enrollment is the engine's own request on disk.
      const onDisk = JSON.parse(
        await readFile(devLedgerPath(f.repo.root, 'feature/x'), 'utf8'),
      ) as { records: { kind: string; debt?: { reference: { requestId: string } } }[] };
      const persisted = onDisk.records.filter((entry) => entry.kind === 'vendor-debt');
      expect(persisted).toHaveLength(1);
      expect(persisted[0]!.debt?.reference.requestId).toBe(debt.reference.requestId);
      expect(
        ledger.records.some(
          (entry) => entry.kind === 'cycle' && entry.cycleId === 'c913-external-append',
        ),
      ).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      await f.cleanup();
    }
  });
});
