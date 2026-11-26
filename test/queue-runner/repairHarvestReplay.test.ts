import { describe, expect, it } from 'vitest';
import { PyError } from '../../src/queue-runner/pyErrors.js';
import type { Item, Queue } from '../../src/queue-runner/repairBackfill.js';
import {
  ReplayBudget,
  repairHarvest,
  replaySettled,
  type RepairHarvestEffects,
} from '../../src/queue-runner/repairHarvest.js';

// The terminal-failure replay is O(new) per tick: a run whose every job outcome is durably
// recorded (`siblings_recorded`) is skipped, and a per-tick `ReplayBudget` bounds the rest.
// These tests drive the real `repairHarvest` against recording fakes.

type Rec = Record<string, unknown>;

const jobId = (run: string, n: number): string => `crq-${run}-F${n}`;

function failedRun(run: string, jobs: string[], extra: Rec = {}): Rec {
  return {
    state: 'failed',
    base: 'b0',
    jobs,
    verdicts: [
      {
        job: jobs[0],
        item: 'i1',
        verdict: 'FAILED',
        reason: 'invalid repair result: x',
        finding: { id: 'f' },
      },
    ],
    error: 'x',
    ...extra,
  };
}

interface World {
  readonly log: string[];
  readonly fx: RepairHarvestEffects;
}

function world(
  options: {
    /** job -> write raises (OSError). */
    failMark?: ReadonlySet<string>;
    /** jobs whose result.json is unreadable. */
    unreadable?: ReadonlySet<string>;
    /** jobs whose inbox row has no canonical finding id. */
    noFinding?: ReadonlySet<string>;
    budget?: ReplayBudget;
  } = {},
): World {
  const log: string[] = [];
  const fx = {
    readJob: async (id: string): Promise<unknown> => {
      log.push(`readJob:${id}`);
      return {
        job: id,
        item: 'i1',
        ...(options.noFinding?.has(id) ? {} : { canonical_finding_id: `c-${id}` }),
        finding: { id: `f-${id}` },
      };
    },
    readResult: async (id: string): Promise<unknown> => {
      if (options.unreadable?.has(id)) throw new PyError('OSError', 'gone');
      return { job: id, item: 'i1', verdict: 'NOT-FIXED', reason: 'r', finding: { id: 'f' } };
    },
    resultExists: async () => true,
    saveQueue: async () => {
      log.push('save');
    },
    markFindingOutcome: async (job: Rec) => {
      const id = String(job.job);
      log.push(`mark:${id}`);
      if (options.failMark?.has(id)) throw new PyError('OSError', 'ledger down');
    },
    recordUnpublishedFixedSibling: async () => {
      log.push('fixed');
    },
    cleanupHarvested: undefined,
    replayBudget: options.budget,
  } as unknown as RepairHarvestEffects;
  return { log, fx };
}

function itemOf(runs: Record<string, Rec>): Item {
  return { id: 'i1', kind: 'push', state: 'repair_failed', repair_runs: runs } as Item;
}
const queueOf = (item: Item): Queue => ({ items: [item] }) as unknown as Queue;
const runOf = (item: Item, run: string): Rec => (item.repair_runs as Record<string, Rec>)[run]!;
const marks = (log: string[]): string[] => log.filter((l) => l.startsWith('mark:'));

async function tick(item: Item, fx: RepairHarvestEffects): Promise<void> {
  await repairHarvest(queueOf(item), item, fx);
}

describe('repairHarvest terminal replay is O(new): the settled flag', () => {
  it('replays an unsettled failed run once, flags every job, and skips it on the next tick', async () => {
    const [j1, j2] = [jobId('R', 1), jobId('R', 2)] as [string, string];
    const item = itemOf({ R: failedRun('R', [j1, j2]) });
    const w = world();
    await tick(item, w.fx);
    expect(marks(w.log)).toEqual([`mark:${j1}`, `mark:${j2}`]);
    expect(runOf(item, 'R').siblings_recorded).toEqual([j1, j2]);
    expect(replaySettled(runOf(item, 'R'))).toBe(true);

    const again = world();
    await tick(item, again.fx);
    expect(again.log).toEqual([]); // no reads, no writes: nothing replays
  });

  it('flags a job only after its write succeeded; a failed write is retried alone', async () => {
    const [j1, j2] = [jobId('R', 1), jobId('R', 2)] as [string, string];
    const item = itemOf({ R: failedRun('R', [j1, j2]) });
    const down = world({ failMark: new Set([j2]) });
    await expect(tick(item, down.fx)).rejects.toThrow('ledger down');
    expect(runOf(item, 'R').siblings_recorded).toEqual([j1]);
    expect(replaySettled(runOf(item, 'R'))).toBe(false);

    const up = world();
    await tick(item, up.fx);
    // The retained FAILED verdict of j1 re-marks idempotently (as Python's loop does); j1 is not
    // written a second time as a sibling, and j2 is the only new write.
    expect(marks(up.log)).toEqual([`mark:${j1}`, `mark:${j2}`]);
    expect(runOf(item, 'R').siblings_recorded).toEqual([j1, j2]);
  });

  it('leaves a job with an unreadable result unflagged so a later tick retries it', async () => {
    const [j1, j2] = [jobId('R', 1), jobId('R', 2)] as [string, string];
    const item = itemOf({ R: failedRun('R', [j1, j2]) });
    await tick(item, world({ unreadable: new Set([j2]) }).fx);
    expect(runOf(item, 'R').siblings_recorded).toEqual([j1]);
    const later = world();
    await tick(item, later.fx);
    expect(marks(later.log)).toEqual([`mark:${j1}`, `mark:${j2}`]);
  });

  it('counts a sibling with no canonical finding id as recorded', async () => {
    const [j1, j2] = [jobId('R', 1), jobId('R', 2)] as [string, string];
    const item = itemOf({ R: failedRun('R', [j1, j2]) });
    await tick(item, world({ noFinding: new Set([j2]) }).fx);
    expect(runOf(item, 'R').siblings_recorded).toEqual([j1, j2]);
  });

  it('flags the terminalized job before its siblings, so a sibling write failure keeps it', async () => {
    const [j1, j2] = [jobId('R', 1), jobId('R', 2)] as [string, string];
    const item = itemOf({
      R: { state: 'queued', base: 'b0', jobs: [j1, j2], verdicts: [] },
    });
    const w = world({ failMark: new Set([j2]) });
    // J1's inbox is malformed: the run terminalizes on it, then the J2 sibling write fails.
    const readJob = w.fx.readJob.bind(w.fx);
    const fx = {
      ...w.fx,
      readJob: async (id: string) => {
        if (id === j1) throw new PyError('ValueError', 'bad inbox');
        return readJob(id);
      },
    } as RepairHarvestEffects;
    await expect(tick(item, fx)).rejects.toThrow('ledger down');
    expect(runOf(item, 'R').state).toBe('failed');
    expect(runOf(item, 'R').siblings_recorded).toEqual([j1]);
  });
});

