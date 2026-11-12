import { managedBlocked, managedTerminal } from '../dev/reviewTestKit.js';
import { expect, it } from 'vitest';
import { makeReviewAddress } from '../../../src/ops/review/address.js';
import { createEscalationState } from '../../../src/ops/fix/escalation.js';
import { makeReviewRun } from '../../../src/ops/review/run.js';
import { repoEffects, makeTestRepo } from '../dev/repo.js';
import { configureAgentRepo, scriptedDrivers } from './run.helpers.js';

it.each(['deadline', 'parent'] as const)(
  'remaining review budget stops CodeRabbit and later providers: %s',
  async (mode) => {
    const repo = await makeTestRepo();
    let clock = Date.now();
    const originalNow = Date.now;
    try {
      await configureAgentRepo(repo);
      const controller = new AbortController();
      const effects = repoEffects(repo);
      const drivers = scriptedDrivers();
      let persisted: unknown;
      Date.now = () => clock;
      const result = await makeReviewRun({
        managedSubmit: async (input) => {
          expect(input.remainingWallMs?.()).toBe(10_000);
          expect(input.signal).toBeDefined();
          if (mode === 'deadline') clock += 10_001;
          else controller.abort(new Error('parent stopped reviewer'));
          return managedTerminal([
            { severity: 'major', fileName: 'src/a.ts', excerpt: 'partial finding' },
          ])(input);
        },
        drivers,
        parentSignal: controller.signal,
        effectsFactory: () => effects,
        scannerFactory: () => async (components) =>
          components.map((component) => ({ component: component.component, hits: [] })),
        writeFindingsRecord: async (_path, content) => {
          persisted = JSON.parse(content);
        },
      })({ repoRoot: repo.root, wallMs: 10_000, reviewers: ['coderabbit', 'agent'] });
      expect(result.status).toBe('needs-human');
      if (mode === 'deadline') expect(result).toMatchObject({ report: { blockedBudget: true } });
      else expect(result).not.toMatchObject({ report: { blockedBudget: true } });
      expect(drivers.resolve).not.toHaveBeenCalled();
      expect(persisted).toMatchObject({
        findings: [expect.objectContaining({ text: 'partial finding', status: 'open' })],
      });
      const cycles = effects
        .openLedger('feature/x')
        .load()
        .records.filter((entry) => entry.kind === 'cycle');
      expect(cycles).toHaveLength(1);
      expect(cycles[0]?.completion).toMatchObject({ kind: 'blocked' });
      expect(cycles[0]?.findings).toHaveLength(1);
    } finally {
      Date.now = originalNow;
      await repo.cleanup();
    }
  },
);

it('shares the review deadline signal with intent and numstat reads', async () => {
  const repo = await makeTestRepo();
  try {
    await configureAgentRepo(repo);
    const controller = new AbortController();
    const inner = repoEffects(repo);
    const contextCalls: {
      args: readonly string[];
      timeoutMs: number;
      signal?: AbortSignal;
    }[] = [];
    const effects = {
      ...inner,
      runCommand: async (
        command: string,
        args: readonly string[],
        options: { timeoutMs: number; cwd?: string; signal?: AbortSignal },
      ) => {
        if (
          command === 'git' &&
          (args[0] === 'log' || (args[0] === 'diff' && args.includes('--numstat')))
        ) {
          contextCalls.push({
            args: [...args],
            timeoutMs: options.timeoutMs,
            ...(options.signal ? { signal: options.signal } : {}),
          });
          const result = await inner.runCommand(command, args, options);
          if (args[0] === 'diff') controller.abort(new Error('fixture cancel after numstat'));
          return result;
        }
        return inner.runCommand(command, args, options);
      },
    };
    const drivers = scriptedDrivers();
    const result = await makeReviewRun({
      drivers,
      parentSignal: controller.signal,
      effectsFactory: () => effects,
      scannerFactory: () => async (components) =>
        components.map((component) => ({ component: component.component, hits: [] })),
    })({ repoRoot: repo.root });
    expect(contextCalls.map((call) => call.args[0])).toEqual(['log', 'diff']);
    expect(contextCalls[0]?.signal).toBeDefined();
    expect(contextCalls[0]?.signal).toBe(contextCalls[1]?.signal);
    expect(contextCalls[1]?.signal?.aborted).toBe(true);
    expect(contextCalls.every((call) => call.timeoutMs > 0)).toBe(true);
    expect(drivers.resolve).not.toHaveBeenCalled();
    expect(result.status).toBe('failed');
  } finally {
    await repo.cleanup();
  }
});

