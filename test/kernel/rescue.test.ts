// T1.3 slice 2 — tests for the rescue lane (src/kernel/rescue.ts).
//
// Pinned here (ws-a item 5):
//   1. Guards trip → rescue NEVER retries: baseline-failed and
//      human-intervened terminate with the guard named, against a
//      retry-everything table (guards override every row); a needs-human
//      latest outcome auto-trips the human guard (never auto-retry a
//      needs-human verdict).
//   2. Bounded re-dispatch: retry{maxAttempts} honored — under cap → retry,
//      at cap → terminate; Limits.maxAttemptsPerJob lower than the row →
//      min wins (and named as the binder).
//   3. Escalation: a row with escalate{model,provider,driver} produces a
//      decision carrying the escalation as PLAIN DATA (the kernel records
//      policy, never constructs driver objects); carrySessionRef echoes a
//      present sessionRef and stays absent when none was observed.
//   4. CONSERVATIVE_RESCUE_POLICY rescues nothing; first-match-wins row
//      selection; on:'any' fallback (including the killed outcome);
//      attemptsFromJournal folds the frozen JobStartedJournalEvent.attempt
//      fields (max-of with dispatch occurrence), the killed tail, orphan
//      re-attestations, and cross-job isolation.
//   5. The policy table is plain serializable data: JSON round-trip of a
//      table with every row/action variant, and decisions from the
//      round-tripped table are identical to the original's.
//
// Pure data tests: no clocks, no timers, no I/O — instant by construction.
import { describe, expect, test } from 'vitest';
import {
  CONSERVATIVE_RESCUE_POLICY,
  attemptsFromJournal,
  decideRescue,
  rescueInputFromJournal,
} from '../../src/kernel/rescue.js';
import type {
  JournalEvent,
  OpResult,
} from '../../src/kernel/types.js';
import type {
  RescueAttempt,
  RescueGuard,
  RescuePolicy,
  RescuePolicyRow,
} from '../../src/kernel/rescue.js';

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/** A table that would retry everything, forever — guards must override it. */
const RETRY_EVERYTHING: RescuePolicy = {
  rows: [{ id: 'retry-all', on: 'any', action: { kind: 'retry', maxAttempts: 99 } }],
};

const attempt = (n: number, outcome: RescueAttempt['outcome'], extra?: Partial<RescueAttempt>): RescueAttempt => ({
  attempt: n,
  outcome: outcome,
  ...extra,
});

const input = (attempts: RescueAttempt[], extra?: { guards?: RescueGuard[] | undefined }): {
  jobId: string;
  op: string;
  attempts: RescueAttempt[];
  guards?: RescueGuard[];
} => ({
  jobId: 'j1',
  op: 'gen',
  attempts: attempts,
  ...(extra?.guards !== undefined ? { guards: extra.guards } : {}),
});

const AT = '2026-01-01T00:00:00.000Z';

const started = (runId: string, jobId: string, attemptNo: number): JournalEvent => ({
  type: 'job-started',
  runId: runId,
  at: AT,
  jobId: jobId,
  op: `op-${jobId}`,
  attempt: attemptNo,
});

const finished = (runId: string, jobId: string, result: OpResult<unknown>): JournalEvent => ({
  type: 'job-finished',
  runId: runId,
  at: AT,
  jobId: jobId,
  opId: `op-${jobId}`,
  inputsHash: `hash-${jobId}`,
  result: result,
});

// ---------------------------------------------------------------------------
// 1. Guards — conservative termination
// ---------------------------------------------------------------------------

