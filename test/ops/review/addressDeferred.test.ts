import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { makeAddressBookkeepingReceipt } from '../../../src/ops/review/internal/addressBookkeeping.js';
import type { GhFn, GhResult } from '../../../src/adapters/forge-github/gh.js';
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

async function fixture(ignoreState = true) {
  const repo = await makeTestRepo();
  // The injected resolver does not register pre-existing ledger writes.
  // Isolate receipt ownership while leaving queue evidence/unknown state unignored.
  await repo.write('.gitignore', ignoreState ? '/.cq/\n' : '/.cq/dev/\n');
  await repo.write('cq.json', JSON.stringify(config));
  repo.commitAll('configure offline review');
  const journalDir = await mkdtemp(join(tmpdir(), 'cq-address-debt-'));
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

test('cached clean record cannot erase findings from original outage or an unconfigured reviewer', async () => {
  const f = await fixture();
  try {
    await f.effects.openLedger(f.state.branch).mutate((ledger) => ({
      ledger: {
        ...ledger,
        records: [
          ...ledger.records.map((entry) =>
            entry.kind === 'cycle'
              ? {
                  ...entry,
                  findings: [
                    { id: 'original-known', severity: 'major', excerpt: 'retained outage finding' },
                  ],
                }
              : entry,
          ),
          cycleRecord({
            head: f.state.head,
            base: f.state.base,
            dirtySha256: 'clean-tree',
            cycleId: 'unconfigured',
            reviewer: 'retired-reviewer',
            findings: [
              { id: 'retired-known', severity: 'major', excerpt: 'still needs disposition' },
            ],
          }),
        ],
      },
      value: undefined,
    }));
    const context = await f.resolver({
      repoRoot: f.repo.root,
      target: 'main',
      base: f.state.base,
      record: f.record(),
    });
    expect(context?.findings.map((finding) => finding.id)).toEqual([
      'original-known',
      'retired-known',
    ]);
    const cached = f.record();
    cached.findings = [
      {
        id: 'original-known',
        source: 'coderabbit',
        severity: 'major',
        text: 'retained outage finding',
        status: 'fixed',
      },
    ];
    const result = await makeReviewAddress({
      config,
      initialRecord: cached,
      resolveDeferredVendorContext: f.resolver,
      disposition: async (root, finding) =>
        makeDevDisposition(f.effects)({
          repoRoot: root,
          findingId: finding.id,
          action: 'deferred',
          why: 'requires owner',
        }),
      workerFactory: () => ({
        escalation: createEscalationState,
        fix: async (finding) => {
          expect(finding.status).toBe('open');
          return {
            finding: { ...finding, status: 'deferred', reason: 'requires owner' },
            observedHead: f.record().head,
            reason: 'requires owner',
            validation: [],
          };
        },
      }),
      review: async () => ({ status: 'ok', value: f.record() }),
    })({ repoRoot: f.repo.root, source: 'local', journalDir: f.journalDir, rounds: 1 });
    expect(result.status).toBe('needs-human');
    expect(result.report?.openBlocking.map((finding) => finding.id)).toEqual([
      'original-known',
      'retired-known',
    ]);
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

function ownershipReceipt() {
  const paths: unknown[] = [];
  return JSON.stringify({
    version: 1,
    item_id: 'current-ownership',
    request_id: 'original',
    source: {
      repo: 'owner/repo',
      pr: 1,
      merge_sha: 'a'.repeat(40),
      target_selector: 'promoted-main',
      policy: 'affected-current-additions-v1',
    },
    capture: {
      target: 'b'.repeat(40),
      tree: 'c'.repeat(40),
      paths,
      scope_digest: createHash('sha256').update('[]').digest('hex'),
      equivalence: 'd'.repeat(64),
      policy: 'affected-current-additions-v1',
      projection: 'current-affected-files/full-file-addition-projection',
      reviewer: 'coderabbit-review-agent-committed-v1',
      reviewer_version: 'fixture',
      captured_at: '2026-10-28T00:00:00Z',
    },
    outcome: 'no-current-code',
    counted: false,
    classification: null,
    findings: [],
    run_id: null,
    started_at: null,
    artifacts: {},
    remediation: 'disabled/deferred',
    independent_acceptance: false,
    cli_functional_acceptance: 'pending-D1',
  });
}

test.each(['exact', 'wrong-digest'] as const)(
  'local queue evidence without durable ownership refuses acknowledgement: %s',
  async (mode) => {
    const f = await fixture(false);
    try {
      const bytes = ownershipReceipt();
      const id = createHash('sha256').update(bytes).digest('hex');
      const path = join(await realpath(f.repo.root), '.cq/queue-evidence', id + '.json');
      let imported = false;
      const result = await makeReviewAddress({
        config,
        initialRecord: f.record(),
        resolveDeferredVendorContext: async (request) => {
          if (!imported) {
            imported = true;
            await mkdir(join(f.repo.root, '.cq/queue-evidence'), { recursive: true });
            await writeFile(path, bytes);
            await request.onEvidenceImported?.({
              receiptId: mode === 'wrong-digest' ? 'e'.repeat(64) : id,
              path,
            });
          }
          return f.resolver(request);
        },
      })({ repoRoot: f.repo.root, source: 'local', journalDir: f.journalDir });
      // Local mode has no durable private ownership store. Even an exact
      // import must refuse before the caller can acknowledge its consumption.
      expect(result.status).toBe('needs-human');
      if (mode === 'exact')
        expect(result.status === 'needs-human' && result.reason).toContain(
          'durable queue evidence ownership unavailable',
        );
    } finally {
      await f.cleanup();
    }
  },
);

test.each(['ack-interrupted', 'persist-refused', 'changed-known'] as const)(
  'PR import ownership survives interruption before enclosing action settles: %s',
  async (mode) => {
    const f = await fixture(false);
    try {
      const head = f.record().head;
      f.repo.git('push', '-q', 'origin', 'HEAD:refs/pull/7/head');
      const namespace = createHash('sha256')
        .update(
          JSON.stringify(['owner', 'repo', 7, 'main', null, 'owner/repo', 'feature/x', 'author']),
        )
        .digest('hex');
      const ownershipPath = join(
        await realpath(f.repo.root),
        '.git/cq-review-address',
        namespace,
        'bookkeeping.json',
      );
      const ok = (value: unknown): GhResult => ({
        code: 0,
        stdout: typeof value === 'string' ? value : JSON.stringify(value),
        stderr: '',
      });
      const gh: GhFn = async (args) => {
        if (args[0] === 'repo') return ok({ nameWithOwner: 'owner/repo' });
        if (args[0] === 'pr')
          return ok({
            headRefName: 'feature/x',
            headRepositoryOwner: { login: 'owner' },
            headRepository: { name: 'repo' },
          });
        if (args.includes('user')) return ok('author');
        if (args.includes('graphql'))
          return ok({
            data: {
              repository: {
                pullRequest: {
                  author: { login: 'author' },
                  headRefName: 'feature/x',
                  headRefOid: head,
                  reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
                  reviews: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
                },
              },
            },
          });
        if (args.some((arg) => arg === 'repos/owner/repo/pulls/7'))
          return ok({ head: { sha: head } });
        if (args.some((arg) => arg.includes('/comments') || arg.includes('/reviews')))
          return ok([]);
        throw new Error('unexpected offline forge operation');
      };
      let resumedAfterObserver = false;
      let evidenceRoot: string | undefined;
      let evidencePath: string | undefined;
      const result = await makeReviewAddress({
        config,
        gh,
        workerFactory: (deps) => ({
          escalation: createEscalationState,
          fix: async () => {
            throw new Error('no findings should dispatch');
          },
          withVerifiedHead: async (action) => {
            await deps.prepareBookkeeping?.();
            return action(head);
          },
        }),
        review: async (request) => ({
          status: 'needs-human',
          reason: 'pending vendor debt',
          report: {
            ...f.record(),
            branch: f.repo.git('-C', request.repoRoot, 'branch', '--show-current').trim(),
            deferredVendorDebt: f.debt,
          },
        }),
        resolveDeferredVendorContext: async (request) => {
          evidenceRoot = await realpath(request.repoRoot);
          const bytes = ownershipReceipt();
          const id = createHash('sha256').update(bytes).digest('hex');
          evidencePath = join(evidenceRoot, '.cq/queue-evidence', id + '.json');
          await mkdir(join(evidenceRoot, '.cq/queue-evidence'), { recursive: true });
          await writeFile(evidencePath, bytes);
          if (mode === 'persist-refused') await writeFile(ownershipPath, 'external change');
          if (!request.onEvidenceImported) throw new Error('observer missing');
          await request.onEvidenceImported({ receiptId: id, path: evidencePath });
          // This is the exact point at which QueueClient may send ack. Use a
          // new reader, with no in-memory fingerprints from the running engine.
          const fresh = makeAddressBookkeepingReceipt({
            path: ownershipPath,
            identity: namespace,
            fingerprints: new Map(),
            git: async (root, args) => f.repo.git('-C', root, ...args).trim(),
          });
          expect(await fresh.ownedFiles()).toContain(evidencePath);
          await fresh.prepare(evidenceRoot);
          resumedAfterObserver = true;
          if (mode === 'changed-known') {
            await writeFile(evidencePath, bytes + '\n');
            await request.onEvidenceImported({ receiptId: id, path: evidencePath });
          }
          // Simulate an ack transport failure before context/outer FIFO return.
          throw new Error('ack interrupted');
        },
      })({ repoRoot: f.repo.root, source: 'pr:7', journalDir: f.journalDir });
      expect(result.status, JSON.stringify(result)).toBe('needs-human');
      expect(resumedAfterObserver).toBe(mode !== 'persist-refused');
      if (mode === 'ack-interrupted') {
        const bytes = JSON.parse(await readFile(ownershipPath, 'utf8')) as {
          files: Array<{ path: string; sha256: string }>;
        };
        expect(evidenceRoot).toBeDefined();
        expect(evidencePath).toBeDefined();
        expect(bytes.files).toContainEqual({
          path: relative(evidenceRoot!, evidencePath!),
          sha256: createHash('sha256').update(ownershipReceipt()).digest('hex'),
        });
      }
    } finally {
      await f.cleanup();
    }
  },
);

test('P1: an imported-cycle disposition cannot lend status to a later original finding (same content)', async () => {
  const f = await fixture();
  try {
    const finding = {
      id: 'c009-aaaaaaaa#f1',
      severity: 'major',
      fileName: 'src/a.ts',
      excerpt: 'const x = 1;',
      line: 1,
      rule: 'no-x',
      evidence: 'receipt-9',
    };
    await f.effects.openLedger(f.state.branch).mutate((ledger) => ({
      ledger: {
        ...ledger,
        records: [
          ...ledger.records,
          cycleRecord({
            head: f.state.head,
            base: f.state.base,
            dirtySha256: 'clean-tree',
            cycleId: 'c009-aaaaaaaa',
            reviewer: 'review.address:import',
            findings: [finding],
          }),
          {
            kind: 'disposition',
            findingId: finding.id,
            action: 'rejected',
            why: 'imported repeat',
            head: f.state.head,
            at: '2026-10-17T00:00:00.000Z',
          },
          cycleRecord({
            head: f.state.head,
            base: f.state.base,
            dirtySha256: 'clean-tree',
            cycleId: 'c010-aaaaaaaa',
            findings: [finding],
          }),
        ],
      },
      value: undefined,
    }));
    const context = await f.resolver({
      repoRoot: f.repo.root,
      target: 'main',
      base: f.state.base,
      record: f.record(),
    });
    const row = context?.findings.find((item) => item.id === finding.id);
    // The import cycle is repeat transport: no eligible witness precedes the
    // disposition, so the later original finding stays OPEN.
    expect(row).toMatchObject({ status: 'open' });
    expect(row?.reason).toBeUndefined();
  } finally {
    await f.cleanup();
  }
});

test('P1: the same imported-cycle sequence with CHANGED later content also stays open', async () => {
  const f = await fixture();
  try {
    const imported = {
      id: 'c009-aaaaaaaa#f1',
      severity: 'major',
      fileName: 'src/a.ts',
      excerpt: 'imported repeat text',
      line: 1,
      rule: 'no-x',
    };
    const original = { ...imported, excerpt: 'genuine original text' };
    await f.effects.openLedger(f.state.branch).mutate((ledger) => ({
      ledger: {
        ...ledger,
        records: [
          ...ledger.records,
          cycleRecord({
            head: f.state.head,
            base: f.state.base,
            dirtySha256: 'clean-tree',
            cycleId: 'c009-aaaaaaaa',
            reviewer: 'review.address:import',
            findings: [imported],
          }),
          {
            kind: 'disposition',
            findingId: imported.id,
            action: 'fixed',
            why: 'imported repeat',
            head: f.state.head,
            at: '2026-10-17T00:00:00.000Z',
          },
          cycleRecord({
            head: f.state.head,
            base: f.state.base,
            dirtySha256: 'clean-tree',
            cycleId: 'c010-aaaaaaaa',
            findings: [original],
          }),
        ],
      },
      value: undefined,
    }));
    const context = await f.resolver({
      repoRoot: f.repo.root,
      target: 'main',
      base: f.state.base,
      record: f.record(),
    });
    const row = context?.findings.find((item) => item.id === imported.id);
    expect(row).toMatchObject({ status: 'open', text: 'genuine original text' });
    expect(row?.reason).toBeUndefined();
  } finally {
    await f.cleanup();
  }
});

test('P2: a content-mismatched cached row is reset to OPEN and loses its cached reason', async () => {
  const f = await fixture();
  try {
    // The ledger witness is LEGACY: it carries no line/rule/evidence, so a cached
    // row that carries them can never match it.
    await f.effects.openLedger(f.state.branch).mutate((ledger) => ({
      ledger: {
        ...ledger,
        records: ledger.records.map((entry) =>
          entry.kind === 'cycle'
            ? {
                ...entry,
                findings: [
                  { id: 'original-known', severity: 'major', excerpt: 'retained outage finding' },
                ],
              }
            : entry,
        ),
      },
      value: undefined,
    }));
    const cached = f.record();
    cached.findings = [
      {
        id: 'original-known',
        source: 'coderabbit',
        severity: 'major',
        text: 'retained outage finding',
        file: 'src/a.ts',
        line: 7,
        rule: 'no-a',
        status: 'rejected',
        reason: 'cached adjudication',
      },
    ];
    const seen: { status: string; reason?: string }[] = [];
    const result = await makeReviewAddress({
      config,
      initialRecord: cached,
      resolveDeferredVendorContext: f.resolver,
      disposition: async (root, finding) =>
        makeDevDisposition(f.effects)({
          repoRoot: root,
          findingId: finding.id,
          action: 'deferred',
          why: 'requires owner',
        }),
      workerFactory: () => ({
        escalation: createEscalationState,
        fix: async (finding) => {
          seen.push({
            status: finding.status,
            ...(finding.reason === undefined ? {} : { reason: finding.reason }),
          });
          return {
            finding: { ...finding, status: 'deferred', reason: 'requires owner' },
            observedHead: f.record().head,
            reason: 'requires owner',
            validation: [],
          };
        },
      }),
      review: async () => ({ status: 'ok', value: f.record() }),
    })({ repoRoot: f.repo.root, source: 'local', journalDir: f.journalDir, rounds: 1 });
    // The cached 'rejected' status and its reason cannot survive a content mismatch:
    // the row reaches the fixer as open, so openBlocking still reports it.
    expect(seen).toEqual([{ status: 'open' }]);
    expect(result.status).toBe('needs-human');
  } finally {
    await f.cleanup();
  }
});

test.each([false, true])(
  'real admission preserves empty-file identity and OPEN nondispatchable debt (absent companion=%s)',
  async (withAbsent) => {
    const f = await fixture();
    try {
      const { assembleReadiness } = await import('../../../src/ops/dev/record.js');
      const record = f.record();
      const coverage = record.sources[1]?.coverage;
      if (!coverage || !('version' in coverage) || coverage.version !== 2)
        throw new Error('fixture requires genuine v2 agent coverage');
      // Match the genuine full agent source supplied by fixture(), without inventing
      // any finding witness or letting the import cycle lend disposition authority.
      await f.effects.openLedger(f.state.branch).mutate((ledger) => ({
        ledger: {
          ...ledger,
          records: [
            ...ledger.records,
            cycleRecord({
              cycleId: 'agent-current-empty-file',
              reviewer: 'agent:reviewer',
              head: f.state.head,
              base: f.state.base,
              dirtySha256: 'clean-tree',
              agentCoverage: coverage,
            }),
          ],
        },
        value: undefined,
      }));
      record.findings = [
        {
          id: 'empty-file',
          source: 'coderabbit',
          severity: 'major',
          text: 'empty identity',
          file: '',
          status: 'open',
        },
      ];
      if (withAbsent)
        record.findings.push({
          id: 'absent-file',
          source: 'coderabbit',
          severity: 'major',
          text: 'absent identity',
          status: 'open',
        });
      const fixed: string[] = [];
      let reviews = 0;
      const result = await makeReviewAddress({
        config,
        initialRecord: record,
        resolveDeferredVendorContext: f.resolver,
        // NO deps.disposition: that seam bypasses admitRecord entirely (1088 at 9d).
        // The stopped predecessor's missing import cycle was caused by that bypass,
        // not evidence that dispatch was unentered or batching changed the finding.
        workerFactory: () => ({
          escalation: createEscalationState,
          fix: async (finding) => {
            fixed.push(finding.id);
            return {
              finding: { ...finding, status: 'deferred', reason: 'requires owner' },
              observedHead: f.state.head,
              reason: 'requires owner',
              validation: [],
            };
          },
        }),
        review: async () => {
          reviews++;
          return { status: 'ok', value: f.record() };
        },
      })({ repoRoot: f.repo.root, source: 'local', journalDir: f.journalDir, rounds: 1 });
      const reason = 'unresolved: finding has no file path';
      expect(result, JSON.stringify(result)).toMatchObject({ status: 'needs-human' });
      if (result.status !== 'needs-human' || !result.report)
        throw new Error('missing refusal report');
      const report = result.report;
      expect(result.reason).toBe(`${reason}; report: ${report.reportPath}`);
      expect(report.reasons).toContain(reason);
      expect(report.admissionHead).toBe(f.state.head);
      expect(report.findings.find((row) => row.id === 'empty-file')).toMatchObject({
        file: '',
        status: 'open',
        reason,
      });
      expect(report.openBlocking.find((row) => row.id === 'empty-file')).toMatchObject({
        file: '',
        status: 'open',
        reason,
      });
      expect(fixed).toEqual(withAbsent ? ['absent-file'] : []);
      expect(reviews).toBe(0);
      expect(report.fixes.some((fix) => fix.finding.id === 'empty-file')).toBe(false);
      expect(report.fixesPerRun).toBe(0);
      expect(report.rounds).toHaveLength(1);
      if (!withAbsent) expect(report.rounds[0]?.runs).toEqual([]);
      const ledger = f.effects.openLedger(f.state.branch).load();
      const imported = ledger.records.findLast(
        (entry) => entry.kind === 'cycle' && entry.reviewer === 'review.address:import',
      );
      expect(imported?.kind).toBe('cycle');
      if (imported?.kind !== 'cycle') throw new Error('real import cycle missing');
      expect(imported.findings.find((row) => row.id === 'empty-file')).toHaveProperty(
        'fileName',
        '',
      );
      if (withAbsent)
        expect(imported.findings.find((row) => row.id === 'absent-file')).not.toHaveProperty(
          'fileName',
        );
      expect(
        ledger.records.some(
          (entry) => entry.kind === 'disposition' && entry.findingId === 'empty-file',
        ),
      ).toBe(false);
      const readiness = assembleReadiness({
        branch: f.state.branch,
        target: 'main',
        identity: { base: f.state.base, head: f.state.head, dirtySha256: 'clean-tree' },
        ledger,
        untracked: [],
        nowIso: f.effects.nowIso(),
      });
      expect(readiness.ready).toBe(false);
      if (readiness.ready) throw new Error('pathless OPEN finding cannot be ready');
      const gap = readiness.gaps.find((entry) => entry.field === 'open-blocking-findings');
      expect(gap?.detail).toContain('empty-file');
      expect(gap?.detail).toContain(reason);
    } finally {
      await f.cleanup();
    }
  },
);
