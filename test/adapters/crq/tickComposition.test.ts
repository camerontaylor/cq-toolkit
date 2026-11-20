import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { composeSlot } from '../../../src/adapters/crq/composeTick.js';
import { fileHarvestRunReads } from '../../../src/adapters/crq/harvestRunReads.js';
import {
  composeFullTick,
  INPUT_GAPS,
  STAGED_GAPS,
  TickGapError,
  type TickCompositionInput,
} from '../../../src/adapters/crq/tickComposition.js';
import { JsonObject, parseJsonValue, toPlainJson } from '../../../src/policy/crq/jsonValue.js';
import { TICK_MISSING_EFFECTS } from '../../../src/queue-runner/tick.js';
import type { HarvestReviewEffects } from '../../../src/queue-runner/harvestReview.js';
import { runTick, type TickInput } from '../../../src/queue-runner/tickOrchestrator.js';

const doc = (v: unknown): JsonObject => parseJsonValue(JSON.stringify(v)) as JsonObject;
const plain = (
  q: JsonObject,
): Record<string, unknown> & { items: Array<Record<string, unknown>> } => toPlainJson(q) as never;
const NOW = Date.parse('2027-01-15T08:00:00Z');
const dir = (): string => mkdtempSync(join(tmpdir(), 'tick-composition-'));
const DEAD_PID = 2_147_000_000; // beyond pid_max: ESRCH, so never alive

/** A local bare `origin`, so `git fetch --prune --quiet origin` stays offline. */
function offlineClone(): string {
  const base = dir();
  const bare = join(base, 'origin.git');
  const clone = join(base, 'clone');
  execFileSync('git', ['init', '--bare', '--quiet', bare]);
  execFileSync('git', ['init', '--quiet', clone]);
  execFileSync('git', ['-C', clone, 'remote', 'add', 'origin', bare]);
  return clone;
}

const unusedGh = (() => {
  throw new Error('no forge call is allowed in this test');
}) as never;

interface Rig {
  readonly root: string;
  readonly calls: string[];
  readonly input: TickCompositionInput;
  readonly queuePath: string;
}

function rig(
  queue: unknown = { items: [], starts: [], last_tick: '2027-01-15T07:59:00Z' },
  over: Partial<TickCompositionInput> = {},
): Rig {
  const root = dir();
  const home = dir();
  const calls: string[] = [];
  const queuePath = join(root, 'queue.json');
  writeFileSync(queuePath, JSON.stringify(queue, null, 2) + '\n');
  const input: TickCompositionInput = {
    stateRoot: root,
    config: doc({ schedule_id: 'sched', alerts: { alert_agent_id: 'a' } }),
    clone: offlineClone(),
    watchdogHome: home,
    root: '/r',
    runnerRoot: root,
    repo: 'o/r',
    now: () => NOW,
    usageProbes: {
      vendorProgress: async () => false,
      readUsage: async () => ({ remaining: 1 }),
    },
    delivery: {
      gh: unusedGh,
      authenticate: () => {
        throw new Error('auth');
      },
      files: { readBytes: () => new Uint8Array() } as never,
      readText: () => '',
      primaryRepo: 'o/r',
      push: {} as never,
    },
    admit: {
      config: { maxStartsPerHour: 5, maxStartsPerTick: 10, maxInflight: 10 },
      nowMicros: () => BigInt(NOW) * 1000n,
      startOne: async (q) => {
        calls.push('startOne');
        return { queue: q, log: ['started'], hasCoverage: true };
      },
    },
    ...over,
  };
  return { root, calls, input, queuePath };
}

const TICK: TickInput = {
  dry: false,
  only: null,
  ignoreQuiet: false,
  staleAlarmMin: 36,
  statusPath: 'status.md',
};

describe('gap registry', () => {
  it('keeps TICK_MISSING_EFFECTS in step with STAGED_GAPS', () => {
    expect(TICK_MISSING_EFFECTS.map((row) => row.split(':')[0])).toEqual(
      STAGED_GAPS.map((gap) => gap.id),
    );
    expect(new Set(STAGED_GAPS.map((gap) => gap.id)).size).toBe(STAGED_GAPS.length);
  });

  it('is never complete while a staged gap is open', () => {
    expect(STAGED_GAPS.length).toBeGreaterThan(0);
    expect(composeFullTick(rig().input).complete).toBe(false);
  });
});

