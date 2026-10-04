// W2.4 process proofs. No record TTL stealing (only the acquisition guard
// lease ages out), TMPDIR split, or stale-owner unlink.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { LockOptions } from 'proper-lockfile';
import { afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { createGovernor } from '../../src/kernel/governor.js';
import { acquirePlanLock, openRunLog } from '../../src/kernel/journal.js';
import { runPlan, type OpRegistryView } from '../../src/kernel/runner.js';
import type { Op, OpRegistryEntry } from '../../src/kernel/types.js';

// Event gates only: the guard library and the filesystem run for real; the
// hooks observe its options and pause at named publication points.
const hooks = vi.hoisted(() => ({
  guardAcquired: undefined as ((options: LockOptions) => void) | undefined,
  beforeClaim: undefined as ((temporary: string, claim: string) => Promise<void>) | undefined,
  afterPublication: undefined as (() => void) | undefined,
}));
vi.mock('proper-lockfile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('proper-lockfile')>();
  return {
    ...actual,
    async lock(file: string, options?: LockOptions) {
      const release = await actual.lock(file, options);
      hooks.guardAcquired?.(options ?? {});
      return release;
    },
  };
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    async link(...args: Parameters<typeof actual.link>) {
      // A succession claim: eligibility has been decided, nothing published.
      if (
        typeof args[0] === 'string' &&
        typeof args[1] === 'string' &&
        args[1].endsWith('.claim')
      ) {
        await hooks.beforeClaim?.(args[0], args[1]);
      }
      await actual.link(...args);
    },
    async open(...args: Parameters<typeof actual.open>) {
      const handle = await actual.open(...args);
      // The post-publication owner handle: the record is canonical.
      if (typeof args[0] === 'string' && args[0].endsWith('.lock.json') && args[1] === 'r+') {
        hooks.afterPublication?.();
      }
      return handle;
    },
  };
});

