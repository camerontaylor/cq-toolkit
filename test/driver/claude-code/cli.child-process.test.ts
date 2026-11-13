// Split from test/driver/claude-code/cli.test.ts (pure move). The outer describe
// wrapper is reproduced so every full test title is unchanged.
// Subject: managed-child stdout/stderr retention and signal/exit cleanup (src/shared/proc).

import { withScratch } from './cli.helpers.js';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test, vi } from 'vitest';
import {
  DEFAULT_MAX_RETAINED_BYTES,
  spawnManaged,
  terminateActiveChildrenOnExit,
} from '../../../src/shared/proc.js';

describe('claude-code driver, CLI transport specifics (fake agent CLI)', () => {
  test('stdout retention is a bounded TAIL: droppedBytes counted, every line still observed (#19-10)', async () => {
    await withScratch(async (scratchDir) => {
      const cap = 64 * 1024;
      const lines = 20_000;
      const last = `line-${String(lines - 1).padStart(8, '0')}`;
      const child = spawnManaged({
        command: process.execPath,
        args: [
          '-e',
          `for (let i = 0; i < ${lines}; i++) process.stdout.write('line-' + String(i).padStart(8, '0') + '\\n');`,
        ],
        cwd: scratchDir,
        maxRetainedBytes: cap,
      });
      const seen: string[] = [];
      child.onStdoutLine((line) => seen.push(line));
      const close = await child.close;
      // The buffer is evidence HYGIENE: past the cap only the tail is kept…
      expect(close.droppedBytes).toBeGreaterThan(0);
      expect(Buffer.byteLength(close.stdout)).toBeLessThanOrEqual(cap);
      expect(close.stdout.endsWith(`${last}\n`)).toBe(true); // …the END of the stream
      // …while the line callbacks saw EVERY line.
      expect(seen).toHaveLength(lines);
      expect(seen[0]).toBe('line-00000000');
      expect(seen[lines - 1]).toBe(last);
      // The shipped default.
      expect(DEFAULT_MAX_RETAINED_BYTES).toBe(1_048_576);
    });
  });

  test('a single unterminated line ~3x the cap stays bounded: head dropped, tail emitted (review 3)', async () => {
    await withScratch(async (scratchDir) => {
      const cap = 16 * 1024;
      const tailMark = 'TAIL-MARKER';
      // ONE line of exactly 3× cap with NO trailing newline — the shape the
      // review flagged: the pending line used to grow `rest` unbounded.
      const child = spawnManaged({
        command: process.execPath,
        args: [
          '-e',
          `process.stdout.write('${'x'.repeat(3 * cap - tailMark.length - 1)}' + '-${tailMark}');`,
        ],
        cwd: scratchDir,
        maxRetainedBytes: cap,
      });
      const seen: string[] = [];
      child.onStdoutLine((line) => seen.push(line));
      const close = await child.close;
      // The memory bound is ABSOLUTE: after each chunk, BOTH buffers (the
      // retained tail and the pending line) are ≤ cap — at close only the
      // tail remains, ≤ cap, so total retained never approaches 3× cap.
      expect(Buffer.byteLength(close.stdout)).toBeLessThanOrEqual(cap);
      expect(close.droppedBytes).toBeGreaterThan(0); // the head was really dropped
      // The flushed pending line is its retained TAIL, not the dropped head.
      expect(seen).toHaveLength(1);
      expect(seen[0]?.endsWith(`-${tailMark}`)).toBe(true);
      expect(seen[0]?.startsWith('x')).toBe(true); // the kept bytes are the line's own tail
    });
  }, 20_000);

  test('an unterminated final line is retained EXACTLY once — flush adds no phantom drops (review 4)', async () => {
    await withScratch(async (scratchDir) => {
      const child = spawnManaged({
        command: process.execPath,
        args: [
          '-e',
          `process.stdout.write('complete line\\n'); process.stdout.write('final-fragment');`,
        ],
        cwd: scratchDir,
        maxRetainedBytes: 64 * 1024,
      });
      const seen: string[] = [];
      child.onStdoutLine((line) => seen.push(line));
      const close = await child.close;
      expect(seen).toEqual(['complete line', 'final-fragment']);
      // Nothing exceeded the cap → zero REAL drops; the old flush re-appended
      // the pending line to the already-retained text (double retention and,
      // past a cap, phantom droppedBytes).
      expect(close.droppedBytes).toBe(0);
      expect(close.stdout).toBe('complete line\nfinal-fragment');
      expect(close.stdout.split('final-fragment')).toHaveLength(2); // exactly one occurrence
    });
  }, 20_000);

  test('a throwing stdout listener neither skips the stderr flush nor strands close', async () => {
    await withScratch(async (scratchDir) => {
      const child = spawnManaged({
        command: process.execPath,
        args: ['-e', `process.stdout.write('final-out'); process.stderr.write('final-err');`],
        cwd: scratchDir,
        maxRetainedBytes: 64 * 1024,
      });
      const seenErr: string[] = [];
      // The fragment has no newline, so it is delivered ONLY by the final
      // flush inside the close handler — the throw lands there.
      child.onStdoutLine((line) => {
        if (line === 'final-out') throw new Error('stdout listener boom');
      });
      child.onStderrLine((line) => seenErr.push(line));
      const close = await child.close;
      // The promise still settles, both streams retain their bytes, and the
      // OTHER stream's flush ran despite the throw.
      expect(close.stdout).toBe('final-out');
      expect(close.stderr).toBe('final-err');
      expect(seenErr).toEqual(['final-err']);
    });
  }, 20_000);

  test('oversized lines fail loudly while retention stays bounded', async () => {
    await withScratch(async (scratchDir) => {
      const child = spawnManaged({
        command: process.execPath,
        args: ['-e', `process.stdout.write('x'.repeat(256) + '\\n');`],
        cwd: scratchDir,
        maxRetainedBytes: 32,
      });
      const close = await child.close;
      expect(close.oversizedLine).toBe(true);
      expect(Buffer.byteLength(close.stdout)).toBeLessThanOrEqual(32);
      expect(close.droppedBytes).toBeGreaterThan(0);
    });
  });

  test('the exit hook terminates an active detached child', async () => {
    await withScratch(async (scratchDir) => {
      const child = spawnManaged({
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        cwd: scratchDir,
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      terminateActiveChildrenOnExit();
      const close = await child.close;
      expect(close.signal).toBe('SIGTERM');
    });
  });

  test.each([
    [1, '🦄', ''],
    [2, '🦄', ''],
    [3, '🦄', ''],
    [4, '🦄', '🦄'],
    [5, '🦄🦄', '🦄'],
    [3, 'x�', '�'],
    [4, 'x�!', '�!'],
  ])('UTF-8 retention cap %i preserves complete code points in %s', async (cap, text, expected) => {
    await withScratch(async (scratchDir) => {
      const child = spawnManaged({
        command: process.execPath,
        args: [
          '-e',
          `process.stdout.write(${JSON.stringify(text)}); process.stderr.write(${JSON.stringify(text)});`,
        ],
        cwd: scratchDir,
        maxRetainedBytes: cap,
      });
      const out: string[] = [];
      const err: string[] = [];
      child.onStdoutLine((line) => out.push(line));
      child.onStderrLine((line) => err.push(line));
      const close = await child.close;
      expect(close.stdout).toBe(expected);
      expect(close.stderr).toBe(expected);
      expect(Buffer.byteLength(close.stdout)).toBeLessThanOrEqual(cap);
      expect(Buffer.byteLength(close.stderr)).toBeLessThanOrEqual(cap);
      expect(close.droppedBytes).toBe(2 * (Buffer.byteLength(text) - Buffer.byteLength(expected)));
      expect(out).toEqual(expected === '' ? [] : [expected]);
      expect(err).toEqual(expected === '' ? [] : [expected]);
    });
  });

  test('importing driver and runCli does not install signal handlers', async () => {
    await withScratch(async (scratchDir) => {
      const processUrl = new URL('../../../src/shared/proc.ts', import.meta.url).href;
      const cliUrl = new URL('../../../src/cli/main.ts', import.meta.url).href;
      const loader = fileURLToPath(new URL('../../helpers/ts-source-loader.mjs', import.meta.url));
      const child = spawnManaged({
        command: process.execPath,
        args: [
          '--experimental-transform-types',
          '--import',
          loader,
          '--input-type=module',
          '-e',
          `
          const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
          const before = signals.map(s => process.listenerCount(s));
          const beforeHandles = process._getActiveHandles().length;
          const proc = await import(${JSON.stringify(processUrl)});
          const signalsModule = await import(${JSON.stringify(new URL('../../../src/shared/process-signals.ts', import.meta.url).href)});
          let kills = 0;
          process.kill = () => { kills++; return true; };
          proc.terminateActiveChildrenOnExit();
          const force = signalsModule.prepareProcessSignalCleanup();
          if (kills !== 0 || force.length !== 0 || process._getActiveHandles().length !== beforeHandles) throw new Error('import or empty cleanup started work');
          await import(${JSON.stringify(cliUrl)});
          console.log(JSON.stringify({before, after: signals.map(s => process.listenerCount(s))}));
        `,
        ],
        cwd: scratchDir,
      });
      const close = await child.close;
      expect(close.code, close.stderr).toBe(0);
      const counts = JSON.parse(close.stdout) as { before: number[]; after: number[] };
      expect(counts.after).toEqual(counts.before);
    });
  });

  test.skipIf(process.platform === 'win32').each(['SIGINT', 'SIGTERM', 'SIGHUP'] as const)(
    'CLI parent %s cleans detached workers and descendants from driver and in-process run',
    async (signal) => {
      await withScratch(async (scratchDir) => {
        const loader = fileURLToPath(
          new URL('../../helpers/ts-source-loader.mjs', import.meta.url),
        );
        const bin = fileURLToPath(new URL('../../../src/cli.ts', import.meta.url));
        const processUrl = new URL('../../../src/shared/proc.ts', import.meta.url).href;
        const runUrl = new URL('../../../src/harness/run.ts', import.meta.url).href;
        const preload = join(scratchDir, 'owned-child.mjs');
        const runWorker = join(scratchDir, 'run-worker.cjs');
        const runPidFile = join(scratchDir, 'run-pids.json');
        const descendantCode =
          "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)";
        const workerCode = `
          const { spawn } = require('node:child_process');
          process.on('SIGTERM', () => console.log('term'));
          const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(descendantCode)}], {stdio: ['ignore', 'pipe', 'inherit']});
          descendant.stdout.once('data', () => console.log(JSON.stringify([process.pid, descendant.pid])));
          setInterval(() => {}, 1000);
        `;
        await writeFile(
          runWorker,
          workerCode.replace(
            'console.log(JSON.stringify([process.pid, descendant.pid]))',
            `require('node:fs').writeFileSync(${JSON.stringify(runPidFile)}, JSON.stringify([process.pid, descendant.pid]))`,
          ),
        );
        const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
        const runCommand = `exec ${shellQuote(process.execPath)} ${shellQuote(runWorker)}`;
        // Ignoring TERM is inherited across exec by sleep. Redirect all its
        // pipes so each short-lived leader really closes before the final sweep.
        const lateRunCommand = "trap '' TERM; sleep 60 </dev/null >/dev/null 2>&1 & echo $!";
        await writeFile(
          preload,
          `
          import { spawnManaged, buildChildEnv } from ${JSON.stringify(processUrl)};
          import { runShellCommand } from ${JSON.stringify(runUrl)};
          import childProcess from 'node:child_process';
          import { syncBuiltinESMExports } from 'node:module';
          // Observe the real OS pid at dispatch; the child may be killed before
          // its first instruction during the parent's final cleanup sweep.
          const realSpawn = childProcess.spawn;
          childProcess.spawn = (file, ...args) => {
            const spawned = realSpawn(file, ...args);
            if (file === ${JSON.stringify(lateRunCommand)}) console.log(JSON.stringify({lateRun: spawned.pid}));
            return spawned;
          };
          syncBuiltinESMExports();
          void runShellCommand(${JSON.stringify(runCommand)}, {env: buildChildEnv(process.env), cwd: ${JSON.stringify(scratchDir)}, maxBytes: 1000});
          const child = spawnManaged({ command: process.execPath, args: ['-e', ${JSON.stringify(workerCode)}], cwd: ${JSON.stringify(scratchDir)} });
          let lateStarted = false;
          child.onStdoutLine(line => {
            if (line === 'term' && !lateStarted) {
              lateStarted = true;
              const late = spawnManaged({command: '/bin/sh', args: ['-c', ${JSON.stringify(lateRunCommand)}], cwd: ${JSON.stringify(scratchDir)}});
              late.onStdoutLine(line => console.log(JSON.stringify({lateDescendant: Number(line)})));
              void late.close.then(close => console.log(JSON.stringify({lateClosed: close.code})));
              console.log(JSON.stringify({late: late.pid}));
              void runShellCommand(${JSON.stringify(lateRunCommand)}, {env: buildChildEnv(process.env), cwd: ${JSON.stringify(scratchDir)}, maxBytes: 1000}).then(outcome => {
                if (outcome.kind === 'exit') console.log(JSON.stringify({lateRunClosed: outcome.code, lateRunDescendant: Number(outcome.stdout)}));
              });
            } else process.stdout.write(line + '\\n');
          });
        `,
        );
        const parent = spawn(
          process.execPath,
          ['--experimental-transform-types', '--import', loader, '--import', preload, bin],
          {
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        let out = '';
        let err = '';
        parent.stdout.on('data', (chunk: Buffer) => {
          out += chunk.toString();
        });
        parent.stderr.on('data', (chunk: Buffer) => {
          err += chunk.toString();
        });
        const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
          (resolve) => {
            parent.on('close', (code, endedSignal) => resolve({ code, signal: endedSignal }));
          },
        );
        let pids: number[] = [];
        let runPids: number[] = [];
        const alive = (pid: number): boolean => {
          try {
            process.kill(pid, 0);
            return true;
          } catch (error) {
            return (error as NodeJS.ErrnoException).code !== 'ESRCH';
          }
        };
        try {
          await vi.waitFor(
            async () => {
              expect(err).toContain('missing subcommand'); // actual CLI installed its handlers
              expect(out).toContain('\n'); // managed descendant installed its TERM trap
              runPids = JSON.parse(await readFile(runPidFile, 'utf8')) as number[];
              expect(runPids).toHaveLength(2); // run descendant installed its TERM trap
            },
            { timeout: 10_000 },
          );
          pids = [...(JSON.parse(out.trim()) as number[]), ...runPids];
          expect(pids).toHaveLength(4);
          expect(pids.every(alive)).toBe(true);
          parent.kill(signal);
          expect(await closed).toEqual({ code: null, signal });
          await vi.waitFor(() => expect(pids.some(alive)).toBe(false), { timeout: 3_000 });
          const late = out.split('\n').find((line) => line.startsWith('{"late":'));
          expect(late).toBeDefined(); // signal handling actually dispatched new work
          const lateDriverPid = (JSON.parse(late!) as { late: number }).late;
          const lateRun = out.split('\n').find((line) => line.startsWith('{"lateRun":'));
          expect(lateRun).toBeDefined();
          const lateRunPid = (JSON.parse(lateRun!) as { lateRun: number }).lateRun;
          expect(lateRunPid).toBeGreaterThan(0);
          expect(out).toContain('{"lateClosed":0}');
          const lateDescendant = out
            .split('\n')
            .find((line) => line.startsWith('{"lateDescendant":'));
          expect(lateDescendant).toBeDefined();
          const lateDescendantPid = (JSON.parse(lateDescendant!) as { lateDescendant: number })
            .lateDescendant;
          const lateRunClosed = out
            .split('\n')
            .find((line) => line.startsWith('{"lateRunClosed":'));
          expect(lateRunClosed).toBeDefined();
          const lateRunResult = JSON.parse(lateRunClosed!) as {
            lateRunClosed: number;
            lateRunDescendant: number;
          };
          expect(lateRunResult.lateRunClosed).toBe(0);
          expect(lateDescendantPid).toBeGreaterThan(0);
          expect(lateRunResult.lateRunDescendant).toBeGreaterThan(0);
          await vi.waitFor(
            () =>
              expect(
                [
                  lateDriverPid,
                  lateRunPid,
                  lateDescendantPid,
                  lateRunResult.lateRunDescendant,
                ].some(alive),
              ).toBe(false),
            {
              timeout: 3_000,
            },
          );
        } finally {
          // Recover late ownership even when a mutation failed an earlier assertion.
          const late = out.split('\n').find((line) => line.startsWith('{"late":'));
          const lateDriverPid =
            late === undefined ? undefined : (JSON.parse(late) as { late: number }).late;
          const lateRun = out.split('\n').find((line) => line.startsWith('{"lateRun":'));
          const lateRunPid =
            lateRun === undefined
              ? undefined
              : (JSON.parse(lateRun) as { lateRun: number }).lateRun;
          for (const groupLeader of [pids[0], runPids[0], lateDriverPid, lateRunPid]) {
            if (groupLeader === undefined) continue;
            try {
              process.kill(-groupLeader, 'SIGKILL');
            } catch {
              /* already gone */
            }
          }
          parent.kill('SIGKILL');
          await closed;
        }
      });
    },
    20_000,
  );

  test('astral characters past the cap: byte-exact trim, no lone surrogate at the head (review 9-1)', async () => {
    await withScratch(async (scratchDir) => {
      const cap = 64 * 1024;
      // The whole stream is one giant unterminated line of emoji (4 UTF-8
      // bytes each) — the tail region is FULL of astral pairs, the exact
      // shape where a code-unit trim mis-measured 3+3 instead of 4 bytes
      // per pair, under-counted, and let the retained text exceed the cap.
      const child = spawnManaged({
        command: process.execPath,
        args: ['-e', `process.stdout.write('🦄'.repeat(40_000));`],
        cwd: scratchDir,
        maxRetainedBytes: cap,
      });
      const close = await child.close;
      // The documented absolute bound holds BYTE-exactly.
      expect(Buffer.byteLength(close.stdout)).toBeLessThanOrEqual(cap);
      expect(close.droppedBytes).toBeGreaterThan(0);
      // The retained head starts with a COMPLETE code point — a code-unit
      // cut between the halves of a pair would strand a lone surrogate.
      expect(close.stdout.codePointAt(0)).toBe(0x1f984); // 🦄
    });
  }, 20_000);
});
