import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { makeReviewRun } from '../../../src/ops/review/run.js';
import { readWorkState } from '../../../src/ops/dev/internal/workState.js';
import { deferVendorReview } from '../../../src/ops/dev/internal/deferredReview.js';
import type {
  DeferredQueueClient,
  QueueStatus,
} from '../../../src/ops/review/internal/queueProtocol.js';
import { cycleRecord } from '../dev/fakes.js';
import { repoEffects, makeTestRepo } from '../dev/repo.js';
import { configureAgentRepo, scriptedDrivers } from './run.helpers.js';

it.each(['current', 'changed', 'queue-auth', 'empty-file', 'absent-file'] as const)(
  'durable vendor debt %s invokes fresh full agent coverage without a paid vendor call',
  async (scenario) => {
    const repo = await makeTestRepo();
    try {
      await configureAgentRepo(repo);
      const config = await readFile(join(repo.root, 'cq.json'), 'utf8');
      await repo.write('cq.json', config.replace('["agent"]', '["agent","coderabbit"]'));
      repo.commitAll('configure deferred review');
      const effects = repoEffects(repo, (command, args) => {
        if (command === 'coderabbit') throw new Error('must not dispatch paid vendor');
        if (command === 'gh') return args[0] === 'api' ? 'author' : 'owner/repo';
        return undefined;
      });
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
      const queue: DeferredQueueClient = {
        enqueue: async () => status,
        bind: async () => status,
        cancel: async () => {
          throw new Error('do not cancel');
        },
        status: async () => {
          if (scenario === 'queue-auth') throw new Error('queue authorization unavailable');
          return status;
        },
      };
      const failure = {
        source: 'vendor' as const,
        category: 'vendor-unavailable' as const,
        codes: ['con_err'],
      };
      const evidenceV1 = {
        version: 1 as const,
        failureScenario: 'the retained finding keeps its anchored evidence',
        primary: { file: 'src/a.ts', side: 'head' as const, start: 12, end: 12, quote: 'a' },
        supporting: [],
      };
      const origin = cycleRecord({
        head: state.head,
        base: state.base,
        dirtySha256: 'clean-tree',
        cycleId: 'c001-origin',
        vendorFailure: failure,
        completion: { kind: 'blocked', reason: 'structured local vendor outage' },
        findings: [
          {
            id: 'retained',
            severity: 'major',
            excerpt: 'prior vendor finding',
            line: 12,
            rule: 'vendor-rule',
            evidence: 'vendor-receipt-1',
            evidenceV1,
            ...(scenario === 'empty-file' ? { fileName: '' } : {}),
          },
        ],
      });
      const debt = await deferVendorReview(
        queue,
        {
          requestId: 'origin-intent',
          binding: {
            kind: 'deferred-author',
            repo: 'owner/repo',
            producer: 'author',
            head: state.head,
            target: 'main',
            targetSelector: 'promoted-main',
          },
        },
        'unavailable',
        { id: 'origin-intent', base: state.base, dirtySha256: 'clean-tree' },
        {
          cycleId: origin.cycleId,
          head: state.head,
          base: state.base,
          target: 'main',
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
      if (scenario === 'changed') {
        await repo.write('src/a.ts', 'export const a = 2;\n');
        repo.git('add', 'src/a.ts');
        repo.git('commit', '-qm', 'new current head');
      }
      const drivers = scriptedDrivers();
      const result = await makeReviewRun({
        drivers,
        queueClient: queue,
        effectsFactory: () => effects,
        scannerFactory: () => async (components) =>
          components.map((component) => ({ component: component.component, hits: [] })),
      })({ repoRoot: repo.root });
      expect(effects.calls.filter((call) => call.command === 'coderabbit')).toHaveLength(0);
      if (scenario === 'queue-auth') {
        expect(result.status).toBe('indeterminate');
        expect(drivers.resolve).not.toHaveBeenCalled();
      } else {
        expect(result.status).toBe('ok');
        expect(result.report?.deferredVendorDebt?.vendorCompleted).toBe(false);
        expect(result.usageSummary).toMatchObject({ knownCount: 1, unknownCount: 0 });
        expect(result.report).not.toHaveProperty('usageSummary');
        if (result.status === 'ok') {
          expect(result.value.findings).toContainEqual(
            expect.objectContaining({ id: 'retained', status: 'open' }),
          );
          const retained = result.value.findings.find((finding) => finding.id === 'retained');
          if (scenario === 'empty-file') expect(retained).toHaveProperty('file', '');
          else expect(retained).not.toHaveProperty('file');
          // The deferred projection keeps every content field the disposition
          // check compares, so an unchanged finding keeps its disposition.
          expect(retained).toMatchObject({
            line: 12,
            rule: 'vendor-rule',
            evidence: 'vendor-receipt-1',
          });
          expect(retained?.evidenceV1).toEqual(evidenceV1);
          expect(result.value.sources.find((source) => source.kind === 'coderabbit')?.status).toBe(
            'blocked',
          );
        }
        const ledger = effects.openLedger(state.branch).load();
        expect(ledger.records.findLast((entry) => entry.kind === 'cycle')).toMatchObject({
          reviewer: 'agent:reviewer',
          completion: { kind: 'terminal' },
          agentCoverage: { version: 2, head: repo.git('rev-parse', 'HEAD').trim(), scope: 'full' },
        });
      }
    } finally {
      await repo.cleanup();
    }
  },
);
