import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { makeReviewAddress } from '../../../src/ops/review/address.js';
import { makeReviewRun } from '../../../src/ops/review/run.js';
import type { DriverFactory } from '../../../src/driver/factory.js';
import { makeDevDisposition } from '../../../src/ops/dev/disposition.js';
import { resolveDeferredVendorContext } from '../../../src/ops/review/internal/addressDeferred.js';
import { prepareDeferredVendorReview } from '../../../src/ops/dev/internal/deferredLedger.js';
import { readWorkState } from '../../../src/ops/dev/internal/workState.js';
import { createEscalationState } from '../../../src/ops/fix/escalation.js';
import type { CqConfig } from '../../../src/ops/analyze/cqConfig.js';
import type { FindingsRecord } from '../../../src/ops/review/findings.js';
import type {
  DeferredQueueClient,
  QueueStatus,
} from '../../../src/ops/review/internal/queueProtocol.js';
import { makeTestRepo, repoEffects } from '../dev/repo.js';
import { cycleRecord } from '../dev/fakes.js';

const config: CqConfig = {
  schemaVersion: 2,
  checks: [{ adapter: 'tsc-lines', command: { command: process.execPath, args: [] } }],
  roles: {
    worker: { provider: 'mock', model: 'mock' },
    reviewer: { provider: 'mock', model: 'mock' },
  },
  budgets: { run: { maxTokens: 1000 } },
  review: { reviewers: ['agent', 'coderabbit'] },
};

async function fixture() {
  const repo = await makeTestRepo();
  await repo.write('.gitignore', '/.cq/\n');
  await repo.write('cq.json', JSON.stringify(config));
  repo.commitAll('configure offline review');
  const journalDir = await mkdtemp(join(tmpdir(), 'cq-address-debt-'));
  const effects = repoEffects(repo, (command, args) =>
    command === 'gh' ? (args[0] === 'api' ? 'author' : 'owner/repo') : undefined,
  );
  const read = await readWorkState(effects, { target: 'merge-queue' });
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
  const debt = await prepareDeferredVendorReview(effects, 'merge-queue', state, client);
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
        const read = await readWorkState(f.effects, { target: 'merge-queue', base: f.state.base });
        if (!read.ok) throw new Error(read.reason);
        const successor = await prepareDeferredVendorReview(
          f.effects,
          'merge-queue',
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
    expect(result.status, JSON.stringify(result)).toBe('ok');
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

test.each([false, true])(
  'real review engine fix loop keeps scan-before-upload guards: secret=%s',
  async (secret) => {
    const f = await fixture();
    let uploads = 0;
    let scanAfterFix = false;
    try {
      const drivers = {
        resolve: (request: {
          beforeRequest?: (
            text: string,
            contents: { text: string }[],
            context: { kind: 'model-request' },
          ) => Promise<void>;
        }) => ({
          lane: 'ai-sdk',
          modelSpec: { provider: 'mock', model: 'mock' },
          driver: {
            run: async (input: { prompt: string }) => {
              await request.beforeRequest?.(
                JSON.stringify({ prompt: [{ role: 'user', content: input.prompt }] }),
                [{ text: input.prompt }],
                { kind: 'model-request' },
              );
              uploads++;
              return {
                stopReason: 'complete',
                structuredOutput: {
                  findings:
                    uploads === 1
                      ? [{ severity: 'high', text: 'real engine finding', file: 'src/a.ts' }]
                      : [],
                },
                usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0 },
                denials: [],
                toolFailures: 0,
              };
            },
          },
        }),
      } as unknown as DriverFactory;
      const review = makeReviewRun({
        drivers,
        effectsFactory: () => f.effects,
        queueClient: f.client,
        scannerFactory: () => async (components) =>
          components.map((component) => ({
            component: component.component,
            hits: secret && scanAfterFix ? [{ ruleId: 'fixture-secret', lines: [1] }] : [],
          })),
      });
      const initial = await review({ repoRoot: f.repo.root });
      expect(initial.status).toBe('ok');
      if (initial.status !== 'ok') throw new Error(JSON.stringify(initial));
      const result = await makeReviewAddress({
        config,
        initialRecord: initial.value,
        review,
        resolveDeferredVendorContext: f.resolver,
        disposition: async (root, finding) =>
          makeDevDisposition(f.effects)({
            repoRoot: root,
            findingId: finding.id,
            action: finding.status as 'fixed',
            why: 'verified fixture fix',
          }),
        workerFactory: () => ({
          escalation: createEscalationState,
          fix: async (finding) => {
            const observedHead = f.record().head;
            await f.repo.write('src/a.ts', 'export const fixed = true;\n');
            const commit = f.repo.commitAll('fix real engine finding');
            scanAfterFix = true;
            return {
              finding: { ...finding, status: 'fixed' },
              commit,
              observedHead,
              reason: 'verified',
              validation: [],
            };
          },
        }),
      })({ repoRoot: f.repo.root, source: 'local', journalDir: f.journalDir });
      expect(result.status, JSON.stringify(result)).toBe(secret ? 'needs-human' : 'ok');
      expect(uploads).toBe(secret ? 1 : 2);
      expect(f.effects.calls.filter((call) => call.command === 'coderabbit')).toHaveLength(0);
      const ledger = f.effects.openLedger(f.state.branch).load();
      const debts = ledger.records.filter((entry) => entry.kind === 'vendor-debt');
      expect(debts).toHaveLength(2);
      expect(debts[0]!.debt).toEqual(f.debt);
      expect(debts[1]!.debt.reference.binding).toMatchObject({ head: f.record().head });
      expect(debts[1]!.debt.vendorCompleted).toBe(false);
      if (!secret)
        expect(ledger.records.filter((entry) => entry.kind === 'cycle').at(-1)).toMatchObject({
          head: f.record().head,
          agentCoverage: { version: 2, head: f.record().head, scope: 'full' },
          completion: { kind: 'terminal' },
        });
    } finally {
      await f.cleanup();
    }
  },
);
