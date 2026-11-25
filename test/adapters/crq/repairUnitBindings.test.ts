// Differential run: the same isolated state files, clock and environment through
// Python's `crq_repair.py` (the oracle, test/helpers/repairUnitOracle.py, Python 3.14 pinned)
// and the drain bindings of `fileRepairUnit`. Returned values and written files must be
// equal, and a Python exception must coincide with a TS throw. No network, provider or
// queue state; the only git is a local bare origin inside the temp dir.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { fileRepairUnit } from '../../../src/adapters/crq/repairUnit.js';
import { withLock } from '../../../src/adapters/crq/lock.js';
import { workerLimit } from '../../../src/ops/crq/internal/repairDrain.js';
import { JsonNumber, JsonObject, parseJsonValue } from '../../../src/policy/crq/jsonValue.js';
import type { JsonValue } from '../../../src/policy/crq/jsonValue.js';

const ORACLE = fileURLToPath(new URL('../../helpers/repairUnitOracle.py', import.meta.url));
const APPS = fileURLToPath(new URL('../../../apps/crq-python', import.meta.url));

/** Python 3.14 is production's minor: `python3.14` when present, else `python3` iff it is 3.14. */
function oraclePython(): string {
  for (const name of ['python3.14', 'python3']) {
    const probe = spawnSync(name, ['-c', 'import sys; print(sys.version_info[:2] == (3, 14))'], {
      encoding: 'utf8',
    });
    if (probe.status === 0 && probe.stdout.trim() === 'True') return name;
  }
  throw new Error('the repair-unit oracle needs Python 3.14 (python3.14, or python3 at 3.14)');
}
const PYTHON = oraclePython();

type Op =
  | 'worker_limit'
  | 'dispatch_paused'
  | 'blocked'
  | 'fetch_clone'
  | 'inbox_order'
  | 'inbox_item'
  | 'read_queue'
  | 'read_backlog'
  | 'pending'
  | 'unreadable_result'
  | 'mark_stale';
type FileSpec = string | { dir: true };
interface Case {
  name: string;
  op: Op;
  files?: Record<string, FileSpec>;
  mtimes?: Record<string, number>;
  clock?: string[];
  env?: Record<string, string>;
  clone?: 'repo' | 'none';
  holdLock?: boolean;
  args?: Record<string, unknown>;
}
interface Outcome {
  ok?: unknown;
  error?: string;
  files?: Record<string, string>;
}

const toJson = (value: unknown): JsonValue => parseJsonValue(JSON.stringify(value));
/** The plain value of a parsed document; every number in these cases is a small int. */
function plain(value: JsonValue | undefined): unknown {
  if (value instanceof JsonNumber) return Number(value.integer ?? value.float);
  if (Array.isArray(value)) return value.map((v) => plain(v as JsonValue));
  if (value instanceof JsonObject) {
    return Object.fromEntries(value.entries.map(([k, v]) => [k, plain(v)]));
  }
  return value === undefined ? null : value;
}

