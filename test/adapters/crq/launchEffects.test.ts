import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GitPool } from '../../../src/adapters/crq/gitExec.js';
import { fileLaunchEffects, isoOf, runStampOf } from '../../../src/adapters/crq/launchEffects.js';

const never = async (): Promise<never> => {
  throw new Error('injected seam used');
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  }).trim();
}

async function realClone(): Promise<{ clone: string; head: string }> {
  const clone = await mkdtemp(join(tmpdir(), 'crq-clone-'));
  git(clone, 'init', '-q', '-b', 'main');
  await writeFile(join(clone, 'f'), 'x');
  git(clone, 'add', 'f');
  git(clone, 'commit', '-q', '-m', 'c');
  return { clone, head: git(clone, 'rev-parse', 'HEAD') };
}

async function build(
  over: {
    primaryClone?: string;
    worktreeRoot?: string;
    executableArgs?: string[];
    entry?: string;
  } = {},
) {
  const stateRoot = await mkdtemp(join(tmpdir(), 'crq-launch-'));
  const at = new Date('2026-11-26T01:02:03.456Z');
  const effects = fileLaunchEffects({
    stateRoot,
    worktreeRoot: over.worktreeRoot ?? stateRoot,
    worktreePrefix: 'crq-',
    primaryClone: over.primaryClone ?? '/clone',
    primaryRepo: 'Owner/Repo',
    repos: [{ repo: 'Other/Thing', clone: '/other', scanExtraClasses: ['x'] }],
    scheduleContext: () => ({
      config: { primaryRepo: 'Owner/Repo', repos: [], localReviewAgingMinutes: 60 },
      nowMicros: 0n,
    }),
    root: over.root ?? stateRoot,
    entry: over.entry ?? '/crq.js',
    ...(over.executableArgs ? { executableArgs: over.executableArgs } : {}),
    workRecords: join(stateRoot, 'work', 'records.jsonl'),
    pool: new GitPool(),
    now: () => at,
    scan: never,
    scanBackfillContext: never,
    writeBlockedReceipt: never,
    checkAuthor: () => undefined,
    grantAuthor: () => undefined,
    onDemandClone: never,
    saveQueue: async () => undefined,
  });
  return { stateRoot, effects };
}