it.each([
  ['error', { type: 'error', message: 'auth_required' }, 'error event'],
  ['action', { type: 'action_required', status: 'awaiting_confirmation' }, 'requested action'],
  ['skipped', { type: 'complete', status: 'review_skipped' }, 'review_skipped'],
  [
    'no-fresh',
    {
      type: 'complete',
      status: 'review_completed',
      message: 'No fresh detailed file review was performed in this run.',
    },
    'no-fresh/skipped notice',
  ],
  ['clean', { type: 'heartbeat', status: 'reviewing' }, 'wall budget exhausted'],
] as const)(
  '#532: queued %s verdict at deadline preserves refusal through review.run and address',
  async (mode, _event, reason) => {
    const repo = await makeTestRepo();
    const originalNow = Date.now;
    let clock = originalNow();
    try {
      await configureAgentRepo(repo);
      Date.now = () => clock;
      const result = await makeReviewRun({
        drivers: scriptedDrivers(),
        effectsFactory: () => repoEffects(repo),
        managedSubmit: async (input) => {
          clock += 1001;
          return (mode === 'clean' ? managedTerminal([]) : managedBlocked(reason))(input);
        },
        scannerFactory: () => async (components) =>
          components.map((component) => ({ component: component.component, hits: [] })),
      })({ repoRoot: repo.root, wallMs: 1000, reviewers: ['coderabbit'] });
      expect(result.status).toBe('needs-human');
      if (mode === 'clean') expect(result).toMatchObject({ report: { blockedBudget: true } });
      else expect(result).not.toMatchObject({ report: { blockedBudget: true } });
      expect(result.report?.sources[0]).toMatchObject({
        status: 'blocked',
        reason: expect.stringContaining(reason) as unknown,
      });
      const head = repo.git('rev-parse', 'HEAD').trim();
      const role = { provider: 'mock', model: 'mock' };
      const addressed = await makeReviewAddress({
        config: {
          schemaVersion: 2,
          roles: { worker: role, reviewer: role },
          budgets: { run: { maxTokens: 1000 } },
          checks: [{ adapter: 'tsc-lines', command: { command: process.execPath, args: [] } }],
          review: { reviewers: ['agent'] },
        },
        initialRecord: {
          schemaVersion: 1,
          branch: 'feature/x',
          head,
          reviewed: {
            base: repo.git('merge-base', 'origin/main', 'HEAD').trim(),
            scope: 'full',
          },
          sources: [{ kind: 'agent', status: 'terminal' }],
          findings: [
            { id: 'f1', source: 'agent', severity: 'major', text: 'fix this', status: 'open' },
          ],
        },
        disposition: async () => ({ status: 'ok', value: {} }),
        workerFactory: () => ({
          escalation: createEscalationState,
          fix: async (item) => ({
            finding: { ...item, status: 'fixed', reason: 'verified' },
            commit: head,
            observedHead: head,
            reason: 'verified',
            validation: [],
          }),
        }),
        review: async () => {
          clock += 1001;
          return result;
        },
      })({
        repoRoot: repo.root,
        source: 'local',
        wallMs: 1000,
        journalDir: `${repo.root}/.cq/test-journal`,
      });
      expect(addressed.status).toBe('needs-human');
      expect(addressed.report?.fixesPerRun).toBe(1);
      expect(addressed.report?.stop).toBe(mode === 'clean' ? 'budget' : undefined);
    } finally {
      Date.now = originalNow;
      await repo.cleanup();
    }
  },
);

it.each(['auth', 'mixed', 'coverage', 'drift', 'scan', 'thrown'] as const)(
  '#532: coincident deadline never attributes %s failure to the budget',
  async (mode) => {
    const repo = await makeTestRepo();
    const originalNow = Date.now;
    let clock = originalNow();
    try {
      await configureAgentRepo(repo);
      Date.now = () => clock;
      const result = await makeReviewRun({
        // 'thrown' faults the driver under the real reviewer seam (never a raw
        // throw past the engine): a coincident deadline must not reclassify an
        // unexpected fault as a budget stop.
        drivers: scriptedDrivers(() => {
          if (mode === 'thrown') {
            clock += 1001;
            throw new Error('unexpected reviewer fault');
          }
        }),
        effectsFactory: () => repoEffects(repo),
        managedSubmit: async (input) => {
          if (mode === 'auth') clock += 1001;
          return managedBlocked('Review failed: auth_required')(input);
        },
        scannerFactory: () => async (components) => {
          if (mode === 'scan') {
            clock += 1001;
            throw new Error('scan refused');
          }
          return components.map((component) => ({ component: component.component, hits: [] }));
        },
        // No injected reviewer for 'thrown', so the real seam runs. No .catch
        // fallback either: the engine must refuse with a structured result,
        // and a thrown engine error fails the test instead of being laundered
        // into a report-less needs-human object that satisfies both
        // assertions vacuously.
        ...(mode === 'thrown'
          ? {}
          : {
              runAgentReviewer: async () => {
                clock += 1001;
                if (mode === 'drift') repo.git('commit', '--allow-empty', '-m', 'drift');
                return mode === 'coverage'
                  ? { status: 'needs-human' as const, reason: 'coverage incomplete' }
                  : { status: 'budget-exhausted' as const };
              },
            }),
      })({
        repoRoot: repo.root,
        wallMs: 1000,
        reviewers: mode === 'auth' || mode === 'mixed' ? ['coderabbit', 'agent'] : ['agent'],
      });
      expect(result.status).toBe('needs-human');
      expect(result).not.toMatchObject({ report: { blockedBudget: true } });
    } finally {
      Date.now = originalNow;
      await repo.cleanup();
    }
  },
);

it('#532: an agent wall stop is attributed through the real review engine', async () => {
  const repo = await makeTestRepo();
  const originalNow = Date.now;
  let clock = originalNow();
  try {
    await configureAgentRepo(repo);
    Date.now = () => clock;
    const result = await makeReviewRun({
      drivers: scriptedDrivers(() => {
        clock += 10001;
      }),
      effectsFactory: () => repoEffects(repo),
      scannerFactory: () => async (components) =>
        components.map((component) => ({ component: component.component, hits: [] })),
    })({ repoRoot: repo.root, wallMs: 10000 });
    expect(result.status).toBe('needs-human');
    expect(result).toMatchObject({ report: { blockedBudget: true } });
  } finally {
    Date.now = originalNow;
    await repo.cleanup();
  }
});
