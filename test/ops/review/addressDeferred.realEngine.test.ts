import { join } from 'node:path';
import { expectOpaqueIncomplete } from './slotOwnership.helpers.js';
// Split provenance: test/ops/review/addressDeferred.test.ts was split into
// addressDeferred.{admission,fixLoop,cachedFindings,realEngine,queueOwnership,
// importProvenance,emptyFileAdmission}.test.ts. This file drives the real
// review engine fix loop and its scan-before-upload guard.
import { expect, test } from 'vitest';
import { makeReviewAddress } from '../../../src/ops/review/address.js';
import { makeReviewRun } from '../../../src/ops/review/run.js';
import type { DriverFactory } from '../../../src/driver/factory.js';
import { makeDevDisposition } from '../../../src/ops/dev/disposition.js';
import { createEscalationState } from '../../../src/ops/fix/escalation.js';
import { config, fixture } from './addressDeferred.helpers.js';

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
            owner: 'test',
            evidence: [],
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
      await expectOpaqueIncomplete(result, join(f.repo.root, '.git'));
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
