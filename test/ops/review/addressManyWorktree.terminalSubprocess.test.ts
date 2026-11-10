import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { withAddressOwnership } from '../../../src/ops/review/internal/addressCheckoutOwnership.js';
import { readSlotMetadata } from '../../../src/adapters/lock/slotLock.js';

import * as ownershipModule from '../../../src/ops/review/internal/addressCheckoutOwnership.js';

import {
  boundedFixtureProcess,
  deferred,
  fixture,
  terminalInput,
  terminalReport,
} from './addressManyWorktree.helpers.js';

// Only fixed fixture Node programs replace the private terminal spawn. Ordinary
// Git and the existing offline harness keep their actual implementations.
const terminalProcessFaults = vi.hoisted(() => ({
  spawn: undefined as
    | undefined
    | ((
        command: string,
        args: readonly string[],
        options: SpawnOptions,
      ) => ChildProcess | undefined),
}));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (command: string, args: readonly string[], options: SpawnOptions) =>
      terminalProcessFaults.spawn?.(command, args, options) ?? actual.spawn(command, args, options),
  };
});

test.each([
  'stdout',
  'stderr',
  'post-spawn-error',
  'spawn-failure',
  'timeout',
  'no-close',
] as const)(
  'terminal subprocess refusal retains registration until actual close: %s',
  async (mode) => {
    const f = await fixture();
    const parent = new AbortController();
    const report = terminalReport(join(f.root, 'terminal-process-report.json'));
    const closeHeld = deferred(),
      releaseClose = deferred();
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    let child: ChildProcess | undefined,
      used = false,
      resultSettled = false;
    const longTimers: Array<() => void> = [];
    let timerSpy: { mockRestore(): void } | undefined;
    const actualSetTimeout = globalThis.setTimeout;
    const baseline = await readFile(join(f.repo.root, 'src/a.ts'));
    let pending: Promise<unknown> | undefined;
    try {
      pending = withAddressOwnership(
        {
          repoRoot: f.repo.root,
          git: f.run,
          source: 'local',
          production: false,
          signal: parent.signal,
        },
        async (lease) => {
          await ownershipModule.bindAddressTerminalReport(lease, report);
          const binding = ownershipModule.addressTerminalWorkerBinding(lease);
          const attempt = await ownershipModule.recordAddressTerminalAttempt(
            binding,
            terminalInput(f.repo),
          );
          await writeFile(join(f.repo.root, 'src/a.ts'), 'CANCELLED partial bytes\n');
          if (mode === 'timeout' || mode === 'no-close')
            timerSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
              handler: (...args: unknown[]) => void,
              delay?: number,
              ...args: unknown[]
            ) => {
              if (typeof handler === 'function' && delay && delay > 59_000)
                longTimers.push(() => handler(...args));
              return actualSetTimeout(handler, delay, ...args);
            }) as unknown as typeof setTimeout);
          terminalProcessFaults.spawn = (_command, _args, options) => {
            if (used) return undefined;
            used = true;
            if (mode === 'spawn-failure') {
              closeHeld.resolve();
              throw new Error('fixed fixture synchronous spawn failure');
            }
            // These constant programs cannot access a provider or network. The
            // parent test delays observed close, never treats exit as settlement.
            const script =
              mode === 'stdout'
                ? 'process.stdout.write(Buffer.alloc(8*1024*1024+1,65));'
                : mode === 'stderr'
                  ? 'process.stderr.write(Buffer.alloc(64*1024+1,66));'
                  : 'setTimeout(()=>{},10000);';
            child = actual.spawn(process.execPath, ['-e', script], options);
            const emit = child.emit;
            child.emit = function (event: string | symbol, ...args: unknown[]): boolean {
              if (event === 'close') {
                closeHeld.resolve();
                void releaseClose.promise.then(
                  () => {
                    Reflect.apply(emit, this, [event, ...args]) as boolean;
                  },
                  () => undefined,
                );
                return true;
              }
              return Reflect.apply(emit, this, [event, ...args]) as boolean;
            };
            if (mode === 'timeout' || mode === 'no-close')
              queueMicrotask(() => longTimers.at(-1)!());
            if (mode === 'post-spawn-error')
              child.once('spawn', () => {
                child!.emit('error', new Error('fixed fixture post-spawn error'));
                child!.kill('SIGKILL');
              });
            return child;
          };
          parent.abort();
          expect(ownershipModule.deferAddressTerminalAttempt(binding, attempt)).toBe(true);
          expect(() => ownershipModule.releaseAddressTerminalAttempt(binding, attempt)).toThrow(
            'cancelled release',
          );
          return ownershipModule.addressCancelledResult(lease);
        },
      );
      const outcome = pending.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      void outcome.then(
        () => {
          resultSettled = true;
        },
        () => {
          resultSettled = true;
        },
      );
      await closeHeld.promise;
      if (mode === 'no-close') {
        longTimers[0]!(); // Availability failure is not process settlement.
        expect(await outcome).toHaveProperty('error');
        await expect(
          withAddressOwnership(
            { repoRoot: f.repo.root, git: f.run, source: 'local', production: false },
            async () => undefined,
          ),
        ).rejects.toThrow(/busy|incomplete/i);
      }
      if (mode !== 'spawn-failure') {
        if (mode !== 'no-close') expect(resultSettled).toBe(false);
        expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toBe(
          'CANCELLED partial bytes\n',
        );
        await expect(lstat(report.reportPath)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(f.repo.git('for-each-ref', '--format=%(refname)', 'refs/heads/cq-address/')).toBe(
          '',
        );
      }
      releaseClose.resolve();
      const result = await outcome;
      expect(result).toHaveProperty('error');
      const dir = join(f.repo.root, '.git', 'cq-review', 'slots');
      const names = (await readdir(dir)).filter((name) => name.endsWith('.json'));
      expect(names.length).toBeGreaterThan(0);
      for (const name of names)
        expect((await readSlotMetadata(join(dir, name)))?.incomplete).toBe(true);
      expect(await readFile(join(f.repo.root, 'src/a.ts'))).not.toEqual(baseline);
    } finally {
      terminalProcessFaults.spawn = undefined;
      releaseClose.resolve();
      timerSpy?.mockRestore();
      child?.kill('SIGKILL');
      await Promise.allSettled(pending ? [pending] : []);
      await new Promise<void>((done) => setImmediate(done));
      await f.repo.cleanup();
    }
  },
);
test('RAW terminal plumbing never invokes configured clean/smudge filters or hooks', async () => {
  const f = await fixture();
  const parent = new AbortController();
  const report = terminalReport(join(f.root, 'raw-terminal-report.json'));
  const marker = join(f.root, 'forbidden-helper-marker');
  const helper = join(f.root, 'fixed-filter.cjs');
  try {
    await f.repo.write('.gitattributes', 'src/a.ts filter=terminalfixture\n');
    f.repo.commitAll('raw attribute fixture');
    await writeFile(
      helper,
      `require('node:fs').writeFileSync(${JSON.stringify(marker)},'helper invoked'); process.stdin.pipe(process.stdout);`,
    );
    f.repo.git('config', 'filter.terminalfixture.clean', `${process.execPath} ${helper}`);
    f.repo.git('config', 'filter.terminalfixture.smudge', `${process.execPath} ${helper}`);
    const hooks = join(f.root, 'configured-hooks');
    await mkdir(hooks);
    const hook = join(hooks, 'post-index-change');
    await writeFile(
      hook,
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'hook invoked');\n`,
    );
    const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    await actualFs.chmod(hook, 0o755);
    f.repo.git('config', 'core.hooksPath', hooks);
    const head = f.repo.git('rev-parse', 'HEAD').trim();
    const result = await withAddressOwnership(
      {
        repoRoot: f.repo.root,
        git: f.run,
        source: 'local',
        production: false,
        signal: parent.signal,
      },
      async (lease) => {
        await ownershipModule.bindAddressTerminalReport(lease, report);
        const binding = ownershipModule.addressTerminalWorkerBinding(lease);
        const attempt = await ownershipModule.recordAddressTerminalAttempt(
          binding,
          terminalInput(f.repo),
        );
        await writeFile(join(f.repo.root, 'src/a.ts'), 'RAW retained bytes\n');
        parent.abort();
        ownershipModule.deferAddressTerminalAttempt(binding, attempt);
        return ownershipModule.addressCancelledResult(lease);
      },
    );
    expect(result.status).toBe('needs-human');
    expect(report.failed).toHaveLength(1);
    expect(f.repo.git('cat-file', 'blob', `${report.failed[0]!.sha}:src/a.ts`)).toBe(
      'RAW retained bytes\n',
    );
    expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
    expect(f.repo.git('rev-parse', 'HEAD').trim()).toBe(head);
    await expect(lstat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await f.repo.cleanup();
  }
});
test.each(['commands', 'ref-creations'] as const)(
  'terminal helper work has a finite per-receipt bound: %s',
  async (bound) => {
    const f = await fixture();
    const parent = new AbortController();
    const report = terminalReport(join(f.root, 'terminal-command-bound.json'));
    let updates = 0,
      shows = 0;
    try {
      await expect(
        withAddressOwnership(
          {
            repoRoot: f.repo.root,
            git: f.run,
            source: 'local',
            production: false,
            signal: parent.signal,
          },
          async (lease) => {
            await ownershipModule.bindAddressTerminalReport(lease, report);
            const binding = ownershipModule.addressTerminalWorkerBinding(lease);
            const input = terminalInput(f.repo);
            const attempt = await ownershipModule.recordAddressTerminalAttempt(binding, input);
            await writeFile(join(f.repo.root, 'src/a.ts'), 'BOUNDED PARTIAL\n');
            terminalProcessFaults.spawn = (_command, args) => {
              if (bound === 'commands') {
                if (args.includes('for-each-ref')) {
                  const base = args.at(-1)!;
                  return boundedFixtureProcess(
                    Array.from({ length: 600 }, (_, index) => `${base}a${index + 1}`).join('\n'),
                  );
                }
                if (args.includes('show')) {
                  shows++;
                  const identity = Buffer.from(
                    JSON.stringify(['review', input.slug, input.finding]),
                  ).toString('base64url');
                  return boundedFixtureProcess(`Cq-Ref-Identity: ${identity}\n`);
                }
              } else {
                if (args.includes('update-ref')) {
                  updates++;
                  return boundedFixtureProcess('', 1);
                }
                if (args.includes('rev-parse') && args.includes('--verify'))
                  return boundedFixtureProcess(`${input.parent}\n`);
              }
              return undefined;
            };
            parent.abort();
            ownershipModule.deferAddressTerminalAttempt(binding, attempt);
            return ownershipModule.addressCancelledResult(lease);
          },
        ),
      ).rejects.toThrow(bound === 'commands' ? 'command/time bound' : 'branch collision limit');
      if (bound === 'commands') {
        expect(shows).toBeGreaterThan(400);
        expect(shows).toBeLessThan(512);
      } else expect(updates).toBe(32);
      expect(report.failed).toEqual([]);
      expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toBe('BOUNDED PARTIAL\n');
      await expect(lstat(report.reportPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(
        f.repo.git('for-each-ref', '--format=%(refname)', 'refs/heads/terminal-fixture/'),
      ).toBe('');
    } finally {
      terminalProcessFaults.spawn = undefined;
      await f.repo.cleanup();
    }
  },
);