// proper-lockfile judges staleness by the guard directory's mtime against
// the wall clock (Date.now() - stale). Tests age a lease as data — an mtime
// at the epoch — instead of waiting out the real 30s window.
const LEASE_EPOCH = new Date(0);
const GUARD = 'locked.lock.guard.lock';
function compromisedError(): Error {
  return Object.assign(new Error('Unable to update lock within the stale threshold'), {
    code: 'ECOMPROMISED',
  });
}
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Run the actual sources in another process without a build or extra package.
// Node's strip-types supplies the TS syntax; the loader maps source .js imports.
const loader = `
import { access } from 'node:fs/promises';
export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL && specifier.startsWith('.') && specifier.endsWith('.js')) {
    const ts = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
    try { await access(ts); return nextResolve(ts.href, context); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return nextResolve(specifier, context);
}`;
const journalUrl = new URL('../../src/kernel/journal.ts', import.meta.url).href;
const script = `
import { acquirePlanLock, claimSeq, openRunLog } from ${JSON.stringify(journalUrl)};
import { createInterface } from 'node:readline';
import cp from 'node:child_process';
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
let bootCalls = 0;
if (process.env.J_TEST_BOOT_CACHE === 'yes') {
  const original = promisify(cp.execFile);
  const intercepted = () => { throw new Error('unexpected callback boot invocation'); };
  intercepted[promisify.custom] = async (...args) => {
    bootCalls++;
    if (bootCalls === 1) throw Object.assign(new Error('injected lookup timeout'), { code: null, killed: true, signal: 'SIGTERM', stderr: '' });
    return original(...args);
  };
  cp.execFile = intercepted;
  syncBuiltinESMExports();
}
if (process.env.J_TEST_PAUSE_PUBLICATION === 'yes') {
  // hostname() is first called while building the record: the guard lease
  // is held and nothing is published yet.
  const original = os.hostname;
  let paused = false;
  os.hostname = () => {
    if (!paused) {
      paused = true;
      console.log(JSON.stringify({ status: 'publication-held' }));
      process.kill(process.pid, 'SIGSTOP');
    }
    return original();
  };
  syncBuiltinESMExports();
}
const lines = createInterface({ input: process.stdin });
const commands = [];
let pending;
lines.on('line', line => { if (pending) { const done = pending; pending = undefined; done(line); } else commands.push(line); });
const next = () => commands.length ? Promise.resolve(commands.shift()) : new Promise(done => { pending = done; });
const send = value => console.log(JSON.stringify(value));
if (process.env.J_TEST_BOOT_CACHE === 'yes') {
  for (const runId of ['first', 'second', 'third']) {
    try {
      const current = await acquirePlanLock(process.env.J_TEST_DIR, 'locked', runId);
      await current.release();
      send({ status: 'released', bootCalls });
    } catch (error) {
      send({ status: 'refused', error: error.message, bootCalls });
    }
  }
  process.exit(0);
}
if (process.env.J_TEST_CLAIM_ONLY === 'yes') {
  const seq = await claimSeq(process.env.J_TEST_DIR, 'locked', 1);
  send({ status: 'claimed', seq });
  process.exit(0);
}
if (process.env.J_TEST_RACE === 'yes') { send({ status: 'waiting' }); await next(); }
let lease;
try {
  lease = await acquirePlanLock(process.env.J_TEST_DIR, 'locked', process.env.J_TEST_RUN);
  const seq = await claimSeq(process.env.J_TEST_DIR, 'locked', 1);
  if (process.env.J_TEST_CRASH === 'yes') {
    const runId = process.env.J_TEST_RUN;
    const log = openRunLog(process.env.J_TEST_DIR);
    await log.append(runId, { type: 'run-started', runId, planId: 'locked', at: '2026-01-01T00:00:00Z', journalVersion: 2, seq, governance: { attended: false, capUsd: 10 } }, { durable: true });
    await log.append(runId, { type: 'reservation-opened', runId, at: '2026-01-01T00:00:01Z', jobId: 'a', op: 'work', attempt: 1, reservationId: runId + ':a:1:1', usd: 4, class: 'advisory' }, { durable: true });
  }
  send({ status: 'acquired', seq });
} catch (error) { send({ status: 'refused', error: error.message }); process.exit(0); }
for (;;) {
  const command = await next();
  if (command === 'check') {
    try { await lease.assertHeld(); send({ status: 'held' }); }
    catch (error) { send({ status: 'lost', error: error.message }); }
  }
  if (command === 'release') { await lease.release(); send({ status: 'released' }); process.exit(0); }
}
`;
interface Message {
  status: string;
  seq?: number;
  error?: string;
}
interface Worker {
  child: ChildProcessWithoutNullStreams;
  next(): Promise<Message>;
  exited: Promise<void>;
}
// Mirrors journal.ts's private 10s boot bound; the remaining 15s covers
// measured Node/loader startup and guard/record I/O under load (the retired
// flock helper's 10s slot, kept until re-measured). Update on source-bound
// drift.
const CHILD_STEP_MS = 2 * 10_000 + 5_000;
const workers: Worker[] = [];
const directories: string[] = [];
const sockets = new Set<string>();
async function directory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cq-j-lock-'));
  directories.push(dir);
  return dir;
}
function start(dir: string, runId: string, extra: Record<string, string> = {}): Worker {
  const child = spawn(
    process.execPath,
    [
      '--experimental-strip-types',
      '--experimental-loader',
      `data:text/javascript,${encodeURIComponent(loader)}`,
      '--input-type=module',
      '-e',
      script,
    ],
    { env: { ...process.env, J_TEST_DIR: dir, J_TEST_RUN: runId, ...extra }, stdio: 'pipe' },
  );
  let stderr = '';
  child.stderr.on('data', (bytes: Buffer) => {
    stderr += bytes.toString();
  });
  const messages: Message[] = [];
  let waiter: ((message: Message) => void) | undefined;
  let refuseWaiter: (() => void) | undefined;
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line) as Message;
    if (waiter !== undefined) {
      const done = waiter;
      waiter = undefined;
      done(message);
    } else messages.push(message);
  });
  const exited = new Promise<void>((resolve) => {
    child.once('close', () => {
      refuseWaiter?.();
      resolve();
    });
  });
  const worker: Worker = {
    child,
    exited,
    next() {
      const queued = messages.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          waiter = undefined;
          refuseWaiter = undefined;
          reject(new Error(`lock child timed out: ${stderr}`));
        }, CHILD_STEP_MS);
        refuseWaiter = () => {
          clearTimeout(timeout);
          waiter = undefined;
          refuseWaiter = undefined;
          reject(new Error(`lock child closed before expected handshake: ${stderr}`));
        };
        waiter = (message) => {
          clearTimeout(timeout);
          refuseWaiter = undefined;
          resolve(message);
        };
      });
    },
  };
  workers.push(worker);
  return worker;
}
async function record(dir: string): Promise<Record<string, unknown>> {
  const value = JSON.parse(await readFile(join(dir, 'locked.lock.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  if (typeof value.socketPath === 'string') sockets.add(value.socketPath);
  return value;
}
function workRegistry(calls: string[]): OpRegistryView {
  const candidate: OpRegistryEntry<never, never> = {
    name: 'work',
    inputSchema: z.object({ id: z.string() }) as unknown as z.ZodType<never>,
    importer: () =>
      Promise.resolve((async () => {
        calls.push('a');
        return { status: 'ok', value: 'a' };
      }) as unknown as Op<never, never>),
  };
  return { get: () => candidate };
}
afterEach(async () => {
  hooks.guardAcquired = undefined;
  hooks.beforeClaim = undefined;
  hooks.afterPublication = undefined;
  for (const worker of workers.splice(0)) {
    if (worker.child.exitCode === null && worker.child.signalCode === null) {
      worker.child.kill('SIGCONT');
      worker.child.kill('SIGKILL');
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        worker.exited,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('lock child not reaped; journal retained')),
            CHILD_STEP_MS,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  await Promise.all([...sockets].map((path) => unlink(path).catch(() => undefined)));
  sockets.clear();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}, CHILD_STEP_MS + 5_000);

// Owner child, contender child, then parent acquisition: three bounded steps.
// Enclosure: three acquisitions, two of them fresh child processes.
test(
  'different TMPDIR contenders use the recorded socket and cannot split one plan lock',
  async () => {
    const dir = await directory();
    const owner = start(dir, 'owner', { TMPDIR: '/tmp/owner-only' });
    expect((await owner.next()).status).toBe('acquired');
    await record(dir);
    const contender = start(dir, 'contender', { TMPDIR: '/tmp/contender-only' });
    const refusal = await contender.next();
    expect(refusal.status).toBe('refused');
    expect(refusal.error).toContain('plan locked');
    owner.child.stdin.write('release\n');
    expect((await owner.next()).status).toBe('released');
    await owner.exited;
    const next = await acquirePlanLock(dir, 'locked', 'next');
    await next.release();
  },
  3 * CHILD_STEP_MS,
);

// Enclosure: owner child then contender; includes the 1s socket probe within margin.
test(
  'SIGSTOP with a saturated socket backlog never permits stealing a live owner',
  async () => {
    const dir = await directory();
    const owner = start(dir, 'paused');
    expect((await owner.next()).status).toBe('acquired');
    const lock = await record(dir);
    owner.child.kill('SIGSTOP');
    // The listener uses backlog 16. Connections queue while the owner is paused;
    // both a full backlog and PID liveness must remain refusal evidence.
    const connections: Socket[] = [];
    await Promise.all(
      Array.from(
        { length: 64 },
        () =>
          new Promise<void>((resolve) => {
            const socket = createConnection(String(lock.socketPath));
            connections.push(socket);
            const done = () => {
              clearTimeout(timeout);
              resolve();
            };
            const timeout = setTimeout(done, 100);
            socket.once('connect', done);
            socket.once('error', done);
          }),
      ),
    );
    try {
      await expect(acquirePlanLock(dir, 'locked', 'contender')).rejects.toThrow('plan locked');
      expect((await record(dir)).nonce).toBe(lock.nonce);
    } finally {
      for (const socket of connections) socket.destroy();
      owner.child.kill('SIGCONT');
    }
    owner.child.stdin.write('release\n');
    expect((await owner.next()).status).toBe('released');
  },
  2 * CHILD_STEP_MS,
);

// Enclosure: owner write-ahead then parent recovery.
test(
  'SIGKILL recovery charges an unresolved durable reservation and quarantines its job',
  async () => {
    const dir = await directory();
    const owner = start(dir, 'locked--1--a', { J_TEST_CRASH: 'yes' });
    expect((await owner.next()).status).toBe('acquired');
    await record(dir);
    owner.child.kill('SIGKILL');
    await owner.exited;
    const calls: string[] = [];
    const registry = workRegistry(calls);
    const governor = createGovernor({ maxUsd: 10 });
    const report = await runPlan(
      { id: 'locked', jobs: [{ id: 'a', op: 'work', input: { id: 'a' } }] },
      { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
      registry,
      { governor, allowAdvisory: true },
    );
    expect(calls).toEqual([]);
    expect(governor.usdSpent).toBe(4);
    expect(governor.quarantinedJobs.has('a')).toBe(true);
    expect(governor.outstandingCount).toBe(0);
    expect(governor.inFlight).toBe(0);
    const recoveryEvents = await openRunLog(dir).read(report.runId);
    expect(recoveryEvents.find((event) => event.type === 'run-started')).toMatchObject({
      journalVersion: 2,
      seq: 2,
    });
    const verdict = report.jobs[0]?.result;
    expect(verdict?.status).toBe('needs-human');
    if (verdict?.status !== 'needs-human') throw new Error('missing quarantine verdict');
    expect(verdict.reason).toContain('quarantined:');
  },
  2 * CHILD_STEP_MS,
);

test.each(['', '{"nonce":', '{"nonce":"invalid"}'])(
  'half-written or corrupt lock refuses without replacing bytes: %s',
  async (bytes) => {
    const dir = await directory();
    const path = join(dir, 'locked.lock.json');
    await writeFile(path, bytes);
    await expect(acquirePlanLock(dir, 'locked', 'contender')).rejects.toThrow('half-written');
    expect(await readFile(path, 'utf8')).toBe(bytes);
  },
);

// Enclosure: seed plus two independently booted reclaimers (parallel, conservatively summed).
test(
  'racing reclaimers fence by nonce and stale release cannot clobber the winner',
  async () => {
    const dir = await directory();
    const seed = await acquirePlanLock(dir, 'locked', 'seed');
    await seed.release();
    const contenders = [
      start(dir, 'one', { J_TEST_RACE: 'yes' }),
      start(dir, 'two', { J_TEST_RACE: 'yes' }),
    ];
    expect(await Promise.all(contenders.map((worker) => worker.next()))).toEqual([
      { status: 'waiting' },
      { status: 'waiting' },
    ]);
    for (const worker of contenders) worker.child.stdin.write('go\n');
    const acquired = await Promise.all(contenders.map((worker) => worker.next()));
    const seqs = acquired
      .filter((message) => message.status === 'acquired')
      .map((message) => message.seq);
    expect(seqs).toHaveLength(1); // exclusion, not merely eventual nonce convergence
    expect(new Set(seqs).size).toBe(seqs.length);
    const winner = await record(dir);
    const statuses = await Promise.all(
      contenders.map(async (worker, index) => {
        if (acquired[index]?.status !== 'acquired') return 'refused';
        worker.child.stdin.write('check\n');
        return (await worker.next()).status;
      }),
    );
    expect(statuses.filter((status) => status === 'held')).toHaveLength(1);
    for (const [index, worker] of contenders.entries()) {
      if (statuses[index] !== 'lost') continue;
      worker.child.stdin.write('release\n');
      expect((await worker.next()).status).toBe('released');
      expect((await record(dir)).nonce).toBe(winner.nonce);
      expect(await record(dir)).not.toHaveProperty('released');
    }
    for (const [index, worker] of contenders.entries()) {
      if (statuses[index] !== 'held') continue;
      worker.child.stdin.write('release\n');
      expect((await worker.next()).status).toBe('released');
    }
  },
  3 * CHILD_STEP_MS,
);

// Enclosure: one acquisition before the foreign-host refusal.
test(
  'foreign-host record refuses even with dead-looking PID/socket evidence',
  async () => {
    const dir = await directory();
    const path = join(dir, 'locked.lock.json');
    const bytes = JSON.stringify({
      nonce: randomUUID(),
      socketPath: '/tmp/no-such-cq-j.sock',
      pid: 2147483647,
      host: 'foreign-host',
      bootId: 'old-boot',
      runId: 'foreign',
    });
    await writeFile(path, bytes);
    await expect(acquirePlanLock(dir, 'locked', 'contender')).rejects.toThrow('foreign host');
    expect(await readFile(path, 'utf8')).toBe(bytes);
  },
  CHILD_STEP_MS + 5_000,
);

// Enclosure: one acquisition reclaiming a moved journal's tombstone.
test(
  'foreign-host released tombstone is reclaimable and release publishes a whole tombstone',
  async () => {
    const dir = await directory();
    const path = join(dir, 'locked.lock.json');
    await writeFile(
      path,
      JSON.stringify({
        nonce: randomUUID(),
        socketPath: '/tmp/no-such-cq-j.sock',
        pid: 2147483647,
        host: 'foreign-host',
        bootId: 'old-boot',
        runId: 'foreign',
        released: true,
      }),
    );
    const lease = await acquirePlanLock(dir, 'locked', 'contender');
    const held = await record(dir);
    expect(held).toMatchObject({ runId: 'contender' });
    expect(held).not.toHaveProperty('released');
    await lease.release();
    expect(await record(dir)).toEqual({ ...held, released: true });
    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  },
  CHILD_STEP_MS + 5_000,
);

// Enclosure: parallel Node/loader startups; no helper or boot lookup.
test(
  'independent child sequence claims use the real plan and unique positive ordinals',
  async () => {
    const dir = await directory();
    const contenders = [
      start(dir, 'claim-one', { J_TEST_CLAIM_ONLY: 'yes' }),
      start(dir, 'claim-two', { J_TEST_CLAIM_ONLY: 'yes' }),
    ];
    const claims = await Promise.all(contenders.map((worker) => worker.next()));
    expect(claims.map((message) => message.status)).toEqual(['claimed', 'claimed']);
    expect(claims.map((message) => message.seq).sort()).toEqual([1, 2]);
  },
  CHILD_STEP_MS,
);

test('an interrupted publication guard refuses without unsafe automatic reclamation', async () => {
  const dir = await directory();
  const guard = join(dir, 'locked.lock.acquiring');
  await mkdir(guard);
  await expect(acquirePlanLock(dir, 'locked', 'contender')).rejects.toThrow(
    'acquisition in progress or interrupted',
  );
  await expect(readFile(join(dir, 'locked.lock.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

// Enclosure: seed and paused child each 25s; parent contention/recovery share remaining 25s.
test(
  'guard lease retains exclusion through SIGSTOP within its 30s stale bound; a SIGKILLed holder recovers once its lease is stale',
  async () => {
    const dir = await directory();
    const path = join(dir, 'locked.lock.json');
    // Complete released prior state; no legacy acquiring directory exists.
    const seed = await acquirePlanLock(dir, 'locked', 'seed');
    await seed.release();
    const prior = await readFile(path, 'utf8');
    const held = start(dir, 'interrupted', { J_TEST_PAUSE_PUBLICATION: 'yes' });
    expect(await held.next()).toMatchObject({ status: 'publication-held' });
    await expect(acquirePlanLock(dir, 'locked', 'contender')).rejects.toThrow(
      'acquisition in progress',
    );
    expect(await readFile(path, 'utf8')).toBe(prior);
    held.child.kill('SIGKILL');
    await held.exited;
    // The trade against flock: death no longer releases the guard. Until
    // the dead holder's lease is stale, acquisition still refuses as busy.
    await expect(acquirePlanLock(dir, 'locked', 'too-soon')).rejects.toThrow(
      'acquisition in progress',
    );
    expect(await readFile(path, 'utf8')).toBe(prior);
    await utimes(join(dir, GUARD), LEASE_EPOCH, LEASE_EPOCH);
    const recovered = await acquirePlanLock(dir, 'locked', 'recovered');
    try {
      await recovered.assertHeld();
    } finally {
      await recovered.release();
    }
    expect((await record(dir)).runId).toBe('recovered');
    expect(await readdir(dir)).not.toContain(GUARD);
  },
  3 * CHILD_STEP_MS,
);

/** Gate the next succession claim only: the judgment is made, nothing is published. */
function gateNextClaim(): { judged: Promise<void>; resume: () => void } {
  const judged = deferred();
  const resume = deferred();
  hooks.beforeClaim = async () => {
    hooks.beforeClaim = undefined;
    judged.resolve();
    await resume.promise;
  };
  return { judged: judged.promise, resume: resume.resolve };
}

test('a stale guard lease taken over cannot let its displaced holder publish over the new owner', async () => {
  const dir = await directory();
  const seed = await acquirePlanLock(dir, 'locked', 'seed');
  await seed.release();
  const seedNonce = String((await record(dir)).nonce);
  const gate = gateNextClaim();
  const displaced = acquirePlanLock(dir, 'locked', 'displaced').then(
    () => 'acquired',
    (error: unknown) => (error as Error).message,
  );
  let owner: Awaited<ReturnType<typeof acquirePlanLock>> | undefined;
  try {
    // The displaced holder judged the seed tombstone reclaimable and holds
    // the guard. Its lease goes stale (a stall past `stale`): a new owner
    // takes the guard over and claims the same tombstone first.
    await gate.judged;
    await utimes(join(dir, GUARD), LEASE_EPOCH, LEASE_EPOCH);
    owner = await acquirePlanLock(dir, 'locked', 'owner');
    const owned = await record(dir);
    expect(owned).toMatchObject({ runId: 'owner' });
    const ownedInode = await stat(join(dir, 'locked.lock.json'));
    gate.resume();
    // The seed's claim is taken by a live, unreleased owner: refuse, never
    // replace (the canonical record was never touched, inode included).
    expect(await displaced).toContain("plan locked by 'owner'");
    expect(await record(dir)).toEqual(owned);
    const after = await stat(join(dir, 'locked.lock.json'));
    expect({ dev: after.dev, ino: after.ino }).toEqual({
      dev: ownedInode.dev,
      ino: ownedInode.ino,
    });
    expect(
      JSON.parse(await readFile(join(dir, `locked.lock.json.${seedNonce}.claim`), 'utf8')),
    ).toEqual(owned);
    await owner.assertHeld();
    await owner.release();
    expect(await record(dir)).toEqual({ ...owned, released: true });
  } finally {
    gate.resume();
    await displaced;
    await owner?.release();
  }
  expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
});

test('a stale judgment walks the succession past a released claimant instead of replacing blindly', async () => {
  const dir = await directory();
  const path = join(dir, 'locked.lock.json');
  const seed = await acquirePlanLock(dir, 'locked', 'seed');
  await seed.release();
  const prior = await record(dir);
  const gate = gateNextClaim();
  const late = acquirePlanLock(dir, 'locked', 'late');
  void late.catch(() => undefined); // observed below
  try {
    await gate.judged;
    // While the late acquirer's judgment of the seed is stale, another run
    // claimed the seed, owned the plan, and released. Built as data: no
    // guard ageing or second process, so no refresh timer is raced.
    const between = {
      nonce: randomUUID(),
      socketPath: '/tmp/no-such-cq-j.sock',
      pid: process.pid, // alive: only its released tombstone permits succession
      host: prior.host,
      bootId: prior.bootId,
      runId: 'between',
    };
    await writeFile(`${path}.${String(prior.nonce)}.claim`, JSON.stringify(between));
    await writeFile(path, JSON.stringify({ ...between, released: true }));
    gate.resume();
    // The seed's claim names 'between', whose canonical record is its
    // released tombstone: the late acquirer succeeds IT, by its own claim.
    const lease = await late;
    try {
      await lease.assertHeld();
      expect(await record(dir)).toMatchObject({ runId: 'late' });
      expect(JSON.parse(await readFile(`${path}.${between.nonce}.claim`, 'utf8'))).toMatchObject({
        runId: 'late',
      });
    } finally {
      await lease.release();
    }
  } finally {
    gate.resume();
    await late.catch(() => undefined);
  }
});

test('a claimant that died between claim and publication is succeeded, not wedged', async () => {
  const dir = await directory();
  const path = join(dir, 'locked.lock.json');
  const seed = await acquirePlanLock(dir, 'locked', 'seed');
  await seed.release();
  const prior = await record(dir);
  // A crashed reclaimer: its claim on the seed exists, its record was never
  // published, and its pid/socket are dead on this host.
  const crashed = {
    nonce: randomUUID(),
    socketPath: '/tmp/no-such-cq-j.sock',
    pid: 2147483647,
    host: prior.host,
    bootId: prior.bootId,
    runId: 'crashed',
  };
  await writeFile(`${path}.${String(prior.nonce)}.claim`, JSON.stringify(crashed));
  const lease = await acquirePlanLock(dir, 'locked', 'recovered');
  try {
    await lease.assertHeld();
    expect(await record(dir)).toMatchObject({ runId: 'recovered' });
    expect(JSON.parse(await readFile(`${path}.${crashed.nonce}.claim`, 'utf8'))).toMatchObject({
      runId: 'recovered',
    });
  } finally {
    await lease.release();
  }
});

test('a retransmitted claim link reporting EEXIST for our own claim publishes, not refuses', async () => {
  const dir = await directory();
  const seed = await acquirePlanLock(dir, 'locked', 'seed');
  await seed.release();
  // NFS: the claim link succeeded, its reply was lost, and the retransmit
  // reports EEXIST. The claim already holds our own (synced) record.
  hooks.beforeClaim = async (temporary, claim) => {
    hooks.beforeClaim = undefined;
    await writeFile(claim, await readFile(temporary));
  };
  const lease = await acquirePlanLock(dir, 'locked', 'retransmit');
  try {
    await lease.assertHeld();
    const held = await record(dir);
    expect(held).toMatchObject({ runId: 'retransmit' });
    const claims = (await readdir(dir)).filter((name) => name.endsWith('.claim'));
    expect(claims).toHaveLength(1);
    expect(JSON.parse(await readFile(join(dir, claims[0] ?? ''), 'utf8'))).toEqual(held);
  } finally {
    await lease.release();
  }
});

test.each([
  { claimant: 'foreign-host', host: 'foreign-host', pid: 2147483647 },
  // Same host and alive (our own pid): a claimant whose rename faulted.
  { claimant: 'live-unpublished', host: undefined, pid: process.pid },
])(
  'a never-published $claimant claim refuses naming the claim file, and its removal unblocks',
  async ({ claimant, host, pid }) => {
    const dir = await directory();
    const path = join(dir, 'locked.lock.json');
    const seed = await acquirePlanLock(dir, 'locked', 'seed');
    await seed.release();
    const prior = await record(dir);
    const priorBytes = await readFile(path, 'utf8');
    const claim = `${path}.${String(prior.nonce)}.claim`;
    // The claim on the seed exists, but the seed tombstone is still canonical.
    await writeFile(
      claim,
      JSON.stringify({
        nonce: randomUUID(),
        socketPath: '/tmp/no-such-cq-j.sock',
        pid,
        host: host ?? prior.host,
        bootId: prior.bootId,
        runId: claimant,
      }),
    );
    const refusal = acquirePlanLock(dir, 'locked', 'blocked');
    await expect(refusal).rejects.toThrow(`plan lock claim '${claim}' names run '${claimant}'`);
    await expect(refusal).rejects.toThrow('never published');
    await expect(refusal).rejects.toMatchObject({
      cause: { message: expect.stringContaining('plan locked') as unknown },
    });
    expect(await readFile(path, 'utf8')).toBe(priorBytes);
    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    // The operator remedy the message names: remove the claim file.
    await unlink(claim);
    const lease = await acquirePlanLock(dir, 'locked', 'unblocked');
    try {
      await lease.assertHeld();
      expect(await record(dir)).toMatchObject({ runId: 'unblocked' });
    } finally {
      await lease.release();
    }
  },
);

test('a guard lease compromised before publication refuses as lock-lost and publishes nothing', async () => {
  const dir = await directory();
  hooks.guardAcquired = (options) => {
    // The handler records; it must never throw into the library's timer.
    expect(() => options.onCompromised?.(compromisedError())).not.toThrow();
  };
  await expect(acquirePlanLock(dir, 'locked', 'compromised')).rejects.toMatchObject({
    message: expect.stringContaining('lock-lost while acquiring') as unknown,
    cause: { code: 'ECOMPROMISED' },
  });
  expect(await readdir(dir)).toEqual([]);
});

test('a guard lease compromised after publication rolls back to our released tombstone', async () => {
  const dir = await directory();
  let compromise: (() => void) | undefined;
  hooks.guardAcquired = (options) => {
    compromise = () => options.onCompromised?.(compromisedError());
  };
  hooks.afterPublication = () => compromise?.();
  await expect(acquirePlanLock(dir, 'locked', 'compromised')).rejects.toThrow(
    'lock-lost while acquiring',
  );
  expect(await record(dir)).toMatchObject({ runId: 'compromised', released: true });
  expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  hooks.guardAcquired = undefined;
  hooks.afterPublication = undefined;
  // A tombstone is reclaimable: the loss wedges nothing.
  const next = await acquirePlanLock(dir, 'locked', 'next');
  await next.release();
});

test('runPlan treats a compromised guard lease as lease loss before reading or journaling history', async () => {
  const dir = await directory();
  hooks.guardAcquired = (options) => options.onCompromised?.(compromisedError());
  const calls: string[] = [];
  await expect(
    runPlan(
      { id: 'locked', jobs: [{ id: 'a', op: 'work', input: { id: 'a' } }] },
      { concurrency: 1, stopOnError: false, journalDir: dir },
      workRegistry(calls),
    ),
  ).rejects.toThrow('lock-lost');
  expect(calls).toEqual([]);
  // No run file, seq claim, lock record, temporary, or guard directory.
  expect(await readdir(dir)).toEqual([]);
});

test('a guard fault other than a held lease refuses without record publication', async () => {
  const dir = await directory();
  // A stale non-directory at the guard name: the library's stale removal
  // (rmdir) fails, which is a fault, not contention.
  await writeFile(join(dir, GUARD), '');
  await utimes(join(dir, GUARD), LEASE_EPOCH, LEASE_EPOCH);
  await expect(acquirePlanLock(dir, 'locked', 'refused')).rejects.toMatchObject({
    message: expect.stringContaining('publication guard') as unknown,
    cause: { code: 'ENOTDIR' },
  });
  await expect(readFile(join(dir, 'locked.lock.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(join(dir, GUARD), 'utf8')).toBe('');
});

// Enclosure: three sequential child acquisitions; first failure must remain retryable.
test(
  'boot identity timeout remains retryable; a successful lookup is reused per process',
  async (context) => {
    if (process.platform !== 'darwin') {
      context.skip();
      return;
    }
    const dir = await directory();
    const worker = start(dir, 'cache', { J_TEST_BOOT_CACHE: 'yes' });
    expect(await worker.next()).toMatchObject({
      status: 'refused',
      bootCalls: 1,
      error:
        'journal: boot identity startup/completion deadline exceeded after 10000ms (possible slow host)',
    });
    expect(await worker.next()).toMatchObject({ status: 'released', bootCalls: 2 });
    expect(await worker.next()).toMatchObject({ status: 'released', bootCalls: 2 });
    await worker.exited;
  },
  3 * CHILD_STEP_MS,
);
