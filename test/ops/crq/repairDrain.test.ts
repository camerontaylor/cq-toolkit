import { describe, expect, test } from 'vitest';
import { JsonNumber, JsonObject, type JsonValue } from '../../../src/policy/crq/jsonValue.js';
import {
  BACKLOG_MAX_AGE_SECONDS,
  RepairQueueUnreadableError,
  createWorkerChannel,
  drainItem,
  drainItems,
  drainOutcome,
  holdBackfillGroups,
  runRepairDrain,
  runRepairWorker,
  workerExitCode,
  workerLimit,
  type DrainJobClass,
  type RepairDrainEffects,
  type RepairWorkerHandle,
  type WorkerExit,
} from '../../../src/ops/crq/internal/repairDrain.js';
import { RUNNER_DISABLED } from '../../../src/ops/crq/internal/repairPassGates.js';

const int = (n: number): JsonNumber => JsonNumber.int(n);
const obj = (...entries: [string, JsonValue][]): JsonObject => new JsonObject(entries);
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function jobObject(id: string, item: string, run = 'r1', severity = 'major'): JsonObject {
  return obj(['job', id], ['item', item], ['run', run], ['finding', obj(['severity', severity])]);
}

interface JobSpec {
  item: string;
  run?: string;
  severity?: string;
  status?: 'run' | 'stale' | 'skip';
  reason?: string;
  unreadable?: boolean;
  pending?: boolean;
  /** `bounded.drain_job` could not read or parse the inbox file. */
  noJob?: boolean;
}

interface Options {
  jobs?: Record<string, JobSpec>;
  inbox?: string[];
  /** Sticky script of `runnerDisabled()` samples. */
  disabled?: boolean[];
  /** Sticky script of `dispatchPaused()` samples. */
  paused?: (string | null)[];
  limit?: JsonValue | undefined;
  fetchError?: string | null;
  triage?: () => Promise<JsonValue | null>;
  backlog?: JsonValue | undefined;
  nowMs?: number;
  blocked?: boolean;
  queue?: () => Promise<JsonValue>;
  processItem?: RepairDrainEffects['processItem'];
  startWorker?: RepairDrainEffects['startWorker'];
  withAdmissionLock?: RepairDrainEffects['withAdmissionLock'];
}

function rig(options: Options = {}) {
  const calls: string[] = [];
  const said: string[] = [];
  const stale: string[] = [];
  const processed: { item: string; jobs: string[] }[] = [];
  const jobs = options.jobs ?? {};
  const flags = { disabled: options.disabled ?? [false], paused: options.paused ?? [null] };
  let disabledReads = 0;
  let pausedReads = 0;
  const spec = (id: string): JobSpec => jobs[id] ?? { item: 'none', status: 'skip' };
  const effects: RepairDrainEffects = {
    runnerDisabled: async () =>
      flags.disabled[Math.min(disabledReads++, flags.disabled.length - 1)]!,
    narrate: (message) => void said.push(message),
    maxConcurrentItems: async () => ('limit' in options ? options.limit : undefined),
    dispatchPaused: async () => flags.paused[Math.min(pausedReads++, flags.paused.length - 1)]!,
    blocked: () => options.blocked ?? false,
    fetchClone: async () => (calls.push('fetch'), options.fetchError ?? null),
    triage: options.triage ?? (async () => (calls.push('triage'), null)),
    inboxOrder: async () => options.inbox ?? Object.keys(jobs),
    inboxItem: async (id) => (jobs[id]?.noJob ? undefined : jobs[id]?.item),
    readQueue: options.queue ?? (async () => obj(['items', []])),
    readBacklog: async () => options.backlog,
    nowMs: () => options.nowMs ?? Date.parse('2026-11-20T12:00:00Z'),
    classifyJob: async (_queue, id): Promise<DrainJobClass> => {
      const s = spec(id);
      if (s.noJob) return { status: 'skip', job: null, reason: 'unreadable' };
      return {
        status: s.status ?? 'run',
        job: jobObject(id, s.item, s.run, s.severity),
        reason: s.reason ?? 'no queued tick-owned repair run',
      };
    },
    unreadableResult: async (id) => spec(id).unreadable ?? false,
    pending: async (id) => spec(id).pending ?? true,
    markStale: async (job, reason) => void stale.push(`${String(job.get('job'))}:${reason}`),
    processItem:
      options.processItem ??
      (async (list) => {
        processed.push({
          item: String(list[0]!.get('item')),
          jobs: list.map((j) => String(j.get('job'))),
        });
        return null;
      }),
    withAdmissionLock: options.withAdmissionLock ?? (async (admission) => admission()),
    startWorker:
      options.startWorker ??
      ((): RepairWorkerHandle => {
        throw new Error('no worker expected');
      }),
  };
  return { effects, calls, said, stale, processed, flags };
}

const fresh = (open: number, limit: number, at = '2026-11-20T11:30:00Z'): JsonValue =>
  obj(['at', at], ['open', int(open)], ['limit', int(limit)]);

