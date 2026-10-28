import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import * as runner from '../../src/harness/run.js';
import { defaultHarnessConfig } from '../../src/harness/config.js';
import type { HarnessConfig } from '../../src/harness/config.js';
import { buildTools } from '../../src/harness/tools.js';
import type { ToolkitTool } from '../../src/harness/tools.js';

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

async function withWorkspace(body: (workspace: string) => Promise<void>): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), 'cq-search-tools-'));
  try {
    await body(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

function tool(tools: ToolkitTool[], name: string): ToolkitTool {
  const found = tools.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`missing ${name} tool`);
  return found;
}

function configWithReadPaths(pathPatterns: string[], maxOutputChars?: number): HarnessConfig {
  return {
    ...defaultHarnessConfig,
    tools: {
      ...defaultHarnessConfig.tools,
      read: {
        ...defaultHarnessConfig.tools.read,
        pathPatterns,
        ...(maxOutputChars === undefined ? {} : { maxOutputChars }),
      },
    },
  };
}

test.each([
  ['enumeration', false],
  ['enumeration', true],
  ['grep', false],
  ['grep', true],
] as const)('search %s distinguishes deadline from caller abort (%s)', async (phase, aborted) => {
  await withWorkspace(async (workspace) => {
    await writeFile(join(workspace, 'a.txt'), 'needle');
    const controller = new AbortController();
    const original = runner.runArgvCommand;
    const spy = vi
      .spyOn(runner, 'runArgvCommand')
      .mockImplementation(async (file, args, options) => {
        if ((phase === 'grep') === args.includes('--json')) {
          if (aborted) controller.abort();
          return { kind: 'killed', stdout: '', stderr: '', overflowed: false };
        }
        return original(file, args, options);
      });
    try {
      const result = await tool(
        buildTools(defaultHarnessConfig, workspace, 'read-only'),
        'grep',
      ).execute({ pattern: 'needle' }, { signal: controller.signal });
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(result.denial.reason).toMatch(new RegExp(`^${aborted ? 'CANCELLED' : 'TIMEOUT'}: `));
    } finally {
      spy.mockRestore();
    }
  });
});

describe('windowed read tool', () => {
  test('uses 1-based windows, line numbers, the path alias, and a continuation hint', async () => {
    await withWorkspace(async (workspace) => {
      await writeFile(join(workspace, 'window.txt'), 'alpha\nbeta\ngamma\n', 'utf8');
      const read = tool(buildTools(defaultHarnessConfig, workspace), 'read');
      const result = await read.execute({ path: 'window.txt', offset: 2, limit: 1 });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.output).toContain('--- window.txt ---');
      expect(result.output).toContain('     2: beta');
      expect(result.output).toContain('offset=3 to continue');
      expect(result.output).not.toContain('alpha');
      expect(result.sourceContents).toEqual([{ text: 'beta', path: 'window.txt' }]);
      expect(result.truncated).toBe(true);
    });
  });

  test('defaults to 2000 lines and caps long lines with a visible marker', async () => {
    await withWorkspace(async (workspace) => {
      const lines = Array.from({ length: 2_003 }, (_, index) => `line-${index + 1}`);
      lines[0] = `long-${'x'.repeat(2_100)}`;
      await writeFile(join(workspace, 'many.txt'), lines.join('\n'), 'utf8');
      const read = tool(buildTools(defaultHarnessConfig, workspace), 'read');
      const result = await read.execute({ file_path: 'many.txt' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.output).toContain('line truncated at 2000 chars');
      expect(result.output).toContain('  2000: line-2000');
      expect(result.output).toContain('offset=2001 to continue');
      expect(result.output).not.toContain('line-2001');
      expect(result.truncated).toBe(true);
    });
  });

  test('keeps the full-file F1 staleness ledger after returning a partial window', async () => {
    await withWorkspace(async (workspace) => {
      await writeFile(join(workspace, 'ledger.txt'), 'visible\nhidden target\n', 'utf8');
      const tools = buildTools(defaultHarnessConfig, workspace);
      const read = tool(tools, 'read');
      const edit = tool(tools, 'edit');
      const readResult = await read.execute({ file_path: 'ledger.txt', offset: 1, limit: 1 });
      expect(readResult.ok).toBe(true);
      if (!readResult.ok) return;
      expect(readResult.output).not.toContain('hidden target');
      const editResult = await edit.execute({
        file_path: 'ledger.txt',
        old_string: 'hidden target',
        new_string: 'updated target',
      });
      expect(editResult.ok).toBe(true);
      expect(await readFile(join(workspace, 'ledger.txt'), 'utf8')).toBe(
        'visible\nupdated target\n',
      );
    });
  });

  test('refuses NUL-containing and invalid UTF-8 files', async () => {
    await withWorkspace(async (workspace) => {
      await writeFile(join(workspace, 'binary.dat'), Buffer.from([0x61, 0x00, 0x62]));
      await writeFile(join(workspace, 'invalid.txt'), Buffer.from([0xc3, 0x28]));
      const read = tool(buildTools(defaultHarnessConfig, workspace), 'read');
      const binary = await read.execute({ file_path: 'binary.dat' });
      expect(binary.ok).toBe(false);
      if (!binary.ok) expect(binary.denial.reason).toContain('binary file');
      const invalid = await read.execute({ file_path: 'invalid.txt' });
      expect(invalid.ok).toBe(false);
      if (!invalid.ok) expect(invalid.denial.reason).toContain('not valid UTF-8');
    });
  });

  test('denies invalid alias combinations and shows output-cap truncation', async () => {
    await withWorkspace(async (workspace) => {
      await writeFile(join(workspace, 'small.txt'), 'one\ntwo\nthree', 'utf8');
      const read = tool(buildTools(configWithReadPaths(['**/*'], 40), workspace), 'read');
      await expect(
        read.execute({ file_path: 'small.txt', path: 'other.txt' }),
      ).resolves.toMatchObject({
        ok: false,
      });
      const result = await read.execute({ file_path: 'small.txt' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('[truncated: output chars cap 40]');
        expect(result.truncated).toBe(true);
      }
    });
  });
});

describe('contained grep and glob tools', () => {
  test('exist only in read-only builds and honor the per-op tool selection names', async () => {
    await withWorkspace(async (workspace) => {
      const writable = buildTools(defaultHarnessConfig, workspace, 'workspace-write');
      expect(writable.some(({ name }) => name === 'grep' || name === 'glob')).toBe(false);
      const readOnly = buildTools(defaultHarnessConfig, workspace, 'read-only');
      expect(readOnly.map(({ name }) => name)).toContain('grep');
      expect(readOnly.map(({ name }) => name)).toContain('glob');
    });
  });

  test('excludes .git before the candidate cap can crowd out workspace files', async () => {
    await withWorkspace(async (workspace) => {
      const gitDir = join(workspace, '.git');
      await mkdir(gitDir);
      await Promise.all(
        Array.from({ length: 1_001 }, (_, index) =>
          writeFile(join(gitDir, `${String(index).padStart(4, '0')}.txt`), 'needle', 'utf8'),
        ),
      );
      await writeFile(join(workspace, 'visible.txt'), 'needle', 'utf8');
      const grep = tool(buildTools(defaultHarnessConfig, workspace, 'read-only'), 'grep');
      const result = await grep.execute({ pattern: 'needle' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('visible.txt');
        expect(result.output).not.toContain('.git/');
      }
    });
  });

  test('grep supports regex, include alias, line numbers, grouped source provenance, and no matches', async () => {
    await withWorkspace(async (workspace) => {
      await mkdir(join(workspace, 'src'), { recursive: true });
      await writeFile(join(workspace, 'src', 'match.ts'), 'first\nneedle-value\nlast\n', 'utf8');
      await writeFile(join(workspace, 'src', 'other.js'), 'needle-value\n', 'utf8');
      const tools = buildTools(defaultHarnessConfig, workspace, 'read-only');
      const grep = tool(tools, 'grep');
      const result = await grep.execute({ pattern: 'needle-[a-z]+', path: 'src', include: '*.ts' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.output).toContain('--- src/match.ts ---');
      expect(result.output).toContain('2: needle-value');
      expect(result.output).not.toContain('other.js');
      expect(result.sourceContents).toEqual([{ path: 'src/match.ts', text: 'needle-value' }]);
      const empty = await grep.execute({ pattern: 'no-such-token' });
      expect(empty).toMatchObject({ ok: true, output: 'No matches', truncated: false });
    });
  });

  test('glob includes ignored and hidden files while grep respects .gitignore', async () => {
    await withWorkspace(async (workspace) => {
      await mkdir(join(workspace, '.git'), { recursive: true });
      await mkdir(join(workspace, 'ignored'), { recursive: true });
      await writeFile(join(workspace, '.gitignore'), 'ignored/\n', 'utf8');
      await writeFile(join(workspace, 'ignored', 'secret.ts'), 'ignored-needle\n', 'utf8');
      await writeFile(join(workspace, '.hidden.ts'), 'visible-needle\n', 'utf8');
      for (const vcs of ['.git', '.hg', '.svn']) {
        await mkdir(join(workspace, vcs), { recursive: true });
        await writeFile(join(workspace, vcs, 'internal.ts'), 'vcs-needle\n', 'utf8');
      }
      const tools = buildTools(defaultHarnessConfig, workspace, 'read-only');
      await expect(
        tool(tools, 'grep').execute({ pattern: 'ignored-needle' }),
      ).resolves.toMatchObject({
        ok: true,
        output: 'No matches',
      });
      const listed = await tool(tools, 'glob').execute({ pattern: '**/*.ts' });
      expect(listed.ok).toBe(true);
      if (listed.ok) {
        expect(listed.output).toContain('ignored/secret.ts');
        expect(listed.output).toContain('.hidden.ts');
        expect(listed.output).not.toContain('internal.ts');
      }
      await expect(
        tool(tools, 'grep').execute({ pattern: 'visible-needle' }),
      ).resolves.toMatchObject({
        ok: true,
        output: expect.stringContaining('.hidden.ts') as unknown,
      });
    });
  });

  test('patterns beginning with a dash are passed as data, not options', async () => {
    await withWorkspace(async (workspace) => {
      await writeFile(join(workspace, 'dash.txt'), '-needle\n', 'utf8');
      const grep = tool(buildTools(defaultHarnessConfig, workspace, 'read-only'), 'grep');
      const result = await grep.execute({ pattern: '-needle' });
      expect(result).toMatchObject({ ok: true });
      if (result.ok) expect(result.output).toContain('1: -needle');
    });
  });

  test('filters forbidden descendants before grep and glob can read or return them', async () => {
    await withWorkspace(async (workspace) => {
      await mkdir(join(workspace, 'src'), { recursive: true });
      await mkdir(join(workspace, 'private'), { recursive: true });
      await writeFile(join(workspace, 'src', 'allowed.ts'), 'needle-safe\n', 'utf8');
      await writeFile(join(workspace, 'private', 'secret.ts'), 'needle-secret\n', 'utf8');
      const tools = buildTools(configWithReadPaths(['src/**']), workspace, 'read-only');
      const grep = tool(tools, 'grep');
      const search = await grep.execute({ pattern: 'needle-' });
      expect(search.ok).toBe(true);
      if (search.ok) {
        expect(search.output).toContain('needle-safe');
        expect(search.output).not.toContain('needle-secret');
      }
      const glob = tool(tools, 'glob');
      const listed = await glob.execute({ pattern: '**/*.ts' });
      expect(listed.ok).toBe(true);
      if (listed.ok) {
        expect(listed.output).toContain('src/allowed.ts');
        expect(listed.output).not.toContain('private/secret.ts');
      }
    });
  });

  test('denies outside-workspace symlinks, symlinks into .git, and .git files', async () => {
    await withWorkspace(async (scratch) => {
      const workspace = join(scratch, 'workspace');
      const outside = join(scratch, 'outside');
      await mkdir(join(workspace, '.git'), { recursive: true });
      await mkdir(join(workspace, 'nested'), { recursive: true });
      await mkdir(outside, { recursive: true });
      await writeFile(join(workspace, '.git', 'config'), 'secret-config', 'utf8');
      await writeFile(join(workspace, 'nested', '.git'), 'gitdir: elsewhere', 'utf8');
      await writeFile(join(outside, 'secret.txt'), 'external-secret', 'utf8');
      await symlink(join(outside, 'secret.txt'), join(workspace, 'outside-link'));
      await symlink(join(workspace, '.git'), join(workspace, 'git-link'));
      await symlink(join(outside, 'secret.txt'), join(workspace, 'nested', 'outside-link'));
      const tools = buildTools(defaultHarnessConfig, workspace, 'read-only');
      const grep = tool(tools, 'grep');
      const outsideLink = await grep.execute({ pattern: 'secret', path: 'outside-link' });
      expect(outsideLink.ok).toBe(false);
      if (!outsideLink.ok) expect(outsideLink.denial.reason).toContain('path escape');
      const gitLink = await grep.execute({ pattern: 'config', path: 'git-link' });
      expect(gitLink.ok).toBe(false);
      if (!gitLink.ok) expect(gitLink.denial.reason).toContain('.git');
      const gitFile = await grep.execute({ pattern: 'gitdir', path: 'nested/.git' });
      expect(gitFile.ok).toBe(false);
      if (!gitFile.ok) expect(gitFile.denial.reason).toContain('.git');
      const glob = tool(tools, 'glob');
      for (const path of ['outside-link', 'git-link', 'nested/.git']) {
        const denied = await glob.execute({ pattern: '**/*', path });
        expect(denied.ok).toBe(false);
        if (!denied.ok) expect(denied.denial.reason).toMatch(/^(PATH_ESCAPE|PATH_DENIED): /);
      }
      const broadSearch = await grep.execute({ pattern: 'external-secret' });
      expect(broadSearch).toMatchObject({ ok: true, output: 'No matches' });
    });
  });

  test('shows explicit match, output, per-line, and byte-cap markers', async () => {
    await withWorkspace(async (workspace) => {
      const longLine = `${'x'.repeat(2_100)} token`;
      await writeFile(
        join(workspace, 'long.txt'),
        `${Array.from({ length: 105 }, () => longLine).join('\n')}\n`,
        'utf8',
      );
      const grep = tool(buildTools(defaultHarnessConfig, workspace, 'read-only'), 'grep');
      const result = await grep.execute({ pattern: 'token' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('[truncated: matches cap 100]');
        expect(result.output).toContain('[truncated: per-line chars cap 2000]');
        expect(result.truncated).toBe(true);
      }
      await writeFile(join(workspace, 'oversize.txt'), Buffer.alloc(20 * 1_024 * 1_024 + 1, 0x78));
      const byteLimited = await grep.execute({ pattern: 'never-present' });
      expect(byteLimited.ok).toBe(true);
      if (byteLimited.ok) {
        expect(byteLimited.output).toContain(
          `[truncated: searched bytes cap ${20 * 1_024 * 1_024}]`,
        );
        expect(byteLimited.truncated).toBe(true);
      }
    });
  });

  test('candidate and output caps are named in the response', async () => {
    await withWorkspace(async (workspace) => {
      await Promise.all(
        Array.from({ length: 1_005 }, (_, index) =>
          writeFile(
            join(workspace, `file-${String(index).padStart(4, '0')}-${'x'.repeat(60)}.txt`),
            'x',
            'utf8',
          ),
        ),
      );
      const glob = tool(buildTools(defaultHarnessConfig, workspace, 'read-only'), 'glob');
      const result = await glob.execute({ pattern: '*.txt' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('[truncated: candidate files cap 1000]');
        expect(result.output).toContain('[truncated: output chars cap 50000]');
        expect(result.truncated).toBe(true);
      }
    });
  });

  test('returns a denial when an in-flight rg operation is aborted', async () => {
    await withWorkspace(async (workspace) => {
      await Promise.all(
        Array.from({ length: 1_500 }, (_, index) =>
          writeFile(join(workspace, `abort-${index}.txt`), 'needle\n', 'utf8'),
        ),
      );
      const grep = tool(buildTools(defaultHarnessConfig, workspace, 'read-only'), 'grep');
      const controller = new AbortController();
      const pending = grep.execute({ pattern: 'needle' }, { signal: controller.signal });
      setTimeout(() => controller.abort(), 5);
      const aborted = await pending;
      expect(aborted.ok).toBe(false);
      if (!aborted.ok) expect(aborted.denial.reason).toContain('cancelled:');
    });
  });

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

  test('an oversized early candidate is skipped and later files still search (#493)', async () => {
    await withWorkspace(async (workspace) => {
      await mkdir(join(workspace, '.git'), { recursive: true });
      await writeFile(join(workspace, 'aaa-big.bin'), Buffer.alloc(20 * 1_024 * 1_024 + 1, 0x78));
      await writeFile(join(workspace, 'zzz-small.txt'), 'needle\n', 'utf8');
      const grep = tool(buildTools(defaultHarnessConfig, workspace, 'read-only'), 'grep');
      const result = await grep.execute({ pattern: 'needle' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('--- zzz-small.txt ---');
        expect(result.output).toContain('1: needle');
        expect(result.output).toContain(`[truncated: searched bytes cap ${20 * 1_024 * 1_024}]`);
        expect(result.output).toContain('[truncated: skipped oversized candidate aaa-big.bin');
        expect(result.truncated).toBe(true);
      }
    });
  });

  test('glob discovery reports oversized files without a byte-budget stop (#494)', async () => {
    await withWorkspace(async (workspace) => {
      await mkdir(join(workspace, '.git'), { recursive: true });
      await writeFile(join(workspace, 'aaa-big.bin'), Buffer.alloc(20 * 1_024 * 1_024 + 1, 0x78));
      await writeFile(join(workspace, 'zzz-small.txt'), 'needle\n', 'utf8');
      const glob = tool(buildTools(defaultHarnessConfig, workspace, 'read-only'), 'glob');
      const result = await glob.execute({ pattern: '*' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('aaa-big.bin');
        expect(result.output).toContain('zzz-small.txt');
        expect(result.output).not.toContain('searched bytes cap');
        expect(result.truncated).toBe(false);
      }
    });
  });

  test('brace include finds matches past a huge unrelated enumeration (streaming, CR MAJOR 1+2)', async () => {
    await withWorkspace(async (workspace) => {
      await mkdir(join(workspace, '.git'), { recursive: true });
      await mkdir(join(workspace, 'bulk'), { recursive: true });
      // Over 4 MiB of rg --files ENUMERATION OUTPUT from unrelated
      // filenames (the old whole-output cap): ~21k long names, only two
      // matching files. At 5ef68b24 this request denies with SEARCH_LIMIT
      // before the include filter ever runs; the streaming path finds both.
      await Promise.all(
        Array.from({ length: 21_000 }, (_, index) =>
          writeFile(
            join(workspace, 'bulk', `${'u'.repeat(200)}-${String(index).padStart(6, '0')}.dat`),
            'unrelated\n',
            'utf8',
          ),
        ),
      );
      await writeFile(join(workspace, 'hit-a.ts'), 'brace-needle\n', 'utf8');
      await writeFile(join(workspace, 'hit-b.tsx'), 'brace-needle\n', 'utf8');
      await writeFile(join(workspace, 'miss.md'), 'brace-needle\n', 'utf8');
      const grep = tool(buildTools(defaultHarnessConfig, workspace, 'read-only'), 'grep');
      const result = await grep.execute({ pattern: 'brace-needle', include: '*.{ts,tsx}' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('--- hit-a.ts ---');
        expect(result.output).toContain('--- hit-b.tsx ---');
        expect(result.output).not.toContain('miss.md');
        expect(result.output).not.toContain('SEARCH_LIMIT');
        expect(result.truncated).toBe(false);
      }
    });
  });

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

  test('nested braces expand and rootless brace alternatives stay basename filters', async () => {
    await withWorkspace(async (workspace) => {
      await mkdir(join(workspace, '.git'), { recursive: true });
      await mkdir(join(workspace, 'src'), { recursive: true });
      await writeFile(join(workspace, 'src', 'a.ts'), 'nested-needle\n', 'utf8');
      await writeFile(join(workspace, 'src', 'b.js'), 'nested-needle\n', 'utf8');
      await writeFile(join(workspace, 'c.rs'), 'nested-needle\n', 'utf8');
      const grep = tool(buildTools(defaultHarnessConfig, workspace, 'read-only'), 'grep');
      const result = await grep.execute({
        pattern: 'nested-needle',
        include: '{src/*.{ts,js},*.rs}',
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('--- src/a.ts ---');
        expect(result.output).toContain('--- src/b.js ---');
        expect(result.output).toContain('--- c.rs ---');
      }
    });
  });

  test('escaped brace delimiters and commas follow rg glob expansion (#604)', async () => {
    await withWorkspace(async (workspace) => {
      await mkdir(join(workspace, '.git'), { recursive: true });
      for (const name of [
        '{a,b}.ts',
        'a.ts',
        'b.ts',
        'a,b.ts',
        'c.ts',
        'a}.ts',
        '{b.ts',
        '\\a.ts',
        '\\b.ts',
      ]) {
        await writeFile(join(workspace, name), 'needle\n', 'utf8');
      }
      const grep = tool(buildTools(defaultHarnessConfig, workspace, 'read-only'), 'grep');
      // Verified against rg --files --hidden --no-ignore --glob on this fixture:
      // one slash escapes a brace/comma; two slashes escape each other.
      const cases = [
        {
          include: '\\{a,b\\}.ts',
          expected: ['{a,b}.ts'],
          excluded: ['a.ts', 'b.ts'],
        },
        {
          include: '{a\\,b,c}.ts',
          expected: ['a,b.ts', 'c.ts'],
          excluded: ['{a,b}.ts'],
        },
        {
          include: '\\\\{a,b}.ts',
          expected: ['\\a.ts', '\\b.ts'],
          excluded: ['a.ts', 'b.ts'],
        },
        {
          include: '{a\\},b}.ts',
          expected: ['a}.ts', 'b.ts'],
          excluded: ['a.ts'],
        },
        {
          include: '{a,\\{b}.ts',
          expected: ['a.ts', '{b.ts'],
          excluded: ['b.ts'],
        },
        {
          include: '{a}.ts',
          expected: ['a.ts'],
          excluded: ['{a,b}.ts'],
        },
      ];
      for (const { include, expected, excluded } of cases) {
        const result = await grep.execute({ pattern: 'needle', include });
        expect(result.ok).toBe(true);
        if (result.ok) {
          for (const name of expected) expect(result.output).toContain(`--- ${name} ---`);
          for (const name of excluded) expect(result.output).not.toContain(`--- ${name} ---`);
        }
      }
    });
  });

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
      // Each unanchored suffix copies the remaining path components. The
      // copied work alone exceeds 4,096 on this 100-component candidate;
      // a silent No matches verdict would hide exhausted matching.
      spawnState.fake = {
        stdoutChunks: [Buffer.from(`${'a/'.repeat(100)}x.ts\0`)],
        stderrChunks: [],
        exitCode: 0,
        pid: 4248,
      };
      spawnState.calls.length = 0;
      try {
        const suffixes = await grep.execute({ pattern: 'needle', include: 'z' });
        expect(suffixes.ok).toBe(false);
        if (!suffixes.ok) {
          expect(suffixes.denial.reason).toBe(
            'SEARCH_LIMIT: search denied: include match state budget exhausted',
          );
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
