import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';
import * as servedModel from '../../src/driver/served-model.js';
import { createDriverFactory } from '../../src/driver/factory.js';
import type { OpInvocation, WorkerResult } from '../../src/driver/types.js';
import { makeAgenticRemediation } from '../../src/ops/analyze/agenticRemediation.js';
import { bindingsFromDispatch } from '../../src/ops/sweep/unit.js';

const FAKE_CLI = fileURLToPath(new URL('../fixtures/fake-agent-cli.mjs', import.meta.url));
const temporary: string[] = [];
const proposal = { summary: 'A valid remediation proposal' };

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'served-construction-'));
  temporary.push(root);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('served-model real construction paths', () => {
  test.each(['CONTROL', 'TREATMENT'] as const)(
    'S1 agenticRemediation through a factory-resolved driver %s: dispatch preserves success only for the requested model',
    async (variant) => {
      const root = await fixture();
      // The FACTORY is the served-model hook (ADR-0002 §2.6), so the real
      // construction path under test is factory → subprocess lane over the
      // fake CLI. The lane binding is explicit factory config (the
      // conservative defaults never resolve to a host-CLI lane).
      const binary = [
        'env',
        'FAKE_AGENT_MODE=structured-ok',
        `FAKE_AGENT_STRUCTURED_RAW=${JSON.stringify(proposal)}`,
        ...(variant === 'TREATMENT' ? ['FAKE_AGENT_SERVED_MODEL=remapped'] : []),
        process.execPath,
        FAKE_CLI,
      ];
      vi.stubEnv('CQ_CONSTRUCTION_KEY', 'offline-fixture-key');

      // The op intentionally summarizes driver failures without their error
      // text. Observe the REAL wrapper verdict without replacing construction,
      // the subprocess, or its run result. A removed wrap leaves the control
      // green, but the treatment's op status becomes ok and fails below.
      const verdicts: WorkerResult[] = [];
      const wrap = servedModel.withServedModelAssertion;
      vi.spyOn(servedModel, 'withServedModelAssertion').mockImplementation((...args) => {
        const driver = wrap(...args);
        const run = driver.run.bind(driver);
        vi.spyOn(driver, 'run').mockImplementation(async (invocation) => {
          const verdict = await run(invocation);
          verdicts.push(verdict);
          return verdict;
        });
        return driver;
      });
      const op = makeAgenticRemediation(
        createDriverFactory({
          bindings: { remediator: { construction: 'subprocess' } },
          lanes: {
            subprocess: {
              binary,
              sessionsDir: join(root, 'sessions'),
              routingTable: {
                endpoints: {
                  construction: {
                    baseUrlEnv: 'CQ_CONSTRUCTION_URL',
                    baseUrlDefault: 'https://unused.invalid',
                    keyEnv: 'CQ_CONSTRUCTION_KEY',
                    models: ['construction-model'],
                    notes: 'Offline fake CLI; no network calls',
                  },
                },
              },
            },
          },
        }),
      );
      const outcome = await op({
        clusterId: '0deadbe0',
        cluster: {
          id: '0deadbe0',
          signature: '["oxlint","r","boom"]',
          tool: 'oxlint',
          ruleId: 'r',
          confidence: 'low',
          failures: [
            {
              file: 'src/a.ts',
              line: 1,
              column: 1,
              ruleId: 'r',
              message: 'boom',
              severity: 'error',
            },
          ],
          size: 1,
        },
        modelSpec: { provider: 'construction', model: 'construction-model' },
      });
      if (variant === 'CONTROL') {
        expect(outcome).toMatchObject({
          status: 'ok',
          value: {
            stopReason: 'complete',
            structuredOutput: proposal,
            model: 'construction-model',
          },
        });
      } else {
        expect(outcome.status).toBe('failed');
        expect(verdicts).toHaveLength(1);
        expect(verdicts[0]?.errorClass).toBe('served-model-mismatch');
        expect(verdicts[0]?.error).toContain("requested 'construction-model', served 'remapped'");
      }
    },
  );

  test.each(['CONTROL', 'TREATMENT'] as const)(
    'S2 sweep bindingsFromDispatch %s: returned driver rejects a remapped CLI model',
    async (variant) => {
      const root = await fixture();
      vi.stubEnv('CQ_CONSTRUCTION_KEY', 'offline-fixture-key');
      vi.stubEnv('FAKE_AGENT_MODE', 'ok');
      vi.stubEnv('FAKE_AGENT_SERVED_MODEL', undefined);
      // S4b-B2 (ADR-0002 §2.3/§2.5): the dispatch input's driver section is
      // the factory's RESOLUTION INPUT ({provider, model} — plan data names
      // no executable); the lane knobs (binary/routing table/sessions dir)
      // moved into DriverFactoryConfig.lanes.subprocess, and the CONFIGURED
      // factory is bindingsFromDispatch's second argument. The factory owns
      // the served-model assertion.
      const drivers = createDriverFactory({
        bindings: { fixer: { construction: 'subprocess' } },
        lanes: {
          subprocess: {
            binary: [
              'env',
              ...(variant === 'TREATMENT' ? ['FAKE_AGENT_SERVED_MODEL=remapped'] : []),
              process.execPath,
              FAKE_CLI,
            ],
            sessionsDir: join(root, 'sessions'),
            routingTable: {
              endpoints: {
                construction: {
                  baseUrlEnv: 'CQ_CONSTRUCTION_URL',
                  baseUrlDefault: 'https://unused.invalid',
                  keyEnv: 'CQ_CONSTRUCTION_KEY',
                  models: ['construction-model'],
                  notes: 'Offline fake CLI; no network calls',
                },
              },
            },
          },
        },
      });
      const bindings = bindingsFromDispatch(
        {
          repoRoot: join(root, 'repo'), // synthetic: not yet materialised
          worktreesDir: join(root, 'worktrees'),
          runPrefix: 'cq/construction',
          base: 'main',
          package: 'fixture',
          fixer: 'fix',
          files: ['file.ts'],
          driver: {
            model: 'construction-model',
            provider: 'construction',
            budget: { maxUsd: 1 },
          },
          check: { adapter: 'tsc-lines', command: 'unused', args: [] },
        },
        drivers,
      );
      const invocation: OpInvocation = {
        prompt: 'construction proof',
        // The RESOLVED spec rides the invocation (never the input's raw spec).
        modelSpec: bindings.modelSpec,
        toolPolicy: { mode: 'none', allow: [] },
        sandboxPolicy: { level: 'read-only' },
        budget: {},
      };
      const outcome = await bindings.driver.run(invocation);
      if (variant === 'CONTROL') {
        expect(outcome).toMatchObject({ stopReason: 'complete', model: 'construction-model' });
      } else {
        expect(outcome.stopReason).toBe('error');
        expect(outcome.errorClass).toBe('served-model-mismatch');
        expect(outcome.error).toContain("requested 'construction-model', served 'remapped'");
      }
    },
  );
});
