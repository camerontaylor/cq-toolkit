// Split provenance: test/ops/review/addressDeferred.test.ts was split into
// addressDeferred.{admission,fixLoop,cachedFindings,realEngine,queueOwnership,
// importProvenance,emptyFileAdmission}.test.ts. This module carries the shared
// fixture surface verbatim from the original file; it declares no tests.
import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { resolveDeferredVendorContext } from '../../../src/ops/review/internal/addressDeferred.js';
import { prepareDeferredVendorReview } from '../../../src/ops/dev/internal/deferredLedger.js';
import { readWorkState } from '../../../src/ops/dev/internal/workState.js';
import type { CqConfig } from '../../../src/ops/analyze/cqConfig.js';
import type { FindingsRecord } from '../../../src/ops/review/findings.js';
import type {
  DeferredQueueClient,
  QueueStatus,
} from '../../../src/ops/review/internal/queueProtocol.js';
import { makeTestRepo, repoEffects } from '../dev/repo.js';
import { cycleRecord } from '../dev/fakes.js';
import { realTmpDir } from '../../helpers/tmp-dir.js';

export const config: CqConfig = {
  schemaVersion: 2,
  checks: [{ adapter: 'tsc-lines', command: { command: process.execPath, args: [] } }],
  roles: {
    worker: { provider: 'mock', model: 'mock' },
    reviewer: { provider: 'mock', model: 'mock' },
  },
  budgets: { run: { maxTokens: 1000 } },
  review: { reviewers: ['agent', 'coderabbit'] },
};

export async function fixture(ignoreState = true) {
  const repo = await makeTestRepo();
  // The injected resolver does not register pre-existing ledger writes.
  // Isolate receipt ownership while leaving queue evidence/unknown state unignored.
  await repo.write('.gitignore', ignoreState ? '/.cq/\n' : '/.cq/dev/\n');
  await repo.write('cq.json', JSON.stringify(config));
  repo.commitAll('configure offline review');
  const journalDir = await realTmpDir('cq-address-debt-');
  const effects = repoEffects(repo, (command, args) =>
    command === 'gh' ? (args[0] === 'api' ? 'author' : 'owner/repo') : undefined,
  );
  const read = await readWorkState(effects, { target: 'main' });
  if (!read.ok) throw new Error(read.reason);
  const state = read.state;
  const status: QueueStatus = {
    state: 'awaiting-pr',
    pr: null,
    mergeSha: null,
    itemId: null,
    receiptId: null,
    consumed: false,
    reviewed: false,
    fixed: false,
  };
  let queueReads = 0;
  const client: DeferredQueueClient = {
    enqueue: async () => status,
    bind: async () => status,
    cancel: async () => {
      throw new Error('prior obligations cannot be cancelled');
    },
    status: async () => {
      queueReads++;
      return status;
    },
  };
  const origin = cycleRecord({
    head: state.head,
    base: state.base,
    dirtySha256: 'clean-tree',
    cycleId: 'original-outage',
    completion: { kind: 'blocked', reason: 'typed vendor outage' },
    vendorFailure: { source: 'vendor', category: 'vendor-unavailable', codes: ['con_err'] },
  });
  effects.openLedger(state.branch).save({ version: 2, branch: state.branch, records: [origin] });
  const debt = await prepareDeferredVendorReview(effects, 'main', state, client);
  if (!debt) throw new Error('fixture debt missing');
  const record = (): FindingsRecord => ({
    schemaVersion: 1,
    branch: state.branch,
    head: repo.git('rev-parse', 'HEAD').trim(),
    reviewed: { scope: 'full', base: state.base },
    sources: [
      {
        kind: 'coderabbit',
        status: 'blocked',
        cycleId: origin.cycleId,
        reason: 'vendor unavailable',
      },
      {
        kind: 'agent',
        status: 'terminal',
        coverage: {
          version: 2,
          head: repo.git('rev-parse', 'HEAD').trim(),
          base: state.base,
          scope: 'full',
          mode: 'session',
          modeReason: 'fixture full delivery',
          pieces: [
            {
              component: 'tracked:a',
              path: 'src/a.ts',
              sha256: createHash('sha256').update('x').digest('hex'),
              chars: 1,
              bytes: 1,
              state: 'completed',
              sessionId: 's1',
            },
          ],
          sessions: [
            {
              id: 's1',
              status: 'complete',
              usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
              deliveries: [
                {
                  component: 'tracked:a',
                  start: 0,
                  end: 1,
                  sha256: createHash('sha256').update('x').digest('hex'),
                },
              ],
              requests: [{ serializedChars: 1, decodedChars: 1 }],
            },
          ],
        },
      },
    ],
    findings: [],
  });
  const resolver = (request: Parameters<typeof resolveDeferredVendorContext>[0]) =>
    resolveDeferredVendorContext(request, { effectsFactory: () => effects, queueClient: client });
  return {
    repo,
    journalDir,
    effects,
    state,
    status,
    client,
    debt,
    record,
    resolver,
    queueReads: () => queueReads,
    cleanup: async () => {
      await repo.cleanup();
      await rm(journalDir, { recursive: true, force: true });
    },
  };
}
