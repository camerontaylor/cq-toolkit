// Differential run: the same isolated state files, clock and environment through
// Python's `crq_repair.py` (the oracle, test/helpers/repairUnitOracle.py, Python 3.14 pinned)
// and the drain bindings of `fileRepairUnit`. Returned values and written files must be
// equal, and a Python exception must coincide with a TS throw. No network, provider or
// queue state; the only git is a local bare origin inside the temp dir.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { fileRepairUnit } from '../../../src/adapters/crq/repairUnit.js';
import { withLock } from '../../../src/adapters/crq/lock.js';
import { holdBackfillGroups, workerLimit } from '../../../src/ops/crq/internal/repairDrain.js';
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
  | 'mark_stale'
  | 'classify_job'
  | 'hold_backfill';
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

interface SeedCommit {
  files: Record<string, string>;
  /** The origin branch the commit is pushed to; the local clone is then reset (default `main`). */
  push?: string;
}

/**
 * The oracle's `seed_clone`, command for command. A fixed identity and date make the commit
 * ids reproducible, so a job can name a commit both sides will have. Returns each commit id.
 */
function seedClone(clone: string, commits: SeedCommit[]): string[] {
  const env = {
    PATH: process.env.PATH ?? '',
    GIT_AUTHOR_NAME: 'oracle',
    GIT_AUTHOR_EMAIL: 'oracle@example.invalid',
    GIT_COMMITTER_NAME: 'oracle',
    GIT_COMMITTER_EMAIL: 'oracle@example.invalid',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
  };
  const git = (...args: string[]): string =>
    execFileSync('git', ['-C', clone, '-c', 'commit.gpgsign=false', ...args], {
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  const ids: string[] = [];
  commits.forEach((entry, index) => {
    const before = index > 0 ? git('rev-parse', 'HEAD') : '';
    for (const [rel, text] of Object.entries(entry.files)) {
      mkdirSync(dirname(join(clone, rel)), { recursive: true });
      writeFileSync(join(clone, rel), text);
      git('add', rel);
    }
    git('commit', '--quiet', '-m', `seed ${String(index)}`);
    ids.push(git('rev-parse', 'HEAD'));
    const branch = entry.push ?? 'main';
    git('push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`);
    if (branch !== 'main') git('reset', '--quiet', '--hard', before);
  });
  return ids;
}

/** The commit ids a seed produces, from a scratch clone (they do not depend on the clone's path). */
function seedIds(commits: SeedCommit[]): string[] {
  const tmp = mkdtempSync(join(tmpdir(), 'crq-unit-seed-'));
  cleanups.push(tmp);
  return seedClone(makeClone(tmp), commits);
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
    (item.op === 'fetch_clone' || item.op === 'classify_job') && item.clone !== 'none'
      ? makeClone(tmp)
      : join(tmp, 'clone');
  if (item.op === 'classify_job' && item.clone !== 'none' && args.seed) {
    seedClone(clone, args.seed as SeedCommit[]);
  }
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
      case 'classify_job': {
        const outcome = await drain.classifyJob(toJson(args.queue), args.job as string);
        ok = { status: outcome.status, job: plain(outcome.job), reason: outcome.reason };
        break;
      }
      case 'hold_backfill': {
        const narrated: string[] = [];
        const groups = new Map((args.items as string[]).map((name) => [name, ['x']]));
        const kept = await holdBackfillGroups(
          groups,
          () => drain.readBacklog(),
          () => drain.nowMs(),
          async () => true,
          (line) => narrated.push(line),
        );
        ok = { kept: [...kept.keys()], narrated };
        break;
      }
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

/**
 * Each side runs in its own temp dir; an error text that names it is compared without it. The
 * parser's own wording after `unreadable job:` (Python's json vs the TS parser) is diagnostic
 * text, not a verdict, and is compared by its prefix.
 */
const scrub = (outcome: Outcome): Outcome =>
  outcome.ok === undefined || outcome.ok === null
    ? outcome
    : {
        ...outcome,
        ok: JSON.parse(
          JSON.stringify(outcome.ok)
            .replace(/\/[^"\s]*?(?:repair-unit-oracle-|crq-unit-ts-)[\w-]+/g, '<tmp>')
            .replace(/("unreadable job: )[^"]*/g, '$1'),
        ),
      };

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
    // Handshake, no timing: the admission records whether the other contender still holds
    // tick.lock when it runs. The holder clears its flag only just before releasing, and a
    // pass-through admission runs inside the call below, before release() is reached.
    let holding = false;
    let heldWhenAdmitted: boolean | null = null;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    let acquired: () => void = () => undefined;
    const isHolding = new Promise<void>((resolve) => (acquired = resolve));
    const holder = withLock(join(state, 'tick.lock'), { wait: false }, async () => {
      holding = true;
      acquired();
      await held;
    });
    await isHolding;
    const admitted = drain.withAdmissionLock(async () => {
      heldWhenAdmitted = holding;
      return 'admitted';
    });
    holding = false;
    release();
    await holder;
    expect(await admitted).toBe('admitted');
    expect(heldWhenAdmitted).toBe(false);
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
  it('nowMs: the unit clock drives the backlog age window, as hold_backfill_groups', async () => {
    const path = 'repair/fix-pr-backlog.json';
    const NOW = '2026-11-21T00:00:00Z';
    const backlog = (
      at: unknown,
      open: unknown = 1,
      limit: unknown = 3,
    ): Record<string, string> => ({
      [path]: JSON.stringify({ at, open, limit }),
    });
    const two = ['backfill-finding-a', 'backfill-finding-b'];
    const hold = (
      name: string,
      files: Record<string, string>,
      extra: Partial<Case> = {},
    ): Case => ({
      name,
      op: 'hold_backfill',
      files,
      args: { items: two },
      ...extra,
    });
    const cases: Case[] = [
      // The age window is 0..3600 s, both ends inclusive.
      hold('age 0', backlog('2026-11-21T00:00:00Z')),
      hold('age exactly the limit', backlog('2026-11-20T23:00:00Z')),
      hold('age one second over', backlog('2026-11-20T22:59:59Z')),
      hold('one second in the future', backlog('2026-11-21T00:00:01Z')),
      hold('offset form of the same instant', backlog('2026-11-20T23:30:00+00:00')),
      hold('a non-UTC offset', backlog('2026-11-21T09:30:00+10:00')),
      hold('fractional seconds', backlog('2026-11-20T23:59:59.500Z')),
      hold('naive timestamp', backlog('2026-11-20T23:30:00')),
      hold('non-string timestamp', backlog(1763683200)),
      // The same file under a clock that has moved on: only the unit clock can make it stale.
      hold('same file two hours later', backlog('2026-11-20T23:30:00Z'), {
        clock: ['2026-11-21T01:30:00Z'],
      }),
      // Budget arithmetic over the admitted file.
      hold('one slot of two groups', backlog(NOW, 2, 3)),
      hold('no slots', backlog(NOW, 3, 3)),
      hold('open above limit', backlog(NOW, 5, 3)),
      hold('boolean open', backlog(NOW, true, 3)),
      hold('null limit', backlog(NOW, 1, null)),
      hold('float open', backlog(NOW, 1.5, 3)),
      hold('missing file', {}),
      hold('unreadable file', { [path]: '{' }),
      {
        name: 'no backfill group: the file is never consulted',
        op: 'hold_backfill',
        files: { [path]: '{' },
        args: { items: ['pr-1', 'pr-2'] },
      },
      {
        name: 'non-backfill groups pass through a held pass',
        op: 'hold_backfill',
        files: backlog(NOW, 3, 3),
        args: { items: ['pr-1', 'backfill-finding-a', 'pr-2'] },
      },
    ];
    const python = await expectParity(cases);
    const kept = (index: number): unknown =>
      ((python[index] as Outcome).ok as { kept: string[] }).kept;
    expect(kept(0)).toEqual(two);
    expect(kept(1)).toEqual(two);
    expect(kept(2)).toEqual([]);
    expect(kept(3)).toEqual([]);
    expect(kept(9)).toEqual([]);
    expect(kept(10)).toEqual(['backfill-finding-a']);
    expect(kept(18)).toEqual(['pr-1', 'pr-2']);
    expect(kept(19)).toEqual(['pr-1', 'pr-2']);
  });

  it('nowMs: reads the injected clock at call time and defaults to the wall clock', async () => {
    const stamps = [Date.parse('2026-11-21T00:00:00Z'), Date.parse('2026-11-21T00:00:07.250Z')];
    let reads = 0;
    const { drain } = fileRepairUnit({
      stateRoot: '/nonexistent',
      clone: '/nonexistent',
      narrate: () => undefined,
      now: () => new Date(stamps[Math.min(reads++, 1)] as number),
    });
    expect(reads).toBe(0); // constructing a unit samples nothing
    expect(drain.nowMs()).toBe(stamps[0]);
    expect(drain.nowMs()).toBe(stamps[1]);
    expect(reads).toBe(2);
    const wall = fileRepairUnit({
      stateRoot: '/nonexistent',
      clone: '/nonexistent',
      narrate: () => undefined,
    }).drain;
    const before = Date.now();
    const sampled = wall.nowMs();
    expect(sampled).toBeGreaterThanOrEqual(before);
    expect(sampled).toBeLessThanOrEqual(Date.now());
  });

  describe('classifyJob: bounded.drain_job over a real clone', () => {
    const ID = 'crq-run1-F1';
    const KEPT = 'src/kept.ts';
    const V1 = 'a\nb\nc\n';
    const V2 = 'a\nB\nc\n';
    const V3 = 'a\nb\nC\n';
    const hex = (n: string): string => n.repeat(40);
    const FID = hex('d').repeat(1) + hex('d').slice(0, 24); // 64 hex digits
    const finding = (over: Record<string, unknown> = {}) => ({
      path: KEPT,
      line: 2,
      severity: 'major',
      body: 'Finding data',
      ...over,
    });
    const jobBody = (pin: string, over: Record<string, unknown> = {}) => ({
      job: ID,
      item: 'pr1-merged',
      run: 'run1',
      kind: 'merged',
      pr: 1,
      repair_base: pin,
      repair_round: 1,
      finding: finding(),
      ...over,
    });
    const queueOf = (record: unknown, itemId = 'pr1-merged') => ({
      items: [{ id: itemId, kind: 'merged', repair_runs: { run1: record } }],
    });
    const queued = (pin: string, over: Record<string, unknown> = {}) => ({
      base: pin,
      jobs: [ID],
      state: 'queued',
      open_pr: false,
      ...over,
    });
    // Main holds A. `fix/x`, `fix/y` and `fix/z` each branch from A: X carries V2, Y carries V3
    // and Z carries V2 again (a different commit, the same blob).
    const branched = [
      { files: { [KEPT]: V1 } },
      { files: { [KEPT]: V2 }, push: 'fix/x' },
      { files: { [KEPT]: V3 }, push: 'fix/y' },
      { files: { [KEPT]: V2 }, push: 'fix/z' },
    ];
    const moved = [{ files: { [KEPT]: V1 } }, { files: { [KEPT]: V2 } }];
    const seedA = [{ files: { [KEPT]: V1 } }];
    const [PA, PX] = seedIds(branched) as [string, string];
    const started = { [`repair/${ID}/result.json`]: '{}' };
    const triageRow = (task: string, status = 'delivered'): Record<string, string> => ({
      [`backfill/findings/triage/${FID}.json`]: JSON.stringify({
        status,
        receipt: { repair_task: task },
      }),
    });

    function run(
      name: string,
      body: unknown,
      args: { queue: unknown; seed?: SeedCommit[]; job?: string },
      extra: Partial<Case> = {},
    ): Case {
      return {
        name,
        op: 'classify_job',
        files: {
          ...(body === undefined
            ? {}
            : job(ID, typeof body === 'string' ? body : JSON.stringify(body))),
          ...extra.files,
        },
        args: { job: ID, seed: seedA, ...args },
        ...(extra.clone ? { clone: extra.clone } : {}),
      };
    }

    it('agrees with Python on every refusal, stale ground and bound job', async () => {
      const q = queueOf(queued(PA));
      const open = (branch: unknown, pin = PX): Record<string, unknown> =>
        queued(pin, { open_pr: true, branch });
      const cases: Case[] = [
        run('invalid id', jobBody(PA), { queue: q, job: '../x' }),
        run('job file missing', undefined, { queue: q }),
        run(
          'job path is a directory',
          undefined,
          { queue: q },
          { files: { [`repair/inbox/${ID}.json`]: { dir: true } } },
        ),
        run('job is a list', '[]', { queue: q }),
        run('job is not json', '{', { queue: q }),
        run('job names another id', jobBody(PA, { job: 'crq-other-F1' }), { queue: q }),
        run('item absent from the queue', jobBody(PA), { queue: queueOf(queued(PA), 'other') }),
        run('queue item without an id', jobBody(PA), { queue: { items: [{ repair_runs: {} }] } }),
        run('queue without items', jobBody(PA), { queue: {} }),
        run('record not queued', jobBody(PA), { queue: queueOf(queued(PA, { state: 'running' })) }),
        run('job missing from the record', jobBody(PA), {
          queue: queueOf(queued(PA, { jobs: ['x'] })),
        }),
        run('no finding', jobBody(PA, { finding: undefined }), { queue: q }),
        run('minor severity', jobBody(PA, { finding: finding({ severity: 'minor' }) }), {
          queue: q,
        }),
        run('path escapes the repository', jobBody(PA, { finding: finding({ path: '../x' }) }), {
          queue: q,
        }),
        run('path is absent', jobBody(PA, { finding: finding({ path: undefined }) }), { queue: q }),
        run('pin is not a sha', jobBody('main'), { queue: queueOf(queued('main')) }),
        run('pin differs from the run record', jobBody(PA), { queue: queueOf(queued(hex('b'))) }),
        run('canonical id malformed', jobBody(PA, { canonical_finding_id: 'abc' }), { queue: q }),
        run('canonical row missing', jobBody(PA, { canonical_finding_id: FID }), { queue: q }),
        run(
          'canonical row names another task',
          jobBody(PA, { canonical_finding_id: FID }),
          { queue: q },
          {
            files: triageRow('crq-other-F1'),
          },
        ),
        run(
          'canonical row delivered',
          jobBody(PA, { canonical_finding_id: FID }),
          { queue: q },
          {
            files: triageRow(ID),
          },
        ),
        run(
          'canonical minor finding is repaired',
          jobBody(PA, { canonical_finding_id: FID, finding: finding({ severity: 'minor' }) }),
          { queue: q },
          {
            files: triageRow(ID),
          },
        ),
        run('bound at the pin', jobBody(PA), { queue: q }),
        run('path absent at the pin', jobBody(PA, { finding: finding({ path: 'src/gone.ts' }) }), {
          queue: q,
        }),
        run('source changed on the default branch', jobBody(PA), { queue: q, seed: moved }),
        run(
          'resumed job keeps a moved default branch',
          jobBody(PA),
          { queue: q, seed: moved },
          { files: started },
        ),
        run(
          'resumed job with the path gone',
          jobBody(PA, { finding: finding({ path: 'src/gone.ts' }) }),
          { queue: q },
          {
            files: started,
          },
        ),
        run(
          'prepared job, resumed',
          jobBody(PA, { revalidation: { source_blob_sha: 'x' } }),
          { queue: q },
          {
            files: started,
          },
        ),
        run('open PR already on the default branch', jobBody(PA), {
          queue: queueOf(open('fix/x', PA)),
          seed: branched,
        }),
        run('open PR branch gone', jobBody(PX), {
          queue: queueOf(open('fix/gone')),
          seed: branched,
        }),
        run('open PR branch at the pin', jobBody(PX), {
          queue: queueOf(open('fix/x')),
          seed: branched,
        }),
        run('open PR branch changed the source', jobBody(PX), {
          queue: queueOf(open('fix/y')),
          seed: branched,
        }),
        run('open PR branch moved, same source blob', jobBody(PX), {
          queue: queueOf(open('fix/z')),
          seed: branched,
        }),
        run('open PR branch starts with a dash', jobBody(PX), {
          queue: queueOf(open('-x')),
          seed: branched,
        }),
        run('open PR branch is not a string', jobBody(PX), {
          queue: queueOf(open(7)),
          seed: branched,
        }),
        run(
          'open PR resumed with its branch gone',
          jobBody(PX),
          { queue: queueOf(open('fix/gone')), seed: branched },
          {
            files: started,
          },
        ),
        run('clone is missing', jobBody(PA), { queue: q }, { clone: 'none' }),
      ];
      const python = await expectParity(cases);
      const at = (name: string): Record<string, unknown> => {
        const index = cases.findIndex((c) => c.name === name);
        return (python[index]?.ok ?? { error: python[index]?.error }) as Record<string, unknown>;
      };
      // The oracle's own verdicts, so a case that silently stopped reaching its rule fails here.
      expect(at('invalid id')).toMatchObject({ status: 'skip' });
      expect(at('canonical row missing')).toMatchObject({ status: 'skip' });
      expect(at('canonical row delivered')).toMatchObject({ status: 'run' });
      expect(at('canonical minor finding is repaired')).toMatchObject({ status: 'run' });
      expect(at('minor severity')).toMatchObject({ status: 'skip' });
      expect(at('bound at the pin')).toMatchObject({ status: 'run', reason: '' });
      expect(at('path absent at the pin')).toMatchObject({ status: 'stale' });
      expect(at('source changed on the default branch')).toMatchObject({ status: 'stale' });
      expect(at('resumed job keeps a moved default branch')).toMatchObject({ status: 'run' });
      expect(at('resumed job with the path gone')).toMatchObject({
        status: 'skip',
        reason: 'pinned source path missing',
      });
      expect(at('prepared job, resumed')).toMatchObject({ status: 'run' });
      expect(at('open PR already on the default branch')).toMatchObject({ status: 'stale' });
      expect(at('open PR branch gone')).toMatchObject({ status: 'stale' });
      expect(at('open PR branch at the pin')).toMatchObject({ status: 'run' });
      expect(at('open PR branch changed the source')).toMatchObject({ status: 'stale' });
      expect(at('open PR branch moved, same source blob')).toMatchObject({ status: 'run' });
      expect(at('open PR branch starts with a dash')).toMatchObject({ status: 'stale' });
      expect(at('open PR resumed with its branch gone')).toMatchObject({ status: 'run' });
      // The bound job carries the pin the seed produced: the ids are reproducible across sides.
      expect(at('bound at the pin').job).toMatchObject({ source_sha: PA });
    });

    it('a relative clone path is resolved once, against the process directory', async () => {
      const tmp = mkdtempSync(join(tmpdir(), 'crq-unit-rel-'));
      cleanups.push(tmp);
      const clone = makeClone(tmp);
      const [pin] = seedClone(clone, seedA);
      const stateRoot = join(tmp, 'state');
      await mkdir(join(stateRoot, 'repair', 'inbox'), { recursive: true });
      await writeFile(
        join(stateRoot, 'repair', 'inbox', `${ID}.json`),
        JSON.stringify(jobBody(pin as string)),
      );
      const { drain } = fileRepairUnit({
        stateRoot,
        clone: relative(process.cwd(), clone),
        narrate: () => undefined,
      });
      const outcome = await drain.classifyJob(toJson(queueOf(queued(pin as string))), ID);
      expect(outcome.status).toBe('run');
    });

    it('a failing git read throws, as Python raises, instead of reporting stale', async () => {
      const boom = new Error('git is unavailable');
      const stateRoot = await mkdtemp(join(tmpdir(), 'crq-unit-classify-'));
      cleanups.push(stateRoot);
      await mkdir(join(stateRoot, 'repair', 'inbox'), { recursive: true });
      await writeFile(
        join(stateRoot, 'repair', 'inbox', `${ID}.json`),
        JSON.stringify(jobBody(PA)),
      );
      const { drain } = fileRepairUnit({
        stateRoot,
        clone: '/nonexistent',
        narrate: () => undefined,
        runGitSync: () => {
          throw boom;
        },
      });
      await expect(drain.classifyJob(toJson(queueOf(queued(PA))), ID)).rejects.toBe(boom);
    });
  });
});
