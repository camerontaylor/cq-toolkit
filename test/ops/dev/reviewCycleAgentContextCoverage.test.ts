import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { DriverFactory } from '../../../src/driver/factory.js';
import type { Op } from '../../../src/kernel/types.js';
import type { DiffSecretScanner } from '../../../src/ops/dev/denylist.js';
import {
  makeDevReview,
  type DevCycleInput,
  type DevReviewReport,
} from '../../../src/ops/dev/review.js';
import { runAgentReviewer } from '../../../src/ops/review/agentReviewer.js';
import { isCoverageV2Complete } from '../../../src/ops/review/internal/reviewCoverageV2.js';
import { stubScanner } from './fakes.js';
import { reviewCoverage, sha256 } from './reviewTestKit.js';
import { makeTestRepo, repoEffects, type TestRepo } from './repo.js';

let repo: TestRepo;
beforeEach(async () => {
  repo = await makeTestRepo();
});
afterEach(async () => {
  await repo.cleanup();
});

describe('dev.review cycle', () => {
  test.each(['full', 'uncommitted'] as const)(
    'passes bounded truthful %s context to the agent after the scan',
    async (scope) => {
      await repo.write('src/committed.ts', 'export const committed = 1;\n');
      repo.commitAll('CONTEXT_COMMITTED_INTENT\n\n' + 'x'.repeat(5000));
      await repo.write('src/dirty.ts', 'export const dirty = 1;\n');
      repo.git('add', 'src/dirty.ts');
      const run = vi.fn<NonNullable<Parameters<typeof makeDevReview>[0]['runAgentReviewer']>>(
        async () => ({ status: 'needs-human', reason: 'fixture stop after context capture' }),
      );
      const effects = repoEffects(repo);
      await makeDevReview({ effects, scanSecrets: stubScanner(), runAgentReviewer: run })({
        repoRoot: repo.root,
        reviewer: 'agent:reviewer',
        ...(scope === 'uncommitted' ? { uncommitted: true } : {}),
      });
      expect(run).toHaveBeenCalledOnce();
      const input = run.mock.calls[0]![0];
      expect(input.scope).toBe(scope);
      expect(input.intent!.length).toBeLessThanOrEqual(4000);
      expect(input.fileList!.length).toBeLessThanOrEqual(4000);
      expect(input.fileList).toContain('src/dirty.ts');
      if (scope === 'full') {
        expect(input.intent).toContain('CONTEXT_COMMITTED_INTENT');
        expect(input.intent).toContain('[truncated:');
        expect(input.fileList).toContain('src/committed.ts');
        expect(input.base).toBe(repo.git('merge-base', 'origin/main', 'HEAD').trim());
      } else {
        expect(input.intent).toBe('');
        expect(input.fileList).not.toContain('src/committed.ts');
        expect(input.base).toBe(repo.git('rev-parse', 'HEAD').trim());
      }
    },
  );

  test('caps oversized changed-file context before agent invocation', async () => {
    const effects = repoEffects(repo, (command, args) =>
      command === 'git' && args.includes('--numstat') ? '1\t0\t' + 'path'.repeat(2000) : undefined,
    );
    const run = vi.fn<NonNullable<Parameters<typeof makeDevReview>[0]['runAgentReviewer']>>(
      async () => ({ status: 'needs-human', reason: 'fixture context captured' }),
    );
    await makeDevReview({ effects, scanSecrets: stubScanner(), runAgentReviewer: run })({
      repoRoot: repo.root,
      reviewer: 'agent:reviewer',
    });
    expect(run).toHaveBeenCalledOnce();
    const files = run.mock.calls[0]![0].fileList!;
    expect(files.length).toBeLessThanOrEqual(4000);
    const marker = /\n\[truncated: (\d+) characters omitted\]$/.exec(files)!;
    expect(marker).not.toBeNull();
    expect(files.slice(0, marker.index).length + Number(marker[1])).toBe(8004);
  });

  test('cancellation during context collection refuses agent dispatch and persists a blocker', async () => {
    const controller = new AbortController();
    const inner = repoEffects(repo);
    const effects = {
      ...inner,
      runCommand: async (...args: Parameters<typeof inner.runCommand>) => {
        const result = await inner.runCommand(...args);
        if (args[0] === 'git' && args[1].includes('--numstat'))
          controller.abort(new Error('fixture context cancelled'));
        return result;
      },
    };
    const run = vi.fn<NonNullable<Parameters<typeof makeDevReview>[0]['runAgentReviewer']>>();
    const result = await makeDevReview({
      effects,
      signal: controller.signal,
      remainingWallMs: () => 5000,
      scanSecrets: stubScanner(),
      runAgentReviewer: run,
    })({ repoRoot: repo.root, reviewer: 'agent:reviewer' });
    expect(result.status).toBe('needs-human');
    expect(run).not.toHaveBeenCalled();
    const attempt = effects.openLedger('feature/x').load().records.at(-1);
    expect(attempt?.kind).toBe('cycle');
    if (attempt?.kind === 'cycle') expect(attempt.completion.kind).toBe('blocked');
  });

  test('a secret present only in commit context is scanned before the session engine uploads', async () => {
    await repo.write('src/context.ts', 'export const context = 1;\n');
    repo.commitAll('CONTEXT_SECRET_ONLY_IN_COMMIT');
    const drivers = { resolve: vi.fn() } as unknown as DriverFactory;
    const scan: DiffSecretScanner = async (components) =>
      components.map((component) => ({
        component: component.component,
        hits: component.text.includes('CONTEXT_SECRET_ONLY_IN_COMMIT')
          ? [{ ruleId: 'fixture-context-secret', lines: [1] }]
          : [],
      }));
    const result = await makeDevReview({
      effects: repoEffects(repo),
      scanSecrets: scan,
      runAgentReviewer: (input) =>
        runAgentReviewer(drivers, {
          ...input,
          scanSecrets: scan,
          role: { provider: 'scripted', model: 'reviewer' },
          maxTokens: 500,
          wallMs: 5000,
          severityMap: { high: 'major', medium: 'minor' },
        }),
    })({ repoRoot: repo.root, reviewer: 'agent:reviewer' });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') expect(result.reason).toContain('protected content');
    expect(drivers.resolve).not.toHaveBeenCalled();
  });

  test('an ok agent result with incomplete coverage is blocked, never terminal', async () => {
    const effects = repoEffects(repo);
    const op = makeDevReview({
      effects,
      scanSecrets: stubScanner(),
      runAgentReviewer: async (input) => ({
        status: 'ok',
        value: {
          findings: [],
          usage: 1,
          coverage: reviewCoverage(input.head, input.base, input.scope, 'planned'),
          advisories: [],
          limitations: [],
        },
      }),
    }) as Op<DevCycleInput, DevReviewReport>;
    const result = await op({ repoRoot: repo.root, reviewer: 'agent:reviewer' });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') {
      expect(result.reason).toContain('no verifiable coverage proof');
      expect(result.reason).toContain('coverage is incomplete');
    }
    const [cycle] = effects.openLedger('feature/x').load().records;
    expect(cycle).toMatchObject({
      kind: 'cycle',
      completion: { kind: 'blocked' },
    });
  });

  test('an ok agent result with mismatched coverage is blocked, never terminal', async () => {
    const effects = repoEffects(repo);
    const op = makeDevReview({
      effects,
      scanSecrets: stubScanner(),
      runAgentReviewer: async (input) => ({
        status: 'ok',
        value: {
          findings: [],
          usage: 1,
          coverage: reviewCoverage(input.head, 'c'.repeat(40), input.scope, 'excluded'),
          advisories: [],
          limitations: [],
        },
      }),
    }) as Op<DevCycleInput, DevReviewReport>;
    const result = await op({ repoRoot: repo.root, reviewer: 'agent:reviewer' });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human')
      expect(result.reason).toContain('does not match the reviewed record');
  });

  test('an ok agent result without coverage is blocked, never terminal', async () => {
    const effects = repoEffects(repo);
    const op = makeDevReview({
      effects,
      scanSecrets: stubScanner(),
      runAgentReviewer: async () => ({
        status: 'ok',
        value: {
          findings: [],
          usage: 1,
          coverage: undefined as never,
          advisories: [],
          limitations: [],
        },
      }),
    }) as Op<DevCycleInput, DevReviewReport>;
    const result = await op({ repoRoot: repo.root, reviewer: 'agent:reviewer' });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') expect(result.reason).toContain('no coverage evidence');
  });

  test('legacy v1 coverage is labelled report-only and never settles terminal', async () => {
    const effects = repoEffects(repo);
    const op = makeDevReview({
      effects,
      scanSecrets: stubScanner(),
      runAgentReviewer: async (input) => ({
        status: 'ok',
        value: {
          findings: [],
          usage: 1,
          coverage: {
            head: input.head,
            base: input.base,
            scope: input.scope,
            components: [
              {
                component: 'tracked:src/a.ts',
                path: 'src/a.ts',
                sha256: sha256(''),
                chars: 0,
                bytes: 0,
              },
            ],
            partitions: [
              {
                receipt: 'a'.repeat(64),
                ranges: [{ component: 0, start: 0, end: 0 }],
                complete: true,
                promptChars: 1,
                requests: [{ serializedChars: 1, decodedChars: 0 }],
              },
            ],
          } as never,
          advisories: [],
          limitations: [],
        },
      }),
    }) as Op<DevCycleInput, DevReviewReport>;
    const result = await op({ repoRoot: repo.root, reviewer: 'agent:reviewer' });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human')
      expect(result.reason).toContain('legacy v1 agent review coverage is report only');
    const [cycle] = effects.openLedger('feature/x').load().records;
    expect(cycle).toMatchObject({ kind: 'cycle', completion: { kind: 'blocked' } });
  });

  test('complete excluded coverage settles terminal and persists advisories', async () => {
    const effects = repoEffects(repo);
    const op = makeDevReview({
      effects,
      scanSecrets: stubScanner(),
      runAgentReviewer: async (input) => {
        const coverage = reviewCoverage(input.head, input.base, input.scope, 'excluded');
        expect(isCoverageV2Complete(coverage)).toBe(true);
        return {
          status: 'ok',
          value: {
            findings: [],
            usage: 3,
            coverage,
            advisories: ['fixture advisory'],
            limitations: ['fixture exclusion limitation'],
          },
        };
      },
    }) as Op<DevCycleInput, DevReviewReport>;
    const result = await op({ repoRoot: repo.root, reviewer: 'agent:reviewer' });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value.advisories).toEqual(['fixture advisory']);
    const [cycle] = effects.openLedger('feature/x').load().records;
    expect(cycle).toMatchObject({
      kind: 'cycle',
      completion: { kind: 'terminal' },
      advisories: ['fixture advisory'],
    });
    expect(effects.logs[0]).toContain('coverage: v2 mode=session');
    expect(effects.logs[0]).toContain('exclusions: src/a.ts (fixture/**; limitation=');
    expect(effects.logs[0]).toContain('limitations: fixture exclusion limitation');
    expect(effects.logs[0]).toContain('advisories: fixture advisory');
  });
});
