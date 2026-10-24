import { describe, expect, it, vi } from 'vitest';
import type { DriverFactory } from '../../../src/driver/factory.js';
import { runAgentReviewer } from '../../../src/ops/review/agentReviewer.js';

describe('runAgentReviewer', () => {
  it('uses a read-only structured invocation and applies cq.json severity mapping', async () => {
    const run = vi.fn(
      async (invocation: {
        toolPolicy: { mode?: string };
        sandboxPolicy: { level: string };
        outputSchema?: unknown;
      }) => {
        expect(invocation.toolPolicy).toEqual({ mode: 'none', allow: [] });
        expect(invocation.sandboxPolicy.level).toBe('read-only');
        expect(invocation.outputSchema).toBeDefined();
        return {
          stopReason: 'complete' as const,
          structuredOutput: {
            findings: [
              { file: 'src/a.ts', line: 2, rule: 'bug', severity: 'high', text: 'Evidence' },
            ],
          },
          usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0 },
          denials: [],
        };
      },
    );
    const drivers = {
      resolve: vi.fn(() => ({
        driver: { run },
        lane: 'ai-sdk',
        modelSpec: { provider: 'mock', model: 'mock' },
      })),
    } as unknown as DriverFactory;
    const result = await runAgentReviewer(drivers, {
      repoRoot: '/fixture',
      branch: 'review-fixture',
      head: 'abc123',
      diff: 'diff',
      role: { provider: 'mock', model: 'mock' },
      maxTokens: 500,
      severityMap: { high: 'major', medium: 'minor' },
    });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') expect(result.value.findings[0]?.severity).toBe('major');
  });

  it('maps a reviewer dispatch error to needs-human', async () => {
    const drivers = {
      resolve: vi.fn(() => {
        throw new Error('no reviewer role');
      }),
    } as unknown as DriverFactory;
    const result = await runAgentReviewer(drivers, {
      repoRoot: '/fixture',
      branch: 'review-fixture',
      head: 'abc123',
      diff: '',
      role: { provider: 'mock', model: 'mock' },
      maxTokens: 500,
      severityMap: { high: 'major', medium: 'minor' },
    });
    expect(result).toEqual({
      status: 'needs-human',
      reason: 'agent review could not dispatch: no reviewer role',
    });
  });

  it('maps driver rejection to needs-human', async () => {
    const drivers = {
      resolve: vi.fn(() => ({
        driver: {
          run: vi.fn(async () => {
            throw new Error('provider unavailable');
          }),
        },
        lane: 'ai-sdk',
        modelSpec: { provider: 'mock', model: 'mock' },
      })),
    } as unknown as DriverFactory;
    const result = await runAgentReviewer(drivers, {
      repoRoot: '/fixture',
      branch: 'review-fixture',
      head: 'abc123',
      diff: '',
      role: { provider: 'mock', model: 'mock' },
      maxTokens: 500,
      severityMap: { high: 'major', medium: 'minor' },
    });
    expect(result).toEqual({
      status: 'needs-human',
      reason: 'agent review did not run: provider unavailable',
    });
  });

  it.each([
    ['budget', 'budget-exhausted'],
    ['aborted', 'needs-human'],
    ['error', 'needs-human'],
  ] as const)('maps stop reason %s', async (stopReason, expected) => {
    const drivers = {
      resolve: vi.fn(() => ({
        driver: {
          run: vi.fn(async () => ({
            stopReason,
            structuredOutput: {},
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            denials: [],
          })),
        },
        lane: 'ai-sdk',
        modelSpec: { provider: 'mock', model: 'mock' },
      })),
    } as unknown as DriverFactory;
    const result = await runAgentReviewer(drivers, {
      repoRoot: '/fixture',
      branch: 'review-fixture',
      head: 'abc123',
      diff: '',
      role: { provider: 'mock', model: 'mock' },
      maxTokens: 500,
      severityMap: { high: 'major', medium: 'minor' },
    });
    expect(result.status).toBe(expected);
  });

  it('rejects invalid structured output', async () => {
    const drivers = {
      resolve: vi.fn(() => ({
        driver: {
          run: vi.fn(async () => ({
            stopReason: 'complete',
            structuredOutput: { unexpected: true },
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            denials: [],
          })),
        },
        lane: 'ai-sdk',
        modelSpec: { provider: 'mock', model: 'mock' },
      })),
    } as unknown as DriverFactory;
    const result = await runAgentReviewer(drivers, {
      repoRoot: '/fixture',
      branch: 'review-fixture',
      head: 'abc123',
      diff: '',
      role: { provider: 'mock', model: 'mock' },
      maxTokens: 500,
      severityMap: { high: 'major', medium: 'minor' },
    });
    expect(result).toEqual({
      status: 'failed',
      error: 'agent review returned invalid structured output',
    });
  });
});