describe('composeFullTick with no optional inputs', () => {
  it('reports every input gap and the staged list', () => {
    const c = composeFullTick(rig().input);
    // `startOne` is supplied by the rig, so it is the one input gap that is closed.
    expect(c.unbound.map((g) => g.id).sort()).toEqual(
      Object.keys(INPUT_GAPS)
        .filter((id) => id !== 'startOne')
        .sort(),
    );
    expect(c.staged).toBe(STAGED_GAPS);
  });

  it('binds every gap phase to a TickGapError, never a no-op', async () => {
    const c = composeFullTick(rig().input);
    const q = doc({ items: [] });
    const failing: Array<[string, () => Promise<unknown>, string]> = [
      ['discovery', () => c.phases.discovery(q), 'discovery'],
      ['enrollPrimary', () => c.phases.enrollPrimary(q, false), 'discovery'],
      ['enrollOthers', () => c.phases.enrollOthers(q, false), 'discovery'],
      ['resetFixPrBacklog', () => Promise.resolve(c.phases.resetFixPrBacklog()), 'fixPrBacklog'],
      ['refreshFixPrBacklog', () => c.phases.refreshFixPrBacklog(q), 'fixPrBacklog'],
      ['harvestItems', () => c.phases.harvestItems(q, false), 'harvest'],
      ['reconcileCompleted', () => c.phases.reconcileCompleted(q), 'harvest'],
      ['collectFinished', () => c.collectFinished(q), 'harvest'],
      ['repairBackfill', () => c.phases.repairBackfill(q), 'repairBackfill'],
      ['archiveLegacy', () => c.phases.archiveLegacy(q), 'repairBackfill'],
      ['writeStatus', () => c.phases.writeStatus(q), 'reporting'],
      ['publishLocalReviewPr', () => c.phases.publishLocalReviewPr(q), 'reporting'],
      ['recordClientHealth', () => c.phases.recordClientHealth(q, false), 'reporting'],
    ];
    for (const [name, call, gap] of failing) {
      const error = await call().then(
        () => null,
        (e: unknown) => e,
      );
      expect(error, name).toBeInstanceOf(TickGapError);
      expect((error as TickGapError).gap.id, name).toBe(gap);
    }
  });

  it('keeps backfill always bound: with no rollout the publish and mode phases are inert', async () => {
    const c = composeFullTick(rig().input);
    const q = doc({ items: [] });
    expect(await c.phases.backfillInventoryMode()).toBeNull();
    expect(plain(await c.phases.backfillPublish(q))).toEqual(plain(q));
  });

  it('names the open startOne gap when admit.startOne is absent', () => {
    const base = rig();
    const { startOne: _drop, ...admit } = base.input.admit;
    const c = composeFullTick({ ...base.input, admit });
    expect(c.unbound.map((g) => g.id)).toContain('startOne');
  });
});

