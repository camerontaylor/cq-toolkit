// C3a: runPlan reads the CQ_* environment once (or takes the entry point's
// snapshot) and refuses to dispatch when it carries errors.
import { describe, expect, test, vi } from 'vitest';
import { readCqEnv, type CqEnv } from '../../src/config/env.js';
import { currentCqEnv } from '../../src/config/run-env.js';
import { okOp } from './runner-governed.helpers.js';
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

  test('ops see the run snapshot; a nested runPlan reuses it instead of re-reading ambient', async () => {
    const outer = readCqEnv({ CQ_SANDBOX: 'off' });
    const seen: { where: string; env: CqEnv }[] = [];
    const innerView = viewWith(
      entry('inner', async (raw) => {
        seen.push({ where: 'inner', env: currentCqEnv() });
        return okOp(raw);
      }),
    );
    const outerView = viewWith(
      entry('outer', async (raw) => {
        seen.push({ where: 'outer', env: currentCqEnv() });
        // No cqEnv passed: the nested run must inherit the enclosing snapshot.
        await runPlan(
          independentPlan('plan-cqenv-nested', 1, 'inner'),
          { concurrency: 1, stopOnError: false },
          innerView,
        );
        return okOp(raw);
      }),
    );
    vi.stubEnv('CQ_SANDBOX', 'required');
    try {
      await runPlan(
        independentPlan('plan-cqenv-outer', 1, 'outer'),
        { concurrency: 1, stopOnError: false, cqEnv: outer },
        outerView,
      );
    } finally {
      vi.unstubAllEnvs();
    }
    expect(seen.map((s) => s.where)).toEqual(['outer', 'inner']);
    expect(seen.every((s) => s.env.values['CQ_SANDBOX'] === 'off')).toBe(true);
    expect(seen[0]?.env).toBe(outer);
  });
});
