import { mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { makeReviewAddress, type ReviewAddressReport } from '../../../src/ops/review/address.js';
import { makeReviewRun } from '../../../src/ops/review/run.js';
import type { CqConfig } from '../../../src/ops/analyze/cqConfig.js';
import type { DriverFactory } from '../../../src/driver/factory.js';
import {
  FindingsRecordSchema,
  type Finding,
  type FindingsRecord,
} from '../../../src/ops/review/findings.js';
import { makeTestRepo } from '../dev/repo.js';
import { makeGitleaksFixture } from '../../helpers/gitleaks-fixture.js';
import { makeSubprocessDevEffects } from '../../../src/ops/dev/effects.js';
import { runPlan } from '../../../src/kernel/runner.js';
import { createGovernor, runLadder } from '../../../src/kernel/governor.js';
import type { OpRegistryEntry } from '../../../src/kernel/types.js';
import { z } from 'zod';

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
    drivers,
    op: makeReviewAddress({ drivers, initialRecord: record }),
    cleanup: async () => {
      await repo.cleanup();
      await rm(journalDir, { recursive: true, force: true });
    },
  };
}
describe('review.address local full cycle', () => {
  test('nested worker, feedback, closure and re-review usage reach the enclosing budget exactly once', async () => {
    const f = await fixture();
    let next = 0;
    try {
      const run = await runPlan(
        {
          id: 'outer-address',
          jobs: [
            {
              id: 'address',
              op: 'review.address',
              input: { repoRoot: f.repo.root, source: 'local', journalDir: f.journalDir },
            },
            { id: 'later', op: 'probe', input: {} },
          ],
        },
        { concurrency: 1, stopOnError: false, maxTokens: 10 },
        {
          get: (name) =>
            ({
              name,
              inputSchema: z.unknown(),
              importer: async () =>
                name === 'review.address'
                  ? f.op
                  : async () => {
                      next++;
                      return { status: 'ok', value: {} };
                    },
            }) as unknown as OpRegistryEntry<never, never>,
        },
        {
          governor: createGovernor({ maxTokens: 10 }),
          allowAdvisory: true,
          allowAdvisoryProvenance: 'product',
        },
      );
      expect(run.usage).toEqual({ input: 8, output: 4, cacheRead: 0, cacheWrite: 0 });
      expect(run.jobs[0]?.usage).toEqual(run.usage);
      expect(next).toBe(0);
      expect(run.jobs[1]?.result.status).toBe('budget-exhausted');
      expect(f.models).toEqual(['worker', 'worker', 'reviewer', 'reviewer']);
    } finally {
      await f.cleanup();
    }
  });
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
      expect(result.value.usage).toEqual({
        input: 2 * f.models.length,
        output: f.models.length,
        cacheRead: 0,
        cacheWrite: 0,
      });
      expect(f.models.filter((model) => model === 'reviewer').length).toBeGreaterThan(0);
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
        push: true,
      });
      expect(result.status, JSON.stringify(result)).toBe('ok');
      if (result.status !== 'ok') return;
      expect(
        result.value.attempts
          .filter((attempt) => attempt.invocation === 'edit')
          .map((attempt) => attempt.tier),
      ).toEqual(['worker', 'worker', 'rescue']);
      expect(f.repo.git('ls-remote', '--heads', 'origin', 'cq-address/*')).toBe('');
      expect(f.repo.git('ls-remote', '--heads', 'origin', 'feature/x')).toContain(
        result.value.fixes[0]!.commit,
      );
      expect(result.value.escalation?.perRunUsed).toBe(1);
      expect(result.value.fixesPerRun).toBe(1);
      expect(result.value.failed.map((row) => [row.ordinal, row.tier])).toEqual([
        [1, 'worker'],
        [2, 'worker'],
      ]);
      expect(result.value.fixes[0]!.failedAttempts).toEqual(result.value.failed);
      for (const row of result.value.failed) {
        expect(f.repo.git('rev-parse', row.branch).trim()).toBe(row.sha);
        expect(f.repo.git('rev-parse', `${row.sha}^`).trim()).toBe(row.parent);
      }
      const journal = JSON.parse(
        await readFile(result.value.reportPath, 'utf8'),
      ) as ReviewAddressReport;
      expect(journal.failed).toEqual(result.value.failed);
      expect(
        journal.attempts.filter((row) => row.failedAttempt).map((row) => row.failedAttempt),
      ).toEqual(journal.failed);
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