describe('fix-PR backlog', () => {
  const withRepair = doc({
    items: [{ id: 'backfill-finding-1', kind: 'backfill', state: 'done', repair_runs: [{ n: 1 }] }],
  });

  it('refreshes from the injected listing under one request when a backfill repair is present', async () => {
    let listed = 0;
    const s = rig(undefined, {
      fixPrBacklog: {
        listOpenPrs: async () => (
          listed++,
          [{ headRefName: 'crq/fix-backfill-abc' }, { headRefName: 'main' }]
        ),
      },
    });
    const c = composeFullTick(s.input);
    expect(c.unbound.map((g) => g.id)).not.toContain('fixPrBacklog');
    await c.phases.resetFixPrBacklog();
    await c.phases.refreshFixPrBacklog(withRepair);
    const file = join(s.root, 'repair', 'fix-pr-backlog.json');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ open: 1 });
    expect(listed).toBe(1);
    expect(c.backlog.open).toBe(1);
    // Reset forgets the count: creation holds until the next refresh.
    await c.phases.resetFixPrBacklog();
    expect(c.backlog.open).toBeNull();
  });

  it('makes no forge call, and writes nothing, when no backfill repair is present', async () => {
    let listed = 0;
    const s = rig(undefined, {
      fixPrBacklog: { listOpenPrs: async () => (listed++, []) },
    });
    const c = composeFullTick(s.input);
    await c.phases.refreshFixPrBacklog(
      doc({ items: [{ id: 'a', kind: 'open', state: 'pending' }] }),
    );
    expect(listed).toBe(0);
    expect(existsSync(join(s.root, 'repair', 'fix-pr-backlog.json'))).toBe(false);
  });

  it('a failed listing leaves the view unread and does not abandon the tick', async () => {
    const s = rig(undefined, {
      fixPrBacklog: {
        listOpenPrs: async () => {
          throw new Error('gh down');
        },
      },
    });
    const c = composeFullTick(s.input);
    await expect(c.phases.refreshFixPrBacklog(withRepair)).resolves.toBeUndefined();
    expect(c.backlog.open).toBeNull();
    expect(c.backlog.slotFree({ id: 'backfill-finding-1' })).toBe(false);
  });
});

describe('reconcile queue return', () => {
  it('returns the queue unchanged, with an empty log, when nothing needs reconciling', async () => {
    const c = composeFullTick(rig().input);
    const q = doc({ items: [], starts: [] });
    const out = await c.phases.reconcile(q);
    expect(plain(out.queue)).toEqual(plain(q));
    expect(out.log).toEqual([]);
  });
});

