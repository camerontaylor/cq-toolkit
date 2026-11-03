// Split provenance: test/kernel/journal-lock.test.ts was split by subject into
// journal-lock.exclusion.test.ts, journal-lock.claims.test.ts,
// journal-lock.publication-faults.test.ts, journal-lock.guard.test.ts,
// journal-lock.compromise.test.ts, journal-lock.corruption.test.ts,
// journal-lock.artifacts.test.ts and journal-lock.recovery.test.ts. This
// module holds the shared child-process harness, fixtures, event gates and
// teardown; it contains no tests and no describe blocks.
//
// W2.4 process proofs. No record TTL stealing (only the acquisition guard
// lease ages out), TMPDIR split, or stale-owner unlink.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, readFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { LockOptions } from 'proper-lockfile';
import { afterEach } from 'vitest';
import { z } from 'zod';
import type { OpRegistryView } from '../../src/kernel/runner.js';
import type { Op, OpRegistryEntry } from '../../src/kernel/types.js';

// proper-lockfile judges staleness by the guard directory's mtime against
// the wall clock (Date.now() - stale). Tests age a lease as data — an mtime
// at the epoch — instead of waiting out the real 30s window.
export const LEASE_EPOCH = new Date(0);
export const GUARD = 'locked.lock.guard.lock';
export function compromisedError(): Error {
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
/** The per-file hoisted hooks the mocked modules observe. */
export interface LockHooks {
  guardAcquired: ((options: LockOptions) => void) | undefined;
  beforeClaim: ((temporary: string, claim: string) => Promise<void>) | undefined;
  beforePublish: ((temporary: string, path: string) => Promise<void>) | undefined;
  beforeRename: ((from: string, to: string) => Promise<void>) | undefined;
  afterPublication: (() => void) | undefined;
}
// Mirrors journal.ts's private 10s boot bound; the remaining 15s covers
// measured Node/loader startup and guard/record I/O under load (the retired
// flock helper's 10s slot, kept until re-measured). Update on source-bound
// drift.
export const CHILD_STEP_MS = 2 * 10_000 + 5_000;
const workers: Worker[] = [];
const directories: string[] = [];
const sockets = new Set<string>();
export async function directory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cq-j-lock-'));
  directories.push(dir);
  return dir;
}
export function start(dir: string, runId: string, extra: Record<string, string> = {}): Worker {
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
export async function record(dir: string): Promise<Record<string, unknown>> {
  const value = JSON.parse(await readFile(join(dir, 'locked.lock.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  if (typeof value.socketPath === 'string') sockets.add(value.socketPath);
  return value;
}
export function workRegistry(calls: string[]): OpRegistryView {
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
/**
 * Registers the shared per-file teardown: the file's hoisted hooks (when it
 * carries the mock blocks), then child processes, sockets and temp dirs.
 */
export function lockHarness(hooks?: LockHooks): void {
  afterEach(async () => {
    if (hooks !== undefined) {
      hooks.guardAcquired = undefined;
      hooks.beforeClaim = undefined;
      hooks.beforePublish = undefined;
      hooks.beforeRename = undefined;
      hooks.afterPublication = undefined;
    }
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
    await Promise.all(
      directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  }, CHILD_STEP_MS + 5_000);
}

/** Gate the next succession claim only: the judgment is made, nothing is published. */
export function gateNextClaim(hooks: LockHooks): { judged: Promise<void>; resume: () => void } {
  const judged = deferred();
  const resume = deferred();
  hooks.beforeClaim = async () => {
    hooks.beforeClaim = undefined;
    judged.resolve();
    await resume.promise;
  };
  return { judged: judged.promise, resume: resume.resolve };
}