describe('workerLimit', () => {
  test('defaults to one and accepts integers 1 through 10', () => {
    expect(workerLimit(undefined)).toBe(1);
    expect(workerLimit(int(1))).toBe(1);
    expect(workerLimit(int(10))).toBe(10);
  });
  test.each<[string, JsonValue]>([
    ['zero', int(0)],
    ['eleven', int(11)],
    ['negative', int(-1)],
    ['float', JsonNumber.float(2)],
    ['boolean', true],
    ['null', null],
    ['string', '2'],
  ])('refuses %s', (_name, raw) => {
    expect(() => workerLimit(raw)).toThrow(
      'repair.max_concurrent_items must be an integer from 1 to 10',
    );
  });
});

describe('holdBackfillGroups', () => {
  const groups = () =>
    new Map<string, string[]>([
      ['backfill-finding-a', ['ja']],
      ['pr-1', ['j1']],
      ['backfill-finding-b', ['jb']],
      ['backfill-finding-c', ['jc']],
    ]);
  const now = Date.parse('2026-11-20T12:00:00Z');
  const all = async () => true;
  const hold = async (
    backlog: JsonValue | undefined,
    dispatchable: (item: string) => Promise<boolean> = all,
  ) => {
    const said: string[] = [];
    const kept = await holdBackfillGroups(groups(), backlog, now, dispatchable, (m) =>
      said.push(m),
    );
    return { kept: [...kept.keys()], said };
  };

  test('passes a pass with no backfill group through without reading the backlog', async () => {
    const plain = new Map([['pr-1', ['j1']]]);
    expect(await holdBackfillGroups(plain, undefined, now, all, () => undefined)).toBe(plain);
  });
  test('a missing or unreadable file holds every backfill group', async () => {
    expect(await hold(undefined)).toEqual({
      kept: ['pr-1'],
      said: ['backfill repair held: unknown open fix PRs, limit unknown'],
    });
    expect((await hold(JsonNumber.int(3))).kept).toEqual(['pr-1']);
  });
  test('admits limit minus open dispatchable groups in drain order', async () => {
    expect(await hold(fresh(1, 3))).toEqual({
      kept: ['backfill-finding-a', 'pr-1', 'backfill-finding-b'],
      said: ['backfill repair held: 1 open fix PRs, limit 3'],
    });
  });
  test('a group that cannot dispatch takes no slot and passes through', async () => {
    const result = await hold(fresh(2, 3), async (item) => item !== 'backfill-finding-a');
    expect(result.kept).toEqual(['backfill-finding-a', 'pr-1', 'backfill-finding-b']);
    expect(result.said).toEqual(['backfill repair held: 2 open fix PRs, limit 3']);
  });
  test('a budget that covers every dispatchable group narrates nothing', async () => {
    expect(await hold(fresh(0, 5))).toEqual({
      kept: ['backfill-finding-a', 'pr-1', 'backfill-finding-b', 'backfill-finding-c'],
      said: [],
    });
  });
  test('open at or above the limit holds every backfill group', async () => {
    expect((await hold(fresh(3, 3))).kept).toEqual(['pr-1']);
    expect((await hold(fresh(9, 3))).kept).toEqual(['pr-1']);
  });
  test.each<[string, JsonValue]>([
    ['older than the maximum age', fresh(0, 9, '2026-11-20T10:59:59Z')],
    ['dated in the future', fresh(0, 9, '2026-11-20T12:00:01Z')],
    ['a naive timestamp', fresh(0, 9, '2026-11-20T11:30:00')],
    ['an unparsable timestamp', fresh(0, 9, 'yesterday')],
    ['a non-string timestamp', obj(['at', int(5)], ['open', int(0)], ['limit', int(9)])],
    [
      'a float open count',
      obj(['at', '2026-11-20T11:30:00Z'], ['open', JsonNumber.float(0)], ['limit', int(9)]),
    ],
    ['a boolean limit', obj(['at', '2026-11-20T11:30:00Z'], ['open', int(0)], ['limit', true])],
    ['a missing open count', obj(['at', '2026-11-20T11:30:00Z'], ['limit', int(9)])],
  ])('treats %s as unknown and holds every backfill group', async (_name, backlog) => {
    expect((await hold(backlog)).kept).toEqual(['pr-1']);
  });
  test('accepts the exact maximum age and a zero-age file', async () => {
    expect(BACKLOG_MAX_AGE_SECONDS).toBe(3600);
    expect((await hold(fresh(0, 9, '2026-11-20T11:00:00Z'))).kept).toHaveLength(4);
    expect((await hold(fresh(0, 9, '2026-11-20T12:00:00Z'))).kept).toHaveLength(4);
  });
  test('reads a Z suffix as UTC', async () => {
    expect((await hold(fresh(0, 9, '2026-11-20T19:30:00+08:00'))).kept).toHaveLength(4);
  });
});

