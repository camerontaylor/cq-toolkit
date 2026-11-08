import { afterEach, expect, test, vi } from 'vitest';
import { EventEmitter, getEventListeners } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { acquireSlot } from '../../src/adapters/lock/slotLock.js';
import { CheckoutWriterContext } from '../../src/shared/checkoutWriterContext.js';
import { checkoutWriterCommand } from '../../src/shared/checkoutWriterCommand.js';
import { makeSubprocessDevEffects } from '../../src/ops/dev/effects.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
const roots: string[] = [];
afterEach(async () => {
  vi.mocked(spawn).mockReset();
  vi.mocked(spawn).mockImplementation(
    (await vi.importActual<typeof import('node:child_process')>('node:child_process')).spawn,
  );
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cq-collector-'));
  roots.push(root);
  const context = new CheckoutWriterContext(acquireSlot);
  await context.acquire(root, 1);
  await context.begin();
  return { root, context };
}
async function bounded<T>(promise: Promise<T>, ms: number): Promise<T | 'pending'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<'pending'>((resolve) => {
        timer = setTimeout(() => resolve('pending'), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test.each(['timeout', 'abort', 'maxBuffer', 'effects timeout'] as const)(
  '%s returns before descendant pipe EOF but retains drain (mutations: conflate result/close, drain on kill, retain capture)',
  async (mode) => {
    const { root, context } = await fixture();
    const ready = join(root, 'ready');
    const release = join(root, 'release');
    const descendant = `
      const fs = require('node:fs');
      const timer = setInterval(() => {
        if (fs.existsSync(${JSON.stringify(release)})) clearInterval(timer);
      }, 10);
      process.send('ready', () => process.disconnect());
    `;
    const parent = `
      const fs = require('node:fs');
      const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {
        stdio: ['ignore', 'inherit', 'inherit', 'ipc']
      });
      child.once('message', () => {
        process.stdout.write('captured stdout');
        process.stderr.write('captured stderr');
        fs.writeFileSync(${JSON.stringify(ready)}, String(child.pid));
        ${mode === 'maxBuffer' ? "process.stdout.write('x'.repeat(8192));" : ''}
      });
      setInterval(() => {}, 1000);
    `;
    const controller = new AbortController();
    const started = performance.now();
    const result = context.run(() =>
      mode === 'effects timeout'
        ? makeSubprocessDevEffects(root).runCommand(process.execPath, ['-e', parent], {
            timeoutMs: 1000,
          })
        : checkoutWriterCommand(process.execPath, ['-e', parent], {
            timeout: mode === 'timeout' ? 1000 : 5000,
            maxBuffer: mode === 'maxBuffer' ? 64 : 4096,
            signal: controller.signal,
          }),
    );
    const directChild = vi.mocked(spawn).mock.results.at(-1)!.value as ChildProcess;
    const directExit = new Promise<void>((done) => directChild.once('exit', () => done()));
    let closed = false;
    directChild.once('close', () => {
      closed = true;
    });
    const settled = result.then(
      (value) => ({ kind: 'result' as const, value }),
      (error: unknown) => ({ kind: 'error' as const, error }),
    );
    try {
      await expect.poll(() => readFile(ready, 'utf8'), { timeout: 3000 }).toMatch(/^\d+$/);
      if (mode === 'abort') controller.abort('fixture abort');
      const outcome = await bounded(settled, 2000);
      expect(outcome, 'caller result must not await the descendant release gate').not.toBe(
        'pending',
      );
      expect(performance.now() - started).toBeLessThan(3000);
      if (mode === 'effects timeout') {
        expect(outcome).toMatchObject({
          kind: 'result',
          value: {
            exitCode: null,
            timedOut: true,
            stdout: 'captured stdout',
            stderr: 'captured stderr',
          },
        });
      } else {
        expect(outcome).toMatchObject({
          kind: 'error',
          error: {
            killed: true,
            stdout: expect.stringContaining('captured stdout') as unknown,
            ...(mode === 'abort' ? { code: 'ABORT_ERR' } : {}),
            ...(mode === 'maxBuffer' ? { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' } : {}),
          },
        });
      }
      expect(await bounded(directExit, 2000)).not.toBe('pending');
      // Flush exit/close callbacks. Destroyed raw pipes would falsely drain here,
      // although the descendant is still waiting on its unreleased gate.
      await new Promise<void>((done) => setImmediate(done));
      await new Promise<void>((done) => setImmediate(done));
      expect(closed).toBe(false);
      expect(directChild.stdout?.destroyed).toBe(false);
      expect(directChild.stderr?.destroyed).toBe(false);
      expect(directChild.stdout?.listenerCount('data')).toBe(0);
      expect(directChild.stderr?.listenerCount('data')).toBe(0);
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
      expect(context.pendingChildren).toBe(1);
      await expect(context.close()).rejects.toThrow(/not closed/);
    } finally {
      await writeFile(release, 'release');
      controller.abort('fixture cleanup');
      await expect.poll(() => context.pendingChildren, { timeout: 3000 }).toBe(0);
      await settled;
      await context.close();
    }
  },
);

test.each(['EMFILE', 'ENFILE'])(
  '%s spawn failure with absent stdio preserves error and actual-close drain (mutation: dereference missing stdio)',
  async (code) => {
    const { context } = await fixture();
    const child = Object.assign(new EventEmitter(), { stdin: null, stdout: null, stderr: null });
    vi.mocked(spawn).mockReturnValueOnce(child as ChildProcess);
    const error = Object.assign(new Error('spawn resource exhausted'), { code });
    const result = context.run(() => checkoutWriterCommand('fixture-missing-stdio', []));
    const settled = result.catch((cause: unknown) => cause);
    try {
      // Real Node reports the asynchronous spawn error without stdio objects.
      expect(child.listenerCount('error')).toBeGreaterThan(0);
      child.emit('error', error);
      child.emit('close', -24, null);
      expect(await settled).toMatchObject({ code, stdout: '', stderr: '', killed: false });
      expect(context.pendingChildren).toBe(0);
    } finally {
      child.emit('close', -24, null);
      await settled;
      await context.close();
    }
  },
);