describe('Python child harvest (run artifacts)', () => {
  function runDir(root: string, id: string, files: Record<string, string>): void {
    const d = join(root, 'runs', id);
    mkdirSync(d, { recursive: true });
    for (const [name, body] of Object.entries(files)) writeFileSync(join(d, name), body);
  }
  const reads = (root: string) => fileHarvestRunReads({ stateRoot: root, nowMs: () => NOW });

  const managedPid = (id: string): string =>
    JSON.stringify({
      pid: DEAD_PID,
      pgid: DEAD_PID,
      sid: DEAD_PID,
      group_owner: 'foreground-v1',
      run_id: id,
    });

  it('reads exit code, ended_at, meta and the verbatim review text from the child files', async () => {
    const root = dir();
    runDir(root, 'r-1', {
      'exit.json': '{"exit": 1, "ended_at": "2027-01-15T07:50:00Z", "timed_out": false}',
      'meta.json': '{"worktree": "/w", "wt_branch": "b", "head": "h", "base": "ba"}',
      'review.ndjson': '{"type":"error","errorType":"rate_limit","recoverable":true}\n',
    });
    const fx = reads(root);
    expect(await fx.exitFileExists('r-1')).toBe(true);
    expect(await fx.exitFileExists('nope')).toBe(false);
    expect(await fx.readExitCode('r-1')).toBe(1);
    expect(await fx.readEndedAtMs('r-1')).toBe(Date.parse('2027-01-15T07:50:00Z'));
    expect(await fx.readMeta('r-1')).toMatchObject({ wt_branch: 'b' });
    expect(await fx.readReviewText('r-1')).toContain('rate_limit');
    expect(fx.runPath('r-1', 'findings.md')).toBe(join(root, 'runs', 'r-1', 'findings.md'));
  });

  it('matches Python on a missing or null exit code and an unreadable ended_at', async () => {
    const root = dir();
    runDir(root, 'null-exit', { 'exit.json': '{"exit": null, "ended_at": "garbage"}' });
    runDir(root, 'no-key', { 'exit.json': '{}' });
    const fx = reads(root);
    expect(await fx.readExitCode('null-exit')).toBeNull();
    expect(await fx.readEndedAtMs('null-exit')).toBeNull(); // falls back to now()
    await expect(fx.readExitCode('no-key')).rejects.toThrow('KeyError: exit');
    expect(await fx.readEndedAtMs('missing-run')).toBeNull();
  });

  it('refuses a run id that would escape the runs directory', async () => {
    const fx = reads(dir());
    expect(fx.runPath.bind(null, '../x', 'f')).toThrow('invalid run id');
    expect(await fx.exitFileExists('../x')).toBe(false);
  });

  it('classifies an absent stream as a no-proof failure and writes classification.json', async () => {
    const root = dir();
    runDir(root, 'r-2', { 'exit.json': '{"exit": 0}' });
    const fx = reads(root);
    const cls = await fx.classify('r-2', 0);
    expect(cls.counted).toBe(false);
    await fx.writeClassification('r-2', cls);
    expect(
      JSON.parse(readFileSync(join(root, 'runs', 'r-2', 'classification.json'), 'utf8')),
    ).toMatchObject({
      outcome: cls.outcome,
    });
  });

  it('writes next-review-at with whole seconds', async () => {
    const root = dir();
    await reads(root).writeNext();
    expect(readFileSync(join(root, 'next-review-at'), 'utf8')).toBe('2027-01-15T08:00:00Z\n');
  });

  it('proves an exited, dead managed child harvestable and a live pid alive', async () => {
    const root = dir();
    runDir(root, 'r-3', { 'exit.json': '{"exit": 0}', 'review.pid': managedPid('r-3') });
    const fx = reads(root);
    const run = { run_id: 'r-3' };
    expect(await fx.runLiveness('r-3', {}, run, true)).toBe('harvest');
    // No exit file yet and nothing alive: fail closed, never a silent release.
    runDir(root, 'r-4', { 'review.pid': managedPid('r-4') });
    expect(await fx.runLiveness('r-4', {}, { run_id: 'r-4' }, false)).toBe('ambiguous');
  });

  /** The harvest effects a rate-limit harvest touches, over a throwaway worktree remover. */
  function harvestEffects(over: { removed: string[]; events: string[] }) {
    return {
      kinds: {
        localReview: 'local-review',
        reviewReceipt: 'review-receipt',
        pushCurrent: 'push-current',
        backfill: 'backfill',
        author: 'author',
      },
      config: { maxItemFailures: 3, errorBackoffMin: 5, rateLimitDefaultBackoffMin: 30 },
      writeFindings: async () => undefined,
      event: async (kind: string) => void over.events.push(kind),
      saveQueue: async () => undefined,
      removeWorktree: async (worktree: unknown) => void over.removed.push(String(worktree)),
      nowMs: () => NOW,
      iso: (ms: number = NOW) => `${new Date(ms).toISOString().slice(0, 19)}Z`,
      itemRepo: () => 'o/r',
      isPrimaryRepo: () => true,
      cloneFor: () => null,
    } as unknown as Omit<HarvestReviewEffects, keyof ReturnType<typeof fileHarvestRunReads>>;
  }

  function harvestRig() {
    const queue = {
      items: [
        {
          id: 'a',
          kind: 'open',
          state: 'reviewing',
          run: { run_id: 'r-9', band: 'fast', started_at: '2027-01-15T07:40:00Z' },
        },
      ],
      starts: [],
      last_tick: '2027-01-15T07:59:00Z',
    };
    const s = rig(queue);
    runDir(s.root, 'r-9', {
      'exit.json': '{"exit": 1, "ended_at": "2027-01-15T07:50:00Z", "timed_out": false}',
      'meta.json': '{"worktree": "/w/r-9", "wt_branch": "crq/r-9", "head": "h", "base": "b"}',
      'review.ndjson': '{"type":"error","errorType":"rate_limit","recoverable":true}\n',
      'review.pid': managedPid('r-9'),
    });
    const sink = { removed: [] as string[], events: [] as string[] };
    const composed = composeFullTick({
      ...s.input,
      harvest: {
        local: {
          kind: 'local-review',
          harvest: async (q) => ({ queue: q, message: null }),
          republish: async (q) => q,
          reconcileCompleted: async (q) => q,
        },
        reviewReceiptKind: 'review-receipt',
        review: harvestEffects(sink),
        repairHarvest: async () => [],
      },
    });
    return { s, sink, composed, queue };
  }

  it('harvests a Python child that hit a rate limit: cooldown from exit.json ended_at, next-review-at, pending', async () => {
    const { s, sink, composed } = harvestRig();
    expect(composed.unbound.map((g) => g.id)).not.toContain('harvest');
    const out = await composed.phases.harvestItems(
      parseJsonValue(readFileSync(s.queuePath, 'utf8')) as JsonObject,
      false,
    );
    const q = plain(out.queue);
    // ended_at 07:50 + the 30 min default backoff.
    expect(q.cooldown_until).toBe('2027-01-15T08:20:00Z');
    expect(q.items[0]).toMatchObject({ state: 'pending', run: null });
    expect(out.log.join('\n')).toContain('rate limited');
    expect(sink.removed).toEqual(['/w/r-9']);
    expect(sink.events).toContain('review_finished');
    expect(readFileSync(join(s.root, 'next-review-at'), 'utf8')).toBe('2027-01-15T08:00:00Z\n');
    const cls = JSON.parse(
      readFileSync(join(s.root, 'runs', 'r-9', 'classification.json'), 'utf8'),
    ) as { outcome?: string };
    expect(cls.outcome).toBe('rate_limited');
  });

  it('leaves a still-running child untouched (capacity retained, no harvest)', async () => {
    const s = rig({
      items: [{ id: 'a', kind: 'open', state: 'reviewing', run: { run_id: 'r-live' } }],
      starts: [],
    });
    runDir(s.root, 'r-live', {
      'review.pid': JSON.stringify({
        pid: process.pid,
        pgid: process.pid,
        sid: process.pid,
        group_owner: 'foreground-v1',
        run_id: 'r-live',
      }),
    });
    const sink = { removed: [] as string[], events: [] as string[] };
    const c = composeFullTick({
      ...s.input,
      harvest: {
        local: {
          kind: 'local-review',
          harvest: async (q) => ({ queue: q, message: null }),
          republish: async (q) => q,
          reconcileCompleted: async (q) => q,
        },
        reviewReceiptKind: 'review-receipt',
        review: harvestEffects(sink),
        repairHarvest: async () => [],
      },
    });
    const out = await c.phases.harvestItems(
      parseJsonValue(readFileSync(s.queuePath, 'utf8')) as JsonObject,
      false,
    );
    expect(plain(out.queue).items[0]).toMatchObject({ state: 'reviewing' });
    expect(sink.removed).toEqual([]);
    expect(existsSync(join(s.root, 'next-review-at'))).toBe(false);
  });

  it('slot: collects the finished child, the cooldown holds admission, and the queue is saved', async () => {
    const { s, composed } = harvestRig();
    const log = await composeSlot({
      stateRoot: s.root,
      now: () => NOW,
      phases: composed.phases,
      collectFinished: composed.collectFinished,
    })();
    expect(log.join('\n')).toContain('rate limited');
    const saved = JSON.parse(readFileSync(s.queuePath, 'utf8')) as Record<string, unknown>;
    expect(saved.cooldown_until).toBe('2027-01-15T08:20:00Z');
    // Admission is gated by the cooldown the harvest just set, so nothing starts.
    expect(s.calls).not.toContain('startOne');
  });
});

