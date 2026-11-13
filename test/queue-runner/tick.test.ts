import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { processCommand } from '../../src/adapters/crq/tickSource.js';
import {
  buildTickPlan,
  isoSeconds,
  planTick,
  TICK_MISSING_EFFECTS,
  type TickPlanValue,
} from '../../src/queue-runner/tick.js';
import type { TickEffects } from '../../src/adapters/crq/tickSource.js';

const NOW = 1_700_000_000_000_000n; // 2023-11-14T22:13:20Z, deterministic.

const children: number[] = [];

afterEach(() => {
  while (children.length > 0) {
    const pid = children.pop()!;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone: this test's whole point.
    }
  }
});

interface Root {
  readonly root: string;
  readonly state: string;
  readonly runs: string;
}

async function makeRoot(
  options: { config?: unknown; queue?: unknown; disabled?: boolean } = {},
): Promise<Root> {
  const root = await mkdtemp(join(tmpdir(), 'crq-tick-'));
  const state = join(root, 'state');
  const runs = join(state, 'runs');
  await mkdir(runs, { recursive: true });
  if (options.config !== undefined) {
    await writeFile(join(root, 'config.json'), JSON.stringify(options.config));
  }
  if (options.queue !== undefined) {
    await writeFile(join(state, 'queue.json'), JSON.stringify(options.queue));
  }
  if (options.disabled === true) await writeFile(join(state, 'runner-disabled'), '');
  return { root, state, runs };
}

const CONFIG = { repo: 'acme/widgets', clone: 'clone-not-created' };

/** A pending item the queue schema accepts. */
function pendingItem(id: string, kind = 'delta'): Record<string, unknown> {
  return { id, kind, state: 'pending', order: 1 };
}

/**
 * A detached review's state: pidfile plus the queue row that records it. The
 * pidfile numbers are the same as the child's, and a managed identity requires
 * `pid === pgid === sid` with the `foreground-v1` marker.
 */
async function writeReview(
  holder: Root,
  runId: string,
  pid: number,
  kind = 'delta',
): Promise<Record<string, unknown>> {
  const runDir = join(holder.runs, runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(
    join(runDir, 'review.pid'),
    JSON.stringify({
      run_id: runId,
      pid,
      pgid: pid,
      sid: pid,
      group_owner: 'foreground-v1',
      started_at: '2023-11-14T22:13:20Z',
    }),
  );
  return {
    id: `item-${runId}`,
    kind,
    state: 'reviewing',
    run: { run_id: runId, pid, started_at: '2023-11-14T22:13:20Z' },
  };
}

/** A real child whose command line contains its run id, as a launch would. */
async function spawnNamedProcess(runId: string): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', runId], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  await once(child, 'spawn');
  const pid = child.pid;
  if (pid === undefined) throw new Error('child has no pid');
  children.push(pid);
  // The exec is complete once `ps` reports the run id; poll briefly so a slow
  // host cannot make the liveness probe see the parent's own command line.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await processCommand(pid)).includes(runId)) return pid;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`child ${pid} never reported ${runId}`);
}

/** Every effect answered from memory, for the pure plan shape. */
function fakeEffects(overrides: Partial<TickEffects> = {}): TickEffects {
  return {
    readQueue: async () => JSON.stringify({ items: [] }),
    readConfig: async () => JSON.stringify(CONFIG),
    runnerDisabled: async () => false,
    readUsage: async () => null,
    vendorProgress: async () => false,
    runExited: async () => false,
    readPidfile: async () => null,
    pidAlive: () => false,
    groupAlive: () => false,
    processCommand: async () => '',
    nowMicros: () => NOW,
    ...overrides,
  };
}

function value(plan: { value: unknown }): TickPlanValue {
  return plan.value as TickPlanValue;
}

function targets(plan: { mutations: { target: string }[] }): string[] {
  return plan.mutations.map((mutation) => mutation.target);
}

