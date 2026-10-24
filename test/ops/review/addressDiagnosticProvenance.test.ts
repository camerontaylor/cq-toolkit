// Diagnostic provenance for the pre-upload denylist scan (#464): the engine
// must scan every diagnostic it embeds in a provider prompt under that
// diagnostic's normalized repository-relative source path, so a path-scoped
// denylist rule keyed to the diagnostic's source file fires even though the
// whole-request component is labeled `worker-request.json`. An unattributable
// diagnostic refuses the upload instead of shipping unscanned protected text.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { makeAddressWorker, type AddressAttempt } from '../../../src/ops/review/addressWorker.js';
import { resolveCqConfigDefaults } from '../../../src/ops/analyze/cqConfigDefaults.js';
import type { CqConfig } from '../../../src/ops/analyze/cqConfig.js';
import type { DriverFactory } from '../../../src/driver/factory.js';
import { makeRepoDiffScanner, type ScanComponentInput } from '../../../src/ops/dev/denylist.js';
import { makeGhRunner, type GhFn } from '../../../src/adapters/forge-github/gh.js';
import type { Finding } from '../../../src/ops/review/findings.js';
import { makeTestRepo } from '../dev/repo.js';

const usage = { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 };
const finding = (): Finding => ({
  id: 'src/a.ts',
  source: 'agent',
  file: 'src/a.ts',
  line: 1,
  severity: 'major',
  text: 'Replace BAD with GOOD',
  status: 'open',
});
const patterns = `rules:
  - id: lib-token
    description: protected literal that may only be scanned under its own path
    regex: 'SRC_TOKEN_SECRET'
    path: '^src/lib\\.ts$'
    sample: 'SRC_TOKEN_SECRET'
clean_probes:
  - 'src/a.ts'
`;

async function fixture(options: {
  adapter: 'tsc-lines' | 'vitest-json';
  checkOutput: string;
  providerRequest?: boolean;
}) {
  const repo = await makeTestRepo();
  repo.git('config', 'user.name', 'Test');
  repo.git('config', 'user.email', 'test@example.invalid');
  await repo.write('src/a.ts', 'BAD\n');
  await repo.write('src/lib.ts', 'export const v = "SRC_TOKEN_SECRET";\n');
  await repo.write('scripts/check.cjs', options.checkOutput);
  await repo.write('policy/denylist/patterns.yml', patterns);
  repo.commitAll('fixture');
  const initial = repo.git('rev-parse', 'HEAD').trim();
  const journal = await mkdtemp(join(tmpdir(), 'cq-address-scan-'));
  const attempts: AddressAttempt[] = [];
  let calls = 0;
  const drivers: DriverFactory = {
    resolve: (request) => ({
      lane: 'ai-sdk',
      modelSpec: request.modelSpec,
      driver: {
        run: async (input) => {
          calls++;
          if (options.providerRequest)
            await request.beforeRequest?.('synthetic request', [
              { text: 'synthetic tool output', path: 'src/a.ts' },
            ]);
          if (input.outputSchema?.name === 'review.address.closure/v1')
            return {
              stopReason: 'complete' as const,
              structuredOutput: { closed: true, reason: 'verified' },
              usage,
              denials: [],
            };
          if (!input.prompt.startsWith('related-check feedback'))
            await writeFile(join(input.workspace!.path, 'src/a.ts'), 'GOOD\n');
          return {
            stopReason: 'complete' as const,
            structuredOutput: { disposition: 'fixed', reason: 'fixed', evidence: [] },
            usage,
            denials: [],
          };
        },
      },
    }),
  };
  const config: CqConfig = {
    schemaVersion: 2,
    checks: [
      {
        adapter: options.adapter,
        command: { command: process.execPath, args: ['scripts/check.cjs'] },
      },
    ],
    roles: {
      worker: { provider: 'mock', model: 'worker' },
      rescue: { provider: 'mock', model: 'rescue' },
      reviewer: { provider: 'mock', model: 'reviewer' },
    },
    budgets: { run: { maxTokens: 10000, wallMs: 20000 }, step: { wallMs: 5000 } },
    escalation: { workerAttempts: 1, rescueBase: 0 },
    review: { reviewers: ['agent'] },
  };
  const git: GhFn = makeGhRunner({ bin: 'git', cwd: repo.root });
  const captured: ScanComponentInput[][] = [];
  const rules = makeRepoDiffScanner(repo.root, 'policy/denylist/patterns.yml');
  const engine = makeAddressWorker({
    git,
    drivers,
    repoRoot: repo.root,
    journalDir: journal,
    policy: resolveCqConfigDefaults(config, { packageName: 'fixture' }),
    attempts,
    remainingTokens: () => 10000,
    remainingWallMs: () => 20000,
    account: () => undefined,
    scanner: async (components) => {
      captured.push([...components]);
      return rules(components);
    },
  });
  return {
    repo,
    engine,
    attempts,
    captured,
    calls: () => calls,
    initial,
    cleanup: async () => {
      await repo.cleanup();
      await rm(journal, { recursive: true, force: true });
    },
  };
}

