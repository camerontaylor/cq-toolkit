import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { createGovernor, currentJobContext } from '../../../src/kernel/governor.js';
import { runPlan, type OpRegistryView } from '../../../src/kernel/runner.js';
import type { Op, OpRegistryEntry } from '../../../src/kernel/types.js';

describe('fix.run composition context', () => {
  test('a CLI-style direct invocation gives the inner worker plan its own governed job context', async () => {
    let seenJob: string | undefined;
    const worker: Op<unknown, unknown> = async () => {
      seenJob = currentJobContext()?.info.jobKey;
      return { status: 'ok', value: 'worker ran' };
    };
    const entry = {
      name: 'fixture.worker',
      inputSchema: z.object({}).strict(),
      importer: async () => worker,
    } as unknown as OpRegistryEntry<never, never>;
    const registry: OpRegistryView = { get: () => entry };
    expect(currentJobContext()).toBeUndefined();
    const report = await runPlan(
      { id: 'fix-run-context', jobs: [{ id: 'task', op: entry.name, input: {} }] },
      { concurrency: 1, stopOnError: false },
      registry,
      { governor: createGovernor({ maxTokens: 100 }), allowAdvisory: true },
    );
    expect(report.jobs[0]?.result).toEqual({ status: 'ok', value: 'worker ran' });
    expect(seenJob).toBe('task');
    expect(currentJobContext()).toBeUndefined();
  });
});
