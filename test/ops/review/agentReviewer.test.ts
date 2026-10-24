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
});