const cleanups: string[] = [];
afterAll(async () => {
  await Promise.all(cleanups.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function snapshot(state: string, dir = state): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(out, await snapshot(state, path));
    else if (entry.name !== 'tick.lock') {
      out[path.slice(state.length + 1)] = (await readFile(path)).toString('latin1');
    }
  }
  return out;
}

function makeClone(tmp: string): string {
  const clone = join(tmp, 'clone');
  const origin = join(tmp, 'origin.git');
  const git = ['-c', 'init.defaultBranch=main'];
  execFileSync('git', [...git, 'init', '--bare', '--quiet', origin]);
  execFileSync('git', [...git, 'clone', '--quiet', origin, clone], { stdio: 'ignore' });
  return clone;
}

async function runTs(item: Case): Promise<Outcome> {
  const tmp = await mkdtemp(join(tmpdir(), 'crq-unit-ts-'));
  cleanups.push(tmp);
  const state = join(tmp, 'state');
  await mkdir(state);
  for (const [rel, spec] of Object.entries(item.files ?? {})) {
    const path = join(state, rel);
    if (typeof spec === 'object') {
      await mkdir(path, { recursive: true });
      continue;
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, spec);
  }
  for (const [rel, seconds] of Object.entries(item.mtimes ?? {})) {
    await utimes(join(state, rel), seconds, seconds);
  }
  const args = item.args ?? {};
  const clock = (item.clock ?? ['2026-11-21T00:00:00Z']).map((text) => new Date(text));
  let reads = 0;
  const now = (): Date => clock[Math.min(reads++, clock.length - 1)] as Date;
  const config = 'config' in args ? toJson(args.config) : undefined;
  const clone =
    item.op === 'fetch_clone' && item.clone !== 'none' ? makeClone(tmp) : join(tmp, 'clone');
  const { drain } = fileRepairUnit({
    stateRoot: state,
    clone,
    narrate: () => undefined,
    ...(config === undefined ? {} : { config }),
    now,
    env: item.env ?? {},
    utc: () =>
      now()
        .toISOString()
        .replace(/\.\d{3}Z$/, 'Z'),
  });
  try {
    let ok: unknown;
    switch (item.op) {
      case 'worker_limit':
        ok = workerLimit(await drain.maxConcurrentItems());
        break;
      case 'dispatch_paused':
        ok = await drain.dispatchPaused();
        break;
      case 'blocked': {
        // `blocked(config['repair'])`: the binding reads the section from the unit's config.
        const unit = fileRepairUnit({
          stateRoot: state,
          clone,
          narrate: () => undefined,
          config: toJson({ repair: args.repair }),
          now: () => new Date(args.now as string),
        });
        ok = unit.drain.blocked();
        break;
      }
      case 'fetch_clone':
        ok = item.holdLock
          ? await withLock(join(state, 'tick.lock'), { wait: false }, () => drain.fetchClone())
          : await drain.fetchClone();
        break;
      case 'inbox_order':
        ok = await drain.inboxOrder();
        break;
      case 'inbox_item': {
        const found = await drain.inboxItem(args.job as string);
        ok = typeof found === 'string' ? found : null;
        break;
      }
      case 'read_queue':
      case 'read_backlog':
        try {
          ok = plain(
            item.op === 'read_queue' ? await drain.readQueue() : await drain.readBacklog(),
          );
        } catch (error) {
          if ((error as Error).name !== 'RepairQueueUnreadableError') throw error;
          ok = { unreadable: true };
        }
        // A missing backlog is `undefined` here; Python's drain treats any read failure alike.
        if (item.op === 'read_backlog' && ok === null) ok = { unreadable: true };
        break;
      case 'pending':
        ok = await drain.pending(args.job as string);
        break;
      case 'unreadable_result':
        ok = await drain.unreadableResult(args.job as string);
        break;
      case 'mark_stale':
        ok = await drain.markStale(toJson(args.jobObject) as JsonObject, args.reason as string);
        ok = null;
        break;
    }
    return { ok, files: await snapshot(state) };
  } catch (error) {
    return { error: error instanceof Error ? error.name : 'unknown' };
  }
}

function runOracle(cases: Case[]): Outcome[] {
  const stdout = execFileSync(PYTHON, ['-I', ORACLE, APPS], {
    input: JSON.stringify({ cases }),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
  });
  return (JSON.parse(stdout) as { results: Outcome[] }).results;
}

/** Each side runs in its own temp dir; an error text that names it is compared without it. */
const scrub = (outcome: Outcome): Outcome =>
  typeof outcome.ok === 'string'
    ? {
        ...outcome,
        ok: outcome.ok.replace(/\/\S*(?:repair-unit-oracle-|crq-unit-ts-)[\w-]+/g, '<tmp>'),
      }
    : outcome;

/** Run every case through both implementations and require agreement. */
async function expectParity(cases: Case[]): Promise<Outcome[]> {
  const oracle = runOracle(cases);
  const ours: Outcome[] = [];
  for (const item of cases) ours.push(await runTs(item));
  cases.forEach((item, index) => {
    const python = oracle[index] as Outcome;
    const ts = ours[index] as Outcome;
    if (python.error !== undefined) {
      expect(ts.error, `${item.name}: Python raised ${python.error}`).toBeDefined();
      return;
    }
    expect(ts.error, `${item.name}: TS threw ${ts.error ?? ''}`).toBeUndefined();
    expect(scrub(ts), item.name).toEqual(scrub(python));
  });
  return oracle;
}

const repairConfig = (repair: unknown) => ({ config: { repair } });
const job = (id: string, body: string) => ({ [`repair/inbox/${id}.json`]: body });
const result = (id: string, body: string) => ({ [`repair/${id}/result.json`]: body });

describe('fileRepairUnit drain bindings against crq_repair.py (Python 3.14)', () => {
  it('runs the oracle on Python 3.14', () => {
    expect(PYTHON).toMatch(/^python3(\.14)?$/);
  });

  it('maxConcurrentItems: the worker_limit contract (1..10, default 1)', async () => {
    const limits = [undefined, 1, 2, 10, 0, 11, -1, true, false, 3.5, null, '3', [], {}];
    const cases: Case[] = limits.map((limit) => ({
      name: `limit ${JSON.stringify(limit) ?? 'absent'}`,
      op: 'worker_limit',
      args: repairConfig(limit === undefined ? {} : { max_concurrent_items: limit }),
    }));
    cases.push(
      { name: 'no repair', op: 'worker_limit', args: { config: {} } },
      { name: 'repair null', op: 'worker_limit', args: repairConfig(null) },
      { name: 'repair list', op: 'worker_limit', args: repairConfig([]) },
    );
    const python = await expectParity(cases);
    expect(python.slice(0, 4).map((o) => o.ok)).toEqual([1, 1, 2, 10]);
    expect(python.slice(4, 14).every((o) => o.error === 'ValueError')).toBe(true);
  });

  it('dispatchPaused: marker, provider cooldowns and env readiness', async () => {
    const until = (value: string) => ({
      'repair/rate-limited-until': JSON.stringify({ until: value }),
    });
    const roles = { roles: { fix: { driver: 'cq', model: 'zai/glm-5' } } };
    const python = await expectParity([
      { name: 'quiet', op: 'dispatch_paused', args: repairConfig(roles) },
      {
        name: 'live global marker',
        op: 'dispatch_paused',
        files: until('2026-11-21T01:00:00Z'),
        args: repairConfig(roles),
      },
      {
        name: 'expired marker',
        op: 'dispatch_paused',
        files: until('2026-11-20T23:00:00Z'),
        args: repairConfig(roles),
      },
      {
        name: 'corrupt cooldowns',
        op: 'dispatch_paused',
        files: { 'repair/provider-cooldowns.json': '{' },
        args: repairConfig(roles),
      },
      { name: 'config without repair', op: 'dispatch_paused', args: { config: {} } },
      // Only the fallback branch reads the environment and the cooldown file.
      {
        name: 'ready fallback passes a live marker',
        op: 'dispatch_paused',
        files: until('2026-11-21T01:00:00Z'),
        env: { ZAI_API_KEY: 'k' },
        args: repairConfig({ ...roles, fallback_models: ['zai/glm-4'] }),
      },
      {
        name: 'fallback without credentials stays paused',
        op: 'dispatch_paused',
        files: until('2026-11-21T01:00:00Z'),
        args: repairConfig({ ...roles, fallback_models: ['zai/glm-4'] }),
      },
      {
        name: 'fallback with corrupt cooldowns fails closed',
        op: 'dispatch_paused',
        files: { 'repair/provider-cooldowns.json': '{' },
        env: { ZAI_API_KEY: 'k' },
        args: repairConfig({ ...roles, fallback_models: ['zai/glm-4'] }),
      },
    ]);
    expect(python[1]?.ok).toBe('2026-11-21T01:00:00Z');
    expect(python[0]?.ok).toBeNull();
    expect(python[5]?.ok).toBeNull();
    expect(python[6]?.ok).toBe('2026-11-21T01:00:00Z');
    expect(python[7]?.ok).not.toBeNull();
    expect(python[7]?.ok).not.toBe('2026-11-21T01:00:00Z');
  });

  it('blocked: GLM peak blackout, with and without a reaching wall-clock budget', async () => {
    const window = {
      blackout: { tz: 'UTC', days: [1, 2, 3, 4, 5], start: '10:00', end: '12:00' },
    };
    const repairs: unknown[] = [
      {},
      window,
      { ...window, budget: { wall_clock_min: 90 } },
      { ...window, budget: { wall_clock_min: 'x' } },
      { ...window, budget: [] },
      null,
    ];
    const nows = ['2026-11-23T09:00:00Z', '2026-11-23T10:30:00Z', '2026-11-23T12:00:00Z'];
    const cases: Case[] = repairs.flatMap((repair, r) =>
      nows.map((now): Case => ({
        name: `repair#${String(r)} ${now}`,
        op: 'blocked',
        args: { repair, now },
      })),
    );
    const python = await expectParity(cases);
    // Mon 2026-11-23: inside the window, reached by the 90-minute budget, and outside both.
    expect(python.some((o) => o.ok === true)).toBe(true);
    expect(python.some((o) => o.ok === false)).toBe(true);
  });

  it('fetchClone: a clean fetch, a non-repo clone and a held tick.lock', async () => {
    const python = await expectParity([
      { name: 'fetch ok', op: 'fetch_clone', args: repairConfig({}) },
      { name: 'clone is not a repo', op: 'fetch_clone', clone: 'none', args: repairConfig({}) },
      {
        name: 'tick.lock held, no wait',
        op: 'fetch_clone',
        holdLock: true,
        args: repairConfig({ tick_lock_wait_s: 0 }),
      },
      { name: 'config without repair', op: 'fetch_clone', args: { config: {} } },
      { name: 'bad wait type', op: 'fetch_clone', args: repairConfig({ tick_lock_wait_s: 'x' }) },
      { name: 'repair is a list', op: 'fetch_clone', args: { config: { repair: [] } } },
      { name: 'repair is a string', op: 'fetch_clone', args: { config: { repair: 'x' } } },
      { name: 'repair is null', op: 'fetch_clone', args: { config: { repair: null } } },
    ]);
    expect(python.slice(-3).every((o) => o.error === 'AttributeError')).toBe(true);
    expect(python[0]?.ok).toBeNull();
    expect(String(python[1]?.ok)).toMatch(/^clone fetch failed: /);
    expect(python[2]?.ok).toBe('crq tick holds tick.lock');
  });

  it('triage: null while the triage directory or the rollout is absent, as triage_phase', async () => {
    // Python's `triage_phase` returns None before reading anything else in these two states.
    const tmp = await mkdtemp(join(tmpdir(), 'crq-unit-triage-'));
    cleanups.push(tmp);
    const state = join(tmp, 'state');
    await mkdir(state);
    const { drain } = fileRepairUnit({ stateRoot: state, clone: tmp, narrate: () => undefined });
    expect(await drain.triage()).toBeNull();
    await mkdir(join(state, 'backfill', 'findings', 'triage'), { recursive: true });
    expect(await drain.triage()).toBeNull();
    // A complete rollout reaches the judge, which is not bound: it throws (deferring triage).
    await writeFile(
      join(state, 'backfill-rollout.json'),
      JSON.stringify({
        operational_ruling: 'r',
        no_live_run_verification: 'v',
        owner_branch_ruleset_evidence: 'e',
        durable_artifact_root: '/tmp/artifacts',
        runner_identity: 'crq-runner-app',
        publisher_spool: { ssh_alias: 'user@host', ssh_key: '/tmp/key' },
      }),
    );
    await expect(drain.triage()).rejects.toThrow('judge dispatch is not bound');
    // The directory gate comes first: a complete rollout without the triage directory is null.
    await rm(join(state, 'backfill', 'findings', 'triage'), { recursive: true });
    expect(await drain.triage()).toBeNull();
  });

  it('withAdmissionLock: waits for a held tick.lock, then runs the admission', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'crq-unit-admission-'));
    cleanups.push(tmp);
    const state = join(tmp, 'state');
    await mkdir(state);
    const { drain } = fileRepairUnit({ stateRoot: state, clone: tmp, narrate: () => undefined });
    let ran = false;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    let acquired: () => void = () => undefined;
    const holding = new Promise<void>((resolve) => (acquired = resolve));
    const holder = withLock(join(state, 'tick.lock'), { wait: false }, async () => {
      acquired();
      await held;
    });
    await holding;
    const admitted = drain.withAdmissionLock(async () => {
      ran = true;
      return 'admitted';
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(ran).toBe(false);
    release();
    await holder;
    expect(await admitted).toBe('admitted');
    expect(ran).toBe(true);
  });

  it('inboxOrder: oldest file first, odd names and non-files ignored', async () => {
    const files: Record<string, FileSpec> = {
      ...job('crq-job-b', '{}'),
      ...job('crq-job-a', '{}'),
      ...job('crq-job-c', '{}'),
      'repair/inbox/notes.txt': 'x',
      'repair/inbox/bad name.json': '{}',
      'repair/inbox/dir.json': { dir: true },
    };
    const python = await expectParity([
      {
        name: 'mtime order then name',
        op: 'inbox_order',
        files,
        mtimes: {
          'repair/inbox/crq-job-b.json': 100,
          'repair/inbox/crq-job-a.json': 200,
          'repair/inbox/crq-job-c.json': 100,
        },
      },
      { name: 'no inbox', op: 'inbox_order' },
    ]);
    expect(python[0]?.ok).toEqual(['crq-job-b', 'crq-job-c', 'crq-job-a']);
  });

  it('inboxItem: a string item, else nothing', async () => {
    const bodies: Record<string, string> = {
      'crq-job-1': '{"item": "pr-1"}',
      'crq-job-2': '{"item": 5}',
      'crq-job-3': '{}',
      'crq-job-4': '[]',
      'crq-job-5': 'not json',
      'crq-job-6': '"pr-1"',
    };
    const files = Object.fromEntries(
      Object.entries(bodies).flatMap(([id, body]) => Object.entries(job(id, body))),
    );
    const cases: Case[] = [...Object.keys(bodies), 'crq-job-7'].map((id) => ({
      name: id,
      op: 'inbox_item',
      files,
      args: { job: id },
    }));
    const python = await expectParity(cases);
    expect(python.map((o) => o.ok)).toEqual(['pr-1', null, null, null, null, null, null]);
  });

  it('readQueue: absent default, a document, and unreadable', async () => {
    const python = await expectParity([
      { name: 'absent', op: 'read_queue' },
      { name: 'document', op: 'read_queue', files: { 'queue.json': '{"items": [{"id": 1}]}' } },
      { name: 'not json', op: 'read_queue', files: { 'queue.json': '{' } },
      { name: 'empty', op: 'read_queue', files: { 'queue.json': '' } },
      { name: 'directory', op: 'read_queue', files: { 'queue.json': { dir: true } } },
    ]);
    expect(python[0]?.ok).toEqual({ items: [] });
    expect(python[2]?.ok).toEqual({ unreadable: true });
  });

  it('readBacklog: the document, or nothing when missing or unreadable', async () => {
    const path = 'repair/fix-pr-backlog.json';
    const python = await expectParity([
      {
        name: 'document',
        op: 'read_backlog',
        files: { [path]: '{"at": "x", "open": 1, "limit": 2}' },
      },
      { name: 'missing', op: 'read_backlog' },
      { name: 'not json', op: 'read_backlog', files: { [path]: '{' } },
      { name: 'directory', op: 'read_backlog', files: { [path]: { dir: true } } },
    ]);
    expect(python[0]?.ok).toEqual({ at: 'x', open: 1, limit: 2 });
    expect(python[1]?.ok).toEqual({ unreadable: true });
  });

  it('pending and unreadableResult: result.json classification', async () => {
    const results: Record<string, string> = {
      'crq-job-term': '{"verdict": "PASS"}',
      'crq-job-defer': '{"retry_after": "2026-11-21T00:00:00Z"}',
      'crq-job-zero': '{"retry_after": 0}',
      'crq-job-bad': '{',
      'crq-job-list': '[]',
      'crq-job-null': 'null',
    };
    const files = Object.fromEntries(
      Object.entries(results).flatMap(([id, body]) => Object.entries(result(id, body))),
    );
    const ids = [...Object.keys(results), 'crq-job-none'];
    const cases: Case[] = ids.flatMap((id) => [
      { name: `pending ${id}`, op: 'pending' as const, files, args: { job: id } },
      { name: `unreadable ${id}`, op: 'unreadable_result' as const, files, args: { job: id } },
    ]);
    const python = await expectParity(cases);
    expect(python[0]?.ok).toBe(false); // terminal result: not pending
    expect(python[2]?.ok).toBe(true); // deferred: pending
    expect(python[12]?.ok).toBe(true); // no result: pending
  });

  it('markStale: the STALE result bytes, with each utc() read in order', async () => {
    const stamps = ['2026-11-21T00:00:01Z', '2026-11-21T00:00:02Z'];
    const full = {
      job: 'crq-job-1',
      item: 'pr-1',
      repair_base: 'abc',
      source_sha: 'def',
      finding_sha256: '0'.repeat(64),
      origin_job: 'crq-job-0',
    };
    const python = await expectParity([
      {
        name: 'full job',
        op: 'mark_stale',
        clock: stamps,
        args: { jobObject: full, reason: 'superseded' },
      },
      {
        name: 'optional fields absent',
        op: 'mark_stale',
        clock: stamps,
        args: { jobObject: { job: 'crq-job-2', item: 'pr-2' }, reason: 'gone' },
      },
      {
        name: 'no item raises',
        op: 'mark_stale',
        args: { jobObject: { job: 'crq-job-3' }, reason: 'x' },
      },
    ]);
    const written = python[0]?.files?.['repair/crq-job-1/result.json'] ?? '';
    expect(written).toContain('"started_at": "2026-11-21T00:00:01Z"');
    expect(written).toContain('"finished_at": "2026-11-21T00:00:02Z"');
  });
});
