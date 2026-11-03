// Split provenance: test/ops/review/address-local.test.ts was split into
// address-local.full-cycle.test.ts, address-local.review-run-gate.test.ts,
// address-local.ownership.test.ts, address-local.rereview.test.ts,
// address-local.cancellation.test.ts and
// address-local.opaque-cancellation.test.ts. The scanner hooks and the
// review.address fixture below are shared by all of them.
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, vi } from 'vitest';
import { makeReviewAddress } from '../../../src/ops/review/address.js';
import type { CqConfig } from '../../../src/ops/analyze/cqConfig.js';
import type { DriverFactory } from '../../../src/driver/factory.js';
import type { Finding, FindingsRecord } from '../../../src/ops/review/findings.js';
import { makeTestRepo } from '../dev/repo.js';
import { makeGitleaksFixture } from '../../helpers/gitleaks-fixture.js';

let scanner: Awaited<ReturnType<typeof makeGitleaksFixture>>;

/**
 * Registers the per-test gitleaks PATH fixture the address-local suites share.
 * Call once at module scope in every test file that needs it.
 */
export function useGitleaksPath(): void {
  beforeEach(async () => {
    scanner = await makeGitleaksFixture();
    vi.stubEnv('PATH', scanner.path);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(scanner.root, { recursive: true, force: true });
  });
}

/** Call counts recorded by the last {@link useGitleaksPath} scanner. */
export async function gitleaksCalls() {
  return scanner.calls();
}

export async function fixture(
  mode: 'fix' | 'defer' | 'rescue' = 'fix',
  maxTokens = 10000,
  /** #509: the first N reviewer driver runs fail with this class (default none). */
  reviewerFailures: { count: number; errorClass: 'transient' | 'auth' } = {
    count: 0,
    errorClass: 'transient',
  },
) {
  let reviewerFailuresLeft = reviewerFailures.count;
  const reviewRequests = { count: 0 };
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
          if (input.outputSchema?.name === 'review.agent/v3') reviewRequests.count += 1;
          if (input.outputSchema?.name === 'review.agent/v3' && reviewerFailuresLeft > 0) {
            reviewerFailuresLeft -= 1;
            return {
              stopReason: 'error',
              errorClass: reviewerFailures.errorClass,
              error: 'Cannot connect to API: getaddrinfo EAI_AGAIN api.example.invalid',
              usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
              denials: [],
            };
          }
          if (input.outputSchema?.name === 'review.agent/v3') {
            const serialized = JSON.stringify({
              prompt: [{ role: 'user', content: [{ type: 'text', text: input.prompt }] }],
            });
            await request.beforeRequest?.(serialized, [{ text: input.prompt }], {
              kind: 'model-request',
            });
            structuredOutput = {
              findings: content.includes('BAD')
                ? [{ file: 'src/a.ts', line: 1, severity: 'high', text: finding.text }]
                : [],
            };
          } else if (input.outputSchema?.name === 'review.address.closure/v1')
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
    reviewRequests,
    drivers,
    op: makeReviewAddress({ drivers, initialRecord: record }),
    cleanup: async () => {
      await repo.cleanup();
      await rm(journalDir, { recursive: true, force: true });
    },
  };
}
