// T1.2 slice 3 — tests for the I1 output contract helpers
// (src/kernel/output.ts).
//
// Pinned here:
//   1. emitReport writes pretty JSON + newline to STDOUT that parses back
//      deep-equal to the report (process.stdout.write spied, restored after).
//   2. narrate writes ONE `cq:`-prefixed line to STDERR and never stdout.
//   3. renderHuman defaults to failures-only (nx/turbo pattern) with a
//      summary line; { all: true } renders every row; ok rows render bare.
//   4. Non-ok rows carry their literal status text — failed / needs-human /
//      budget-exhausted / indeterminate — matching the taxonomy, and the
//      count mapping documented in runner.ts (rows keep true statuses).
//   5. Deterministic: the same report renders byte-identical text; no
//      colors, no timestamps.
import { afterEach, describe, expect, test, vi } from 'vitest';
import { emitReport, narrate, renderHuman } from '../../src/kernel/output.js';
import type { JobOutcome, RunReport } from '../../src/kernel/types.js';

function row(jobId: string, result: JobOutcome['result']): JobOutcome {
  return { jobId, op: `op-${jobId}`, result };
}

/** One report covering all five frozen taxonomy statuses. */
function sampleReport(): RunReport {
  return {
    runId: 'run-out',
    stoppedEarly: false,
    counts: {
      queued: 0,
      running: 0,
      blocked: 1, // j4 needs-human → blocked (runner count mapping)
      done: 1,
      failed: 2, // j2 failed + j5 indeterminate → failed
      'budget-exhausted': 1,
    },
    jobs: [
      row('j1', { status: 'ok', value: 1 }),
      row('j2', { status: 'failed', error: 'boom' }),
      row('j3', { status: 'budget-exhausted' }),
      row('j4', { status: 'needs-human', reason: 'credential missing' }),
      row('j5', { status: 'indeterminate', detail: 'worker lost' }),
    ],
  };
}

describe('emitReport (I1: stdout is JSON)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('writes pretty JSON + newline to stdout that parses back deep-equal', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const report = sampleReport();
    emitReport(report);
    expect(write).toHaveBeenCalledTimes(1);
    const out = write.mock.calls[0]?.[0] as string;
    expect(out.endsWith('\n')).toBe(true);
    expect(JSON.parse(out)).toEqual(report);
    expect(out).toContain('\n  '); // pretty-printed (indented), not one line
  });
});

describe('narrate (I1: narration is stderr-only)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('one `cq:`-prefixed line to stderr; stdout untouched', () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    narrate('resuming plan-wsa from journal');
    expect(err).toHaveBeenCalledTimes(1);
    expect(err.mock.calls[0]?.[0]).toBe('cq: resuming plan-wsa from journal\n');
    expect(out).not.toHaveBeenCalled();
  });
});

describe('renderHuman (default failures-only, deterministic)', () => {
  test('default shows ONLY non-ok rows plus a summary; ok rows absent', () => {
    const text = renderHuman(sampleReport());
    expect(text).not.toContain('j1 '); // the ok row never renders by default
    expect(text).toContain('j2 (op-j2): failed — boom');
    expect(text).toContain('j3 (op-j3): budget-exhausted — budget bound hit');
    expect(text).toContain('j4 (op-j4): needs-human — credential missing');
    expect(text).toContain('j5 (op-j5): indeterminate — worker lost');
    expect(text).toContain('done 1, failed 2, blocked 1, queued 0, running 0, budget-exhausted 1');
  });

  test('default output is one line per non-ok row plus exactly one summary line', () => {
    const lines = renderHuman(sampleReport()).split('\n');
    expect(lines).toHaveLength(5); // 4 non-ok rows + summary
    expect(lines[4]).toMatch(/^done /);
  });

  test('all:true renders every row; ok rows are bare (no detail slot)', () => {
    const all = renderHuman(sampleReport(), { all: true });
    expect(all).toContain('j1 (op-j1): ok');
    for (const fragment of [
      'failed — boom',
      'budget-exhausted — budget bound hit',
      'needs-human — credential missing',
      'indeterminate — worker lost',
    ]) {
      expect(all).toContain(fragment);
    }
    expect(all).not.toContain('ok —'); // ok rows carry no detail
    expect(all.split('\n')).toHaveLength(6); // 5 rows + summary
  });

  test('deterministic: the same report renders byte-identical text twice', () => {
    const report = sampleReport();
    expect(renderHuman(report)).toBe(renderHuman(report));
    expect(renderHuman(report, { all: true })).toBe(renderHuman(report, { all: true }));
    expect(renderHuman(report)).not.toContain('run-out'); // ids/timestamps never leak into the view
  });

  test('an all-ok report renders just the summary line', () => {
    const report: RunReport = {
      runId: 'run-clean',
      stoppedEarly: false,
      counts: {
        queued: 0,
        running: 0,
        blocked: 0,
        done: 2,
        failed: 0,
        'budget-exhausted': 0,
      },
      jobs: [row('a', { status: 'ok', value: null }), row('b', { status: 'ok', value: null })],
    };
    expect(renderHuman(report)).toBe(
      'done 2, failed 0, blocked 0, queued 0, running 0, budget-exhausted 0',
    );
  });
});
