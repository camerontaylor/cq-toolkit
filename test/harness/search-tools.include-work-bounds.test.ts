// Split provenance: test/harness/search-tools.test.ts was split into
// subject files; this one covers include expansion, visited-branch and
// match-state work bounds.
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

describe('contained grep and glob tools', () => {
  test('expansion beyond 64 alternatives fails closed without literal fallback (CR MAJOR 1)', async () => {
    await withWorkspace(async (workspace) => {
      await mkdir(join(workspace, '.git'), { recursive: true });
      await writeFile(join(workspace, 'x.ts'), 'needle\n', 'utf8');
      const grep = tool(buildTools(defaultHarnessConfig, workspace, 'read-only'), 'grep');
      const wide = `*.{${Array.from({ length: 65 }, (_, i) => `e${i}`).join(',')}}`;
      const result = await grep.execute({ pattern: 'needle', include: wide });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.denial.reason).toMatch(/^SEARCH_LIMIT: /);
        expect(result.denial.reason).toContain('include expansion exceeds 64 alternatives');
      }
    });
  });

  test('repeated brace alternatives fail closed on visited-branch work cap (#605)', async () => {
    await withWorkspace(async (workspace) => {
      await mkdir(join(workspace, '.git'), { recursive: true });
      await writeFile(join(workspace, 'x.ts'), 'needle\n', 'utf8');
      const grep = tool(buildTools(defaultHarnessConfig, workspace, 'read-only'), 'grep');
      // One unique alternative, but 2^30 visited branches without the cap.
      const pattern = '{a,a}'.repeat(30) + '.ts';
      const result = await grep.execute({ pattern: 'needle', include: pattern });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.denial.reason).toBe(
          'SEARCH_LIMIT: search denied: include expansion exceeds 256 visited branches',
        );
      }
    });
  });

  test('a pathological include pattern returns promptly with bounded work (#614)', async () => {
    await withWorkspace(async (workspace) => {
      await mkdir(join(workspace, '.git'), { recursive: true });
      await writeFile(join(workspace, 'aaaats'), 'needle\n', 'utf8');
      const grep = tool(buildTools(defaultHarnessConfig, workspace, 'read-only'), 'grep');
      // Overlapping backtracking shape under the old regex matcher: with the
      // bounded matcher this either matches or fails within bounded state.
      const result = await grep.execute({ pattern: 'needle', include: `${'*a'.repeat(25)}b.ts` });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.output).toBe('No matches');
      const oversized = await grep.execute({
        pattern: 'needle',
        include: `*${'a'.repeat(300)}`, // over the 256-char pattern bound
      });
      expect(oversized.ok).toBe(false);
      if (!oversized.ok) {
        expect(oversized.denial.reason).toBe(
          'SEARCH_LIMIT: search denied: include pattern exceeds 256 characters',
        );
      }
      // #614: 64 distinct alternatives share work on one 203-character candidate.
      // Their 4,096-state budget must deny rather than silently drop it.
      spawnState.fake = {
        stdoutChunks: [Buffer.from(`${'a'.repeat(200)}.ts\0`)],
        stderrChunks: [],
        exitCode: 0,
        pid: 4247,
      };
      spawnState.calls.length = 0;
      try {
        const deep = await grep.execute({
          pattern: 'needle',
          include: `{${Array.from({ length: 64 }, (_, index) => `${'*a'.repeat(10)}z${index}.ts`).join(',')}}`,
        });
        expect(deep.ok).toBe(false);
        if (!deep.ok) {
          expect(deep.denial.reason).toBe(
            'SEARCH_LIMIT: search denied: include match state budget exhausted',
          );
        }
      } finally {
        spawnState.fake = null;
        spawnState.current = null;
      }
      // #656: a '/'-free glob compiles to exactly ONE run, and rg applies it
      // to the BASENAME only (fixture: --glob z selects deep/sub/z, while
      // --glob d* selects nothing). The old suffix loop charged and copied
      // every remaining component, so this 101-component candidate exhausted
      // the 4,096 budget and denied where the definitive answer is no-match.
      spawnState.fake = {
        stdoutChunks: [Buffer.from(`${'a/'.repeat(100)}x.ts\0`)],
        stderrChunks: [],
        exitCode: 0,
        pid: 4248,
      };
      spawnState.calls.length = 0;
      try {
        const suffixes = await grep.execute({ pattern: 'needle', include: 'z' });
        expect(suffixes.ok).toBe(true);
        if (suffixes.ok) {
          expect(suffixes.output).toBe('No matches');
          expect(suffixes.output).not.toContain('SEARCH_LIMIT');
        }
      } finally {
        spawnState.fake = null;
        spawnState.current = null;
      }
      // A negative anchored glob misses the complete path, but checking
      // all ancestor directories consumes one shared candidate budget.
      spawnState.fake = {
        stdoutChunks: [Buffer.from(`${'a/'.repeat(100)}x.ts\0`)],
        stderrChunks: [],
        exitCode: 0,
        pid: 4250,
      };
      spawnState.calls.length = 0;
      try {
        const ancestors = await grep.execute({ pattern: 'needle', include: '!z/q' });
        expect(ancestors.ok).toBe(false);
        if (!ancestors.ok) {
          expect(ancestors.denial.reason).toBe(
            'SEARCH_LIMIT: search denied: include match state budget exhausted',
          );
        }
      } finally {
        spawnState.fake = null;
        spawnState.current = null;
      }
      // The first 70-globstar alternative alone exhausts the budget
      // through epsilon and final-closure work on one candidate component.
      spawnState.fake = {
        stdoutChunks: [Buffer.from('a\0')],
        stderrChunks: [],
        exitCode: 0,
        pid: 4249,
      };
      spawnState.calls.length = 0;
      try {
        const globstars = '**/'.repeat(70);
        const closure = await grep.execute({
          pattern: 'needle',
          include: `{${globstars}z,${globstars}q}`,
        });
        expect(closure.ok).toBe(false);
        if (!closure.ok) {
          expect(closure.denial.reason).toBe(
            'SEARCH_LIMIT: search denied: include match state budget exhausted',
          );
        }
      } finally {
        spawnState.fake = null;
        spawnState.current = null;
      }
    });
  });
});
