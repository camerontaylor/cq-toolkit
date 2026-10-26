import { describe, expect, it, vi } from 'vitest';
import type { DriverFactory } from '../../../src/driver/factory.js';
import { makeAgentReviewRunner, readPackageName } from '../../../src/ops/dev/agentReview.js';
import type { DiffSecretScanner } from '../../../src/ops/dev/denylist.js';

const scanSecrets: DiffSecretScanner = async (components) =>
  components.map(({ component }) => ({ component, hits: [] }));
const drivers = { resolve: vi.fn() } as unknown as DriverFactory;
const reviewInput = {
  repoRoot: '/repo',
  head: 'a'.repeat(40),
  branch: 'feature',
  diff: '',
  components: [],
  base: 'b'.repeat(40),
  scope: 'full' as const,
};

function config(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 2,
    checks: [{ adapter: 'tsc-lines', command: { command: 'tsc', args: [] } }],
    roles: { reviewer: { provider: 'mock', model: 'mock' } },
    budgets: { run: { maxTokens: 5000, wallMs: 20000 } },
    ...overrides,
  });
}

function runner(files: Record<string, string>) {
  const run = vi.fn(async () => ({ status: 'ok' as const, value: { findings: [] } }));
  const review = makeAgentReviewRunner({
    repoRoot: '/repo',
    readFile: async (path) => {
      const text = files[path];
      if (text === undefined) throw new Error('ENOENT');
      return text;
    },
    drivers,
    scanSecrets,
    run: run as never,
  });
  return { review, run };
}

describe('readPackageName', () => {
  it('reads the package name and falls back for missing, malformed or nameless files', async () => {
    const read = (text?: string) => async () => {
      if (text === undefined) throw new Error('ENOENT');
      return text;
    };
    expect(await readPackageName(read('{"name":"@scope/pkg"}'), '/repo')).toBe('@scope/pkg');
    expect(await readPackageName(read(), '/repo')).toBe('repository');
    expect(await readPackageName(read('not json'), '/repo')).toBe('repository');
    expect(await readPackageName(read('{"name":7}'), '/repo')).toBe('repository');
    expect(await readPackageName(read('null'), '/repo')).toBe('repository');
  });
});

describe('makeAgentReviewRunner', () => {
  it('refuses a role other than reviewer', async () => {
    const { review, run } = runner({});
    expect(await review({ ...reviewInput, role: 'worker' })).toEqual({
      status: 'needs-human',
      reason: "unsupported configured reviewer role 'worker'",
    });
    expect(run).not.toHaveBeenCalled();
  });

  it('requires cq.json and a parseable config', async () => {
    const missing = await runner({}).review({ ...reviewInput, role: 'reviewer' });
    expect(missing).toEqual({ status: 'needs-human', reason: 'agent reviewer requires cq.json' });
    const bad = await runner({ '/repo/cq.json': '{"schemaVersion":99}' }).review({
      ...reviewInput,
      role: 'reviewer',
    });
    expect(bad).toMatchObject({ status: 'needs-human' });
    expect((bad as { reason: string }).reason).toMatch(/^agent reviewer config: /);
  });

  it('requires a reviewer role and a token budget', async () => {
    const noRole = await runner({ '/repo/cq.json': config({ roles: {} }) }).review({
      ...reviewInput,
      role: 'reviewer',
    });
    expect(noRole).toEqual({
      status: 'needs-human',
      reason: 'cq.json roles.reviewer is required for an agent review',
    });
    const noBudget = await runner({ '/repo/cq.json': config({ budgets: {} }) }).review({
      ...reviewInput,
      role: 'reviewer',
    });
    expect(noBudget).toMatchObject({ status: 'needs-human' });
  });

  it('runs the session reviewer with the configured role, budget and scanner', async () => {
    const { review, run } = runner({ '/repo/cq.json': config() });
    const outcome = await review({ ...reviewInput, role: 'reviewer' });
    expect(outcome.status).toBe('ok');
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]).toMatchObject([
      drivers,
      {
        role: { provider: 'mock', model: 'mock' },
        maxTokens: 5000,
        scanSecrets,
        head: 'a'.repeat(40),
      },
    ]);
  });
});