describe('drainItem', () => {
  test('a runner disabled by the item gate refuses and publishes the refusal', async () => {
    const r = rig({ disabled: [true] });
    const published: string[] = [];
    expect(await drainItem(r.effects, 'pr-1', ['j1'], () => published.push('x'))).toBe(
      'runner-disabled',
    );
    expect(published).toEqual(['x']);
    expect(r.said).toEqual([`${RUNNER_DISABLED}: item pr-1 not admitted`]);
    expect(r.processed).toEqual([]);
  });
  test('a blackout or provider pause answers rate-limit without reading the queue', async () => {
    const blocked = rig({ blocked: true, jobs: { j1: { item: 'pr-1' } } });
    expect(await drainItem(blocked.effects, 'pr-1', ['j1'], () => undefined)).toBe('rate-limit');
    const paused = rig({ paused: ['2026-11-20T13:00:00Z'], jobs: { j1: { item: 'pr-1' } } });
    expect(await drainItem(paused.effects, 'pr-1', ['j1'], () => undefined)).toBe('rate-limit');
    expect(blocked.processed.concat(paused.processed)).toEqual([]);
  });
  test('an unreadable queue skips the item, narrates it and continues the pass', async () => {
    const r = rig({
      jobs: { j1: { item: 'pr-1' } },
      queue: async () => {
        throw new RepairQueueUnreadableError('x'.repeat(400));
      },
    });
    expect(await drainItem(r.effects, 'pr-1', ['j1'], () => undefined)).toBeNull();
    expect(r.said).toEqual([`repair item pr-1 skipped: queue unreadable: ${'x'.repeat(300)}`]);
  });
  test('a queue failure that is not an unreadable read propagates', async () => {
    const r = rig({
      jobs: { j1: { item: 'pr-1' } },
      queue: async () => {
        throw new TypeError('bug');
      },
    });
    await expect(drainItem(r.effects, 'pr-1', ['j1'], () => undefined)).rejects.toThrow('bug');
  });
  test('dispatches pending jobs of the item and ignores jobs of another item', async () => {
    const r = rig({ jobs: { j1: { item: 'pr-1' }, j2: { item: 'pr-2' }, j3: { item: 'pr-1' } } });
    expect(await drainItem(r.effects, 'pr-1', ['j1', 'j2', 'j3'], () => undefined)).toBeNull();
    expect(r.processed).toEqual([{ item: 'pr-1', jobs: ['j1', 'j3'] }]);
    expect(r.said).toEqual([]);
  });
  test('marks a stale job, narrates it and keeps it in its run chain', async () => {
    const r = rig({ jobs: { j1: { item: 'pr-1', status: 'stale', reason: 'tip moved' } } });
    await drainItem(r.effects, 'pr-1', ['j1'], () => undefined);
    expect(r.stale).toEqual(['j1:tip moved']);
    expect(r.said).toEqual(['repair j1: stale, not dispatched: tip moved']);
    expect(r.processed).toEqual([{ item: 'pr-1', jobs: ['j1'] }]);
  });
  test('narrates a skipped job except for the no-queued-run reason', async () => {
    const r = rig({
      jobs: {
        j1: { item: 'pr-1', status: 'skip', reason: 'already published' },
        j2: { item: 'pr-1', status: 'skip', reason: 'no queued tick-owned repair run' },
      },
    });
    expect(await drainItem(r.effects, 'pr-1', ['j1', 'j2'], () => undefined)).toBeNull();
    expect(r.said).toEqual(['repair j1: skipped: already published']);
    expect(r.processed).toEqual([]);
  });
  test('a job with no readable object is passed over silently', async () => {
    const r = rig({ jobs: { j1: { item: 'pr-1', noJob: true } } });
    expect(await drainItem(r.effects, 'pr-1', ['j1'], () => undefined)).toBeNull();
    expect(r.said).toEqual([]);
  });
  test('an unreadable result.json holds its whole run and lets other runs proceed', async () => {
    const r = rig({
      jobs: {
        j1: { item: 'pr-1', run: 'r1', unreadable: true },
        j2: { item: 'pr-1', run: 'r1' },
        j3: { item: 'pr-1', run: 'r2' },
      },
    });
    await drainItem(r.effects, 'pr-1', ['j1', 'j2', 'j3'], () => undefined);
    expect(r.said).toEqual([
      'repair j1: skipped: unreadable result.json preserved for tick reconciliation',
      'repair run r1: held: a job has an unreadable result.json',
    ]);
    expect(r.processed).toEqual([{ item: 'pr-1', jobs: ['j3'] }]);
  });
  test('held runs are narrated in sorted order', async () => {
    const r = rig({
      jobs: {
        j1: { item: 'pr-1', run: 'rb', unreadable: true },
        j2: { item: 'pr-1', run: 'ra', unreadable: true },
      },
    });
    await drainItem(r.effects, 'pr-1', ['j1', 'j2'], () => undefined);
    expect(r.said.slice(2)).toEqual([
      'repair run ra: held: a job has an unreadable result.json',
      'repair run rb: held: a job has an unreadable result.json',
    ]);
  });
  test('does nothing when no job is still pending', async () => {
    const r = rig({ jobs: { j1: { item: 'pr-1', pending: false } } });
    expect(await drainItem(r.effects, 'pr-1', ['j1'], () => undefined)).toBeNull();
    expect(r.processed).toEqual([]);
  });
  test('a failed item is narrated and never stops the others', async () => {
    const r = rig({
      jobs: { j1: { item: 'pr-1' } },
      processItem: async () => {
        throw new Error('y'.repeat(400));
      },
    });
    expect(await drainItem(r.effects, 'pr-1', ['j1'], () => undefined)).toBeNull();
    expect(r.said).toEqual([`repair item pr-1 failed: ${'y'.repeat(300)}`]);
  });
  test('passes the item outcome and the refusal publisher through', async () => {
    const published: string[] = [];
    const r = rig({
      jobs: { j1: { item: 'pr-1' } },
      processItem: async (_jobs, context) => {
        context.publishRefusal();
        return 'runner-disabled';
      },
    });
    expect(await drainItem(r.effects, 'pr-1', ['j1'], () => published.push('x'))).toBe(
      'runner-disabled',
    );
    expect(published).toEqual(['x']);
  });
});

