// Exit-code unit mapping (mechanical, no interpretation) — split from test/cli/i1.test.ts (pure move). Suite header: op-subcommands.test.ts; helpers: ./i1-helpers.ts.
import { describe, expect, test } from 'vitest';
import { exitCodeForOpResult, exitCodeForRunReport } from '../../src/cli/exit.js';
import type { OpResult, RunReport } from '../../src/kernel/types.js';
import { reportWith } from './i1-helpers.js';

describe('exit-code unit mapping (mechanical, no interpretation)', () => {
  test('exitCodeForOpResult over all five frozen statuses', () => {
    const cases: Array<[OpResult<unknown>, 0 | 1 | 3]> = [
      [{ status: 'ok', value: null }, 0],
      [{ status: 'failed', error: 'x' }, 1],
      [{ status: 'indeterminate', detail: 'x' }, 1],
      [{ status: 'needs-human', reason: 'x' }, 3],
      [{ status: 'budget-exhausted' }, 3],
    ];
    for (const [result, expected] of cases) {
      expect(exitCodeForOpResult(result)).toBe(expected);
    }
  });

  test('exitCodeForRunReport: all-ok → 0; failed-only → 1', () => {
    expect(
      exitCodeForRunReport(reportWith({ status: 'ok', value: 1 }, { status: 'ok', value: 2 })),
    ).toBe(0);
    expect(exitCodeForRunReport(reportWith({ status: 'failed', error: 'x' }))).toBe(1);
  });

  test('exitCodeForRunReport: needs-human dominates failed (→ 3)', () => {
    const mixed = reportWith(
      { status: 'failed', error: 'x' },
      { status: 'needs-human', reason: 'y' },
    );
    expect(exitCodeForRunReport(mixed)).toBe(3);
    // …and dominates an UNKNOWN status too — the thrown-class default branch
    // (defense against a taxonomy the CLI predates) never outranks row 3.
    const unknownMixed = reportWith({ status: 'nope' } as unknown as OpResult<unknown>, {
      status: 'needs-human',
      reason: 'y',
    });
    expect(exitCodeForRunReport(unknownMixed)).toBe(3);
  });

  test('unknown-status defaults: junk never maps as ok (thrown-class → 1)', () => {
    // exitCodeForOpResult's default branch: an out-of-taxonomy status maps
    // like a throw (1), never silently as ok (cast — unreachable for the
    // frozen union, which is exactly why the defense exists).
    expect(exitCodeForOpResult({ status: 'nope' } as unknown as OpResult<unknown>)).toBe(1);
    // exitCodeForRunReport's unknown-status row → 1 as well.
    expect(
      exitCodeForRunReport(reportWith({ status: 'nope' } as unknown as OpResult<unknown>)),
    ).toBe(1);
  });

  test('exitCodeForRunReport: honest budget stop with no such rows → 3', () => {
    const stopped: RunReport = {
      ...reportWith({ status: 'ok', value: null }),
      stoppedEarly: true,
      earlyStopReason: 'budget',
    };
    expect(exitCodeForRunReport(stopped)).toBe(3);
  });
});