test.each([
  'full',
  'uncommitted',
  'narrow-base',
  'matching-narrow-base',
  'dirty-restored',
  'staged-restored',
  'untracked-restored',
  'mutated-during-review',
] as const)('actual review.run record gates local clean acceptance: %s', async (mode) => {
  const f = await fixture();
  let calls = 0;
  const drivers: DriverFactory = {
    resolve: (request) => ({
      lane: 'ai-sdk',
      modelSpec: request.modelSpec,
      driver: {
        run: async (input) => {
          calls++;
          if (mode === 'dirty-restored' || mode === 'staged-restored')
            expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toContain('GOOD');
          if (mode === 'mutated-during-review')
            await f.repo.write('src/a.ts', 'export const a = "GOOD";\n');
          const serialized = JSON.stringify({
            prompt: [{ role: 'user', content: [{ type: 'text', text: input.prompt }] }],
          });
          await request.beforeRequest?.(serialized, [{ text: input.prompt }], {
            kind: 'model-request',
          });
          return {
            stopReason: 'complete',
            structuredOutput: { findings: [] },
            usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 },
            denials: [],
          };
        },
      },
    }),
  };
  try {
    const narrow = mode === 'narrow-base' || mode === 'matching-narrow-base';
    const head = f.repo.git('rev-parse', 'HEAD').trim();
    const dirty = mode === 'dirty-restored' || mode === 'staged-restored';
    if (dirty) {
      await f.repo.write('src/a.ts', 'export const a = "GOOD";\n');
      if (mode === 'staged-restored') f.repo.git('add', '--', 'src/a.ts');
    }
    if (mode === 'untracked-restored')
      await f.repo.write('src/new.ts', 'export const newFile = 1;\n');
    const produced = await makeReviewRun({ drivers })({
      repoRoot: f.repo.root,
      ...(narrow ? { base: head } : {}),
      ...(mode === 'uncommitted' ? { uncommitted: true } : {}),
    });
    expect(produced.status).toBe(mode === 'mutated-during-review' ? 'needs-human' : 'ok');
    const record = FindingsRecordSchema.parse(
      JSON.parse(
        await readFile(
          join(f.repo.root, '.cq/review', encodeURIComponent(f.record.branch), '1.json'),
          'utf8',
        ),
      ),
    );
    if (mode === 'mutated-during-review')
      expect(record.sources).toContainEqual(
        expect.objectContaining({
          kind: 'agent',
          status: 'blocked',
          reason: 'repository state changed during agent review',
        }),
      );
    expect(record.findings).toEqual([]);
    const reviewerCalls = calls;
    expect(reviewerCalls).toBeGreaterThan(0);
    if (dirty || mode === 'mutated-during-review' || mode === 'untracked-restored') {
      expect(record.reviewed).toBeUndefined();
      f.repo.git('restore', '--source=HEAD', '--staged', '--worktree', '--', 'src/a.ts');
      if (mode === 'untracked-restored') await rm(join(f.repo.root, 'src/new.ts'));
      expect(f.repo.git('status', '--porcelain')).toBe('');
      expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toContain('BAD');
    }
    const result = await makeReviewAddress({ drivers, initialRecord: record })({
      repoRoot: f.repo.root,
      source: 'local',
      journalDir: f.journalDir,
      ...(mode === 'matching-narrow-base' ? { base: head } : {}),
    });
    expect(result.status).toBe(
      mode === 'full' || mode === 'matching-narrow-base' ? 'ok' : 'needs-human',
    );
    expect(calls).toBe(reviewerCalls);
    if (result.status !== 'ok')
      expect(result.report!.reasons.join(' ')).toContain(
        mode === 'mutated-during-review' ? 'review source incomplete' : 'reviewed base/scope',
      );
  } finally {
    await f.cleanup();
  }
});