describe('runRepairDrain admission', () => {
  test('a disabled runner refuses the pass before any read or effect', async () => {
    const r = rig({ disabled: [true], jobs: { j1: { item: 'pr-1' } } });
    expect(await runRepairDrain(r.effects)).toBeNull();
    expect(r.calls).toEqual([]);
    expect(r.said).toEqual([`${RUNNER_DISABLED}: pass not started`]);
  });
  test('an invalid concurrency limit throws before the pause check, fetch or triage', async () => {
    for (const limit of [int(0), int(11), JsonNumber.float(2), true, null] as const) {
      const r = rig({ limit });
      await expect(runRepairDrain(r.effects)).rejects.toThrow(
        'repair.max_concurrent_items must be an integer from 1 to 10',
      );
      expect(r.calls).toEqual([]);
    }
  });
  test('a provider pause skips the pass before any fetch', async () => {
    const r = rig({ paused: ['2026-11-20T13:00:00Z'] });
    expect(await runRepairDrain(r.effects)).toBeNull();
    expect(r.calls).toEqual([]);
    expect(r.said).toEqual(['repair drain paused: provider rate limit until 2026-11-20T13:00:00Z']);
  });
  test('a failed fetch skips the pass and truncates its error to 200 characters', async () => {
    const r = rig({ fetchError: 'f'.repeat(300) });
    expect(await runRepairDrain(r.effects)).toBeNull();
    expect(r.calls).toEqual(['fetch']);
    expect(r.said).toEqual([`repair drain skipped: ${'f'.repeat(200)}`]);
  });
  test('a marker written during the fetch stops the pass before triage', async () => {
    const r = rig({ disabled: [false, true] });
    expect(await runRepairDrain(r.effects)).toBeNull();
    expect(r.calls).toEqual(['fetch']);
    expect(r.said).toEqual([`${RUNNER_DISABLED}: pass stopped before triage`]);
  });
  test('a triage failure defers triage and never the pass', async () => {
    const r = rig({
      triage: async () => {
        throw new Error('z'.repeat(400));
      },
      jobs: { j1: { item: 'pr-1' } },
    });
    expect(await runRepairDrain(r.effects)).toEqual({ status: 'drained' });
    expect(r.said).toEqual([`backfill triage deferred: ${'z'.repeat(300)}`]);
    expect(r.processed).toEqual([{ item: 'pr-1', jobs: ['j1'] }]);
  });
  test('the triage report rides inside the one result', async () => {
    const report = obj(['stopped', 'none']);
    const r = rig({ triage: async () => report, jobs: { j1: { item: 'pr-1' } } });
    expect(await runRepairDrain(r.effects)).toEqual({ status: 'drained', triage: report });
  });
  test('a pause after triage returns the result without admitting any item', async () => {
    const report = obj(['stopped', 'rate-limit']);
    const r = rig({
      paused: [null, '2026-11-20T13:00:00Z'],
      triage: async () => report,
      jobs: { j1: { item: 'pr-1' } },
    });
    expect(await runRepairDrain(r.effects)).toEqual({ status: 'drained', triage: report });
    expect(r.processed).toEqual([]);
  });
});