describe('fileLaunchEffects', () => {
  it('formats iso() and the run stamp like Python', () => {
    const at = new Date('2026-11-26T01:02:03.456Z');
    expect(isoOf(at)).toBe('2026-11-26T01:02:03Z');
    expect(runStampOf(at)).toBe('20261126T010203Z');
  });

  it('resolves item_repo, same_repo and by_repo', async () => {
    const { effects } = await build();
    expect(effects.itemRepo({ repo: '' } as never)).toBe('Owner/Repo');
    expect(effects.itemRepo({} as never)).toBe('Owner/Repo');
    expect(effects.itemRepo({ repo: 'a/b' } as never)).toBe('a/b');
    expect(effects.isPrimaryRepo('owner/repo')).toBe(true);
    expect(effects.isPrimaryRepo('other/thing')).toBe(false);
    expect(effects.repoConfig('OTHER/thing')?.clone).toBe('/other');
    expect(effects.repoConfig('nope/nope')).toBeNull();
  });

  it('allocates a run directory exclusively', async () => {
    const { effects, stateRoot } = await build();
    const rdir = await effects.allocateRun('r1');
    expect(rdir).toBe(join(stateRoot, 'runs', 'r1'));
    expect((await stat(rdir)).isDirectory()).toBe(true);
    await expect(effects.allocateRun('r1')).rejects.toThrow();
  });

  it('writes meta.json as indent-2 ASCII JSON with a newline', async () => {
    const { effects } = await build();
    const rdir = await effects.allocateRun('r2');
    await effects.writeMeta(rdir, { a: 1, b: 'é' });
    expect(await readFile(join(rdir, 'meta.json'), 'utf8')).toBe(
      '{\n  "a": 1,\n  "b": "\\u00e9"\n}\n',
    );
  });

  it('appends events and best-effort work records as JSON lines', async () => {
    const { effects, stateRoot } = await build();
    await effects.event('blocked', { run_id: 'r' });
    expect(await readFile(join(stateRoot, 'events.jsonl'), 'utf8')).toBe(
      '{"at": "2026-11-26T01:02:03Z", "event": "blocked", "run_id": "r"}\n',
    );
    await effects.workStarted({ type: 'work-started' });
    const line = JSON.parse(
      await readFile(join(stateRoot, 'work', 'records.jsonl'), 'utf8'),
    ) as Record<string, unknown>;
    expect(line.type).toBe('work-started');
    expect(typeof line.host).toBe('string');
  });

  it('fails closed through the injected seams', async () => {
    const { effects } = await build();
    await expect(effects.scan({} as never)).rejects.toThrow('injected seam used');
    await expect(effects.onDemandClone('a/b')).rejects.toThrow('injected seam used');
  });

  it('checks out a detached worktree on crq/wt-<run> and removes it with its branch', async () => {
    const { clone, head } = await realClone();
    const root = await mkdtemp(join(tmpdir(), 'crq-wtroot-'));
    const { effects } = await build({ primaryClone: clone, worktreeRoot: root });
    const wt = await effects.checkout({ runId: 'r9', head, clone: null });
    expect(wt).toEqual({ path: join(root, 'crq-wt-r9'), branch: 'crq/wt-r9' });
    expect(git(wt.path, 'rev-parse', 'HEAD')).toBe(head);
    await effects.removeWorktree(wt.path, wt.branch, null);
    await expect(stat(wt.path)).rejects.toThrow();
    expect(git(clone, 'branch', '--list', 'crq/wt-r9')).toBe('');
  });

  it('removeWorktree never sweeps a path outside the worktree prefix', async () => {
    const { clone } = await realClone();
    const { effects } = await build({ primaryClone: clone });
    const other = await mkdtemp(join(tmpdir(), 'not-prefixed-'));
    await writeFile(join(other, 'keep'), 'x');
    await effects.removeWorktree(other, '', null);
    expect((await stat(join(other, 'keep'))).isFile()).toBe(true);
  });

  it('removeWorktree raises nothing when the sweep fails and still deletes the branch', async () => {
    if (process.getuid?.() === 0) return; // root ignores directory modes
    const { clone, head } = await realClone();
    git(clone, 'branch', 'crq/wt-stuck', head);
    const parent = await mkdtemp(join(tmpdir(), 'crq-ro-'));
    const path = join(parent, 'crq-wt-stuck');
    await mkdir(path);
    await writeFile(join(path, 'f'), 'x');
    await chmod(parent, 0o500);
    try {
      const { effects } = await build({ primaryClone: clone });
      await expect(effects.removeWorktree(path, 'crq/wt-stuck', null)).resolves.toBeUndefined();
      expect(git(clone, 'branch', '--list', 'crq/wt-stuck')).toBe('');
    } finally {
      await chmod(parent, 0o700);
    }
  });

  it('spawns the entry detached as `<entry> _review <run_id>` in runner.log', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crq-spawn-'));
    const entry = join(dir, 'entry.mjs');
    const out = join(dir, 'argv.json');
    await writeFile(
      entry,
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)));\n`,
    );
    const { effects } = await build({ entry });
    const rdir = await effects.allocateRun('r5');
    expect(rdir).toContain('r5');
    const pid = await effects.spawn('r5', rdir);
    expect(pid).toBeGreaterThan(0);
    for (let i = 0; i < 100; i += 1) {
      const text = await readFile(out, 'utf8').catch(() => '');
      if (text) {
        expect(JSON.parse(text)).toEqual(['_review', 'r5']);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('child never ran');
  });

  it('removeWorktree still prunes and deletes the branch when the directory has vanished', async () => {
    const { clone, head } = await realClone();
    git(clone, 'branch', 'crq/wt-gone', head);
    const { effects } = await build({ primaryClone: clone });
    await effects.removeWorktree(join(tmpdir(), 'crq-wt-does-not-exist'), 'crq/wt-gone', null);
    expect(git(clone, 'branch', '--list', 'crq/wt-gone')).toBe('');
  });

  it('checks out in an explicit clone, not the primary clone', async () => {
    const { clone, head } = await realClone();
    const root = await mkdtemp(join(tmpdir(), 'crq-wtroot-'));
    const { effects } = await build({ primaryClone: '/nonexistent-primary', worktreeRoot: root });
    const wt = await effects.checkout({ runId: 'rx', head, clone });
    expect(git(wt.path, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(clone, 'branch', '--list', 'crq/wt-rx')).toContain('crq/wt-rx');
  });

  it('spawns with the runner root as cwd (Popen cwd=ROOT)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crq-spawn-'));
    const root = await mkdtemp(join(tmpdir(), 'crq-root-'));
    const entry = join(dir, 'entry.mjs');
    const out = join(dir, 'cwd.txt');
    await writeFile(
      entry,
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(out)}, process.cwd());\n`,
    );
    const { effects } = await build({ entry, root });
    const rdir = await effects.allocateRun('r6');
    await effects.spawn('r6', rdir);
    for (let i = 0; i < 100; i += 1) {
      const text = await readFile(out, 'utf8').catch(() => '');
      if (text) {
        expect(await realpath(text)).toBe(await realpath(root));
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('child never ran');
  });
});
