// T1.2 slice 2 — tests for the plan runner (src/kernel/runner.ts).
//
// The centerpiece is THE ws-a replay check: a 10-job chain run against a
// COUNTING FAKE (shared counter object — the goal's counting-fake driver
// seam), crashed on job 5 with stopOnError, then resumed from the journal:
// jobs 1-4 skip via terminal journal records with ZERO new invocations, job 5
// (was failed) re-runs, 6-10 run — exactly 6 (and <= 6) invocations in run 2,
// and the final report counts 10 done.
//
// Also pinned here: stopOnError:false fleet collection (all 10 outcomes,
// downstream blocked), the queued/blocked counts policy for never-started
// jobs (a definitively failed dependency BLOCKS even when a sibling dep is
// merely queued), replay folding ALL prior runs of the plan per-job
// last-finish-wins (a later partial run keeps older completed jobs; a later
// failed re-attempt re-runs), a sibling plan whose id extends this one
// ('a' vs 'a--b') cannot block the resume with its corrupt journal, replay
// re-running an input-changed job (hash mismatch beats terminal ok), replay
// OFF without resume:true, unknown op / schema violation / throwing op /
// contract-violating op / non-serializable op result / throwing registry
// lookup all record honest `failed` results, the runId filename-safety assert
// applying only to journaled runs, p-limit actually caps in-flight work
// (high-water === concurrency), usage reconstruction + rollup from a
// replayed journal, and report JSON-serializability.
//
// Matcher note: bare regex literals passed as values inside toMatchObject
// are wrapped in expect.stringMatching — vitest 5.0.0's subset-compare quirk.
//
// The suite was split into per-subject files (runner.<subject>.test.ts) so
// review tooling can see below the 256 KiB single-file cap; this module
// carries the shared counting fake, registry/plan builders and journal
// helpers all of them import.

import { z } from 'zod';
import type { OpRegistryView } from '../../src/kernel/runner.js';
import type {
  JobFinishedJournalEvent,
  JournalEvent,
  Op,
  OpRegistryEntry,
  OpResult,
  Plan,
} from '../../src/kernel/types.js';

// ---------------------------------------------------------------------------
// Counting fake — the driver seam: every op delegates to one shared counter
// ---------------------------------------------------------------------------

export interface FakeState {
  /** Job ids in invocation order (one entry per actual op invocation). */
  calls: string[];
  inFlight: number;
  highWater: number;
  /** These jobs get a `failed` RESULT. */
  failOn: Set<string>;
  /** These jobs make the op THROW (contract-visible crash). */
  crashOn: Set<string>;
}

export function makeFake(): { state: FakeState; op: (raw: unknown) => Promise<OpResult<unknown>> } {
  const state: FakeState = {
    calls: [],
    inFlight: 0,
    highWater: 0,
    failOn: new Set(),
    crashOn: new Set(),
  };
  const op = async (raw: unknown): Promise<OpResult<unknown>> => {
    const input = raw as { jobId: string };
    state.calls.push(input.jobId);
    state.inFlight += 1;
    state.highWater = Math.max(state.highWater, state.inFlight);
    try {
      // Yield so the pool genuinely overlaps work under load.
      await new Promise((resolve) => setTimeout(resolve, 2));
      if (state.crashOn.has(input.jobId)) throw new Error(`boom ${input.jobId}`);
      if (state.failOn.has(input.jobId)) return { status: 'failed', error: `nope ${input.jobId}` };
      return { status: 'ok', value: input.jobId };
    } finally {
      state.inFlight -= 1;
    }
  };
  return { state, op };
}

// Non-strict on purpose: replay tests add keys to an input to change its hash.
export const jobInputSchema = z.object({ jobId: z.string() });

/** Wrap an op as a registry entry (op-contract params cast to the bottom instantiation). */
export function entry(
  name: string,
  schema: z.ZodType<unknown>,
  op: (raw: unknown) => Promise<OpResult<unknown>>,
): OpRegistryEntry<never, never> {
  return {
    name,
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

export const DEFAULT_VIEW = (): OpRegistryView =>
  viewWith(entry('fake', jobInputSchema, makeFake().op));

/** n-job chain over the 'fake' op; input carries the job id. Job ids are `<prefix><i>` (prefix defaults to 'j'). */
export function chainPlan(id: string, n: number, prefix = 'j'): Plan {
  return {
    id,
    jobs: Array.from({ length: n }, (_, i) => {
      const jobId = `${prefix}${i + 1}`;
      return i === 0
        ? { id: jobId, op: 'fake', input: { jobId } }
        : { id: jobId, op: 'fake', input: { jobId }, dependsOn: [`${prefix}${i}`] };
    }),
  };
}

/** n independent jobs (single wave) — for concurrency-pool tests. */
export function independentPlan(id: string, n: number): Plan {
  return {
    id,
    jobs: Array.from({ length: n }, (_, i) => {
      const jobId = `i${i + 1}`;
      return { id: jobId, op: 'fake', input: { jobId } };
    }),
  };
}

export function jobFinishes(events: JournalEvent[]): JobFinishedJournalEvent[] {
  return events.filter((event): event is JobFinishedJournalEvent => event.type === 'job-finished');
}

/** All six frozen counts keys, for order-insensitive key assertions. */
export const SIX_STATES = [
  'blocked',
  'budget-exhausted',
  'done',
  'failed',
  'queued',
  'running',
].sort();