describe('runRepairDrain queue and ordering', () => {
  test('an unreadable queue keeps the triage report in one error artifact, admitting nothing', async () => {
    const report = obj(['stopped', 'none']);
    const r = rig({
      triage: async () => report,
      jobs: { j1: { item: 'pr-1' } },
      queue: async () => {
        throw new RepairQueueUnreadableError('q'.repeat(400));
      },
    });
    const result = await runRepairDrain(r.effects);
    expect(result).toEqual({
      status: 'error',
      triage: report,
      error: `queue unreadable: ${'q'.repeat(300)}`,
    });
    expect(Object.keys(result!)).toEqual(['status', 'triage', 'error']);
    expect(r.said).toEqual([`repair drain failed: queue unreadable: ${'q'.repeat(300)}`]);
    expect(r.processed).toEqual([]);
    expect(drainOutcome(result)).toEqual({ exitCode: 1, artifact: result });
  });
  test('a queue failure that is not an unreadable read propagates as a bug', async () => {
    const r = rig({
      queue: async () => {
        throw new TypeError('bug');
      },
    });
    await expect(runRepairDrain(r.effects)).rejects.toThrow('bug');
  });
  test('groups the inbox by item in the order of its oldest job', async () => {
    const r = rig({
      jobs: {
        a1: { item: 'pr-a' },
        b1: { item: 'pr-b' },
        a2: { item: 'pr-a' },
        x: { item: 'pr-x', noJob: true },
      },
      inbox: ['a1', 'b1', 'a2', 'x'],
    });
    await runRepairDrain(r.effects);
    expect(r.processed).toEqual([
      { item: 'pr-a', jobs: ['a1', 'a2'] },
      { item: 'pr-b', jobs: ['b1'] },
    ]);
  });
  test('drains critical and major items before minor-only items, keeping inbox order otherwise', async () => {
    const r = rig({
      jobs: {
        m1: { item: 'minor-1', severity: 'minor' },
        k1: { item: 'major-1', severity: 'major' },
        m2: { item: 'minor-2', severity: 'minor' },
        c1: { item: 'crit-1', severity: 'critical' },
      },
    });
    await runRepairDrain(r.effects);
    expect(r.processed.map((p) => p.item)).toEqual(['major-1', 'crit-1', 'minor-1', 'minor-2']);
  });
  test('a stale, completed or unreadable major job cannot promote a minor-only item', async () => {
    const r = rig({
      jobs: {
        a: { item: 'item-a', severity: 'minor' },
        b: { item: 'item-b', severity: 'major', status: 'stale', reason: 'moved' },
        c: { item: 'item-c', severity: 'major', pending: false },
        d: { item: 'item-d', severity: 'major', unreadable: true },
        e: { item: 'item-e', severity: 'major', status: 'skip' },
      },
    });
    await runRepairDrain(r.effects);
    expect(r.processed.map((p) => p.item)).toEqual(['item-a', 'item-b']);
    expect(r.stale).toEqual(['b:moved']);
  });
  test('a held backfill group is neither processed nor marked stale', async () => {
    const r = rig({
      jobs: { b1: { item: 'backfill-finding-1' }, p1: { item: 'pr-1' } },
      backlog: fresh(5, 5),
    });
    await runRepairDrain(r.effects);
    expect(r.processed).toEqual([{ item: 'pr-1', jobs: ['p1'] }]);
    expect(r.stale).toEqual([]);
    expect(r.said).toEqual(['backfill repair held: 5 open fix PRs, limit 5']);
  });
  test('a backfill group with no runnable job takes no budget slot', async () => {
    const r = rig({
      jobs: {
        b1: { item: 'backfill-finding-1', pending: false },
        b2: { item: 'backfill-finding-2' },
        b3: { item: 'backfill-finding-3' },
      },
      backlog: fresh(2, 3),
    });
    await runRepairDrain(r.effects);
    expect(r.processed.map((p) => p.item)).toEqual(['backfill-finding-2']);
    expect(r.said).toEqual(['backfill repair held: 2 open fix PRs, limit 3']);
  });
  test('a rate-limit outcome stops the serial pass before the next item', async () => {
    const r = rig({
      jobs: { a: { item: 'pr-a' }, b: { item: 'pr-b' } },
      processItem: async (list) => {
        r.processed.push({ item: String(list[0]!.get('item')), jobs: [] });
        return 'rate-limit';
      },
    });
    expect(await runRepairDrain(r.effects)).toEqual({ status: 'drained' });
    expect(r.processed.map((p) => p.item)).toEqual(['pr-a']);
  });
  test('a runner-disabled outcome stops the serial pass before the next item', async () => {
    const r = rig({
      jobs: { a: { item: 'pr-a' }, b: { item: 'pr-b' } },
      processItem: async (list) => {
        r.processed.push({ item: String(list[0]!.get('item')), jobs: [] });
        return 'runner-disabled';
      },
    });
    await runRepairDrain(r.effects);
    expect(r.processed.map((p) => p.item)).toEqual(['pr-a']);
  });
  test('a marker written while an item runs stops the next admission, not the running item', async () => {
    const r = rig({
      jobs: { a: { item: 'pr-a' }, b: { item: 'pr-b' } },
      processItem: async (list) => {
        r.processed.push({ item: String(list[0]!.get('item')), jobs: [] });
        r.flags.disabled = [true];
        return null;
      },
    });
    await runRepairDrain(r.effects);
    expect(r.processed.map((p) => p.item)).toEqual(['pr-a']);
    expect(r.said).toEqual([`${RUNNER_DISABLED}: pass stopped before pr-b`]);
  });
  test('a blackout stops the pass before the first item', async () => {
    const r = rig({ blocked: true, jobs: { a: { item: 'pr-a' } } });
    expect(await runRepairDrain(r.effects)).toEqual({ status: 'drained' });
    expect(r.processed).toEqual([]);
  });
  test('an item that fails never stops the remaining items', async () => {
    const r = rig({
      jobs: { a: { item: 'pr-a' }, b: { item: 'pr-b' } },
      processItem: async (list) => {
        const item = String(list[0]!.get('item'));
        r.processed.push({ item, jobs: [] });
        if (item === 'pr-a') throw new Error('boom');
        return null;
      },
    });
    await runRepairDrain(r.effects);
    expect(r.processed.map((p) => p.item)).toEqual(['pr-a', 'pr-b']);
    expect(r.said).toEqual(['repair item pr-a failed: boom']);
  });
  test('an empty inbox drains cleanly', async () => {
    const r = rig();
    expect(drainOutcome(await runRepairDrain(r.effects))).toEqual({
      exitCode: 0,
      artifact: { status: 'drained' },
    });
  });
  test('a narrated early exit reports the drained artifact with exit code zero', () => {
    expect(drainOutcome(null)).toEqual({ exitCode: 0, artifact: { status: 'drained' } });
  });
});