describe('slot pacing', () => {
  it('skips the slot while next-review-at is in the future', async () => {
    const s = rig();
    const c = composeFullTick(s.input);
    writeFileSync(join(s.root, 'next-review-at'), '2027-01-15T09:00:00Z\n');
    let collected = false;
    const log = await composeSlot({
      stateRoot: s.root,
      now: () => NOW,
      phases: c.phases,
      collectFinished: async (q) => ((collected = true), { queue: q, log: [] }),
    })();
    expect(log).toEqual([]);
    expect(collected).toBe(false);
    expect(s.calls).toEqual([]);
  });

  it('a runnable slot admits, saves the queue and rewrites next-review-at', async () => {
    const s = rig({ items: [{ id: 'a', kind: 'open', state: 'pending' }], starts: [] });
    const c = composeFullTick(s.input);
    const log = await composeSlot({
      stateRoot: s.root,
      now: () => NOW,
      phases: c.phases,
      collectFinished: async (q) => ({ queue: q, log: [] }),
    })();
    expect(log).toEqual(['started']);
    expect(s.calls).toEqual(['startOne']);
    expect(existsSync(join(s.root, 'next-review-at'))).toBe(true);
  });
});

describe('interruption and restart', () => {
  it('a gap phase abandons the tick: nothing is saved, and the next tick resumes from disk', async () => {
    const s = rig({ items: [], starts: [], last_tick: '2027-01-15T07:00:00Z' });
    const before = readFileSync(s.queuePath, 'utf8');
    const c = composeFullTick(s.input);

    // First tick: discovery has no inputs, so it throws; Python saves nothing then.
    await expect(runTick(TICK, c.phases)).rejects.toBeInstanceOf(TickGapError);
    expect(readFileSync(s.queuePath, 'utf8')).toBe(before);

    // Restart: the same disk state, with every open gap closed by a recording fake.
    const ran: string[] = [];
    const fake = (name: string) => async (q: JsonObject) => (ran.push(name), { queue: q, log: [] });
    const phases = {
      ...c.phases,
      discovery: fake('discovery'),
      enrollPrimary: fake('enrollPrimary'),
      enrollOthers: fake('enrollOthers'),
      resetFixPrBacklog: () => void ran.push('reset'),
      refreshFixPrBacklog: async () => void ran.push('refresh'),
      harvestItems: fake('harvest'),
      reconcileCompleted: async (q: JsonObject) => (ran.push('reconcileCompleted'), q),
      repairBackfill: async (q: JsonObject) => (ran.push('repairBackfill'), q),
      archiveLegacy: async (q: JsonObject) => (ran.push('archiveLegacy'), q),
      writeStatus: async () => void ran.push('writeStatus'),
      publishLocalReviewPr: async (q: JsonObject) => (ran.push('publishLocalReviewPr'), q),
      recordClientHealth: async (q: JsonObject) => (
        ran.push('recordClientHealth'),
        { queue: q, log: [] }
      ),
    } as unknown as typeof c.phases;
    const log = await runTick(TICK, phases);
    expect(ran).toContain('discovery');
    expect(ran).toContain('writeStatus');
    expect(log.join('\n')).not.toMatch(/tick gap [a-z]/); // TickGapError text, not the stale-tick alarm
    const saved = JSON.parse(readFileSync(s.queuePath, 'utf8')) as Record<string, unknown>;
    expect(saved.last_tick).not.toBe('2027-01-15T07:00:00Z');
  });

  it('a harvest interrupted by a dead child leaves the run files for the next tick', async () => {
    // exit.json is written last by the child; without it a dead child is `ambiguous`, not released.
    const s = rig({
      items: [{ id: 'a', kind: 'open', state: 'reviewing', run: { run_id: 'r-x' } }],
      starts: [],
    });
    const d = join(s.root, 'runs', 'r-x');
    mkdirSync(d, { recursive: true });
    writeFileSync(
      join(d, 'review.pid'),
      JSON.stringify({
        pid: DEAD_PID,
        pgid: DEAD_PID,
        sid: DEAD_PID,
        group_owner: 'foreground-v1',
        run_id: 'r-x',
      }),
    );
    const events: string[] = [];
    const c = composeFullTick({
      ...s.input,
      harvest: {
        local: {
          kind: 'local-review',
          harvest: async (q) => ({ queue: q, message: null }),
          republish: async (q) => q,
          reconcileCompleted: async (q) => q,
        },
        reviewReceiptKind: 'review-receipt',
        review: {
          kinds: {
            localReview: 'local-review',
            reviewReceipt: 'review-receipt',
            pushCurrent: 'push-current',
            backfill: 'backfill',
            author: 'author',
          },
          event: async (kind: string) => void events.push(kind),
        } as never,
        repairHarvest: async () => [],
      },
    });
    const out = await c.phases.harvestItems(
      parseJsonValue(readFileSync(s.queuePath, 'utf8')) as JsonObject,
      false,
    );
    expect(plain(out.queue).items[0]).toMatchObject({ state: 'reviewing' });
    expect(events).toEqual(['review_ambiguous']);
    expect(existsSync(join(d, 'classification.json'))).toBe(false);
  });
});
