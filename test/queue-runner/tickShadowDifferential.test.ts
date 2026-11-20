// Seeded differential for the tick scheduling pass: the TypeScript dry-run plan
// (`planTick`) against the Python oracle (`apps/crq-python/tick_shadow_compare.py`,
// which imports the real crq.py) on the SAME runner root. This is the offline
// form of the operator shadow in docs/crq/tick-slot-shadow-procedure.md.
//
// Classification: `process` in test/suite-classes.json (python3, child processes).
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fileTickEffects, processCommand } from '../../src/adapters/crq/tickSource.js';
import type { VendorUsage } from '../../src/policy/crq/usageSlots.js';
import { planTick } from '../../src/queue-runner/tick.js';

const PYTHON_ROOT = join(import.meta.dirname, '../../apps/crq-python');
const COMPARE = join(PYTHON_ROOT, 'tick_shadow_compare.py');
/** A whole second, so the Python clock pinned to `last_tick` is the same instant. */
const NOW_MS = Date.parse('2026-11-20T03:00:00Z');
const iso = (msBefore: number): string =>
  new Date(NOW_MS - msBefore).toISOString().replace(/\.\d{3}Z$/, 'Z');
const MIN = 60_000;
/** Pids far above any live process on the test host: proved absent. */
const DEAD = [4_190_011, 4_190_013, 4_190_017];

const children: number[] = [];
afterEach(() => {
  for (const pid of children.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
});

interface Root {
  readonly root: string;
  readonly state: string;
}

async function seed(queue: unknown, config: Record<string, unknown> = {}): Promise<Root> {
  const root = await mkdtemp(join(tmpdir(), 'tick-shadow-'));
  const state = join(root, 'state');
  await mkdir(join(state, 'runs'), { recursive: true });
  await writeFile(
    join(root, 'config.json'),
    JSON.stringify({
      repo: 'acme/widgets',
      clone: join(root, 'clone-absent'),
      worktree_root: join(root, 'wt'),
      worktree_prefix: 'crq-',
      ...config,
    }),
  );
  await writeFile(join(state, 'queue.json'), JSON.stringify(queue));
  return { root, state };
}

async function writeRun(
  holder: Root,
  runId: string,
  pid: number,
  options: { exit?: boolean; progress?: boolean } = {},
): Promise<void> {
  const dir = join(holder.state, 'runs', runId);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'review.pid'),
    JSON.stringify({
      run_id: runId,
      pid,
      pgid: pid,
      sid: pid,
      group_owner: 'foreground-v1',
      started_at: iso(5 * MIN),
    }),
  );
  if (options.exit === true) {
    await writeFile(join(dir, 'exit.json'), JSON.stringify({ exit: 0, ended_at: iso(MIN) }));
  }
  if (options.progress === true) {
    await writeFile(join(dir, 'review.ndjson'), '{"type":"status","status":"reviewing"}\n');
  }
}

async function spawnNamed(runId: string): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', runId], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  await once(child, 'spawn');
  const pid = child.pid!;
  children.push(pid);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await processCommand(pid)).includes(runId)) return pid;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`child ${pid} never reported ${runId}`);
}

interface Comparison {
  readonly identical?: boolean;
  readonly diffs?: unknown[];
  readonly error?: string;
}

/** Run the TS dry-run plan, write it as the runner does, then the Python comparator. */
async function differential(holder: Root, usage: VendorUsage | null = null): Promise<Comparison> {
  const effects = {
    ...fileTickEffects({ runnerRoot: holder.root, stateRoot: holder.state }, () => NOW_MS),
    readUsage: async () => usage,
  };
  const plan = await planTick(holder.root, 'tick', [], effects);
  const planPath = join(holder.root, 'plan.json');
  await writeFile(planPath, JSON.stringify({ command: 'tick', ...plan }));
  let stdout: string;
  try {
    stdout = execFileSync(
      'python3',
      [
        '-I',
        COMPARE,
        '--python-root',
        PYTHON_ROOT,
        '--runner-root',
        holder.root,
        '--ts-plan',
        planPath,
      ],
      { encoding: 'utf8' },
    );
  } catch (error) {
    stdout = String((error as { stdout?: unknown }).stdout ?? '');
  }
  return JSON.parse(stdout) as Comparison;
}

const pending = (id: string, kind: string, extra: Record<string, unknown> = {}) => ({
  id,
  kind,
  state: 'pending',
  order: 5,
  ...extra,
});