test.each(['same checkout', 'aliased checkout', 'linked checkout'] as const)(
  'distinct default-journal invocations cannot overlap worker ownership: %s',
  async (mode) => {
    const f = await fixture();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const owned = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let edits = 0;
    const drivers: DriverFactory = {
      resolve: (request) => {
        const resolved = f.drivers.resolve(request);
        return {
          ...resolved,
          driver: {
            ...resolved.driver,
            run: async (input) => {
              if (
                input.outputSchema?.name === 'review.address.outcome/v1' &&
                !input.prompt.startsWith('related-check feedback')
              ) {
                edits++;
                if (edits > 1) throw new Error('overlapping provider dispatch');
                entered();
                await gate;
              }
              return resolved.driver.run(input);
            },
          },
        };
      },
    };
    let otherRoot = f.repo.root;
    if (mode === 'aliased checkout') {
      otherRoot = join(f.journalDir, 'alias');
      await symlink(f.repo.root, otherRoot, 'dir');
    } else if (mode === 'linked checkout') {
      otherRoot = join(f.journalDir, 'linked');
      f.repo.git('worktree', 'add', '-q', '-b', 'other', otherRoot, 'HEAD');
    }
    const invoke = makeReviewAddress({ drivers, initialRecord: f.record });
    const first = invoke({ repoRoot: f.repo.root, source: 'local' });
    try {
      await Promise.race([
        owned,
        first.then((result) => {
          throw new Error(`first worker did not enter: ${JSON.stringify(result)}`);
        }),
      ]);
      // Even disjoint file claims from another worker instance must not use
      // the shared mutable checkout while this provider owns its tree.
      const other = await invoke({ repoRoot: otherRoot, source: 'local' });
      expect(other.status, JSON.stringify(other)).toBe('needs-human');
      expect(other.report?.reasons.join(' ')).toContain('could not acquire');
      expect(edits).toBe(1);
      expect(f.repo.git('rev-parse', 'HEAD').trim()).toBe(f.record.head);
      expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toContain('BAD');
      release();
      const completed = await first;
      expect(completed.status, JSON.stringify(completed)).toBe('ok');
      const fresh = completed.status === 'ok' ? completed.value : completed.report!;
      const clean = fresh.rounds.at(-1)!.record;
      const later = await makeReviewAddress({ drivers, initialRecord: clean })({
        repoRoot: f.repo.root,
        source: 'local',
      });
      expect(later.status, JSON.stringify(later)).toBe('ok');
      expect(edits).toBe(1);
    } finally {
      release();
      await first;
      await f.cleanup();
    }
  },
);