describe('worker channel and body', () => {
  test('the first signal is the barrier verdict; later refusals are drained once', async () => {
    const channel = createWorkerChannel();
    channel.publish('admitted');
    expect(await channel.admitted).toBe(true);
    expect(channel.takeRefusal()).toBe(false);
    channel.publish('refused');
    channel.publish('refused');
    expect(channel.takeRefusal()).toBe(true);
    expect(channel.takeRefusal()).toBe(false);
  });
  test('a first refusal is a refused barrier', async () => {
    const channel = createWorkerChannel();
    channel.publish('refused');
    expect(await channel.admitted).toBe(false);
    expect(channel.takeRefusal()).toBe(false);
  });
  test('closing before any signal reads as end-of-file: not admitted', async () => {
    const channel = createWorkerChannel();
    channel.close();
    expect(await channel.admitted).toBe(false);
    channel.close();
    channel.publish('admitted');
    expect(await channel.admitted).toBe(false);
  });
  test('close after a verdict changes nothing', async () => {
    const channel = createWorkerChannel();
    channel.publish('admitted');
    channel.close();
    expect(await channel.admitted).toBe(true);
  });
  test('exit codes: 2 provider pause, 3 runner disabled, otherwise 0', () => {
    expect(workerExitCode('rate-limit')).toBe(2);
    expect(workerExitCode('runner-disabled')).toBe(3);
    expect(workerExitCode(null)).toBe(0);
  });
  test('a refused worker publishes before doing anything and exits 3', async () => {
    const r = rig({ disabled: [true], jobs: { j1: { item: 'pr-1' } } });
    const channel = createWorkerChannel();
    expect(await runRepairWorker(r.effects, 'pr-1', ['j1'], channel)).toBe(3);
    expect(await channel.admitted).toBe(false);
    expect(r.processed).toEqual([]);
    expect(r.said).toEqual([`${RUNNER_DISABLED}: item pr-1 not admitted`]);
  });
  test('an admitted worker publishes admitted, drains its item and exits 0', async () => {
    const r = rig({ jobs: { j1: { item: 'pr-1' } } });
    const channel = createWorkerChannel();
    expect(await runRepairWorker(r.effects, 'pr-1', ['j1'], channel)).toBe(0);
    expect(await channel.admitted).toBe(true);
    expect(r.processed).toEqual([{ item: 'pr-1', jobs: ['j1'] }]);
  });
  test('a marker written between the worker gate and the item gate publishes a refusal and exits 3', async () => {
    const r = rig({ disabled: [false, true], jobs: { j1: { item: 'pr-1' } } });
    const channel = createWorkerChannel();
    expect(await runRepairWorker(r.effects, 'pr-1', ['j1'], channel)).toBe(3);
    expect(await channel.admitted).toBe(true);
    expect(channel.takeRefusal()).toBe(true);
    expect(r.processed).toEqual([]);
  });
  test('a provider pause inside the item exits 2', async () => {
    const r = rig({ paused: ['2026-11-20T13:00:00Z'], jobs: { j1: { item: 'pr-1' } } });
    expect(await runRepairWorker(r.effects, 'pr-1', ['j1'], createWorkerChannel())).toBe(2);
  });
  test('a failed item exits 0 and an unexpected exception exits 1', async () => {
    const failed = rig({
      jobs: { j1: { item: 'pr-1' } },
      processItem: async () => {
        throw new Error('boom');
      },
    });
    expect(await runRepairWorker(failed.effects, 'pr-1', ['j1'], createWorkerChannel())).toBe(0);
    const crashed = rig({
      jobs: { j1: { item: 'pr-1' } },
      queue: async () => {
        throw new TypeError('bug');
      },
    });
    expect(await runRepairWorker(crashed.effects, 'pr-1', ['j1'], createWorkerChannel())).toBe(1);
  });
  test('a refusal published by the item body reaches the coordinator read end', async () => {
    const r = rig({
      jobs: { j1: { item: 'pr-1' } },
      processItem: async (_jobs, context) => {
        context.publishRefusal();
        return 'runner-disabled';
      },
    });
    const channel = createWorkerChannel();
    expect(await runRepairWorker(r.effects, 'pr-1', ['j1'], channel)).toBe(3);
    expect(channel.takeRefusal()).toBe(true);
  });
});

interface ManualWorker {
  readonly item: string;
  readonly channel: ReturnType<typeof createWorkerChannel>;
  finish(exit: WorkerExit): void;
  fail(): void;
}

/** Workers the test drives by hand, in place of forked children. */
function manualWorkers() {
  const workers: ManualWorker[] = [];
  const start = (item: string): RepairWorkerHandle => {
    const channel = createWorkerChannel();
    let finish: (exit: WorkerExit) => void = () => undefined;
    let fail: () => void = () => undefined;
    const exit = new Promise<WorkerExit>((resolve, reject) => {
      finish = resolve;
      fail = () => reject(new Error('wait failed'));
    });
    workers.push({ item, channel, finish, fail });
    return { admitted: channel.admitted, takeRefusal: () => channel.takeRefusal(), exit };
  };
  return { workers, start, started: () => workers.map((w) => w.item) };
}

const groupsOf = (...items: string[]) => new Map(items.map((item) => [item, [`${item}-job`]]));

