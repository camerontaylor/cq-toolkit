// Governor tests (split from test/kernel/governor.test.ts — pure move): the src/index.ts barrel re-export of the governor public surface.

import { describe, expect, test } from 'vitest';
import * as toolkit from '../../src/index.js';

// ---------------------------------------------------------------------------
// Barrel — the public surface is re-exported (re-export only, no logic)
// ---------------------------------------------------------------------------

describe('src/index.ts barrel', () => {
  test('re-exports the governor public surface', () => {
    expect(typeof toolkit.createGovernor).toBe('function');
    expect(typeof toolkit.runLadder).toBe('function');
    expect(typeof toolkit.governorConfig).toBe('function');
    expect(typeof toolkit.currentJobContext).toBe('function');
    expect(typeof toolkit.realClock.now()).toBe('number');
    // DD-1 spike result (docs/dd-1-abort-spike.md): 5000, ≈2.5× the measured
    // worst cooperative abort settle (~2.0 s, claude-agent lane); the value
    // is pinned to the doc by test/kernel/governor-config.test.ts.
    expect(toolkit.DEFAULT_ABORT_GRACE_MS).toBe(5_000);
    expect(toolkit.DEFAULT_KILL_GRACE_MS).toBe(5_000);
    // The W2.3 journal-event schemas ride the barrel next to every
    // preexisting journal event schema — consumers name and validate the
    // new variants through the supported API, never unpublished internals
    // (Codex P2, the fix round).
    expect(toolkit.ReservationOpenedJournalEventSchema).toBeDefined();
    expect(toolkit.ReservationSettledJournalEventSchema).toBeDefined();
    expect(toolkit.ReservationRefusedJournalEventSchema).toBeDefined();
    expect(toolkit.JobQuarantinedJournalEventSchema).toBeDefined();
    expect(toolkit.QuarantineReleasedJournalEventSchema).toBeDefined();
    expect(toolkit.BudgetTrippedJournalEventSchema).toBeDefined();
  });

  test('public consumers can CONSTRUCT a governor from the barrel (review VB1B)', () => {
    // A type-only BudgetGovernor export would leave createGovernor /
    // governorConfig exported but unusable.
    expect(typeof toolkit.BudgetGovernor).toBe('function');
    expect(typeof toolkit.governorConfig).toBe('function');
    const governor = new toolkit.BudgetGovernor({}); // minimal valid config
    expect(governor.admit('k')).toEqual({ decision: 'admit', attempt: 1 });
    expect(governor.dispatchCount).toBe(1);
    expect(governor.tripped).toBe(false);
  });
});
