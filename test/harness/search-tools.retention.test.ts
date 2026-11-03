// Split provenance: test/harness/search-tools.test.ts was split into
// subject files; this one covers candidate retention against the legacy oracle
// and ordering past the cap.
// Siblings: search-tools.helpers.ts (shared fixtures) and the other
// search-tools.*.test.ts files in this directory.
import { mkdir, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { defaultHarnessConfig } from '../../src/harness/config.js';
import { buildTools } from '../../src/harness/tools.js';
import {
  withWorkspace,
  tool,
  CANDIDATE_CAP,
  legacyRetained,
  writeCandidateFiles,
  fakeEnumeration,
  renderedPaths,
} from './search-tools.helpers.js';

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
  test('streaming retention keeps the legacy lexical top-1000 under descending, mixed and duplicate emissions', async () => {
    await withWorkspace(async (workspace) => {
      await mkdir(join(workspace, '.git'), { recursive: true });
      // 1,053 emissions over 1,051 distinct names: descending, ascending,
      // mixed, and same-name duplicates that reach the capacity boundary. The
      // oracle is the pre-heap policy itself, so this compares retention
      // rather than restating the heap.
      const emissions = [
        ...Array.from({ length: 520 }, (_, index) => `d${String(519 - index).padStart(4, '0')}.ts`),
        'd0000.ts',
        'd0000.ts',
        'd0000.ts',
        ...Array.from({ length: 500 }, (_, index) => `a${String(index).padStart(4, '0')}.ts`),
        ...Array.from({ length: 30 }, (_, index) => `m${String(index).padStart(4, '0')}.ts`),
      ];
      const expected = legacyRetained(emissions);
      expect(expected.truncated).toBe(true);
      await writeCandidateFiles(workspace, emissions);
      spawnState.fake = {
        stdoutChunks: fakeEnumeration(emissions),
        stderrChunks: [],
        exitCode: 0,
        pid: 4350,
        once: true,
      };
      try {
        const grep = tool(buildTools(defaultHarnessConfig, workspace, 'read-only'), 'grep');
        const result = await grep.execute({ pattern: 'retained-needle', include: '*.ts' });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.truncated).toBe(expected.truncated);
        expect(result.output).toContain('[truncated: candidate files cap 1000]');
        // Observable window: the content render keeps at most 100 match lines
        // (one per file here) in the renderer's lexical order. The retained
        // tail is internal state and is not claimed here.
        const retainedNames = [...new Set(expected.rels)].sort((left, right) =>
          left.localeCompare(right),
        );
        expect(renderedPaths(result.output)).toEqual(retainedNames.slice(0, 100));
      } finally {
        spawnState.fake = null;
        spawnState.current = null;
      }
    });
  });

  test('a duplicate of the largest name still consumes a retained slot at the cap (separate-slot rule)', async () => {
    await withWorkspace(async (workspace) => {
      await mkdir(join(workspace, '.git'), { recursive: true });
      // 1,000 distinct names plus one duplicate of the largest: the legacy
      // buffer keeps the duplicate as its own slot (the later emission
      // displaces the earlier copy of the same name), so the +1 truncation
      // slot is reached although only 1,000 distinct names exist. A
      // dedupe-based retention would report no truncation at all.
      const emissions = [
        ...Array.from({ length: 1_000 }, (_, index) => `x${String(index).padStart(4, '0')}.ts`),
        'x0999.ts',
      ];
      const expected = legacyRetained(emissions);
      expect(expected.rels).toHaveLength(CANDIDATE_CAP);
      expect(expected.truncated).toBe(true);
      await writeCandidateFiles(workspace, emissions);
      spawnState.fake = {
        stdoutChunks: fakeEnumeration(emissions),
        stderrChunks: [],
        exitCode: 0,
        pid: 4351,
        once: true,
      };
      try {
        const grep = tool(buildTools(defaultHarnessConfig, workspace, 'read-only'), 'grep');
        const result = await grep.execute({ pattern: 'retained-needle', include: '*.ts' });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.truncated).toBe(true);
        expect(result.output).toContain('[truncated: candidate files cap 1000]');
        const retainedNames = [...new Set(expected.rels)].sort((left, right) =>
          left.localeCompare(right),
        );
        expect(renderedPaths(result.output)).toEqual(retainedNames.slice(0, 100));
      } finally {
        spawnState.fake = null;
        spawnState.current = null;
      }
    });
  });

  test('retention and output ordering agree past the candidate cap (#613)', async () => {
    await withWorkspace(async (workspace) => {
      await mkdir(join(workspace, '.git'), { recursive: true });
      // 1,005 lowercase candidates do NOT match; ONLY Z.ts contains the
      // needle. This isolates the #613 scenario: with the old mixed
      // ordering, the single matching candidate could be dropped by the
      // native-code-unit top-1000 retention while a locale-sorted output
      // would have kept it — candidate-cap selection and result ordering
      // must agree. (The result cap is separate: only one file matches, so
      // SEARCH_MATCH_LIMIT is not reached.)
      await Promise.all(
        Array.from({ length: 1_005 }, (_, index) =>
          writeFile(
            join(workspace, `a${String(index).padStart(4, '0')}.ts`),
            'no match here\n',
            'utf8',
          ),
        ),
      );
      await writeFile(join(workspace, 'Z.ts'), 'needle\n', 'utf8');
      const grep = tool(buildTools(defaultHarnessConfig, workspace, 'read-only'), 'grep');
      const result = await grep.execute({
        pattern: 'needle',
        include: '*.ts',
        output_mode: 'files_with_matches',
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('Z.ts');
        expect(result.output).not.toContain('a0000.ts');
        // All 1,006 paths match include *.ts, so the 1,000-candidate cap
        // excludes five paths before content matching; the honest cap
        // marker is part of the response.
        expect(result.truncated).toBe(true);
        expect(result.output).toContain('[truncated: candidate files cap 1000]');
      }
    });
  });
});
