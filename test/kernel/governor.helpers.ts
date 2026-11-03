// T1.3 slice 2 — tests for the budget governor (src/kernel/governor.ts).
//
// THE ws-a acceptance checks, in goal order:
//   1. THE KILL-LADDER CHECK: a fake op that IGNORES the abort signal is
//      killed through the full escalation ladder — each rung asserted rung by
//      rung (names, order, exact delays via the injected virtual clock), the
//      final kill producing OpResult budget-exhausted, with a late
//      post-kill rejection provably swallowed (no unhandled rejection).
//   2. USD cap trips mid-run: remaining work is stopped honestly (I9) by the
//      GOVERNED RUNNER itself — refusal rows stay real terminal verdicts,
//      done rows keep real results, queued/blocked rows whose non-execution
//      is transitively budget-caused re-mark budget-exhausted, and
//      stoppedEarly is claimed ONLY when the stop actually gated undispatched
//      work (I9 honesty, both directions), dispatch-quota stops included.
//   3. Dual caps: the in-flight ceiling holds as a high-water mark even at
//      higher RunOptions.concurrency (and the pool binds in the min()'s other
//      direction); runDispatchQuota refuses with the refusal recorded.
//   4. Attempt caps: bounded re-dispatch end-to-end (a resumed run is the
//      second attempt; the governor refuses the third dispatch) and the frozen
//      JobStartedJournalEvent.attempt field driving the cap after seeding.
//   5. Resume after a budget stop: a killed job with NO terminal event IS
//      re-dispatched on resume; a terminal budget-exhausted row is NOT
//      re-dispatched under a seeded, still-tripped governor (documented
//      semantics); reports stay honest.
//   6. Journal evidence: a killed run leaves job-started with attempt, a
//      budget-exhausted finish, and run-finished; statusOf folds sensibly.
//
// T1.6b adds the DD-9 describe block: the api-equivalent budget — a parallel
// token rollup cap (maxTokens, independent of maxUsd), the USD cap tripping
// through MODELED cost on subscription-shaped lanes, and the unpriced
// fail-loud rule (real usage with no costUSD under a USD cap trips, never
// fails open).
//
// Composition (W2.2 slice C): every runPlan leg goes through the GOVERNED
// RUNNER — `runPlan(plan, opts, view, { governor })`; the deleted
// governRegistry/withBudgetStop/seedFromRunLog decorator seam has no tests
// here anymore (the runner-owned honest stop/admission/ledger is pinned in
// test/kernel/runner-governed.*.test.ts).
//
// Determinism: EVERY timer flows through the injected virtual Clock — no
// real-time waits anywhere (a setImmediate pump yields event-loop turns for
// the runner's fs/microtask work; assertions on delays are exact). Temp
// journal dirs: mkdtemp under os.tmpdir, removed in afterEach.

// Split provenance: test/kernel/governor.test.ts was split into
// governor-*.test.ts subject files (pure move). The file-level helpers
// below are the shared toolkit for exactly those files.

import { expect } from 'vitest';
import { z } from 'zod';
import { currentJobContext } from '../../src/kernel/governor.js';
import type { GovernorEvent } from '../../src/kernel/governor.js';
import type { OpRegistryView } from '../../src/kernel/runner.js';
import type { Op, OpRegistryEntry, OpResult, Plan, RunReport } from '../../src/kernel/types.js';

/** Narrowed governor-event views for filter predicates. */
export type LadderRungEvent = Extract<GovernorEvent, { kind: 'ladder-rung' }>;
export type CompletedEvent = Extract<GovernorEvent, { kind: 'completed' }>;
export type ShortCircuitEvent = Extract<GovernorEvent, { kind: 'short-circuited' }>;

// ---------------------------------------------------------------------------
// Virtual clock + pump — the injected-time toolkit (no real waits anywhere)
// ---------------------------------------------------------------------------

interface VirtualClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** Fire every timer due within the next `ms` of virtual time, in due order. */
  advance(ms: number): void;
}

export function virtualClock(startMs = 1_000_000): VirtualClock {
  let nowMs = startMs;
  let seq = 0;
  const timers: Array<{ at: number; fn: () => void }> = [];
  return {
    now: () => nowMs,
    setTimeout(fn: () => void, ms: number) {
      const timer = { at: nowMs + ms, fn: fn, id: ++seq };
      timers.push(timer);
      return timer;
    },
    clearTimeout(handle: unknown) {
      const index = timers.indexOf(handle as { at: number; fn: () => void });
      if (index >= 0) timers.splice(index, 1);
    },
    advance(ms: number) {
      const target = nowMs + ms;
      for (;;) {
        const due = timers.filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at)[0];
        if (due === undefined) break;
        nowMs = due.at; // timers fire at their exact due time, not at step granularity
        timers.splice(timers.indexOf(due), 1);
        due.fn();
      }
      nowMs = target;
    },
  };
}

