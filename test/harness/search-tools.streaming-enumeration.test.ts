// Split provenance: test/harness/search-tools.test.ts was split into
// subject files; this one covers streaming include enumeration work caps,
// abort, deadline and drain lifecycle.
// Siblings: search-tools.helpers.ts (shared fixtures) and the other
// search-tools.*.test.ts files in this directory.
import { mkdir, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { defaultHarnessConfig } from '../../src/harness/config.js';
import { buildTools } from '../../src/harness/tools.js';
import { withWorkspace, tool } from './search-tools.helpers.js';

/** Handle of the most recent fake child (kill target for assertions). */
interface FakeChildHandle {
  kill: () => boolean;
  pid: number | undefined;
}

/** Every spawn this test process makes, recorded at the child_process seam. */
const spawnState = vi.hoisted(() => ({
  calls: [] as { file: string; args: string[] }[],
  /** When set, spawn returns a deterministic fake child instead of rg. */
  fake: null as null | {
    stdoutChunks: Buffer[];
    stderrChunks: Buffer[];
    exitCode: number | null; // null: never auto-closes; a kill is required
    pid: number | undefined;
    /**
     * Hang shape: when set, close is WITHHELD until the test drains these
     * bytes through stdout (a full pipe keeps close blocked after a kill).
     */
    closeAfterDrainBytes?: Buffer[];
    /** Consume this fake for one spawn only (the rest run the real child). */
    once?: boolean;
  },
  /** The most recent fake child (kill target for abort/timeout tests). */
  current: null as FakeChildHandle | null,
}));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const spawn = (file: unknown, args: unknown, ...rest: unknown[]) => {
    spawnState.calls.push({
      file: String(file),
      args: (Array.isArray(args) ? args : []).map((arg) => String(arg)),
    });
    if (spawnState.fake === null) {
      type SpawnFn = (...parts: unknown[]) => ReturnType<typeof actual.spawn>;
      return (actual.spawn as SpawnFn)(file, args, ...rest);
    }
    const config = spawnState.fake;
    if (config.once === true) spawnState.fake = null;
    const stdout = new EventEmitter() as EventEmitter & { pause: () => void };
    stdout.pause = () => {};
    const stderr = new EventEmitter();
    const child = new EventEmitter() as EventEmitter & {
      stdout: typeof stdout;
      stderr: typeof stderr;
      pid: number | undefined;
      kill: (signal?: string) => boolean;
    };
    child.stdout = stdout;
    child.stderr = stderr;
    child.pid = config.pid;
    child.kill = vi.fn((): boolean => {
      // A SIGKILL terminates the child: close follows with a null code,
      // UNLESS the pipe is full (hang shape): then close waits for drains.
      const drain = config.closeAfterDrainBytes;
      if (drain === undefined) {
        queueMicrotask(() => child.emit('close', null, 'SIGKILL'));
      } else {
        queueMicrotask(() => {
          let index = 0;
          const pump = (): void => {
            if (index >= drain.length) {
              child.emit('close', null, 'SIGKILL');
              return;
            }
            stdout.emit('data', drain[index]);
            index += 1;
            queueMicrotask(pump);
          };
          pump();
        });
      }
      return true;
    });
    spawnState.current = { kill: child.kill, pid: config.pid };
    queueMicrotask(() => {
      for (const chunk of config.stdoutChunks) stdout.emit('data', chunk);
      for (const chunk of config.stderrChunks) stderr.emit('data', chunk);
      if (config.exitCode !== null) queueMicrotask(() => child.emit('close', config.exitCode));
    });
    return child as unknown as ReturnType<typeof actual.spawn>;
  };
  return { ...actual, spawn };
});

/**
 * Registration counts for the streaming helper's cleanup contract: the
 * enumeration registers on spawn and must unregister in the close
 * settlement. Deltas are asserted around a single call (other modules
 * register at import time and stay registered).
 */