test('adopted no-ignore repository can re-review ledger revisions and commit a second round', async () => {
  const f = await fixture();
  try {
    await f.repo.write('.gitignore', '');
    f.repo.commitAll('adopted repository');
    const record = { ...f.record, head: f.repo.git('rev-parse', 'HEAD').trim() };
    let reviews = 0;
    const reviewedHeads = new Set<string>();
    const drivers: DriverFactory = {
      resolve(request) {
        const resolved = f.drivers.resolve(request);
        return {
          ...resolved,
          driver: {
            ...resolved.driver,
            run: async (input) => {
              if (input.outputSchema?.name === 'review.agent/v3') {
                const serialized = JSON.stringify({
                  prompt: [{ role: 'user', content: [{ type: 'text', text: input.prompt }] }],
                });
                await request.beforeRequest?.(serialized, [{ text: input.prompt }], {
                  kind: 'model-request',
                });
                const reviewHead = /^Head: ([a-f0-9]{40,64})$/m.exec(input.prompt)?.[1];
                expect(reviewHead).toBeDefined();
                if (!reviewedHeads.has(reviewHead!)) {
                  reviewedHeads.add(reviewHead!);
                  reviews++;
                }
                return {
                  stopReason: 'complete',
                  usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 },
                  denials: [],
                  structuredOutput: {
                    findings:
                      reviews === 1
                        ? [
                            {
                              file: 'src/a.ts',
                              line: 1,
                              severity: 'high',
                              text: 'Replace GOOD with FINAL',
                            },
                          ]
                        : [],
                  },
                };
              }
              if (
                reviews === 1 &&
                input.outputSchema?.name === 'review.address.outcome/v1' &&
                !input.prompt.startsWith('related-check feedback')
              ) {
                const path = join(input.workspace!.path, 'src/a.ts');
                await writeFile(path, (await readFile(path, 'utf8')).replace('GOOD', 'FINAL'));
              }
              const result = await resolved.driver.run(input);
              if (reviews === 1 && input.outputSchema?.name === 'review.address.closure/v1')
                return {
                  ...result,
                  structuredOutput: { closed: true, reason: 'FINAL candidate checked' },
                };
              return result;
            },
          },
        };
      },
    };
    const result = await makeReviewAddress({ drivers, initialRecord: record })({
      repoRoot: f.repo.root,
      source: 'local',
      journalDir: f.journalDir,
    });
    expect(result.status, JSON.stringify(result)).toBe('ok');
    const report = result.status === 'ok' ? result.value : result.report!;
    expect(report.fixesPerRun).toBe(2);
    expect(reviews).toBe(2);
    expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toContain('FINAL');
    expect(f.repo.git('status', '--porcelain')).toContain('.cq/');
  } finally {
    await f.cleanup();
  }
});

test('cancelled edit reports an ordinary local branch and finding pointer without publication', async () => {
  const f = await fixture();
  const parent = new AbortController();
  const drivers: DriverFactory = {
    resolve: (request) => {
      const resolved = f.drivers.resolve(request);
      return {
        ...resolved,
        driver: {
          run: async (input) => {
            await writeFile(join(input.workspace!.path, 'src/a.ts'), 'CANCELLED PARTIAL\n');
            parent.abort();
            return {
              stopReason: 'aborted',
              usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 },
              denials: [],
            };
          },
        },
      };
    },
  };
  try {
    const governed = await runLadder(
      () =>
        makeReviewAddress({ drivers, initialRecord: f.record })({
          repoRoot: f.repo.root,
          source: 'local',
          journalDir: f.journalDir,
          push: true,
        }),
      {},
      { op: 'review.address', jobKey: 'cancelled-address', attempt: 1 },
      { signal: parent.signal },
    );
    expect(governed.outcome).toBe('completed');
    if (governed.outcome !== 'completed') return;
    const result = governed.value;
    expect(result.status).toBe('needs-human');
    if (result.status === 'ok') return;
    const report = result.report!;
    expect(report.failed).toHaveLength(1);
    const retained = report.failed[0]!;
    expect(retained.gate).toBe('budget');
    expect(f.repo.git('show', `${retained.branch}:src/a.ts`)).toBe('CANCELLED PARTIAL\n');
    expect(JSON.parse(report.findings[0]!.evidence!)).toEqual(retained);
    expect(
      (JSON.parse(await readFile(report.reportPath, 'utf8')) as ReviewAddressReport).failed,
    ).toEqual(report.failed);
    expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toBe('export const a = "BAD";\n');
    expect(f.repo.git('ls-remote', '--heads', 'origin', 'cq-address/*')).toBe('');
  } finally {
    await f.cleanup();
  }
});
