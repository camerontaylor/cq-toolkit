// C3a: runPlan reads the CQ_* environment once (or takes the entry point's
// snapshot) and refuses to dispatch when it carries errors.
import { describe, expect, test } from 'vitest';
import { readCqEnv } from '../../src/config/env.js';
import { CqEnvError } from '../../src/config/entry.js';
import {
  countingOp,
  entry,
  independentPlan,
  runPlan,
  viewWith,
} from './runner-governed.helpers.js';

describe('runPlan CQ_* environment', () => {
  test('a snapshot with errors throws one error listing all of them, before any job', async () => {
    const calls: string[] = [];
    const cqEnv = readCqEnv({ CQ_SANDBOX: 'of', CQ_RUN_TOOL: 'maybe' });
    expect(cqEnv.errors).toHaveLength(2);
    const failure = await runPlan(
      independentPlan('plan-cqenv-errors', 2),
      { concurrency: 1, stopOnError: false, cqEnv },
      viewWith(entry('fake', countingOp(calls))),
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CqEnvError);
    const message = (failure as Error).message;
    expect(message).toContain('CQ_SANDBOX');
    expect(message).toContain('CQ_RUN_TOOL');
    expect(calls).toEqual([]);
  });

  test('a valid snapshot with warnings still runs; runPlan prints nothing', async () => {
    const calls: string[] = [];
    const cqEnv = readCqEnv({ CQ_SANBOX: 'off' });
    expect(cqEnv.warnings).toHaveLength(1);
    const report = await runPlan(
      independentPlan('plan-cqenv-warn', 2),
      { concurrency: 1, stopOnError: false, cqEnv },
      viewWith(entry('fake', countingOp(calls))),
    );
    expect(report.counts.done).toBe(2);
    expect(calls).toHaveLength(2);
  });
});