describe('drainItems concurrency', () => {
  test('runs up to the limit, waits at the cap and admits the next item after a reap', async () => {
    const m = manualWorkers();
    const r = rig({ startWorker: (item) => m.start(item) });
    const done = drainItems(r.effects, groupsOf('a', 'b', 'c'), ['a', 'b', 'c'], 2);
    await flush();
    expect(m.started()).toEqual(['a']);
    m.workers[0]!.channel.publish('admitted');
    await flush();
    m.workers[1]!.channel.publish('admitted');
    await flush();
    expect(m.started()).toEqual(['a', 'b']);
    m.workers[0]!.finish({ kind: 'exit', code: 0 });
    await flush();
    expect(m.started()).toEqual(['a', 'b', 'c']);
    m.workers[2]!.channel.publish('admitted');
    m.workers[1]!.finish({ kind: 'exit', code: 0 });
    m.workers[2]!.finish({ kind: 'exit', code: 0 });
    await done;
    expect(r.said).toEqual([]);
  });
  test('never has more than the limit in flight', async () => {
    let live = 0;
    let peak = 0;
    const r = rig({
      jobs: Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map((i) => [`${i}-job`, { item: i }])),
    });
    const effects: RepairDrainEffects = {
      ...r.effects,
      startWorker: (item) => {
        live += 1;
        peak = Math.max(peak, live);
        const channel = createWorkerChannel();
        const exit = runRepairWorker(r.effects, item, [`${item}-job`], channel).then(
          async (code): Promise<WorkerExit> => {
            await flush();
            live -= 1;
            channel.close();
            return { kind: 'exit', code };
          },
        );
        return { admitted: channel.admitted, takeRefusal: () => channel.takeRefusal(), exit };
      },
    };
    await drainItems(effects, groupsOf('a', 'b', 'c', 'd', 'e'), ['a', 'b', 'c', 'd', 'e'], 3);
    expect(peak).toBe(3);
    expect(live).toBe(0);
    expect(r.processed.map((p) => p.item).sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
  test('a refusal published after admission stops the next admission before the exit status', async () => {
    const m = manualWorkers();
    const r = rig({ startWorker: (item) => m.start(item) });
    const done = drainItems(r.effects, groupsOf('a', 'b'), ['a', 'b'], 2);
    await flush();
    m.workers[0]!.channel.publish('admitted');
    m.workers[0]!.channel.publish('refused');
    await flush();
    expect(m.started()).toEqual(['a']);
    m.workers[0]!.finish({ kind: 'exit', code: 3 });
    await done;
    expect(r.said).toEqual(['repair item a: runner disabled; stopping new admission']);
  });
  test('a worker refused at its own gate latches the stop', async () => {
    const m = manualWorkers();
    const r = rig({ startWorker: (item) => m.start(item) });
    const done = drainItems(r.effects, groupsOf('a', 'b'), ['a', 'b'], 2);
    await flush();
    m.workers[0]!.channel.publish('refused');
    m.workers[0]!.finish({ kind: 'exit', code: 3 });
    await done;
    expect(m.started()).toEqual(['a']);
  });
  test('a worker that dies before publishing reads as end-of-file and stops admission', async () => {
    const m = manualWorkers();
    const r = rig({ startWorker: (item) => m.start(item) });
    const done = drainItems(r.effects, groupsOf('a', 'b'), ['a', 'b'], 2);
    await flush();
    m.workers[0]!.channel.close();
    m.workers[0]!.finish({ kind: 'exit', code: 1 });
    await done;
    expect(m.started()).toEqual(['a']);
    expect(r.said).toEqual(['repair item a: worker exited with code 1']);
  });
  test.each<[string, WorkerExit, string]>([
    ['a provider pause', { kind: 'exit', code: 2 }, 'provider pause; stopping new admission'],
    [
      'a runner-disabled exit',
      { kind: 'exit', code: 3 },
      'runner disabled; stopping new admission',
    ],
    ['another exit code', { kind: 'exit', code: 7 }, 'worker exited with code 7'],
    ['a signal', { kind: 'signal', signal: 9 }, 'worker terminated by signal 9'],
    [
      'a lost status',
      { kind: 'lost' },
      'worker exit status lost to an interrupt; stopping new admission',
    ],
  ])('%s stops new admission and is narrated', async (_name, exit, message) => {
    const m = manualWorkers();
    const r = rig({ startWorker: (item) => m.start(item) });
    const done = drainItems(r.effects, groupsOf('a', 'b', 'c'), ['a', 'b', 'c'], 2);
    await flush();
    m.workers[0]!.channel.publish('admitted');
    await flush();
    m.workers[1]!.channel.publish('admitted');
    await flush();
    m.workers[0]!.finish(exit);
    await flush();
    m.workers[1]!.finish({ kind: 'exit', code: 0 });
    await done;
    expect(m.started()).toEqual(['a', 'b']);
    expect(r.said).toEqual([`repair item a: ${message}`]);
  });
  test('a rejected exit wait is a lost status, not a crash', async () => {
    const m = manualWorkers();
    const r = rig({ startWorker: (item) => m.start(item) });
    const done = drainItems(r.effects, groupsOf('a'), ['a'], 2);
    await flush();
    m.workers[0]!.channel.publish('admitted');
    m.workers[0]!.fail();
    await done;
    expect(m.started()).toEqual(['a']);
    expect(r.said).toEqual([
      'repair item a: worker exit status lost to an interrupt; stopping new admission',
    ]);
  });
  test('a marker that appears while the pass waits at the cap stops the next admission', async () => {
    const m = manualWorkers();
    const r = rig({ startWorker: (item) => m.start(item), disabled: [false] });
    const done = drainItems(r.effects, groupsOf('a', 'b', 'c'), ['a', 'b', 'c'], 2);
    await flush();
    m.workers[0]!.channel.publish('admitted');
    await flush();
    m.workers[1]!.channel.publish('admitted');
    await flush();
    r.flags.disabled = [true];
    m.workers[0]!.finish({ kind: 'exit', code: 0 });
    await flush();
    expect(m.started()).toEqual(['a', 'b']);
    expect(r.said).toEqual([`${RUNNER_DISABLED}: pass stopped before c`]);
    m.workers[1]!.finish({ kind: 'exit', code: 0 });
    await done;
  });
  test('a provider pause written under the admission lock starts no worker', async () => {
    const m = manualWorkers();
    const r = rig({
      startWorker: (item) => m.start(item),
      paused: [null, '2026-11-20T13:00:00Z'],
    });
    await drainItems(r.effects, groupsOf('a'), ['a'], 2);
    expect(m.started()).toEqual([]);
  });
  test('re-samples a marker under the lock and starts no worker', async () => {
    const m = manualWorkers();
    const r = rig({
      startWorker: (item) => m.start(item),
      disabled: [false, true],
    });
    await drainItems(r.effects, groupsOf('a'), ['a'], 2);
    expect(m.started()).toEqual([]);
    expect(r.said).toEqual([`${RUNNER_DISABLED}: pass stopped before a`]);
  });
  test('holds the admission lock across the admission only, never across the work', async () => {
    const m = manualWorkers();
    const events: string[] = [];
    const r = rig({
      startWorker: (item) => (events.push(`start:${item}`), m.start(item)),
      withAdmissionLock: async (admission) => {
        events.push('lock');
        try {
          return await admission();
        } finally {
          events.push('unlock');
        }
      },
    });
    const done = drainItems(r.effects, groupsOf('a', 'b'), ['a', 'b'], 2);
    await flush();
    m.workers[0]!.channel.publish('admitted');
    await flush();
    m.workers[1]!.channel.publish('admitted');
    m.workers[0]!.finish({ kind: 'exit', code: 0 });
    m.workers[1]!.finish({ kind: 'exit', code: 0 });
    await done;
    expect(events).toEqual(['lock', 'start:a', 'unlock', 'lock', 'start:b', 'unlock']);
  });
  test('reaps an admitted worker before an admission failure unwinds, never killing it', async () => {
    const m = manualWorkers();
    let locks = 0;
    const r = rig({
      startWorker: (item) => m.start(item),
      withAdmissionLock: async (admission) => {
        locks += 1;
        if (locks === 2) throw new Error('lock failed');
        return admission();
      },
    });
    let settled = false;
    const done = drainItems(r.effects, groupsOf('a', 'b'), ['a', 'b'], 2).then(
      () => (settled = true),
      (error: Error) => ((settled = true), error.message),
    );
    await flush();
    m.workers[0]!.channel.publish('admitted');
    await flush();
    expect(settled).toBe(false);
    m.workers[0]!.finish({ kind: 'exit', code: 0 });
    expect(await done).toBe('lock failed');
    expect(m.started()).toEqual(['a']);
  });
  test('a worker registered during the barrier is reaped when the barrier fails', async () => {
    const m = manualWorkers();
    const r = rig({
      startWorker: (item) => {
        const handle = m.start(item);
        return { ...handle, admitted: Promise.reject(new Error('barrier read failed')) };
      },
    });
    let settled = false;
    const done = drainItems(r.effects, groupsOf('a', 'b'), ['a', 'b'], 2).then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);
    m.workers[0]!.finish({ kind: 'exit', code: 0 });
    await done;
    expect(m.started()).toEqual(['a']);
  });
  test('a blackout stops admission before any worker starts', async () => {
    const m = manualWorkers();
    const r = rig({ startWorker: (item) => m.start(item), blocked: true });
    await drainItems(r.effects, groupsOf('a'), ['a'], 3);
    expect(m.started()).toEqual([]);
  });
});

describe('drainItems serial path', () => {
  test('limit one runs items in-process in order and never forks', async () => {
    const r = rig({ jobs: { a1: { item: 'a' }, b1: { item: 'b' } } });
    await drainItems(
      r.effects,
      new Map([
        ['a', ['a1']],
        ['b', ['b1']],
      ]),
      ['a', 'b'],
      1,
    );
    expect(r.processed.map((p) => p.item)).toEqual(['a', 'b']);
  });
  test('the coordinator gate runs before each item', async () => {
    const r = rig({ jobs: { a1: { item: 'a' } }, disabled: [true] });
    await drainItems(r.effects, new Map([['a', ['a1']]]), ['a'], 1);
    expect(r.processed).toEqual([]);
    expect(r.said).toEqual([`${RUNNER_DISABLED}: pass stopped before a`]);
  });
});
