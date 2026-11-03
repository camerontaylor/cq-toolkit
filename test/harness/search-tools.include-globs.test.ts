// Split provenance: test/harness/search-tools.test.ts was split into
// subject files; this one covers grep include filtering: argv, .gitignore
// precedence, bracket classes, negation and basename rules.
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
  test('grep enumeration argv never carries the user include glob (#491)', async () => {
    await withWorkspace(async (workspace) => {
      await mkdir(join(workspace, '.git'), { recursive: true });
      await writeFile(join(workspace, 'keep.ts'), 'needle\n', 'utf8');
      await writeFile(join(workspace, 'drop.js'), 'needle\n', 'utf8');
      spawnState.calls.length = 0;
      const result = await tool(
        buildTools(defaultHarnessConfig, workspace, 'read-only'),
        'grep',
      ).execute({ pattern: 'needle', include: '*.ts' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('keep.ts');
        expect(result.output).not.toContain('drop.js');
      }
      const enumerations = spawnState.calls.filter(
        (call) => call.file === 'rg' && !call.args.includes('--json'),
      );
      expect(enumerations.length).toBeGreaterThan(0);
      const fixed = new Set(['!.git', '!.hg', '!.svn']);
      for (const call of enumerations) {
        for (const [index, arg] of call.args.entries()) {
          if (arg === '--glob') expect(fixed.has(call.args[index + 1] ?? '')).toBe(true);
        }
      }
    });
  });

  test('grep include narrows results and .gitignore wins over the include (#491)', async () => {
    await withWorkspace(async (workspace) => {
      await mkdir(join(workspace, '.git'), { recursive: true });
      await mkdir(join(workspace, 'data'), { recursive: true });
      await mkdir(join(workspace, 'src'), { recursive: true });
      await writeFile(join(workspace, '.gitignore'), 'data/\n', 'utf8');
      await writeFile(join(workspace, 'data', 'big.log'), 'needle-in-log\n', 'utf8');
      await writeFile(join(workspace, 'src', 'keep.ts'), 'needle-ts\n', 'utf8');
      await writeFile(join(workspace, 'src', 'drop.js'), 'needle-js\n', 'utf8');
      const grep = tool(buildTools(defaultHarnessConfig, workspace, 'read-only'), 'grep');
      const includeLog = await grep.execute({ pattern: 'needle', include: '*.log' });
      expect(includeLog.ok).toBe(true);
      if (includeLog.ok) {
        expect(includeLog.output).toBe('No matches');
        expect(includeLog.truncated).toBe(false);
      }
      const includeTs = await grep.execute({ pattern: 'needle', glob: '*.ts' });
      expect(includeTs.ok).toBe(true);
      if (includeTs.ok) {
        expect(includeTs.output).toContain('--- src/keep.ts ---');
        expect(includeTs.output).not.toContain('drop.js');
        expect(includeTs.output).not.toContain('big.log');
      }
      const rooted = await grep.execute({ pattern: 'needle', include: 'src/*.ts' });
      expect(rooted.ok).toBe(true);
      if (rooted.ok) {
        expect(rooted.output).toContain('--- src/keep.ts ---');
        expect(rooted.output).not.toContain('big.log');
      }
    });
  });

  test('ripgrep bracket classes and negation work in grep include (#604)', async () => {
    await withWorkspace(async (workspace) => {
      await mkdir(join(workspace, '.git'), { recursive: true });
      await writeFile(join(workspace, 'file1.ts'), 'needle\n', 'utf8');
      await writeFile(join(workspace, 'file2.ts'), 'needle\n', 'utf8');
      await writeFile(join(workspace, 'fileX.ts'), 'needle\n', 'utf8');
      await writeFile(join(workspace, 'a.test.ts'), 'needle\n', 'utf8');
      await writeFile(join(workspace, 'keep.ts'), 'needle\n', 'utf8');
      const grep = tool(buildTools(defaultHarnessConfig, workspace, 'read-only'), 'grep');
      // rg fixture: file[12].ts selects exactly file1/file2 (bracket class).
      const bracket = await grep.execute({ pattern: 'needle', include: 'file[12].ts' });
      expect(bracket.ok).toBe(true);
      if (bracket.ok) {
        expect(bracket.output).toContain('--- file1.ts ---');
        expect(bracket.output).toContain('--- file2.ts ---');
        expect(bracket.output).not.toContain('fileX.ts');
      }
      // rg --glob '!*.test.ts' retains non-excluded paths when there are
      // no positive globs. The exclusion still vetoes a.test.ts.
      const exclusion = await grep.execute({ pattern: 'needle', include: '!*.test.ts' });
      expect(exclusion.ok).toBe(true);
      if (exclusion.ok) {
        expect(exclusion.output).toContain('--- keep.ts ---');
        expect(exclusion.output).not.toContain('--- a.test.ts ---');
      }
      // rg fixture (P1 #604): an arm starting with '!' inside braces is a
      // LITERAL-'!' component, not an exclusion — '{!*.test.ts,*.test.ts}'
      // lists .test.ts files. Negation is pattern-level, BEFORE expansion.
      await writeFile(join(workspace, '.test.ts'), 'needle\n', 'utf8');
      const braceArm = await grep.execute({
        pattern: 'needle',
        include: '{!*.test.ts,*.test.ts}',
      });
      expect(braceArm.ok).toBe(true);
      if (braceArm.ok) {
        expect(braceArm.output).toContain('--- .test.ts ---');
        expect(braceArm.output).toContain('--- a.test.ts ---');
        expect(braceArm.output).not.toContain('--- keep.ts ---');
      }
      const ranged = await grep.execute({ pattern: 'needle', include: 'file[1-x].ts' });
      expect(ranged.ok).toBe(true);
      if (ranged.ok) {
        expect(ranged.output).toContain('--- file1.ts ---');
        expect(ranged.output).not.toContain('--- keep.ts ---');
      }
    });
  });

  test('negated directory globs veto descendants like rg (#604)', async () => {
    await withWorkspace(async (workspace) => {
      await mkdir(join(workspace, '.git'), { recursive: true });
      await mkdir(join(workspace, 'src', 'nested'), { recursive: true });
      await mkdir(join(workspace, 'deep', 'src'), { recursive: true });
      await writeFile(join(workspace, 'src', 'nested', 'root.ts'), 'needle\n', 'utf8');
      await writeFile(join(workspace, 'deep', 'src', 'nested.ts'), 'needle\n', 'utf8');
      await writeFile(join(workspace, 'deep', 'keep.ts'), 'needle\n', 'utf8');
      await writeFile(join(workspace, 'srcx.ts'), 'needle\n', 'utf8');
      const grep = tool(buildTools(defaultHarnessConfig, workspace, 'read-only'), 'grep');
      const result = await grep.execute({ pattern: 'needle', include: '!src' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('--- deep/keep.ts ---');
        expect(result.output).toContain('--- srcx.ts ---');
        expect(result.output).not.toContain('src/nested/root.ts');
        expect(result.output).not.toContain('deep/src/nested.ts');
      }
      // A leading slash anchors the excluded directory at the workspace root.
      const anchored = await grep.execute({ pattern: 'needle', include: '!/src' });
      expect(anchored.ok).toBe(true);
      if (anchored.ok) {
        expect(anchored.output).toContain('--- deep/src/nested.ts ---');
        expect(anchored.output).toContain('--- srcx.ts ---');
        expect(anchored.output).not.toContain('--- src/nested/root.ts ---');
      }
    });
  });

  test('ordinary unanchored includes are basename filters at any depth (#656)', async () => {
    await withWorkspace(async (workspace) => {
      await mkdir(join(workspace, '.git'), { recursive: true });
      await mkdir(join(workspace, 'deep', 'sub'), { recursive: true });
      await mkdir(join(workspace, 'other'), { recursive: true });
      await writeFile(join(workspace, 'deep', 'sub', 'z'), 'ordinary-needle\n', 'utf8');
      await writeFile(join(workspace, 'deep', 'sub', 'a.ts'), 'ordinary-needle\n', 'utf8');
      await writeFile(join(workspace, 'other', 'deep.ts'), 'ordinary-needle\n', 'utf8');
      const grep = tool(buildTools(defaultHarnessConfig, workspace, 'read-only'), 'grep');
      // rg 14.1.1 fixtures: --glob z selects deep/sub/z; --glob d* and
      // --glob s* select NOTHING from the same tree, so an unanchored glob is
      // a basename filter, never an any-component filter.
      const basename = await grep.execute({ pattern: 'ordinary-needle', include: 'z' });
      expect(basename.ok).toBe(true);
      if (basename.ok) {
        expect(basename.output).toContain('--- deep/sub/z ---');
        expect(basename.output).not.toContain('deep/sub/a.ts');
        expect(basename.output).not.toContain('other/deep.ts');
      }
      const directoryName = await grep.execute({ pattern: 'ordinary-needle', include: 'd*' });
      expect(directoryName.ok).toBe(true);
      if (directoryName.ok) {
        // 'd*' matches the BASENAME 'deep.ts', never the ancestor directory
        // 'deep': the deep path is not selected merely because of its parent.
        expect(directoryName.output).toContain('--- other/deep.ts ---');
        expect(directoryName.output).not.toContain('deep/sub/z');
      }
      // '!z' applies the same basename rule to an exclusion.
      const negated = await grep.execute({ pattern: 'ordinary-needle', include: '!z' });
      expect(negated.ok).toBe(true);
      if (negated.ok) {
        expect(negated.output).not.toContain('deep/sub/z');
        expect(negated.output).toContain('--- deep/sub/a.ts ---');
        expect(negated.output).toContain('--- other/deep.ts ---');
      }
      // Excluding a directory excludes its whole subtree (rg: --glob '!deep').
      const ancestor = await grep.execute({ pattern: 'ordinary-needle', include: '!deep' });
      expect(ancestor.ok).toBe(true);
      if (ancestor.ok) {
        expect(ancestor.output).not.toContain('deep/sub/a.ts');
        expect(ancestor.output).toContain('--- other/deep.ts ---');
      }
      // A whole-component globstar keeps spanning components.
      const globstar = await grep.execute({ pattern: 'ordinary-needle', include: '**/z' });
      expect(globstar.ok).toBe(true);
      if (globstar.ok) expect(globstar.output).toContain('--- deep/sub/z ---');
    });
  });
});
