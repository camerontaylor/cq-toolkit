import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { makeReviewAddress } from '../../../src/ops/review/address.js';
import type { CqConfig } from '../../../src/ops/analyze/cqConfig.js';
import type { DriverFactory } from '../../../src/driver/factory.js';
import type { Finding, FindingsRecord } from '../../../src/ops/review/findings.js';
import { makeTestRepo } from '../dev/repo.js';
import { makeGitleaksFixture } from '../../helpers/gitleaks-fixture.js';
import { makeSubprocessDevEffects } from '../../../src/ops/dev/effects.js';

let scanner: Awaited<ReturnType<typeof makeGitleaksFixture>>;
beforeEach(async () => {
  scanner = await makeGitleaksFixture();
  vi.stubEnv('PATH', scanner.path);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(scanner.root, { recursive: true, force: true });
});
async function fixture(mode: 'fix' | 'defer' | 'rescue' = 'fix', maxTokens = 10000) {
  const repo = await makeTestRepo();
  repo.git('config', 'user.name', 'Test');
  repo.git('config', 'user.email', 'test@example.invalid');
  const journalDir = await mkdtemp(join(tmpdir(), 'cq-address-local-'));
  const role = { provider: 'mock', model: 'worker' };
  const config: CqConfig = {
    schemaVersion: 2,
    checks: [
      { adapter: 'tsc-lines', command: { command: process.execPath, args: ['scripts/check.cjs'] } },
    ],
    roles: {
      worker: role,
      rescue: { ...role, model: 'rescue' },
      reviewer: { ...role, model: 'reviewer' },
    },
    review: { reviewers: ['agent'], rounds: 2 },
    budgets: { run: { maxTokens, wallMs: 20000 }, step: { wallMs: 5000 } },
    escalation: { workerAttempts: 2, rescueBase: 1, rescuePerPackageCap: 1 },
  };
  await repo.write('.gitignore', '.cq/\n');
  await repo.write('src/a.ts', 'export const a = "BAD";\n');
  await repo.write('scripts/check.cjs', 'process.exitCode = 0;\n');
  await repo.write('cq.json', JSON.stringify(config));
  repo.commitAll('review address fixture');
  const head = repo.git('rev-parse', 'HEAD').trim();
  const finding: Finding = {
    id: 'seed-a',
    source: 'agent',
    file: 'src/a.ts',
    line: 1,
    severity: 'major',
    text: 'Replace BAD with GOOD',
    status: 'open',
  };
  const record: FindingsRecord = {
    schemaVersion: 1,
    branch: 'feature/x',
    head,
    sources: [{ kind: 'agent', status: 'terminal' }],
    findings: [finding],
  };
  const models: string[] = [];
  const drivers: DriverFactory = {
    resolve: (request) => ({
      lane: 'ai-sdk',
      modelSpec: request.modelSpec,
      driver: {
        run: async (input) => {
          models.push(input.modelSpec.model);
          let structuredOutput: unknown;
          const content = await readFile(join(input.workspace!.path, 'src/a.ts'), 'utf8');
          if (input.outputSchema?.name === 'review.agent/v1')
            structuredOutput = {
              findings: content.includes('BAD')
                ? [{ file: 'src/a.ts', line: 1, severity: 'high', text: finding.text }]
                : [],
            };
          else if (input.outputSchema?.name === 'review.address.closure/v1')
            structuredOutput = {
              closed: content.includes('GOOD'),
              reason: 'verified candidate bytes',
            };
          else if (mode === 'defer')
            structuredOutput = {
              disposition: 'deferred',
              reason: 'owner design required',
              evidence: [{ path: 'src/a.ts', line: 1 }],
            };
          else if (mode === 'rescue' && input.modelSpec.model === 'worker')
            structuredOutput = {
              disposition: 'fixed',
              reason: 'worker claim without edit',
              evidence: [],
            };
          else {
            if (!input.prompt.startsWith('related-check feedback'))
              await writeFile(
                join(input.workspace!.path, 'src/a.ts'),
                content.replace('BAD', 'GOOD'),
              );
            structuredOutput = { disposition: 'fixed', reason: 'fixed seeded issue', evidence: [] };
          }
          return {
            stopReason: 'complete',
            structuredOutput,
            usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 },
            denials: [],
          };
        },
      },
    }),
  };
  return {
    repo,
    journalDir,
    record,
    models,
    op: makeReviewAddress({ drivers, initialRecord: record }),
    cleanup: async () => {
      await repo.cleanup();
      await rm(journalDir, { recursive: true, force: true });
    },
  };
}
describe('review.address local full cycle', () => {
  test('fixture findings become a gated commit, dev disposition, actual review.run and clean report', async () => {
    const f = await fixture();
    try {
      const result = await f.op({
        repoRoot: f.repo.root,
        source: 'local',
        journalDir: f.journalDir,
      });
      expect(result.status, JSON.stringify(result)).toBe('ok');
      if (result.status !== 'ok') return;
      expect(result.value.fixesPerRun).toBe(1);
      expect(result.value.openBlocking).toEqual([]);
      expect(result.value.attempts.map((attempt) => attempt.invocation)).toEqual([
        'edit',
        'feedback',
        'closure',
      ]);
      expect(result.value.usage).toEqual({ input: 8, output: 4, cacheRead: 0, cacheWrite: 0 });
      expect((await scanner.calls()).length).toBeGreaterThan(3);
      const ledger = makeSubprocessDevEffects(f.repo.root).openLedger('feature/x').load();
      expect(
        ledger.records.some(
          (row) =>
            row.kind === 'disposition' && row.findingId === 'seed-a' && row.action === 'fixed',
        ),
      ).toBe(true);
      expect(JSON.parse(await readFile(result.value.reportPath, 'utf8'))).toEqual(result.value);
      expect(f.repo.git('show', '--format=', '--name-only', 'HEAD').trim()).toBe('src/a.ts');
      // Publication is an explicit opt-in even after a successful run.
      expect(() => f.repo.git('rev-parse', 'refs/remotes/origin/feature/x')).toThrow();
    } finally {
      await f.cleanup();
    }
  });
  test('two failed worker attempts route to shared rescue before human', async () => {
    const f = await fixture('rescue');
    try {
      const result = await f.op({
        repoRoot: f.repo.root,
        source: 'local',
        journalDir: f.journalDir,
      });
      expect(result.status, JSON.stringify(result)).toBe('ok');
      if (result.status !== 'ok') return;
      expect(
        result.value.attempts
          .filter((attempt) => attempt.invocation === 'edit')
          .map((attempt) => attempt.tier),
      ).toEqual(['worker', 'worker', 'rescue']);
      expect(result.value.escalation?.perRunUsed).toBe(1);
      expect(result.value.fixesPerRun).toBe(1);
    } finally {
      await f.cleanup();
    }
  });
  test('a deferred blocker survives actual re-review and yields honest needs-human at the round cap', async () => {
    const f = await fixture('defer');
    try {
      const result = await f.op({
        repoRoot: f.repo.root,
        source: 'local',
        journalDir: f.journalDir,
      });
      expect(result.status).toBe('needs-human');
      const report = result.status === 'ok' ? result.value : result.report!;
      expect(report.openBlocking).toHaveLength(1);
      expect(report.openBlocking[0]?.status).toBe('deferred');
      expect(report.fixesPerRun).toBe(0);
      expect(f.repo.git('rev-parse', 'HEAD').trim()).toBe(f.record.head);
    } finally {
      await f.cleanup();
    }
  });
});
