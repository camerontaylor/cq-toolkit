import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { DriverFactory } from '../../../src/driver/factory.js';
import type { DevLedgerFile } from '../../../src/ops/dev/record.js';
import { deferVendorReview } from '../../../src/ops/dev/internal/deferredReview.js';
import { readWorkState } from '../../../src/ops/dev/internal/workState.js';
import { makeReviewRun } from '../../../src/ops/review/run.js';
import { importQueueEvidence } from '../../../src/ops/review/internal/queueEvidence.js';
import type {
  DeferredQueueClient,
  QueueStatus,
} from '../../../src/ops/review/internal/queueProtocol.js';
import { cycleRecord } from '../dev/fakes.js';
import { makeTestRepo, repoEffects } from '../dev/repo.js';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');

it.each([
  'major',
  'clean',
  'pending',
  'queue-error',
  'write-then-throw',
  'observer-error',
] as const)(
  'final refresh bookkeeping observes actual durable change before %s exit',
  async (mode) => {
    const repo = await makeTestRepo();
    try {
      await repo.write('.gitignore', '/.cq/\n');
      await repo.write('package.json', JSON.stringify({ name: 'final-refresh-fixture' }));
      await repo.write(
        'cq.json',
        JSON.stringify({
          schemaVersion: 2,
          checks: [{ adapter: 'tsc-lines', command: { command: 'tsc', args: [] } }],
          roles: { reviewer: { provider: 'mock', model: 'mock' } },
          budgets: { run: { maxTokens: 500 } },
          review: { reviewers: ['agent', 'coderabbit'] },
        }),
      );
      repo.commitAll('configure offline deferred review');
      let finalPhase = false;
      const events: string[] = [];
      const effects = repoEffects(repo, (command, args) => {
        if (command === 'coderabbit') throw new Error('paid vendor dispatch is forbidden');
        if (command === 'gh') return args[0] === 'api' ? 'author' : 'owner/repo';
        return undefined;
      });
      const read = await readWorkState(effects, { target: 'merge-queue' });
      if (!read.ok) throw new Error(read.reason);
      const state = read.state;
      const pending: QueueStatus = {
        state: 'awaiting-pr',
        pr: null,
        mergeSha: null,
        itemId: null,
        receiptId: null,
        consumed: false,
        reviewed: false,
        fixed: false,
      };
      const queue: DeferredQueueClient = {
        enqueue: async () => pending,
        bind: async () => pending,
        cancel: async () => {
          throw new Error('no cancellation');
        },
        status: async () => pending,
      };
      const failure = {
        source: 'vendor' as const,
        category: 'vendor-unavailable' as const,
        codes: ['con_err'],
      };
      const origin = cycleRecord({
        head: state.head,
        base: state.base,
        dirtySha256: 'clean-tree',
        cycleId: 'c001-origin',
        vendorFailure: failure,
        completion: { kind: 'blocked', reason: 'structured local outage' },
      });
      const debt = await deferVendorReview(
        queue,
        {
          requestId: 'final-refresh-intent',
          binding: {
            kind: 'deferred-author',
            repo: 'owner/repo',
            producer: 'author',
            head: state.head,
            target: 'merge-queue',
            targetSelector: 'promoted-main',
          },
        },
        'unavailable',
        { id: 'final-refresh-intent', base: state.base, dirtySha256: 'clean-tree' },
        {
          cycleId: origin.cycleId,
          head: state.head,
          base: state.base,
          target: 'merge-queue',
          scope: 'full',
          dirtySha256: 'clean-tree',
          failure,
        },
      );
      effects.openLedger(state.branch).save({
        version: 2,
        branch: state.branch,
        records: [origin, { kind: 'vendor-debt', debt, at: effects.nowIso() }],
      });
      const paths = [
        {
          source_path: 'src/a.ts',
          path: 'src/a.ts',
          resolution: 'same-path-current',
          disposition: 'included',
          blob: repo.git('rev-parse', 'HEAD:src/a.ts').trim(),
          mode: '100644',
          bytes: 20,
        },
      ];
      const identity = {
        target: state.head,
        tree: repo.git('rev-parse', 'HEAD^{tree}').trim(),
        paths,
        scope_digest: digest(paths),
        policy: 'affected-current-additions-v1',
        projection: 'current-affected-files/full-file-addition-projection',
        reviewer: 'coderabbit-review-agent-committed-v1',
        reviewer_version: 'fixture-v1',
      };
      const hasFinding = mode !== 'clean';
      const findings = hasFinding
        ? [
            {
              type: 'finding',
              severity: 'major',
              fileName: 'src/a.ts',
              comment: 'genuine retained major',
              codegenInstructions: 'preserve original evidence',
            },
          ]
        : [];
      const document = {
        version: 1,
        source: {
          repo: 'owner/repo',
          pr: 42,
          merge_sha: state.head,
          target_selector: 'promoted-main',
          policy: 'affected-current-additions-v1',
        },
        capture: {
          ...identity,
          equivalence: digest(identity),
          captured_at: '2026-10-28T00:00:00Z',
        },
        item_id: 'current-fixture',
        request_id: debt.reference.requestId,
        outcome: hasFinding ? 'terminal-with-findings' : 'terminal-clean',
        counted: true,
        classification: { counted: true, outcome: 'completed', findings: findings.length },
        findings,
        run_id: 'genuine-run',
        started_at: '2026-10-28T00:00:00Z',
        artifacts: {},
        remediation: 'disabled/deferred',
        independent_acceptance: false,
        cli_functional_acceptance: 'pending-D1',
      };
      const bytes = Buffer.from(JSON.stringify(document));
      const receiptId = createHash('sha256').update(bytes).digest('hex');
      let consumed = false;
      const client: DeferredQueueClient = {
        ...queue,
        status: async () => {
          if (!finalPhase || mode === 'pending') return pending;
          if (mode === 'queue-error') throw new Error('queue authorization unavailable');
          return {
            ...pending,
            state: hasFinding ? 'terminal-with-findings' : 'terminal-clean',
            pr: 42,
            mergeSha: state.head,
            itemId: 'current-fixture',
            receiptId,
            reviewed: true,
            consumed,
          };
        },
        report: async (_reference, root, options) => {
          const evidence = await importQueueEvidence(root, receiptId, bytes);
          await options?.onEvidenceImported?.({ receiptId, path: join(root, `${receiptId}.json`) });
          consumed = true;
          return evidence;
        },
      };
      const openLedger = effects.openLedger;
      effects.openLedger = (branch) => {
        const store = openLedger(branch);
        return {
          ...store,
          async mutate<T>(fn: (ledger: DevLedgerFile) => { ledger: DevLedgerFile; value: T }) {
            const value = await store.mutate(fn);
            if (finalPhase) {
              events.push('durable-write');
              if (mode === 'write-then-throw')
                throw new Error('lost response after durable settlement');
            }
            return value;
          },
        };
      };
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
              return {
                stopReason: 'complete',
                structuredOutput: { findings: [] },
                usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0 },
                denials: [],
                toolFailures: 0,
              };
            },
          },
        }),
      } as unknown as DriverFactory;
      const result = await makeReviewRun({
        drivers,
        queueClient: client,
        effectsFactory: () => effects,
        scannerFactory: () => async (components) =>
          components.map((component) => ({ component: component.component, hits: [] })),
        writeFindingsRecord: async (path, content) => {
          await writeFile(path, content, { flag: 'wx', mode: 0o600 });
          finalPhase = true;
        },
        noteLedgerWrite: async (branch, root) => {
          expect(branch).toBe(state.branch);
          expect(root).toBe(repo.root);
          if (!finalPhase) return;
          const latest = effects.openLedger(branch).load().records.at(-1);
          expect(latest).toMatchObject({ kind: 'vendor-debt', debt: { vendorCompleted: true } });
          events.push('bookkeeping');
          if (mode === 'observer-error') throw new Error('ledger bookkeeping refused');
        },
      })({ repoRoot: repo.root });
      events.push('returned');
      expect(finalPhase).toBe(true);
      expect(effects.calls.filter((call) => call.command === 'coderabbit')).toHaveLength(0);
      const settled = effects
        .openLedger(state.branch)
        .load()
        .records.filter((entry) => entry.kind === 'vendor-debt' && entry.debt.vendorCompleted);
      if (mode === 'pending' || mode === 'queue-error') {
        expect(settled).toHaveLength(0);
        expect(events).toEqual(['returned']);
        expect(result.status).toBe(mode === 'pending' ? 'ok' : 'needs-human');
      } else {
        expect(settled).toHaveLength(1);
        expect(events).toEqual(['durable-write', 'bookkeeping', 'returned']);
        expect(result.status).toBe(mode === 'clean' ? 'ok' : 'needs-human');
        if (mode === 'major') {
          expect(result.report?.findings).toContainEqual(
            expect.objectContaining({
              source: 'coderabbit',
              severity: 'major',
              status: 'open',
              text: 'genuine retained major',
            }),
          );
        }
        if (mode === 'write-then-throw' || mode === 'observer-error') {
          expect(result).toMatchObject({
            reason: expect.stringContaining(
              mode === 'write-then-throw'
                ? 'lost response after durable settlement'
                : 'ledger bookkeeping refused',
            ),
          });
        }
      }
    } finally {
      await repo.cleanup();
    }
  },
);
