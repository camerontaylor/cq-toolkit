// C3a: runPlan reads the CQ_* environment once (or takes the entry point's
// snapshot) and refuses to dispatch when it carries errors.
import { describe, expect, test, vi } from 'vitest';
import { readCqEnv, type CqEnv } from '../../src/config/env.js';
import { currentCqEnv, currentEntryEnv } from '../../src/config/run-env.js';
import type { OpRegistryEntry } from '../../src/kernel/types.js';
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

  test('importer wiring carries the FROZEN entry record, not a mutable RunOptions.env', async () => {
    // The CLI hands `RunOptions.env` the entry capture; a host or a test can
    // hand a live record. Importers must receive the run's pinned copy, or an
    // op that captures `deps.env` (review.addressMany, fix.run) would track a
    // mid-run mutation while every other reader keeps entry-time values.
    const live: Record<string, string | undefined> = { PATH: '/entry/bin' };
    const seen: { frozen: boolean; path: string | undefined; context: string | undefined }[] = [];
    const probe = {
      ...entry('probe', okOp),
      importer: async (wiring?: {
        cqEnv?: CqEnv;
        env?: Readonly<Record<string, string | undefined>>;
      }) => {
        const wired = wiring?.env;
        return async (raw: never) => {
          // A hostile mutation of the record the host passed in, per dispatch.
          live['PATH'] = '/drifted/bin';
          seen.push({
            frozen: wired !== undefined && Object.isFrozen(wired),
            path: wired?.['PATH'],
            context: currentEntryEnv()['PATH'],
          });
          return okOp(raw);
        };
      },
    } as unknown as OpRegistryEntry<never, never>;
    await runPlan(
      independentPlan('plan-env-wiring', 2, 'probe'),
      { concurrency: 1, stopOnError: false, cqEnv: readCqEnv({}), env: live },
      viewWith(probe),
    );
    expect(seen).toHaveLength(2);
    // Job 2's importer runs AFTER job 1 mutated the live record.
    expect(seen.map((s) => s.path)).toEqual(['/entry/bin', '/entry/bin']);
    expect(seen.map((s) => s.context)).toEqual(['/entry/bin', '/entry/bin']);
    expect(seen.every((s) => s.frozen)).toBe(true);
  });
});
