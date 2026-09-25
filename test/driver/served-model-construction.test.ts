import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';
import * as servedModel from '../../src/driver/served-model.js';
import type { OpInvocation, WorkerResult } from '../../src/driver/types.js';
import { registry } from '../../src/ops/analyze/registry.js';
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

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

describe('served-model real construction paths', () => {
  test.each(['CONTROL', 'TREATMENT'] as const)(
    'S1 analyze registry importer %s: dispatch preserves success only for the requested model',
    async (variant) => {
      const root = await fixture();
      const bin = join(root, 'bin');
      await mkdir(bin);
      await writeFile(
        join(bin, 'claude'),
        `#!/bin/sh\nexec env FAKE_AGENT_MODE=structured-ok FAKE_AGENT_STRUCTURED_RAW=${quote(JSON.stringify(proposal))} ${variant === 'TREATMENT' ? 'FAKE_AGENT_SERVED_MODEL=remapped ' : ''}${quote(process.execPath)} ${quote(FAKE_CLI)} "$@"\n`,
        { mode: 0o755 },
      );
      vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
      vi.stubEnv('ANTHROPIC_API_KEY', 'offline-fixture-key');

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
      const entry = registry.find((candidate) => candidate.name === 'analyze.agenticRemediation');
      if (entry === undefined) throw new Error('analyze.agenticRemediation is missing');
      const dispatch = await entry.importer();
      const outcome = await dispatch(
        entry.inputSchema.parse({
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
          modelSpec: { provider: 'anthropic', model: 'claude-haiku-4-5' },
        }),
      );
      if (variant === 'CONTROL') {
        expect(outcome).toMatchObject({
          status: 'ok',
          value: { stopReason: 'complete', structuredOutput: proposal, model: 'claude-haiku-4-5' },
        });
      } else {
        expect(outcome.status).toBe('failed');
        expect(verdicts).toHaveLength(1);
        expect(verdicts[0]?.error).toContain('served model assertion');
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
      const bindings = bindingsFromDispatch({
        repoRoot: root,
        worktreesDir: join(root, 'worktrees'),
        runPrefix: 'cq/construction',
        base: 'main',
        package: 'fixture',
        fixer: 'fix',
        files: ['file.ts'],
        driver: {
          binary: [
            'env',
            ...(variant === 'TREATMENT' ? ['FAKE_AGENT_SERVED_MODEL=remapped'] : []),
            process.execPath,
            FAKE_CLI,
          ],
          model: 'construction-model',
          provider: 'construction',
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
        check: { adapter: 'tsc-lines', command: 'unused', args: [] },
      });
      const invocation: OpInvocation = {
        prompt: 'construction proof',
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
        expect(outcome.error).toContain('served model assertion');
      }
    },
  );
});