const signalCleanupState = vi.hoisted(() => ({ registered: 0, unregistered: 0 }));
vi.mock('../../src/shared/process-signals.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/shared/process-signals.js')>();
  return {
    ...actual,
    registerProcessSignalCleanup: (prepare: () => (() => void) | undefined) => {
      signalCleanupState.registered += 1;
      const dispose = actual.registerProcessSignalCleanup(prepare);
      return () => {
        signalCleanupState.unregistered += 1;
        dispose();
      };
    },
  };
});

describe('contained grep and glob tools', () => {
  test('streaming include enumeration fails closed at the scanned-bytes work cap', async () => {
    await withWorkspace(async (workspace) => {
      await mkdir(join(workspace, '.git'), { recursive: true });
      await writeFile(join(workspace, 'hit.ts'), 'needle\n', 'utf8');
      // One 33 MiB chunk exceeds the 32 MiB scanned-bytes traversal cap
      // before any path is complete: the outcome must be a denial, and the
      // child must have been killed (it would never close on its own).
      spawnState.fake = {
        stdoutChunks: [Buffer.alloc(33 * 1_024 * 1_024, 0x61)],
        stderrChunks: [],
        exitCode: null,
        pid: 4242,
      };
      const registeredBefore = signalCleanupState.registered;
      const unregisteredBefore = signalCleanupState.unregistered;
      try {
        const result = await tool(
          buildTools(defaultHarnessConfig, workspace, 'read-only'),
          'grep',
        ).execute({ pattern: 'needle', include: '*.ts' });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.denial.reason).toBe(
            'SEARCH_LIMIT: search denied: candidate enumeration work cap exceeded',
          );
        }
        expect(spawnState.current?.kill).toHaveBeenCalled();
        expect(signalCleanupState.registered - registeredBefore).toBe(1);
        expect(signalCleanupState.unregistered - unregisteredBefore).toBe(1);
      } finally {
        spawnState.fake = null;
        spawnState.current = null;
      }
    });
  });

  test('streaming include enumeration fails closed at the scanned-paths work cap', async () => {
    await withWorkspace(async (workspace) => {
      await mkdir(join(workspace, '.git'), { recursive: true });
      await writeFile(join(workspace, 'hit.ts'), 'needle\n', 'utf8');
      // 1,000,001 complete paths in one bounded (~2 MiB) chunk: one past the
      // traversal path cap. The include matches nothing, so nothing is kept.
      spawnState.fake = {
        stdoutChunks: [Buffer.from('unrelated.dat\0'.repeat(1_000_001))],
        stderrChunks: [],
        exitCode: null,
        pid: 4243,
      };
      try {
        const result = await tool(
          buildTools(defaultHarnessConfig, workspace, 'read-only'),
          'grep',
        ).execute({ pattern: 'needle', include: '*.ts' });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.denial.reason).toBe(
            'SEARCH_LIMIT: search denied: candidate enumeration work cap exceeded',
          );
        }
        expect(spawnState.current?.kill).toHaveBeenCalled();
      } finally {
        spawnState.fake = null;
        spawnState.current = null;
      }
    });
  });

  test('aborting a streaming include enumeration cancels, kills the child and unregisters', async () => {
    await withWorkspace(async (workspace) => {
      await mkdir(join(workspace, '.git'), { recursive: true });
      await writeFile(join(workspace, 'hit.ts'), 'needle\n', 'utf8');
      spawnState.fake = {
        stdoutChunks: [], // never emits; only the abort can end the wait
        stderrChunks: [],
        exitCode: null,
        pid: 4244,
      };
      const controller = new AbortController();
      const registeredBefore = signalCleanupState.registered;
      const unregisteredBefore = signalCleanupState.unregistered;
      try {
        const pending = tool(
          buildTools(defaultHarnessConfig, workspace, 'read-only'),
          'grep',
        ).execute({ pattern: 'needle', include: '*.ts' }, { signal: controller.signal });
        // Deterministic spawn observation (REAL timers here): the abort
        // listener is attached synchronously inside the helper right after
        // spawn, so observing the child is sufficient readiness. No fake
        // timer API is used in this test.
        await vi.waitFor(() => {
          expect(spawnState.current).not.toBeNull();
        });
        expect(spawnState.current?.kill).not.toHaveBeenCalled();
        controller.abort();
        const result = await pending;
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.denial.reason).toMatch(/^CANCELLED: /);
        expect(spawnState.current?.kill).toHaveBeenCalled();
        expect(signalCleanupState.registered - registeredBefore).toBe(1);
        expect(signalCleanupState.unregistered - unregisteredBefore).toBe(1);
      } finally {
        spawnState.fake = null;
        spawnState.current = null;
      }
    });
  });

  test('an enumeration deadline kills the child and reports TIMEOUT, not CANCELLED', async () => {
    vi.useFakeTimers();
    try {
      await withWorkspace(async (workspace) => {
        await mkdir(join(workspace, '.git'), { recursive: true });
        await writeFile(join(workspace, 'hit.ts'), 'needle\n', 'utf8');
        spawnState.fake = {
          stdoutChunks: [],
          stderrChunks: [],
          exitCode: null,
          pid: 4245,
        };
        const registeredBefore = signalCleanupState.registered;
        const unregisteredBefore = signalCleanupState.unregistered;
        try {
          const pending = tool(
            buildTools(defaultHarnessConfig, workspace, 'read-only'),
            'grep',
          ).execute({ pattern: 'needle', include: '*.ts' });
          // Spawn-observed synchronization: the deadline timer must exist
          // before it is advanced (vi.getTimerCount() > 0).
          await vi.waitFor(() => {
            expect(spawnState.current).not.toBeNull();
            expect(vi.getTimerCount()).toBeGreaterThan(0);
          });
          expect(spawnState.current?.kill).not.toHaveBeenCalled();
          // The enumeration deadline is SEARCH_TIMEOUT_MS (10 seconds).
          await vi.advanceTimersByTimeAsync(10_000);
          const result = await pending;
          expect(result.ok).toBe(false);
          if (!result.ok) expect(result.denial.reason).toMatch(/^TIMEOUT: /);
          expect(spawnState.current?.kill).toHaveBeenCalled();
          expect(signalCleanupState.registered - registeredBefore).toBe(1);
          expect(signalCleanupState.unregistered - unregisteredBefore).toBe(1);
        } finally {
          spawnState.fake = null;
          spawnState.current = null;
        }
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test('overflow with a buffered pipe settles: drain keeps flowing after the kill', async () => {
    await withWorkspace(async (workspace) => {
      await mkdir(join(workspace, '.git'), { recursive: true });
      await writeFile(join(workspace, 'hit.ts'), 'needle\n', 'utf8');
      // The P1 hang shape: the first chunk exceeds the scanned-bytes cap
      // (terminal: kill fires), and close is withheld until MORE stdout is
      // drained out of the pipe. The helper must keep consuming that stdout
      // (discard-only) so close arrives and the search settles promptly
      // with the truthful SEARCH_LIMIT denial.
      spawnState.fake = {
        stdoutChunks: [Buffer.alloc(33 * 1_024 * 1_024, 0x61)],
        stderrChunks: [],
        exitCode: null,
        pid: 4246,
        closeAfterDrainBytes: [
          Buffer.alloc(1024, 0x62),
          Buffer.alloc(1024, 0x63),
          Buffer.alloc(1024, 0x64),
        ],
      };
      const registeredBefore = signalCleanupState.registered;
      const unregisteredBefore = signalCleanupState.unregistered;
      try {
        const result = await tool(
          buildTools(defaultHarnessConfig, workspace, 'read-only'),
          'grep',
        ).execute({ pattern: 'needle', include: '*.ts' });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.denial.reason).toBe(
            'SEARCH_LIMIT: search denied: candidate enumeration work cap exceeded',
          );
        }
        expect(spawnState.current?.kill).toHaveBeenCalled();
        expect(signalCleanupState.registered - registeredBefore).toBe(1);
        expect(signalCleanupState.unregistered - unregisteredBefore).toBe(1);
      } finally {
        spawnState.fake = null;
        spawnState.current = null;
      }
    });
  });
});