describe('guards trip → rescue NEVER retries (ws-a item 5)', () => {
  test('baseline-failed guard terminates against a retry-everything table, guard named', () => {
    const decision = decideRescue(input([attempt(1, 'indeterminate')], { guards: ['baseline-failed'] }), RETRY_EVERYTHING);
    expect(decision).toEqual({
      kind: 'terminate',
      reason: 'guard-baseline-failed',
      guard: 'baseline-failed',
    });
  });

  test('human-intervened guard terminates likewise', () => {
    const decision = decideRescue(input([attempt(3, 'indeterminate')], { guards: ['human-intervened'] }), RETRY_EVERYTHING);
    expect(decision).toEqual({
      kind: 'terminate',
      reason: 'guard-human-intervened',
      guard: 'human-intervened',
    });
  });

  test('a needs-human outcome auto-trips the human guard — never auto-retry a needs-human verdict', () => {
    const decision = decideRescue(input([attempt(1, 'needs-human')]), RETRY_EVERYTHING);
    expect(decision).toEqual({
      kind: 'terminate',
      reason: 'guard-human-intervened',
      guard: 'human-intervened',
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Bounded re-dispatch
// ---------------------------------------------------------------------------

describe('bounded re-dispatch (ws-a item 5)', () => {
  const ROW: RescuePolicyRow = {
    id: 'retry-2',
    on: 'failed',
    action: { kind: 'retry', maxAttempts: 2 },
  };

  test('under cap → retry decision with the next attempt ordinal', () => {
    expect(decideRescue(input([attempt(1, 'failed')]), { rows: [ROW] })).toEqual({
      kind: 'retry',
      attempt: 2,
      rowId: 'retry-2',
    });
  });

  test('at cap → terminate attempt-cap, naming the row', () => {
    expect(decideRescue(input([attempt(1, 'failed'), attempt(2, 'failed')]), { rows: [ROW] })).toEqual({
      kind: 'terminate',
      reason: 'attempt-cap',
      rowId: 'retry-2',
      cap: 'row-max-attempts',
    });
  });

  test('Limits.maxAttemptsPerJob lower than the row → min wins, bound named', () => {
    // limits cap 1 < row 2: the FIRST attempt already exhausted the effective cap.
    expect(
      decideRescue(input([attempt(1, 'failed')]), { rows: [ROW] }, { maxAttemptsPerJob: 1 }),
    ).toEqual({
      kind: 'terminate',
      reason: 'attempt-cap',
      rowId: 'retry-2',
      cap: 'per-job-attempts',
    });
    // limits cap 3 > row 2: the row stays the binder.
    expect(
      decideRescue(input([attempt(1, 'failed'), attempt(2, 'failed')]), { rows: [ROW] }, { maxAttemptsPerJob: 3 }),
    ).toEqual({
      kind: 'terminate',
      reason: 'attempt-cap',
      rowId: 'retry-2',
      cap: 'row-max-attempts',
    });
  });
});

// ---------------------------------------------------------------------------
// 2b. Policy validation — retry caps must be positive integers (#15-9)
// ---------------------------------------------------------------------------

describe('retry-row maxAttempts validation (#15-9)', () => {
  const row = (maxAttempts: number): RescuePolicy => ({
    rows: [{ id: 'capped', on: 'failed', action: { kind: 'retry', maxAttempts } }],
  });

  test.each([NaN, 1.5, 0, -2])('maxAttempts %p is rejected loudly at the decision path', (bad) => {
    expect(() => decideRescue(input([attempt(1, 'failed')]), row(bad))).toThrowError(
      /maxAttempts must be an integer >= 1/,
    );
  });

  test('the rejection names the row id and the bad value', () => {
    expect(() => decideRescue(input([attempt(1, 'failed')]), row(NaN))).toThrowError(
      "rescue: policy row 'capped' maxAttempts must be an integer >= 1, got NaN",
    );
  });

  test('a valid cap still decides: maxAttempts 1 means the initial dispatch only', () => {
    expect(decideRescue(input([attempt(1, 'failed')]), row(1))).toEqual({
      kind: 'terminate',
      reason: 'attempt-cap',
      rowId: 'capped',
      cap: 'row-max-attempts',
    });
  });
});

// ---------------------------------------------------------------------------
// Review round 3 — the LIMITS half of the cap arithmetic is validated too:
// caps.maxAttemptsPerJob NaN/fractional made effectiveCap NaN (`>= NaN` is
// false → UNBOUNDED retry); 0/negative → silent never-retry.
// ---------------------------------------------------------------------------

describe('caps.maxAttemptsPerJob validation (review round 3)', () => {
  const row = (maxAttempts: number): RescuePolicy => ({
    rows: [{ id: 'capped', on: 'failed', action: { kind: 'retry', maxAttempts } }],
  });

  test.each([Number.NaN, 1.5, 0, -2])('caps.maxAttemptsPerJob %p throws naming the field', (bad) => {
    expect(() =>
      decideRescue(input([attempt(1, 'failed')]), row(9), { maxAttemptsPerJob: bad }),
    ).toThrowError(/caps\.maxAttemptsPerJob must be an integer >= 1/);
  });

  test('the rejection names the bad value', () => {
    expect(() =>
      decideRescue(input([attempt(1, 'failed')]), row(9), { maxAttemptsPerJob: Number.NaN }),
    ).toThrowError('rescue: caps.maxAttemptsPerJob must be an integer >= 1, got NaN');
  });

  test('valid caps are untouched: the min() semantics still decide', () => {
    // limits cap 2 < row 9: two attempts exhaust the effective cap — the
    // LIMITS half is the named binder.
    expect(
      decideRescue(input([attempt(1, 'failed'), attempt(2, 'failed')]), row(9), {
        maxAttemptsPerJob: 2,
      }),
    ).toEqual({
      kind: 'terminate',
      reason: 'attempt-cap',
      rowId: 'capped',
      cap: 'per-job-attempts',
    });
    // limits cap 9 > row 2: the row stays the binder.
    expect(
      decideRescue(input([attempt(1, 'failed'), attempt(2, 'failed')]), row(2), {
        maxAttemptsPerJob: 9,
      }),
    ).toEqual({
      kind: 'terminate',
      reason: 'attempt-cap',
      rowId: 'capped',
      cap: 'row-max-attempts',
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Escalation — policy recorded as data, never driver objects
// ---------------------------------------------------------------------------

describe('escalation as policy rows (ws-a item 5)', () => {
  const ESCALATE: RescuePolicy = {
    rows: [
      {
        id: 'escalate-on-failure',
        on: 'failed',
        action: {
          kind: 'retry',
          maxAttempts: 3,
          escalate: { model: 'glm-5.3', provider: 'zai', driver: 'subprocess' },
          carrySessionRef: true,
        },
      },
    ],
  };

  test('the decision carries the escalation and the observed session resume token', () => {
    const decision = decideRescue(
      input([attempt(1, 'failed', { sessionRef: 'sess-42', model: 'glm-lite' })]),
      ESCALATE,
    );
    expect(decision).toEqual({
      kind: 'retry',
      attempt: 2,
      rowId: 'escalate-on-failure',
      escalate: { model: 'glm-5.3', provider: 'zai', driver: 'subprocess' },
      sessionRef: 'sess-42',
    });
    // Plain data only — the kernel records policy, it never constructs
    // driver objects: the decision round-trips JSON losslessly.
    expect(JSON.parse(JSON.stringify(decision))).toEqual(decision);
  });

  test('carrySessionRef with NO observed token → the decision carries no sessionRef', () => {
    const decision = decideRescue(input([attempt(1, 'failed')]), ESCALATE);
    expect(decision.kind).toBe('retry');
    expect(decision).toMatchObject({ attempt: 2, escalate: { model: 'glm-5.3' } });
    expect('sessionRef' in decision).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Table mechanics — conservative default, matching, evidence fold
// ---------------------------------------------------------------------------

describe('CONSERVATIVE_RESCUE_POLICY and row matching (ws-a item 5)', () => {
  test('the conservative default rescues nothing', () => {
    for (const outcome of ['failed', 'budget-exhausted', 'indeterminate', 'killed'] as const) {
      const decision = decideRescue(input([attempt(1, outcome)]), CONSERVATIVE_RESCUE_POLICY);
      expect(decision).toEqual({ kind: 'terminate', reason: 'no-policy-row' });
    }
    // needs-human never even reaches row matching — the auto-derived guard
    // terminates first (rule 1 before rule 4).
    expect(decideRescue(input([attempt(1, 'needs-human')]), CONSERVATIVE_RESCUE_POLICY)).toEqual({
      kind: 'terminate',
      reason: 'guard-human-intervened',
      guard: 'human-intervened',
    });
    expect(CONSERVATIVE_RESCUE_POLICY).toEqual({ rows: [] });
  });

  test('first-match-wins: the first matching row decides', () => {
    const policy: RescuePolicy = {
      rows: [
        { id: 'first', on: 'failed', action: { kind: 'retry', maxAttempts: 5 } },
        { id: 'second', on: 'failed', action: { kind: 'skip' } },
      ],
    };
    expect(decideRescue(input([attempt(1, 'failed')]), policy)).toMatchObject({ kind: 'retry', rowId: 'first' });
  });

  test("op-scoped rows only match their op; on:'any' is the fallback (killed included)", () => {
    const policy: RescuePolicy = {
      rows: [
        { id: 'verify-skip', on: 'any', op: 'verify', action: { kind: 'skip' } },
        { id: 'killed-retry', on: 'killed', action: { kind: 'retry', maxAttempts: 3 } },
        { id: 'any-fallback', on: 'any', action: { kind: 'retry', maxAttempts: 9 } },
      ],
    };
    // The verify-scoped skip row matches ONLY the verify op...
    expect(
      decideRescue({ jobId: 'v1', op: 'verify', attempts: [attempt(1, 'killed')] }, policy),
    ).toEqual({ kind: 'terminate', reason: 'policy-skip', rowId: 'verify-skip' });
    // ...another op with the same killed attempt skips past it to the
    // killed-scoped row (beating the fallback)...
    expect(decideRescue(input([attempt(2, 'killed')]), policy)).toEqual({
      kind: 'retry',
      attempt: 3,
      rowId: 'killed-retry',
    });
    // ...and an unmatched outcome falls through to the on:'any' row.
    expect(decideRescue(input([attempt(1, 'indeterminate')]), policy)).toEqual({
      kind: 'retry',
      attempt: 2,
      rowId: 'any-fallback',
    });
  });
});

describe('attemptsFromJournal — the frozen attempt field fold (ws-a item 2/5)', () => {
  test('pairs starts with finishes, takes max(frozen attempt, occurrence), folds the killed tail', () => {
    const events: JournalEvent[] = [
      started('r1', 'j1', 1),
      finished('r1', 'j1', { status: 'failed', error: 'boom' }),
      started('r1', 'j2', 1), // a DIFFERENT job — must not leak into j1's fold
      started('r2', 'j1', 1), // occurrence 2; frozen field still 1 → ordinal max(1, 2) = 2
      // no finish for the run-2 attempt: hard-killed / torn tail
    ];
    expect(attemptsFromJournal(events, 'j1')).toEqual([
      { attempt: 1, outcome: 'failed', detail: 'boom' },
      { attempt: 2, outcome: 'killed' },
    ]);
    // cross-job isolation
    expect(attemptsFromJournal(events, 'j2')).toEqual([{ attempt: 1, outcome: 'killed' }]);
    // jobs with no evidence fold to nothing
    expect(attemptsFromJournal(events, 'ghost')).toEqual([]);
  });

  test('an orphan finish is a replay re-attestation refreshing the last attempt; unattributable finishes are ignored', () => {
    // Chained-resume shape: attempt closes failed, then a resumed run
    // re-attests the same dispatch's outcome (no new start).
    const refreshed: JournalEvent[] = [
      started('r1', 'j1', 1),
      finished('r1', 'j1', { status: 'indeterminate', detail: 'lost worker' }),
      finished('r2', 'j1', { status: 'failed', error: 'attested worse' }),
    ];
    expect(attemptsFromJournal(refreshed, 'j1')).toEqual([
      { attempt: 1, outcome: 'failed', detail: 'attested worse' },
    ]);
    // A finish with no start and NO history is not attributable — ignored.
    expect(attemptsFromJournal([finished('r9', 'lone', { status: 'ok', value: 1 })], 'lone')).toEqual([]);
  });

  test('rescueInputFromJournal assembles the decision input; the fold feeds decideRescue', () => {
    const events: JournalEvent[] = [
      started('r1', 'j1', 1),
      finished('r1', 'j1', { status: 'budget-exhausted' }),
      started('r2', 'j1', 1),
    ];
    const policy: RescuePolicy = {
      rows: [{ id: 'kill-retry', on: 'killed', action: { kind: 'retry', maxAttempts: 3 } }],
    };
    const assembled = rescueInputFromJournal(events, 'j1', 'op-j1');
    expect(assembled).toEqual({
      jobId: 'j1',
      op: 'op-j1',
      attempts: [
        { attempt: 1, outcome: 'budget-exhausted' },
        { attempt: 2, outcome: 'killed' },
      ],
    });
    expect(decideRescue(assembled, policy)).toEqual({ kind: 'retry', attempt: 3, rowId: 'kill-retry' });
    // ...and no third dispatch once the effective cap is 2.
    expect(decideRescue(assembled, policy, { maxAttemptsPerJob: 2 })).toEqual({
      kind: 'terminate',
      reason: 'attempt-cap',
      rowId: 'kill-retry',
      cap: 'per-job-attempts',
    });
  });
});

// ---------------------------------------------------------------------------
// 5. Serializability — the table is plain data
// ---------------------------------------------------------------------------

describe('the policy table is plain serializable data (ws-a item 5)', () => {
  test('JSON round-trip of a table with every row/action variant; decisions survive it', () => {
    const table: RescuePolicy = {
      rows: [
        {
          id: 'retry-escalate-session',
          on: 'failed',
          action: {
            kind: 'retry',
            maxAttempts: 3,
            escalate: { model: 'm2', provider: 'zai', driver: 'subprocess' },
            carrySessionRef: true,
          },
        },
        { id: 'retry-plain', on: 'indeterminate', op: 'gen', action: { kind: 'retry', maxAttempts: 2 } },
        { id: 'skip-killed', on: 'killed', action: { kind: 'skip' } },
        { id: 'fallback', on: 'any', action: { kind: 'skip' } },
      ],
    };
    const roundTripped = JSON.parse(JSON.stringify(table)) as RescuePolicy;
    expect(roundTripped).toEqual(table); // lossless — no functions, no exotic values

    // Every decision is identical whether taken from the table or its
    // round-trip — the data form is the contract, not the object identity.
    const probe = input([attempt(1, 'failed', { sessionRef: 's' })]);
    expect(decideRescue(probe, roundTripped)).toEqual(decideRescue(probe, table));
    const probe2 = input([attempt(1, 'killed')]);
    expect(decideRescue(probe2, roundTripped)).toEqual(decideRescue(probe2, table));
    const probe3 = input([attempt(1, 'indeterminate')]);
    expect(decideRescue(probe3, roundTripped)).toEqual(decideRescue(probe3, table));
    // And a decision itself round-trips (it is what a resumed run would consume).
    const decision = decideRescue(probe, table);
    expect(JSON.parse(JSON.stringify(decision))).toEqual(decision);
  });
});
