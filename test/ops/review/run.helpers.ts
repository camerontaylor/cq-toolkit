import { vi } from 'vitest';
import type { DriverFactory } from '../../../src/driver/factory.js';
import type { makeTestRepo } from '../dev/repo.js';

export async function configureAgentRepo(
  repo: Awaited<ReturnType<typeof makeTestRepo>>,
): Promise<void> {
  await repo.write('package.json', JSON.stringify({ name: 'fixture-review' }));
  await repo.write(
    'cq.json',
    JSON.stringify({
      schemaVersion: 2,
      checks: [{ adapter: 'tsc-lines', command: { command: 'tsc', args: [] } }],
      roles: { reviewer: { provider: 'mock', model: 'mock' } },
      budgets: { run: { maxTokens: 500 } },
      review: { reviewers: ['agent'] },
    }),
  );
  repo.commitAll('fixture agent review setup');
}

export function scriptedDrivers(
  onRun?: (input: { prompt: string }) => void,
  toolFailures = 0,
  findings?: () => unknown[],
  stopReason?: () => 'complete' | 'error',
) {
  return {
    resolve: vi.fn(
      (request: {
        beforeRequest?: (
          text: string,
          contents?: readonly { text: string }[],
          context?: { kind: 'model-request' | 'tool-output' },
        ) => void | Promise<void>;
      }) => ({
        lane: 'ai-sdk',
        modelSpec: { provider: 'mock', model: 'mock' },
        driver: {
          run: async (input: { prompt: string }) => {
            onRun?.(input);
            // The engine records delivery from the real serialized ai-sdk
            // request shape, not from the model's output.
            await request.beforeRequest?.(
              JSON.stringify({ prompt: [{ role: 'user', content: input.prompt }] }),
              [{ text: input.prompt }],
              { kind: 'model-request' },
            );
            return {
              stopReason: stopReason?.() ?? ('complete' as const),
              error: 'provider quota refused',
              errorClass: 'quota' as const,
              structuredOutput: {
                findings: findings?.() ?? [{ severity: 'high', text: 'seeded' }],
              },
              usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0 },
              // Seam v3: this scripted driver models a provider MEASUREMENT, so
              // the fixture must declare it; absence would count as unknown.
              usageProvenance: 'measured',
              denials: [],
              toolFailures,
            };
          },
        },
      }),
    ),
  } as unknown as DriverFactory;
}