describe('crq tick: refusals', () => {
  it('rejects commands and arguments it cannot serve', async () => {
    await expect(planTick('/unused', 'harvest', [])).rejects.toThrow(/not implemented/);
    await expect(planTick('/unused', 'tick', ['--now'])).rejects.toThrow(/does not accept/);
  });

  it('short-circuits a disarmed runner before reading config or queue', async () => {
    const holder = await makeRoot({ disabled: true });
    const plan = await planTick(holder.root, 'tick', []);
    expect(plan).toEqual({
      value: { complete: false, disabled: true, reason: 'runner disabled for host handover' },
      mutations: [],
    });
  });

  it('refuses a missing config and a queue the schema rejects', async () => {
    const bare = await makeRoot({ queue: { items: [] } });
    await expect(planTick(bare.root, 'tick', [])).rejects.toThrow(/config\.json/);
    const bad = await makeRoot({ config: CONFIG, queue: { items: [{ id: 'x' }] } });
    await expect(planTick(bad.root, 'tick', [])).rejects.toThrow(/queue\.schema\.json/);
    await expect(planTick(bad.root, 'tick', [])).rejects.toThrow(/kind/);
  });

  it('refuses a config without the bindings tick needs', async () => {
    const holder = await makeRoot({ config: { repo: 'acme/widgets' }, queue: { items: [] } });
    await expect(planTick(holder.root, 'tick', [])).rejects.toThrow(/config\.clone/);
  });
});

describe('crq tick: plan value', () => {
  it('sorts pending work and reports the exact missing effects', () => {
    const queue = {
      items: [
        { id: 'c', kind: 'coverage', state: 'pending', order: 2 },
        { id: 'd', kind: 'delta', state: 'pending', order: 1 },
        { id: 'r', kind: 'delta', state: 'reviewing' },
        { id: 'done', kind: 'delta', state: 'done' },
      ],
    };
    const plan = buildTickPlan({
      queue,
      config: CONFIG,
      nowMicros: NOW,
      usage: null,
      observedRunIds: new Set(),
      runs: [],
    });
    const planned = value(plan);
    expect(planned.complete).toBe(false);
    expect(planned.reason).toBe(`tick effects not implemented: ${TICK_MISSING_EFFECTS.join('; ')}`);
    expect(planned.candidates.map((c) => c.id)).toEqual(['d', 'c']);
    expect(planned.candidates.map((c) => c.rank)).toEqual([1, 4]);
    expect(planned.backgroundTurn).toBe(false);
    expect(targets(plan)).toEqual([
      'queue.json#/usage',
      'queue.json#/backfill_starts_at_observation',
      'queue.json#/last_tick',
    ]);
  });

  it('retires a superseded open cycle and drops legacy boost', () => {
    const queue = {
      items: [
        {
          id: 'open-1',
          kind: 'open',
          state: 'pending',
          cycles: [{ review_run: 'r1', state: 'completed' }],
          boost: 3,
        },
        { id: 'open-2', kind: 'open', state: 'pending', optional_cycle: true, cycles: [{}] },
      ],
    };
    const plan = buildTickPlan({
      queue,
      config: CONFIG,
      nowMicros: NOW,
      usage: null,
      observedRunIds: new Set(),
      runs: [],
    });
    expect(value(plan).normalized).toEqual({ retired: ['open-1'], boostsDropped: 1 });
    expect(plan.mutations.slice(0, 3)).toEqual([
      { operation: 'set', target: 'queue.json#/items/0/state', value: 'done' },
      { operation: 'set', target: 'queue.json#/items/0/not_before', value: null },
      { operation: 'set', target: 'queue.json#/items/0/last_error', value: null },
    ]);
    expect(value(plan).candidates.map((c) => c.id)).toEqual(['open-2']);
  });

  it('counts one reservation against a healthy usage snapshot', () => {
    const queue = {
      items: [
        {
          id: 'a',
          kind: 'delta',
          state: 'reviewing',
          run: { run_id: 'live', started_at: '2023-11-14T22:13:20Z' },
        },
        { id: 'b', kind: 'delta', state: 'pending' },
      ],
    };
    const withUsage = buildTickPlan({
      queue: structuredClone(queue),
      config: CONFIG,
      nowMicros: NOW,
      usage: { remaining: 4 },
      observedRunIds: new Set(),
      runs: [{ itemIndex: 0, liveness: 'alive' }],
    });
    expect(value(withUsage).admission.slots).toBe(3);
    expect(value(withUsage).admission.admissions).toBe(3);
    expect(value(withUsage).harvest.alive).toEqual(['a']);
    expect(targets(withUsage)).toContain('queue.json#/items/0/wait_reason');
    expect(withUsage.mutations.find((m) => m.target === 'queue.json#/usage')?.value).toEqual({
      remaining: 4,
    });

    const without = buildTickPlan({
      queue: structuredClone(queue),
      config: CONFIG,
      nowMicros: NOW,
      usage: null,
      observedRunIds: new Set(['live']),
      runs: [{ itemIndex: 0, liveness: 'alive' }],
    });
    expect(value(without).admission.slots).toBe(5);
    expect(value(without).admission.admissions).toBe(5);
    expect(value(without).admission.reserved).toEqual(['2023-11-14T22:13:20Z']);
    expect(targets(without)).not.toContain('queue.json#/items/0/run/vendor_observed');
    expect(
      without.mutations.find((m) => m.target === 'queue.json#/items/0/wait_reason')?.value,
    ).toBe('detached review still alive');
  });

  it('marks a vendor-observed reservation once usage is readable', () => {
    const plan = buildTickPlan({
      queue: {
        items: [{ id: 'a', kind: 'author', state: 'reviewing', run: { run_id: 'live' } }],
      },
      config: CONFIG,
      nowMicros: NOW,
      usage: { remaining: 2 },
      observedRunIds: new Set(['live']),
      runs: [{ itemIndex: 0, liveness: 'alive' }],
    });
    expect(targets(plan)).toContain('queue.json#/items/0/run/vendor_observed');
    expect(plan.mutations.find((m) => m.target === 'queue.json#/items/0/wait_reason')?.value).toBe(
      'author: run alive',
    );
  });
});

