// Helpers for the runner-governed.*.test.ts split (was one
// runner-governed.test.ts; the subject areas below now live in those
// sibling files). Shared fixtures only — no tests here.

import { z } from 'zod';
import { currentJobContext, type GovernorEvent } from '../../src/kernel/governor.js';
import { runPlan as kernelRunPlan, type OpRegistryView } from '../../src/kernel/runner.js';
import type {
  JournalEvent,
  Op,
  OpRegistryEntry,
  OpResult,
  Plan,
  RunReport,
} from '../../src/kernel/types.js';

// The GOVERNED runner (W2.2, ADR-0003 §2) — runPlan's 4th `gov` parameter.
//
// Pinned here:
//   1. Caps without governance are refused before anything runs (a cap with
//      no admission gate is a lie, not a limit).
//   2. Governed basics: admission keyed on the REAL plan job id (two jobs
//      sharing one op are independent attempts — the old op-name fallback
//      keying is gone), per-job/per-run spend rollups on the report rows,
//      and honest silence when nothing was spent (no fabricated costUSD 0).
//   3. Trip → honest stop: a budget-family trip re-marks only rows whose
//      non-execution is transitively budget-caused (a genuinely-failed dep
//      keeps its real verdict all the way down) and claims
//      stoppedEarly/earlyStopReason 'budget' with the ledger's cost rollup.
//   4. Run signal: a pre-aborted signal stops before any dispatch (rows stay
//      queued, 'signal' — never budget-exhausted); a mid-run abort lets the
//      admitted job keep its post-abort verdict and leaves the rest queued.
//   5. Journal v2 + resume: seq claims, the governance block (caps,
//      attendance, legacyJournal reset, raiseCap), attempt continuation from
//      the seeded fold, the three refusals (ungoverned over governed
//      history / unaccounted v1 dispatches / cap raise) and their opt-ins,
//      the ungoverned-marked escape hatch, spend-seeded resume tripping, and
//      the seq-ordered fold beating reversed fake-clock `at` stamps.
//   6. Honest-stop attribution (the coverage the deleted withBudgetStop
//      helper owned, re-homed here against the runner-owned pass — W2.2
//      slice C): dispatch-quota stops re-mark, silent trips stay silent,
//      fabricated `queued:` verdicts from admitted ops never rewrite, and
//      diamond-shaped BLOCKED rows over a refused dispatch re-mark
//      transitively through memoized causality.
//   7. Chained governed resumes: the fold reads ALL runs (a spent
//      dispatch quota carries across resumes) and a corrupt sibling-plan
//      journal cannot block the fold.
//
// The fold-ordering unit rules themselves live in journal-v2.test.ts — this

// Mirrors journal.ts private PUBLICATION_STARTUP_MS; update if that bound changes.
// First acquisition: boot lookup 10s + guard/record I/O 10s (the retired flock
// helper's slot, kept until re-measured) + startup/I/O margin 5s. Later
// acquisitions reuse the successful boot identity: guard/record I/O 10s + 5s.
export const ACQUISITION_STEP_MS = 2 * 10_000 + 5_000;
export function journalEnclosure(steps: number): number {
  return ACQUISITION_STEP_MS + (steps - 1) * 15_000 + 5_000;
}

/**
 * Captures a runPlan rejection as a value so its CLASS can be asserted: the
 * ledger refusals are GovernanceOptInRefusedError (ADR-0003 §2.9 — the CLI's
 * exit-2 mapping reads the class, never the message), so each canonical
 * refusal test pins the class beside the message contract.
 */
export async function refusalOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}
const pendingRuns = new Map<Promise<unknown>, AbortController>();
export const cleanupActions = new Set<() => void>();
export function runPlan(
  ...args: Parameters<typeof kernelRunPlan>
): ReturnType<typeof kernelRunPlan> {
  const abort = new AbortController();
  const governance = args[3];
  const running = kernelRunPlan(
    args[0],
    args[1],
    args[2],
    governance === undefined
      ? undefined
      : {
          ...governance,
          signal:
            governance.signal === undefined
              ? abort.signal
              : AbortSignal.any([abort.signal, governance.signal]),
        },
  );
  pendingRuns.set(running, abort);
  // Observe outcomes immediately, keeping the original rejecting promise for assertions.
  void running.then(
    () => pendingRuns.delete(running),
    () => pendingRuns.delete(running),
  );
  return running;
}
export async function settleFixtureWork(): Promise<void> {
  for (const abort of pendingRuns.values()) abort.abort();
  for (const action of cleanupActions) action();
  cleanupActions.clear();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcomes = await Promise.race([
      Promise.allSettled([...pendingRuns.keys()]),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('fixture cleanup: work did not settle; journal retained')),
          ACQUISITION_STEP_MS,
        );
      }),
    ]);
    const rejection = outcomes.find((outcome) => outcome.status === 'rejected');
    if (rejection?.status === 'rejected') throw rejection.reason;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Fakes — the runner.test.ts registry/plan patterns, plus spend/flag variants
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

/** A counting op: records invocations, optionally streams a cost through the job context. */
export function countingOp(calls: string[], spendUSD?: number) {
  return async (raw: unknown): Promise<OpResult<unknown>> => {
    const jobId = (raw as { jobId: string }).jobId;
    calls.push(jobId);
    if (spendUSD !== undefined) {
      currentJobContext()?.reportResult({
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
        costUSD: spendUSD,
      });
    }
    return okOp(raw);
  };
}

/** Narrowed governor-event views for filter predicates. */
export type AdmittedEvent = Extract<GovernorEvent, { kind: 'admitted' }>;
export type ShortCircuitEvent = Extract<GovernorEvent, { kind: 'short-circuited' }>;
export type TrippedEvent = Extract<GovernorEvent, { kind: 'budget-tripped' }>;
export type StartedEvent = Extract<JournalEvent, { type: 'job-started' }>;
export type FinishedEvent = Extract<JournalEvent, { type: 'job-finished' }>;

export const jobFinishes = (events: JournalEvent[]): FinishedEvent[] =>
  events.filter((event): event is FinishedEvent => event.type === 'job-finished');
export const jobStarts = (events: JournalEvent[]): StartedEvent[] =>
  events.filter((event): event is StartedEvent => event.type === 'job-started');

export const rowStatuses = (report: RunReport): string[] =>
  report.jobs.map((row) => row.result.status);

export const spendOnce =
  (calls: string[], usd: number) =>
  async (raw: unknown): Promise<OpResult<unknown>> => {
    const jobId = (raw as { jobId: string }).jobId;
    calls.push(jobId);
    currentJobContext()?.reportResult({
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
      costUSD: usd,
    });
    return okOp(raw);
  };
