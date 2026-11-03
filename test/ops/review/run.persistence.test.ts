import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { DriverFactory } from '../../../src/driver/factory.js';
import { assembleReadiness, DEV_LEDGER_VERSION } from '../../../src/ops/dev/record.js';
import { reviewBranchKey } from '../../../src/ops/review/internal/branchKey.js';
import { makeReviewRun } from '../../../src/ops/review/run.js';
import { cycleRecord } from '../dev/fakes.js';
import { repoEffects, makeTestRepo, seed } from '../dev/repo.js';
import { configureAgentRepo, scriptedDrivers } from './run.helpers.js';

describe('review.run', () => {
  it('records an agent cycle blocked by the model token budget', async () => {
    const repo = await makeTestRepo();
    try {
      await configureAgentRepo(repo);
      const drivers = {
        resolve: vi.fn(() => ({
          lane: 'ai-sdk',
          modelSpec: { provider: 'mock', model: 'mock' },
          driver: {
            run: async () => ({
              stopReason: 'budget' as const,
              structuredOutput: { findings: [] },
              usage: { input: 500, output: 0, cacheRead: 0, cacheWrite: 0 },
              denials: [],
            }),
          },
        })),
      } as unknown as DriverFactory;
      const effects = repoEffects(repo);
      const result = await makeReviewRun({
        drivers,
        effectsFactory: () => effects,
        scannerFactory: () => async (components) =>
          components.map((component) => ({ component: component.component, hits: [] })),
      })({ repoRoot: repo.root });
      expect(result.status).toBe('needs-human');
      expect(result).toMatchObject({ report: { blockedBudget: true } });
      if (result.status === 'needs-human')
        expect(result.reason).toContain('not every configured reviewer');
      const ledger = effects.openLedger('feature/x').load();
      expect(ledger.records).toContainEqual(
        expect.objectContaining({
          kind: 'cycle',
          reviewer: 'agent:reviewer',
          completion: expect.objectContaining({
            kind: 'blocked',
            reason: expect.stringContaining('agent review budget exhausted') as unknown,
          }) as unknown,
        }),
      );
    } finally {
      await repo.cleanup();
    }
  });

  it('returns indeterminate when the dispatched agent review log cannot be written', async () => {
    const repo = await makeTestRepo();
    try {
      await configureAgentRepo(repo);
      const effects = repoEffects(repo, () => undefined, {
        writeReviewLog: async () => {
          throw new Error('log disk full');
        },
      });
      const result = await makeReviewRun({
        drivers: scriptedDrivers(),
        effectsFactory: () => effects,
        scannerFactory: () => async (components) =>
          components.map((component) => ({ component: component.component, hits: [] })),
      })({ repoRoot: repo.root });
      expect(result.status).toBe('indeterminate');
      if (result.status === 'indeterminate') expect(result.detail).toContain('log disk full');
      expect(effects.openLedger('feature/x').load().records).toEqual([]);
    } finally {
      await repo.cleanup();
    }
  });

  it('returns indeterminate when the dev ledger mutation fails after the agent review', async () => {
    const repo = await makeTestRepo();
    try {
      await configureAgentRepo(repo);
      const effects = repoEffects(repo);
      const openLedger = effects.openLedger.bind(effects);
      effects.openLedger = (branch) => ({
        ...openLedger(branch),
        mutate: async () => {
          throw new Error('ledger locked');
        },
      });
      const result = await makeReviewRun({
        drivers: scriptedDrivers(),
        effectsFactory: () => effects,
        scannerFactory: () => async (components) =>
          components.map((component) => ({ component: component.component, hits: [] })),
      })({
        repoRoot: repo.root,
      });
      expect(result.status).toBe('indeterminate');
      if (result.status === 'indeterminate') expect(result.detail).toContain('ledger locked');
    } finally {
      await repo.cleanup();
    }
  });

  it('maps findings storage preparation failures to failed', async () => {
    const repo = await makeTestRepo();
    try {
      await configureAgentRepo(repo);
      await repo.write('.cq/review', 'block the findings directory');
      const result = await makeReviewRun({
        drivers: scriptedDrivers(),
        effectsFactory: () => repoEffects(repo),
        scannerFactory: () => async (components) =>
          components.map((component) => ({ component: component.component, hits: [] })),
      })({
        repoRoot: repo.root,
      });
      expect(result.status).toBe('failed');
      if (result.status === 'failed') expect(result.error).toContain('prepare findings');
    } finally {
      await repo.cleanup();
    }
  });

  it('maps a findings record persistence failure to indeterminate', async () => {
    const repo = await makeTestRepo();
    try {
      await configureAgentRepo(repo);
      const result = await makeReviewRun({
        drivers: scriptedDrivers(),
        effectsFactory: () => repoEffects(repo),
        writeFindingsRecord: async () => {
          throw new Error('storage unavailable');
        },
        scannerFactory: () => async (components) =>
          components.map((component) => ({ component: component.component, hits: [] })),
      })({ repoRoot: repo.root });
      expect(result.status).toBe('indeterminate');
      if (result.status === 'indeterminate') expect(result.detail).toContain('storage unavailable');
    } finally {
      await repo.cleanup();
    }
  });

  it('records a failed agent response as a blocked source', async () => {
    const repo = await makeTestRepo();
    try {
      await configureAgentRepo(repo);
      const state = await seed(repo, (current) => [
        cycleRecord({
          cycleId: `c002-${current.head.slice(0, 8)}`,
          reviewer: 'agent:reviewer',
          base: current.base,
          head: current.head,
          dirtySha256: current.dirtySha256,
          target: 'main',
          at: '2026-10-24T00:00:00.000Z',
        }),
      ]);
      const drivers = {
        resolve: vi.fn(() => ({
          lane: 'ai-sdk',
          modelSpec: { provider: 'mock', model: 'mock' },
          driver: {
            run: async () => ({
              stopReason: 'complete' as const,
              structuredOutput: { unexpected: true },
              usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
              denials: [],
            }),
          },
        })),
      } as unknown as DriverFactory;
      const result = await makeReviewRun({
        drivers,
        effectsFactory: () => repoEffects(repo),
        scannerFactory: () => async (components) =>
          components.map((component) => ({ component: component.component, hits: [] })),
      })({ repoRoot: repo.root });
      expect(result.status).toBe('needs-human');
      if (result.status === 'needs-human') {
        expect(result.reason).toContain('not every configured reviewer completed');
        const folder = join(repo.root, '.cq', 'review', 'feature%2Fx');
        expect(await readdir(folder)).toContain('1.json');
      }
      const stored = JSON.parse(
        await readFile(join(repo.root, '.cq', 'review', 'feature%2Fx', '1.json'), 'utf8'),
      ) as {
        sources: { kind: string; status: string; reason?: string; cycleId?: string }[];
      };
      {
        const agent = stored.sources.find((source) => source.kind === 'agent');
        expect(agent?.status).toBe('blocked');
        expect(agent?.reason?.includes('invalid structured output')).toBe(true);
      }
      const ledger = repoEffects(repo).openLedger(state.branch).load();
      const latestAgent = ledger.records
        .filter((record) => record.kind === 'cycle' && record.reviewer === 'agent:reviewer')
        .at(-1);
      expect(latestAgent).toMatchObject({
        kind: 'cycle',
        completion: expect.objectContaining({
          kind: 'blocked',
          reason: expect.stringContaining(
            'agent review returned invalid structured output',
          ) as unknown,
        }) as unknown,
        base: state.base,
        head: state.head,
        dirtySha256: state.dirtySha256,
        target: 'main',
        scope: 'full',
      });
      if (!latestAgent || latestAgent.kind !== 'cycle') throw new Error('missing agent cycle');
      const readiness = assembleReadiness({
        branch: state.branch,
        target: 'main',
        identity: {
          base: state.base,
          head: state.head,
          dirtySha256: state.dirtySha256,
        },
        ledger: { version: DEV_LEDGER_VERSION, branch: state.branch, records: ledger.records },
        untracked: state.untracked,
        configuredReviewers: ['agent'],
        nowIso: '2026-10-24T00:00:00.000Z',
      });
      expect(readiness.ready).toBe(false);
      if (!readiness.ready)
        expect(
          readiness.gaps.find((gap) => gap.field === 'latest-review-blocked')?.detail,
        ).toContain(latestAgent.cycleId);
      expect(stored.sources.find((source) => source.kind === 'agent')?.cycleId).toBe(
        latestAgent.cycleId,
      );
    } finally {
      await repo.cleanup();
    }
  });

  it('chooses the next numeric findings record index and ignores other entries', async () => {
    const repo = await makeTestRepo();
    try {
      await configureAgentRepo(repo);
      const folder = join(repo.root, '.cq', 'review', 'feature%2Fx');
      await repo.write('.cq/review/feature%2Fx/3.json', '{}');
      await repo.write('.cq/review/feature%2Fx/notes.txt', 'not an index');
      const result = await makeReviewRun({
        drivers: scriptedDrivers(),
        effectsFactory: () => repoEffects(repo),
        scannerFactory: () => async (components) =>
          components.map((component) => ({ component: component.component, hits: [] })),
      })({ repoRoot: repo.root });
      expect(result.status).toBe('ok');
      expect(await readdir(folder)).toContain('4.json');
    } finally {
      await repo.cleanup();
    }
  });

  it('persists sequential findings for long branches without prefix collisions', async () => {
    const repo = await makeTestRepo();
    try {
      await configureAgentRepo(repo);
      expect(reviewBranchKey('feature/x')).toBe('feature%2Fx');
      for (const length of [178, 179]) {
        const key = reviewBranchKey('x'.repeat(length) + 'é' + 'y'.repeat(100));
        const prefix = key.slice(0, key.lastIndexOf('-'));
        expect(prefix).not.toMatch(/%[0-9A-F]?$/);
        expect(prefix).toBe('%_' + 'x'.repeat(length));
      }
      const prefix = 'long/' + 'é/'.repeat(80);
      const branches = [
        prefix + 'one',
        prefix + 'two',
        'a/'.repeat(80) + 'tail',
        'a/'.repeat(45) + '-462a0fe9a6d5689f',
      ];
      // The last ordinary branch previously aliased the shortened long key.
      expect(reviewBranchKey(branches[2]!)).not.toBe(reviewBranchKey(branches[3]!));
      expect(reviewBranchKey(branches[0]!)).not.toBe(reviewBranchKey(branches[1]!));
      for (const branch of branches) {
        repo.git('checkout', '-b', branch);
        const run = makeReviewRun({
          drivers: scriptedDrivers(),
          effectsFactory: () => repoEffects(repo),
          scannerFactory: () => async (components) =>
            components.map(({ component }) => ({ component, hits: [] })),
        });
        for (let index = 1; index <= 2; index++) {
          const result = await run({ repoRoot: repo.root });
          expect(result.status).toBe('ok');
          const path = join(repo.root, '.cq', 'review', reviewBranchKey(branch), `${index}.json`);
          expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ branch });
        }
      }
    } finally {
      await repo.cleanup();
    }
  });
});