/** One macrotask turn — lets the runner's real fs work and microtasks progress. */
export const tick = (): Promise<void> =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

/**
 * Advance the virtual clock in steps until `promise` settles (runs need
 * event-loop turns between advances for journal writes). Burns `maxAdvance`
 * of virtual time max, then fails LOUDLY — a hanging run is a test failure,
 * never a suite hang.
 */
export async function pumped<T>(
  promise: Promise<T>,
  clock: VirtualClock,
  maxAdvance = 600_000,
): Promise<T> {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  let advanced = 0;
  while (!settled) {
    clock.advance(10);
    advanced += 10;
    if (advanced > maxAdvance) {
      throw new Error(`pump: run did not settle after advancing ${maxAdvance}ms of virtual time`);
    }
    await tick();
  }
  return promise;
}

/**
 * Advance the clock in pump steps until `gated` fires — the gate-mid-run
 * analogue of `pumped`. Freezing BETWEEN dispatches is what keeps a later
 * job's pre-entry I/O from burning its own wall-clock budget: a ladder that
 * arms while the pump is stopped cannot fire its abort rung before the op
 * body is entered. A run that settles before the gate fired throws here: the
 * caller's next gated await could never resolve, and failing loudly on the
 * settlement (instead of at the framework timeout) keeps the run's own
 * failure mode visible.
 */
export async function pumpUntil<T>(
  promise: Promise<T>,
  clock: VirtualClock,
  gated: () => boolean,
  maxAdvance = 600_000,
): Promise<void> {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  let advanced = 0;
  while (!settled && !gated()) {
    clock.advance(10);
    advanced += 10;
    if (advanced > maxAdvance) {
      throw new Error(
        `pumpUntil: gate not reached after advancing ${maxAdvance}ms of virtual time`,
      );
    }
    await tick();
  }
  if (!gated()) {
    throw new Error(
      'pumpUntil: run settled before the gate fired — the gated await could never resolve',
    );
  }
}

/** Poll a condition across macrotask turns (deterministic, no real time). */
export async function waitFor(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 10_000 && !condition(); i++) {
    await tick();
  }
  expect(condition(), `waitFor: ${what}`).toBe(true);
}

// ---------------------------------------------------------------------------
// Fakes — same shape as runner.test.ts, plus hanging/gated/spending variants
// ---------------------------------------------------------------------------

// Non-strict on purpose: replay tests add keys to an input to change its hash.
const jobInputSchema = z.object({ jobId: z.string() });

export function entry(
  name: string,
  op: (raw: unknown) => Promise<OpResult<unknown>>,
  schema: z.ZodType<unknown> = jobInputSchema,
): OpRegistryEntry<never, never> {
  return {
    name: name,
    inputSchema: schema as unknown as z.ZodType<never>,
    importer: () => Promise.resolve(op as unknown as Op<never, never>),
  };
}

export function viewWith(...entries: OpRegistryEntry<never, never>[]): OpRegistryView {
  const map = new Map(
    entries.map((candidate): [string, OpRegistryEntry<never, never>] => [
      candidate.name,
      candidate,
    ]),
  );
  return { get: (name) => map.get(name) };
}

export function independentPlan(id: string, n: number, op = 'fake'): Plan {
  return {
    id: id,
    jobs: Array.from({ length: n }, (_, i) => {
      const jobId = `j${i + 1}`;
      return { id: jobId, op: op, input: { jobId: jobId } };
    }),
  };
}

export const okOp = async (raw: unknown): Promise<OpResult<unknown>> => {
  const jobId = (raw as { jobId: string }).jobId;
  return { status: 'ok', value: jobId };
};

export const failOp = async (raw: unknown): Promise<OpResult<unknown>> => {
  const jobId = (raw as { jobId: string }).jobId;
  return { status: 'failed', error: `real failure ${jobId}` };
};

/** A spendy op: injects usage + cost through the governed job context (reportResult — the ONE streaming channel). */
const SPENDY_USAGE = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 };
export const spendyOp = async (raw: unknown): Promise<OpResult<unknown>> => {
  const ctx = currentJobContext();
  if (ctx !== undefined) {
    ctx.reportResult({ usage: SPENDY_USAGE, costUSD: 0.6 });
  }
  return okOp(raw);
};

export function rowStatuses(report: RunReport): string[] {
  return report.jobs.map((row) => row.result.status);
}