describe('tick scheduling pass: TypeScript plan vs Python oracle', () => {
  it('agrees on start order, retirement, boosts and the background turn', async () => {
    const holder = await seed({
      items: [
        pending('merged-1', 'merged', { order: 1 }),
        pending('delta-3', 'delta', { order: 3, boost: 2 }),
        pending('open-retire', 'open', { cycles: [{ head: 'a' }] }),
        pending('open-optional', 'open', { cycles: [{ head: 'b' }], optional_cycle: true }),
        pending('delta-priority', 'delta', { order: 9, operator_priority: true }),
        {
          id: 'done-1',
          kind: 'delta',
          state: 'done',
          order: 2,
          attempts: [
            { run_id: `r-a-${'20261120T020000Z'}`, band: 'interactive', started_at: iso(60 * MIN) },
            { run_id: `r-b-${'20261120T021000Z'}`, band: 'interactive', started_at: iso(50 * MIN) },
          ],
        },
        { id: 'promo', kind: 'promotion', state: 'pending', order: 0, boost: 1 },
      ],
      starts: [iso(10 * MIN), iso(30 * MIN), iso(90 * MIN)],
    });
    expect(await differential(holder)).toMatchObject({ identical: true, diffs: [] });
  });

  it.each([
    ['paused', { paused: true, pause_reason: 'owner hold' }],
    ['cooldown', { cooldown_until: iso(-30 * MIN) }],
    ['expired cooldown', { cooldown_until: iso(30 * MIN) }],
    ['hourly cap', { starts: [1, 2, 3, 4, 5].map((n) => iso(n * MIN)) }],
  ])('agrees on the %s gate', async (_name, extra) => {
    const holder = await seed({ items: [pending('d', 'delta')], starts: [], ...extra });
    expect(await differential(holder)).toMatchObject({ identical: true, diffs: [] });
  });

  it('agrees on liveness, holds and vendor-observed releases with a usage snapshot', async () => {
    const holder = await seed({ items: [], starts: [] });
    const alivePid = await spawnNamed('run-alive');
    await writeRun(holder, 'run-alive', alivePid, { progress: true });
    await writeRun(holder, 'run-done', DEAD[0]!, { exit: true });
    await writeRun(holder, 'run-lost', DEAD[1]!);
    const reviewing = (
      id: string,
      runId: string,
      pid: number,
      run: Record<string, unknown> = {},
    ) => ({
      id,
      kind: 'delta',
      state: 'reviewing',
      order: 1,
      run: { run_id: runId, pid, started_at: iso(5 * MIN), ...run },
    });
    await writeFile(
      join(holder.state, 'queue.json'),
      JSON.stringify({
        items: [
          reviewing('alive', 'run-alive', alivePid),
          reviewing('done', 'run-done', DEAD[0]!),
          reviewing('lost', 'run-lost', DEAD[1]!),
          reviewing('seen', 'run-seen', DEAD[2]!, { vendor_observed: true }),
          pending('next', 'delta'),
        ],
        starts: [iso(5 * MIN)],
      }),
    );
    const withUsage = await differential(holder, { remaining: 4, limit: 10 });
    expect(withUsage).toMatchObject({ identical: true, diffs: [] });
    // Without usage, the observed hold folds back and the hourly fallback applies.
    expect(await differential(holder, null)).toMatchObject({ identical: true, diffs: [] });
  });

  it('reports a planted decision difference instead of hiding it', async () => {
    const holder = await seed({ items: [pending('d', 'delta')], starts: [] });
    const effects = {
      ...fileTickEffects({ runnerRoot: holder.root, stateRoot: holder.state }, () => NOW_MS),
      readUsage: async () => null,
    };
    const plan = await planTick(holder.root, 'tick', [], effects);
    const value = plan.value as { admission: { slots: number } };
    value.admission.slots += 1;
    const planPath = join(holder.root, 'plan.json');
    await writeFile(planPath, JSON.stringify({ command: 'tick', ...plan }));
    let stdout = '';
    let status = 0;
    try {
      execFileSync(
        'python3',
        [
          '-I',
          COMPARE,
          '--python-root',
          PYTHON_ROOT,
          '--runner-root',
          holder.root,
          '--ts-plan',
          planPath,
        ],
        { encoding: 'utf8' },
      );
    } catch (error) {
      stdout = String((error as { stdout?: unknown }).stdout ?? '');
      status = (error as { status?: number }).status ?? -1;
    }
    expect(status).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({
      identical: false,
      diffs: [{ field: 'admission.slots', python: 5, ts: 6 }],
    });
  });
});
