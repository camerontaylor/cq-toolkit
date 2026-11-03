// Split provenance: test/ops/review/agentReviewer.test.ts was split into the
// agentReviewer.*.test.ts siblings in this directory; this file keeps the M5b2
// correlation-forwarding tests.
import { describe, expect, it } from 'vitest';
import { runLadder } from '../../../src/kernel/governor.js';
import { runAgentReviewer } from '../../../src/ops/review/agentReviewer.js';
import { fakeDrivers, reviewerInput } from './agentReviewer.helpers.js';

// M5b2 — forward governed invocation correlation: every OpInvocation the
// reviewer dispatches carries the runner's governed correlation verbatim
// when one exists, and stays correlation-free when none does. Run/work/
// parent identity never silently inherits the outer job's; no new role is
// invented here (the helper's absent-role default is the preserved one).
describe('runAgentReviewer correlation forwarding (M5b2)', () => {
  it('M5b2 nominal evidence', async () => {
    const fake = fakeDrivers({ skipHook: true });
    const correlation = { workId: 'w-m5b2', role: 'critic', runId: 'r-m5b2' } as const;
    const result = await runLadder(
      () => runAgentReviewer(fake.drivers, reviewerInput()),
      {},
      { op: 'review.run', jobKey: 'm5b2-nominal', attempt: 1, correlation: { ...correlation } },
    );
    expect(result.outcome).toBe('completed');
    expect(fake.invocations.length).toBeGreaterThan(0);
    for (const invocation of fake.invocations)
      expect(invocation.correlation).toEqual({ ...correlation });
  });

  it('M5b2 missing evidence', async () => {
    const fake = fakeDrivers({ skipHook: true });
    const result = await runLadder(
      () => runAgentReviewer(fake.drivers, reviewerInput()),
      {},
      { op: 'review.run', jobKey: 'm5b2-missing', attempt: 1 },
    );
    expect(result.outcome).toBe('completed');
    expect(fake.invocations.length).toBeGreaterThan(0);
    for (const invocation of fake.invocations) expect(invocation.correlation).toBeUndefined();
  });

  it('M5b2 failure evidence', async () => {
    const fake = fakeDrivers({ skipHook: true });
    // Table cases: run/work/parent/role are varied row by row; each row
    // proves the governed correlation's identity fields ride VERBATIM onto
    // every dispatched invocation — none silently inherits any outer-job
    // value. Rows with an absent role exercise the shared helper's preserved
    // default; no new role is minted by the reviewer. (The case name follows
    // the M5b0 literal naming convention; this row set proves the
    // absent-role default, not a failing dispatch.)
    const rows = [
      { workId: 'w-child', parentWorkId: 'w-parent', role: 'critic' },
      { workId: 'w-other', runId: 'r-9' },
      { workId: 'w-third', role: 'observer', task: 'review a diff' },
    ] as const;
    const invocationsPerRow: Array<typeof fake.invocations> = [];
    for (const [i, governed] of rows.entries()) {
      const before = fake.invocations.length;
      const result = await runLadder(
        () => runAgentReviewer(fake.drivers, reviewerInput()),
        {},
        {
          op: 'review.run',
          jobKey: `m5b2-table-${i}`,
          attempt: 1,
          correlation: { ...governed },
        },
      );
      expect(result.outcome).toBe('completed');
      invocationsPerRow.push(fake.invocations.slice(before));
    }
    // Independently-constructed expected row: the expected correlation is
    // built from the fixture's own inputs, never from the produced output.
    for (const [i, governed] of rows.entries()) {
      const rowInvocations = invocationsPerRow[i]!;
      expect(rowInvocations.length).toBeGreaterThan(0);
      for (const invocation of rowInvocations)
        expect(invocation.correlation).toEqual({
          workId: governed.workId,
          ...('parentWorkId' in governed && { parentWorkId: governed.parentWorkId }),
          ...('runId' in governed && { runId: governed.runId }),
          ...('task' in governed && { task: governed.task }),
          role: 'role' in governed ? governed.role : 'fixer',
        });
    }
  });
});