describe('review.address diagnostic provenance in upload scans', () => {
  test('a diagnostic embedding protected source text is scanned under its source path and refused', async () => {
    const f = await fixture({
      adapter: 'tsc-lines',
      checkOutput:
        `console.log('src/lib.ts(2,20): error TS2322: Type \\"SRC_TOKEN_SECRET\\" is not assignable to type \\"string\\".');\n` +
        'process.exitCode = 1;\n',
    });
    try {
      const fix = await f.engine.fix(finding(), 1);
      // The protected literal would ride to the provider inside the feedback
      // prompt's diagnostic text; after the repair the admission scan refuses
      // before that dispatch, with one edit dispatch already paid.
      expect(fix.reason, JSON.stringify(f.attempts)).toMatch(/upload refused/);
      expect(fix.finding.status).toBe('deferred');
      expect(f.calls()).toBe(1);
      expect(f.repo.git('rev-parse', 'HEAD').trim()).toBe(f.initial);
      const flat = f.captured.flat();
      expect(flat.some((c) => c.path === 'worker-request.json')).toBe(true);
      const attributed = flat.find((c) => c.path === 'src/lib.ts');
      expect(attributed, JSON.stringify(flat.map((c) => c.path))).toBeDefined();
      expect(attributed!.text).toContain('SRC_TOKEN_SECRET');
    } finally {
      await f.cleanup();
    }
  });

  test('an unattributable diagnostic refuses the upload instead of shipping unscanned', async () => {
    const f = await fixture({
      adapter: 'vitest-json',
      checkOutput:
        `console.log(JSON.stringify({ success: false, numTotalTests: 1, numFailedTests: 1, testResults: ` +
        `[{ status: 'failed', name: null, assertionResults: ` +
        `[{ status: 'failed', fullName: 'suite exploded: SRC_TOKEN_SECRET leaked', failureMessages: [] }] }] }));\n` +
        'process.exitCode = 1;\n',
    });
    try {
      const fix = await f.engine.fix(finding(), 1);
      expect(fix.reason, JSON.stringify(f.attempts)).toMatch(
        /upload refused.*provenance unavailable/,
      );
      expect(fix.finding.status).toBe('deferred');
      expect(f.calls()).toBe(1);
      expect(f.repo.git('rev-parse', 'HEAD').trim()).toBe(f.initial);
    } finally {
      await f.cleanup();
    }
  });

  test('whole-request scanning and path-aware sources keep their existing labels', async () => {
    const f = await fixture({
      adapter: 'tsc-lines',
      checkOutput: 'process.exitCode = 0;\n',
      providerRequest: true,
    });
    try {
      const fix = await f.engine.fix(finding(), 1);
      expect(fix.finding.status, JSON.stringify(f.attempts)).toBe('fixed');
      expect(fix.commit).toBeTruthy();
      const providerSend = f.captured.find((components) =>
        components.some((c) => c.text === 'synthetic request'),
      );
      expect(
        providerSend,
        JSON.stringify(f.captured.map((c) => c.map((x) => x.path))),
      ).toBeDefined();
      expect(providerSend!.some((c) => c.path === 'worker-request.json')).toBe(true);
      expect(providerSend!.some((c) => c.path === 'src/a.ts')).toBe(true);
    } finally {
      await f.cleanup();
    }
  });
});
