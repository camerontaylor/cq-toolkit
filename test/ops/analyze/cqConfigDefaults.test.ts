import { describe, expect, test } from 'vitest';
import type { CqConfig } from '../../../src/ops/analyze/cqConfig.js';
import {
  requireAgenticTokenBudget,
  resolveCqConfigDefaults,
} from '../../../src/ops/analyze/cqConfigDefaults.js';

const minimal: CqConfig = {
  schemaVersion: 2,
  checks: [
    { adapter: 'tsc-lines', command: { command: 'compiler', args: [] } },
    { adapter: 'eslint-json', command: { command: 'linter', args: [] } },
    { adapter: 'vitest-json', command: { command: 'tests', args: [] } },
  ],
};
const flags = { packageName: '@fixture/core' };

describe('cq.json effective policy', () => {
  test('spec numeric defaults, adapter kinds and package metadata resolve without selecting models', () => {
    const effective = resolveCqConfigDefaults(minimal, flags);
    expect(effective.packages).toEqual([{ name: '@fixture/core', path: '.' }]);
    expect(effective.checks.map(({ kind }) => kind)).toEqual(['static', 'static', 'tests']);
    expect(effective.roles).toEqual({});
    expect(effective.budgets).toEqual({
      run: { wallMs: 1_200_000 },
      unit: { wallMs: 3_600_000 },
      step: { wallMs: 1_200_000 },
    });
    expect(effective.review).toEqual({
      rounds: 3,
      blockingSeverities: ['critical', 'major'],
      agentSeverityMap: { high: 'major', medium: 'minor' },
      reviewers: ['coderabbit', 'agent'],
      addressConcurrency: 2,
      bulk: { concurrency: 3 },
    });
    expect(effective.escalation).toEqual({
      workerAttempts: 2,
      rescueBase: 20,
      rescuePerFixed: 10,
      rescuePerPackageCap: 10,
    });
  });

  test('flags override individual fields while preserving configured siblings', () => {
    const config: CqConfig = {
      ...minimal,
      packages: [{ name: 'custom', path: 'pkg' }],
      roles: { worker: { provider: 'fixture', model: 'fixture' } },
      budgets: { run: { maxTokens: 10, wallMs: 20 }, unit: { wallMs: 30 } },
      review: {
        rounds: 5,
        blockingSeverities: ['major'],
        agentSeverityMap: { high: 'critical', low: 'info' },
        denylistPatternsFile: 'patterns.yml',
        bulk: { query: 'is:open', concurrency: 6 },
      },
      escalation: { workerAttempts: 4, rescueBase: 0, rescuePerPackageCap: 0 },
    };
    const before = structuredClone(config);
    const effective = resolveCqConfigDefaults(config, {
      ...flags,
      maxTokens: 100,
      budgets: { run: { wallMs: 200 } },
      review: { agentSeverityMap: { medium: 'trivial' }, bulk: { concurrency: 8 } },
      escalation: { rescuePerFixed: 15 },
    });
    expect(effective.packages).toEqual(config.packages);
    expect(effective.roles.worker).toEqual(config.roles?.worker);
    expect(effective.budgets).toEqual({
      run: { maxTokens: 100, wallMs: 200 },
      unit: { wallMs: 30 },
      step: { wallMs: 1_200_000 },
    });
    expect(effective.review).toEqual({
      rounds: 5,
      blockingSeverities: ['major'],
      agentSeverityMap: { high: 'critical', medium: 'trivial', low: 'info' },
      reviewers: ['coderabbit', 'agent'],
      addressConcurrency: 2,
      denylistPatternsFile: 'patterns.yml',
      bulk: { query: 'is:open', concurrency: 8 },
    });
    expect(effective.escalation).toEqual({
      workerAttempts: 4,
      rescueBase: 0,
      rescuePerFixed: 15,
      rescuePerPackageCap: 0,
    });
    expect(config).toEqual(before);
  });

  test('explicit kinds and related args survive resolution', () => {
    const config: CqConfig = {
      ...minimal,
      checks: [{ ...minimal.checks[0]!, kind: 'tests', relatedArgs: ['{files}'] }],
    };
    expect(resolveCqConfigDefaults(config, flags).checks[0]).toMatchObject({
      kind: 'tests',
      relatedArgs: ['{files}'],
    });
  });

  test('an agentic run without maxTokens returns needs-human naming the key', () => {
    const effective = resolveCqConfigDefaults(minimal, flags);
    const stop = requireAgenticTokenBudget(effective);
    expect(stop?.status).toBe('needs-human');
    expect(stop?.reason).toContain('budgets.run.maxTokens');
    expect(requireAgenticTokenBudget(effective, false)).toBeUndefined();
    expect(
      requireAgenticTokenBudget(
        resolveCqConfigDefaults(minimal, { ...flags, budgets: { run: { maxTokens: 1 } } }),
      ),
    ).toBeUndefined();
    expect(
      requireAgenticTokenBudget(
        resolveCqConfigDefaults({ ...minimal, budgets: { run: { maxTokens: 2 } } }, flags),
      ),
    ).toBeUndefined();
  });
});
