// W2.4 process proofs. No TTL stealing, TMPDIR split, or stale-owner unlink.
import {
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  type SpawnOptions,
} from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  access,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { createGovernor } from '../../src/kernel/governor.js';
import { acquirePlanLock, openRunLog } from '../../src/kernel/journal.js';
import { runPlan, type OpRegistryView } from '../../src/kernel/runner.js';
import type { Op, OpRegistryEntry } from '../../src/kernel/types.js';

const helperHooks = vi.hoisted(() => ({
  spawn: undefined as
    | ((args: readonly string[], options: SpawnOptions) => ChildProcess)
    | undefined,
}));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn(file: string, args: readonly string[], options: SpawnOptions) {
      if (file === '/usr/bin/perl' && helperHooks.spawn !== undefined) {
        return helperHooks.spawn(args, options);
      }
      return actual.spawn(file, args, options);
    },
  };
});

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
import { syncBuiltinESMExports } from 'node:module';
if (process.env.J_TEST_PAUSE_PUBLICATION === 'yes') {
  const original = cp.spawn;
  cp.spawn = (...args) => {
    const child = original(...args);
    if (args[0] === '/usr/bin/perl') {
      child.prependOnceListener('close', (code) => {
        if (code === 0) {
          console.log(JSON.stringify({ status: 'publication-held', helperExit: code }));
          process.kill(process.pid, 'SIGSTOP');
        }
      });
    }
    return child;
  };
  syncBuiltinESMExports();
}
const lines = createInterface({ input: process.stdin });
const commands = [];
let pending;
lines.on('line', line => { if (pending) { const done = pending; pending = undefined; done(line); } else commands.push(line); });
const next = () => commands.length ? Promise.resolve(commands.shift()) : new Promise(done => { pending = done; });
const send = value => console.log(JSON.stringify(value));
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
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line) as Message;
    if (waiter !== undefined) {
      const done = waiter;
      waiter = undefined;
      done(message);
    } else messages.push(message);
  });
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
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
          reject(new Error(`lock child timed out: ${stderr}`));
        }, 10000);
        waiter = (message) => {
          clearTimeout(timeout);
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
afterEach(async () => {
  helperHooks.spawn = undefined;
  for (const worker of workers.splice(0)) {
    if (worker.child.exitCode === null && worker.child.signalCode === null) {
      worker.child.kill('SIGCONT');
      worker.child.kill('SIGKILL');
    }
    await worker.exited;
  }
  await Promise.all([...sockets].map((path) => unlink(path).catch(() => undefined)));
  sockets.clear();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// Two child startups each have a 10s watchdog; the enclosing deadline must
// cover both rather than expire at Vitest's default 5s during host load.
test('different TMPDIR contenders use the recorded socket and cannot split one plan lock', async () => {
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
}, 30000);

test('SIGSTOP with a saturated socket backlog never permits stealing a live owner', async () => {
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
});

test('SIGKILL recovery charges an unresolved durable reservation and quarantines its job', async () => {
  const dir = await directory();
  const owner = start(dir, 'locked--1--a', { J_TEST_CRASH: 'yes' });
  expect((await owner.next()).status).toBe('acquired');
  await record(dir);
  owner.child.kill('SIGKILL');
  await owner.exited;
  const calls: string[] = [];
  const candidate: OpRegistryEntry<never, never> = {
    name: 'work',
    inputSchema: z.object({ id: z.string() }) as unknown as z.ZodType<never>,
    importer: () =>
      Promise.resolve((async () => {
        calls.push('a');
        return { status: 'ok', value: 'a' };
      }) as unknown as Op<never, never>),
  };
  const registry: OpRegistryView = { get: () => candidate };
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
});

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

test('racing reclaimers fence by nonce and stale release cannot clobber the winner', async () => {
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
});

test('foreign-host record refuses even with dead-looking PID/socket evidence', async () => {
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
});

test('independent child sequence claims use the real plan and unique positive ordinals', async () => {
  const dir = await directory();
  const contenders = [
    start(dir, 'claim-one', { J_TEST_CLAIM_ONLY: 'yes' }),
    start(dir, 'claim-two', { J_TEST_CLAIM_ONLY: 'yes' }),
  ];
  const claims = await Promise.all(contenders.map((worker) => worker.next()));
  expect(claims.map((message) => message.status)).toEqual(['claimed', 'claimed']);
  expect(claims.map((message) => message.seq).sort()).toEqual([1, 2]);
});

test('an interrupted publication guard refuses without unsafe automatic reclamation', async () => {
  const dir = await directory();
  const guard = join(dir, 'locked.lock.acquiring');
  await mkdir(guard);
  await expect(acquirePlanLock(dir, 'locked', 'contender')).rejects.toThrow(
    'acquisition in progress or interrupted',
  );
  await expect(readFile(join(dir, 'locked.lock.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

function fakeHelper(code: number | null, signal: NodeJS.Signals | null = null, error?: Error) {
  const child = new EventEmitter() as unknown as ChildProcess;
  const kill = vi.fn(() => {
    queueMicrotask(() => child.emit('close', null, 'SIGKILL'));
    return true;
  });
  child.kill = kill;
  queueMicrotask(() => {
    if (error !== undefined) child.emit('error', error);
    child.emit('close', code, signal);
  });
  return { child, kill };
}

test.each([
  { code: 3, signal: null, message: 'acquisition in progress or interrupted' },
  { code: 4, signal: null, message: 'capability failed' },
  { code: 2, signal: null, message: 'capability failed' },
  { code: null, signal: 'SIGTERM' as const, message: 'capability failed' },
])(
  'flock helper refuses exit=$code signal=$signal without record publication',
  async ({ code, signal, message }) => {
    const dir = await directory();
    helperHooks.spawn = (args, options) => {
      expect(args).toEqual(['-e', 'exit(flock(STDIN,6)?0:(($!{EWOULDBLOCK}||$!{EAGAIN})?3:4))']);
      expect(options.stdio).toEqual([expect.any(Number), 'ignore', 'pipe']);
      return fakeHelper(code, signal).child;
    };
    await expect(acquirePlanLock(dir, 'locked', 'refused')).rejects.toThrow(message);
    expect(await readFile(join(dir, 'locked.lock.guard'), 'utf8')).toBe('');
    await expect(readFile(join(dir, 'locked.lock.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  },
);

test('missing flock helper refuses and closes its guard descriptor', async () => {
  const dir = await directory();
  helperHooks.spawn = () =>
    fakeHelper(-2, null, Object.assign(new Error('missing helper'), { code: 'ENOENT' })).child;
  await expect(acquirePlanLock(dir, 'locked', 'refused')).rejects.toMatchObject({
    cause: { code: 'ENOENT' },
  });
  await expect(readFile(join(dir, 'locked.lock.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('hung flock helper is killed and reaped before capability refusal', async () => {
  const dir = await directory();
  const child = new EventEmitter() as unknown as ChildProcess;
  let reaped = false;
  const kill = vi.fn(() => {
    queueMicrotask(() => {
      reaped = true;
      child.emit('close', null, 'SIGKILL');
    });
    return true;
  });
  child.kill = kill;
  helperHooks.spawn = () => child;
  await expect(acquirePlanLock(dir, 'locked', 'refused')).rejects.toThrow('deadline exceeded');
  expect(kill).toHaveBeenCalledWith('SIGKILL');
  expect(reaped).toBe(true);
  await expect(readFile(join(dir, 'locked.lock.json'))).rejects.toMatchObject({ code: 'ENOENT' });
}, 15000);

test('post-flock inode replacement refuses before publishing a record', async () => {
  const dir = await directory();
  const guardPath = join(dir, 'locked.lock.guard');
  helperHooks.spawn = () => {
    const child = new EventEmitter() as unknown as ChildProcess;
    child.kill = () => true;
    (async () => {
      await rename(guardPath, `${guardPath}.displaced`);
      await writeFile(guardPath, '');
      child.emit('close', 0, null);
    })().catch((error: unknown) => {
      child.emit('error', error);
      child.emit('close', 4, null);
    });
    return child;
  };
  await expect(acquirePlanLock(dir, 'locked', 'refused')).rejects.toThrow('inode changed');
  await expect(readFile(join(dir, 'locked.lock.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('invalid inherited descriptor fails closed without publication', async () => {
  const dir = await directory();
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  helperHooks.spawn = (args, options) =>
    actual.spawn('/usr/bin/perl', args, { ...options, stdio: [2147483647, 'ignore', 'pipe'] });
  await expect(acquirePlanLock(dir, 'locked', 'refused')).rejects.toThrow();
  await expect(readFile(join(dir, 'locked.lock.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('helper-exit handshake retains exclusion through SIGSTOP; SIGKILL recovers a complete record', async () => {
  const dir = await directory();
  const path = join(dir, 'locked.lock.json');
  // Complete released prior state; no legacy acquiring directory exists.
  const seed = await acquirePlanLock(dir, 'locked', 'seed');
  await seed.release();
  const prior = await readFile(path, 'utf8');
  const held = start(dir, 'interrupted', { J_TEST_PAUSE_PUBLICATION: 'yes' });
  expect(await held.next()).toMatchObject({ status: 'publication-held' });
  const inode = await stat(join(dir, 'locked.lock.guard'));
  await expect(acquirePlanLock(dir, 'locked', 'contender')).rejects.toThrow(
    'acquisition in progress',
  );
  expect(await readFile(path, 'utf8')).toBe(prior);
  held.child.kill('SIGKILL');
  await held.exited;
  const recovered = await acquirePlanLock(dir, 'locked', 'recovered');
  try {
    await recovered.assertHeld();
  } finally {
    await recovered.release();
  }
  const after = await stat(join(dir, 'locked.lock.guard'));
  expect({ dev: after.dev, ino: after.ino, size: after.size }).toEqual({
    dev: inode.dev,
    ino: inode.ino,
    size: 0,
  });
  expect((await record(dir)).runId).toBe('recovered');
}, 30000);

test('live inherited-descriptor flock retains same-process exclusion after helper exit', async (context) => {
  try {
    await access('/usr/bin/perl');
  } catch {
    context.skip();
    return;
  }
  const dir = await directory();
  const path = join(dir, 'live.guard');
  const first = await open(path, 'a+', 0o600);
  const second = await open(path, 'a+', 0o600);
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const flock = (fd: number) =>
    new Promise<number | null>((resolve, reject) => {
      const helper = actual.spawn(
        '/usr/bin/perl',
        ['-e', 'exit(flock(STDIN,6)?0:(($!{EWOULDBLOCK}||$!{EAGAIN})?3:4))'],
        { stdio: [fd, 'ignore', 'pipe'] },
      );
      helper.once('error', reject);
      helper.once('close', (code) => resolve(code));
    });
  try {
    expect(await flock(first.fd)).toBe(0); // holder handshake before contender
    expect(await flock(second.fd)).toBe(3);
    expect(await flock(first.fd)).toBe(0); // same OFD is a reference to one lock
    await first.close();
    expect(await flock(second.fd)).toBe(0);
  } finally {
    await first.close().catch(() => undefined);
    await second.close();
  }
}, 30000);
