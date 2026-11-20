import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnReviewWrapper, runReviewChild } from '../../../src/adapters/crq/reviewProcess.js';
import { ReviewSpawnError } from '../../../src/queue-runner/reviewLaunch.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function setup(kind: string, cmd: string[]) {
  const root = await mkdtemp(join(tmpdir(), 'crq-review-process-'));
  roots.push(root);
  const dir = join(root, 'runs', 'run-1');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'meta.json'),
    JSON.stringify({ run_id: 'run-1', kind, cmd, worktree: root }),
  );
  return { root, dir };
}
async function waitFor(path: string): Promise<string> {
  for (let i = 0; i < 100; i++) {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${path}`);
}
const modulePath = fileURLToPath(
  new URL('../../../dist/adapters/crq/reviewProcess.js', import.meta.url),
);
/** The child never reaches a real `systemctl`: the kick drops a marker file instead. */
const kickMarker = (root: string) => join(root, 'kicked');
async function start(root: string, timeoutBinary = 'timeout', graceMs?: number) {
  const moduleUrl = pathToFileURL(modulePath).href;
  const code = `import {writeFile} from 'node:fs/promises'; import {runReviewChild} from ${JSON.stringify(moduleUrl)}; await runReviewChild({stateRoot:${JSON.stringify(root)},runId:'run-1',timeoutMinutes:1,timeoutBinary:${JSON.stringify(timeoutBinary)},env:{PATH:'/usr/bin:/bin'},${graceMs === undefined ? '' : `descendantGraceMs:${String(graceMs)},`}kick:()=>writeFile(${JSON.stringify(kickMarker(root))},'kick')});`;
  return spawnReviewWrapper({
    stateRoot: root,
    runId: 'run-1',
    cwd: root,
    executable: process.execPath,
    args: ['--input-type=module', '-e', code],
  });
}
describe('inactive detached review process', () => {
  it('writes managed identity and captures a real disposable child exit', async () => {
    const { root, dir } = await setup('open', [
      '/bin/sh',
      '-c',
      'printf hello; printf problem >&2; exit 7',
    ]);
    const pid = await start(root);
    const result: unknown = JSON.parse(await waitFor(join(dir, 'exit.json')));
    const identity: unknown = JSON.parse(await readFile(join(dir, 'review.pid'), 'utf8'));
    expect(identity).toMatchObject({
      run_id: 'run-1',
      pid,
      pgid: pid,
      sid: pid,
      group_owner: 'foreground-v1',
    });
    expect(identity).toHaveProperty('cli_pid', expect.any(Number));
    expect(result).toMatchObject({ exit: 7, timed_out: false });
    expect(await readFile(join(dir, 'review.ndjson'), 'utf8')).toBe('hello');
    expect(await readFile(join(dir, 'stderr.log'), 'utf8')).toBe('problem');
  });
  it.each([124, 137])(
    'passes group-signalling timeout arguments and records exit %i',
    async (exit) => {
      const { root, dir } = await setup('open', ['/bin/echo', 'hello']);
      const timeout = join(root, 'fake-timeout');
      await writeFile(timeout, `#!/bin/sh\nprintf '%s\\n' "$@"\nexit ${exit}\n`);
      await chmod(timeout, 0o700);
      await start(root, timeout);
      const result: unknown = JSON.parse(await waitFor(join(dir, 'exit.json')));
      expect(result).toMatchObject({ exit, timed_out: true });
      expect(await readFile(join(dir, 'review.ndjson'), 'utf8')).toBe(
        '--foreground\n--kill-after=60\n1m\n/bin/echo\nhello\n',
      );
    },
  );
  it('records a group SIGKILL exit as a plain failure under --foreground', async () => {
    const { root, dir } = await setup('open', ['/bin/echo', 'hello']);
    const timeout = join(root, 'fake-timeout');
    await writeFile(timeout, '#!/bin/sh\nkill -9 $$\n');
    await chmod(timeout, 0o700);
    await start(root, timeout);
    const result: unknown = JSON.parse(await waitFor(join(dir, 'exit.json')));
    expect(result).toMatchObject({ exit: -9, timed_out: false });
  });
  it('kicks the tick service only after exit.json is written', async () => {
    const { root, dir } = await setup('open', ['/bin/sh', '-c', 'exit 0']);
    await start(root);
    await waitFor(kickMarker(root));
    expect(JSON.parse(await readFile(join(dir, 'exit.json'), 'utf8'))).toMatchObject({ exit: 0 });
  });
  describe('backfill submission proof', () => {
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@e.x', ...args], {
        encoding: 'utf8',
      }).trim();
    async function backfill(version: string, overrides: Record<string, unknown> = {}) {
      const { root, dir } = await setup('backfill', ['/bin/false']);
      const repo = join(root, 'repo');
      await mkdir(repo);
      git(repo, 'init', '-q', '-b', 'main');
      await writeFile(join(repo, 'a.txt'), 'one\ntwo\n');
      git(repo, 'add', '.');
      git(repo, 'commit', '-q', '-m', 'base');
      const base = git(repo, 'rev-parse', 'HEAD');
      await writeFile(join(repo, 'a.txt'), 'one\ntwo\nthree\n');
      git(repo, 'commit', '-qam', 'head');
      const head = git(repo, 'rev-parse', 'HEAD');
      const cli = join(root, 'coderabbit');
      await writeFile(
        cli,
        `#!/bin/sh\nif [ "$1" = --version ]; then echo ${version}; exit 0; fi\ntouch ${join(root, 'executed')}\n`,
      );
      await chmod(cli, 0o700);
      await writeFile(
        join(dir, 'meta.json'),
        JSON.stringify({
          run_id: 'run-1',
          kind: 'backfill',
          cmd: [cli, 'review'],
          worktree: repo,
          head,
          base,
          backfill: { attempt_id: 'attempt-1' },
          ...overrides,
        }),
      );
      return { root, dir, repo, head, base };
    }
    it('writes submission.json for a clean pinned head, then runs the reviewer', async () => {
      const { root, dir, head, base } = await backfill('0.8.2');
      await start(root);
      await waitFor(join(dir, 'exit.json'));
      expect(JSON.parse(await readFile(join(dir, 'submission.json'), 'utf8'))).toEqual({
        cli_version: '0.8.2',
        format: 'coderabbit-agent-0.8.2',
        run_id: 'run-1',
        head,
        base,
        attempt_id: 'attempt-1',
        submitted_scope: [
          {
            path: 'a.txt',
            blob: expect.stringMatching(/^[0-9a-f]{40}$/) as unknown,
            intervals: [[3, 3]],
          },
        ],
      });
      expect(await readFile(join(root, 'executed'), 'utf8')).toBe('');
    });
    it.each([
      ['an unknown CLI version', '9.9.9', {}, 'unknown CodeRabbit version'],
      ['a head that moved', '0.8.2', { head: 'f'.repeat(40) }, 'clean pinned head'],
    ])('refuses %s before invoking the reviewer', async (_label, version, overrides, message) => {
      const { root, dir } = await backfill(version, overrides);
      await start(root);
      expect(JSON.parse(await waitFor(join(dir, 'exit.json')))).toMatchObject({
        exit: 3,
        timed_out: false,
        pre_vendor_refusal: true,
      });
      expect(await readFile(join(dir, 'review.ndjson'), 'utf8')).toContain(message);
      await expect(readFile(join(dir, 'submission.json'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(readFile(join(root, 'executed'))).rejects.toMatchObject({ code: 'ENOENT' });
    });
    it('refuses a dirty worktree', async () => {
      const { root, dir, repo } = await backfill('0.8.2');
      await writeFile(join(repo, 'untracked.txt'), 'x');
      await start(root);
      expect(JSON.parse(await waitFor(join(dir, 'exit.json')))).toMatchObject({ exit: 3 });
      expect(await readFile(join(dir, 'review.ndjson'), 'utf8')).toContain('clean pinned head');
    });
  });
  it('retains managed pre-child identity if the timeout executable cannot start', async () => {
    const { root, dir } = await setup('open', ['/bin/true']);
    const pid = await start(root, '/not-a-real-timeout');
    const identity: unknown = JSON.parse(await waitFor(join(dir, 'review.pid')));
    expect(identity).toMatchObject({
      run_id: 'run-1',
      pid,
      pgid: pid,
      sid: pid,
      group_owner: 'foreground-v1',
    });
    expect(identity).not.toHaveProperty('cli_pid');
    const log = await waitFor(join(dir, 'runner.log'));
    // runner.log may be created before the child fails, so wait for an error if necessary.
    let output = log;
    for (let i = 0; i < 100 && !output.includes('ENOENT'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      output = await readFile(join(dir, 'runner.log'), 'utf8');
    }
    expect(output).toContain('ENOENT');
    // A terminal record is left (127: executable not found) and the tick is kicked.
    expect(JSON.parse(await waitFor(join(dir, 'exit.json')))).toMatchObject({
      exit: 127,
      timed_out: false,
    });
    expect(await waitFor(kickMarker(root))).toBe('kick');
  });
  describe('descendants left behind by --foreground', () => {
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    it('terminates a background descendant before writing exit.json', async () => {
      const { root, dir } = await setup('open', []);
      const bg = join(root, 'bg.pid');
      await writeFile(
        join(dir, 'meta.json'),
        JSON.stringify({
          run_id: 'run-1',
          kind: 'open',
          cmd: ['/bin/sh', '-c', `sleep 600 & echo $! > ${bg}; exit 0`],
          worktree: root,
        }),
      );
      await start(root, 'timeout', 300);
      await waitFor(join(dir, 'exit.json'));
      expect(alive(Number((await readFile(bg, 'utf8')).trim()))).toBe(false);
      expect(await waitFor(kickMarker(root))).toBe('kick');
    });
    it('escalates to KILL for a descendant that ignores TERM', async () => {
      const { root, dir } = await setup('open', []);
      const bg = join(root, 'bg.pid');
      await writeFile(
        join(dir, 'meta.json'),
        JSON.stringify({
          run_id: 'run-1',
          kind: 'open',
          cmd: ['/bin/sh', '-c', `(trap '' TERM; exec sleep 600) & echo $! > ${bg}; exit 0`],
          worktree: root,
        }),
      );
      await start(root, 'timeout', 300);
      await waitFor(join(dir, 'exit.json'));
      expect(alive(Number((await readFile(bg, 'utf8')).trim()))).toBe(false);
    });
  });
  it('reports a missing working directory rather than the executable', async () => {
    const { root } = await setup('open', ['/bin/true']);
    const cwd = join(root, 'missing');
    await expect(
      spawnReviewWrapper({
        stateRoot: root,
        runId: 'run-1',
        cwd,
        executable: process.execPath,
        args: [],
      }),
    ).rejects.toThrow(`[Errno 2] No such file or directory: '${cwd}'`);
  });
  it('converts an OS spawn failure and rejects unsafe paths', async () => {
    const { root } = await setup('open', ['/bin/true']);
    await expect(
      spawnReviewWrapper({
        stateRoot: root,
        runId: 'run-1',
        cwd: root,
        executable: '/not-a-real-crq-binary',
        args: [],
      }),
    ).rejects.toThrow(ReviewSpawnError);
    await expect(
      spawnReviewWrapper({
        stateRoot: root,
        runId: '../bad',
        cwd: root,
        executable: process.execPath,
        args: [],
      }),
    ).rejects.toThrow('invalid run id');
  });
  it('refuses an unowned session before spawning', async () => {
    const { root } = await setup('open', ['/bin/true']);
    await expect(
      runReviewChild({ stateRoot: root, runId: 'run-1', timeoutMinutes: 1, env: {} }),
    ).rejects.toThrow('not a detached session leader');
  });
});