describe('crq tick: real host probes', () => {
  it('reads a live child as alive, then ambiguous, then harvestable', async () => {
    const holder = await makeRoot({ config: CONFIG });
    const runId = 'run-live-0001';
    const pid = await spawnNamedProcess(runId);
    const item = await writeReview(holder, runId, pid);
    await writeFile(
      join(holder.state, 'queue.json'),
      JSON.stringify({ items: [item, pendingItem('queued')] }),
    );

    const alive = await planTick(holder.root, 'tick', []);
    expect(value(alive).harvest).toEqual({
      alive: ['item-run-live-0001'],
      ambiguous: [],
      harvestable: [],
    });
    expect(alive.mutations.find((m) => m.target === 'queue.json#/items/0/wait_reason')?.value).toBe(
      'detached review still alive',
    );
    expect(value(alive).admission.reserved).toEqual(['2023-11-14T22:13:20Z']);

    const exited = await makeRoot({ config: CONFIG });
    const goneId = 'run-gone-0001';
    const gonePid = await spawnNamedProcess(goneId);
    const goneItem = await writeReview(exited, goneId, gonePid);
    await writeFile(join(exited.state, 'queue.json'), JSON.stringify({ items: [goneItem] }));
    process.kill(gonePid, 'SIGKILL');
    const ambiguous = await planTick(exited.root, 'tick', []);
    expect(value(ambiguous).harvest).toEqual({
      alive: [],
      ambiguous: ['item-run-gone-0001'],
      harvestable: [],
    });
    expect(
      ambiguous.mutations.find((m) => m.target === 'queue.json#/items/0/wait_reason')?.value,
    ).toMatch(/^run not releasable \(unverifiable identity, missing exit/);

    await writeFile(join(exited.runs, goneId, 'exit.json'), JSON.stringify({ exit_code: 0 }));
    const harvested = await planTick(exited.root, 'tick', []);
    expect(value(harvested).harvest).toEqual({
      alive: [],
      ambiguous: [],
      harvestable: ['item-run-gone-0001'],
    });
    expect(targets(harvested)).not.toContain('queue.json#/items/0/wait_reason');
  });

  it('plans from injected effects without touching the disk', async () => {
    const queue = { items: [pendingItem('a')] };
    const plan = await planTick(
      '/unused',
      'tick',
      [],
      fakeEffects({
        readUsage: async () => ({ remaining: 1 }),
        nowMicros: () => NOW,
        readQueue: async () => JSON.stringify(queue),
        readConfig: async () => JSON.stringify(CONFIG),
      }),
    );
    expect(value(plan).admission).toMatchObject({ slots: 1, admissions: 1, gate: null });
    expect(plan.mutations.at(-1)).toEqual({
      operation: 'set',
      target: 'queue.json#/last_tick',
      value: isoSeconds(NOW),
    });
  });
});

describe('crq tick: timestamps', () => {
  it('writes second precision with a Z suffix', () => {
    expect(isoSeconds(NOW)).toBe('2023-11-14T22:13:20Z');
    expect(isoSeconds(1_700_000_000_999_999n)).toBe('2023-11-14T22:13:20Z');
    expect(isoSeconds(0n)).toBe('1970-01-01T00:00:00Z');
  });
});