describe('repairHarvest terminal replay is bounded per tick: ReplayBudget', () => {
  const runs = (n: number): Record<string, Rec> =>
    Object.fromEntries(
      Array.from({ length: n }, (_, i) => [`R${i}`, failedRun(`R${i}`, [jobId(`R${i}`, 1)])]),
    );
  const replayed = (item: Item): string[] =>
    Object.entries(item.repair_runs as Record<string, Rec>)
      .filter(([, r]) => replaySettled(r))
      .map(([k]) => k);

  it('an unbound budget is unthrottled', async () => {
    const item = itemOf(runs(5));
    await tick(item, world().fx);
    expect(replayed(item)).toHaveLength(5);
  });

  it('replays at most `count` runs per tick, and the rest catch up on later ticks', async () => {
    const item = itemOf(runs(5));
    await tick(item, world({ budget: new ReplayBudget({ count: 2, retrySeconds: 0 }) }).fx);
    expect(replayed(item)).toEqual(['R0', 'R1']);
    await tick(item, world({ budget: new ReplayBudget({ count: 2, retrySeconds: 0 }) }).fx);
    expect(replayed(item)).toEqual(['R0', 'R1', 'R2', 'R3']);
    await tick(item, world({ budget: new ReplayBudget({ count: 2, retrySeconds: 0 }) }).fx);
    expect(replayed(item)).toHaveLength(5);
  });

  it('stops replaying once the wall-clock deadline passes', async () => {
    const item = itemOf(runs(4));
    let now = 0;
    const budget = new ReplayBudget({ count: 99, seconds: 10, retrySeconds: 0, clock: () => now });
    const w = world({ budget });
    const markFinding = w.fx.markFindingOutcome.bind(w.fx);
    const fx = {
      ...w.fx,
      markFindingOutcome: async (job: Rec, result: Rec) => {
        await markFinding(job, result);
        now += 6; // each replay costs 6 s: the second one crosses the 10 s deadline
      },
    } as RepairHarvestEffects;
    await tick(item, fx);
    expect(replayed(item)).toEqual(['R0', 'R1', 'R2'].slice(0, 2));
  });

  it('does not retry a run attempted within the backoff, so unsettleable runs cannot starve the rest', async () => {
    // R0's second job stays unreadable, so it never settles.
    const item = itemOf({
      ...runs(3),
      R0: failedRun('R0', [jobId('R0', 1), jobId('R0', 2)]),
    });
    const j0 = jobId('R0', 2);
    let wall = 1_000;
    const mk = (): ReplayBudget =>
      new ReplayBudget({ count: 1, retrySeconds: 900, wall: () => wall });
    // Make R0 unsettleable: its result is unreadable.
    await tick(item, world({ budget: mk(), unreadable: new Set([j0]) }).fx);
    expect(replayed(item)).toEqual([]);
    expect(runOf(item, 'R0').replay_attempted).toBe(1_000);
    // Within the backoff the budget moves on to R1 instead of retrying R0.
    wall = 1_100;
    await tick(item, world({ budget: mk(), unreadable: new Set([j0]) }).fx);
    expect(replayed(item)).toEqual(['R1']);
    wall = 1_200;
    await tick(item, world({ budget: mk(), unreadable: new Set([j0]) }).fx);
    expect(replayed(item)).toEqual(['R1', 'R2']);
    // Past the backoff R0 is retried.
    wall = 2_000;
    await tick(item, world({ budget: mk() }).fx);
    expect(replayed(item)).toEqual(['R0', 'R1', 'R2']);
  });

  it('leaves a settled run untouched by the budget (no stamp, no count)', async () => {
    const item = itemOf({
      R0: failedRun('R0', [jobId('R0', 1)], { siblings_recorded: [jobId('R0', 1)] }),
    });
    const budget = new ReplayBudget({ count: 1 });
    await tick(item, world({ budget }).fx);
    expect(runOf(item, 'R0').replay_attempted).toBeUndefined();
    expect(budget.take({})).toBe(true); // the one slot was never spent
  });
});
