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
async function start(root: string, timeoutBinary = 'timeout') {
  const moduleUrl = pathToFileURL(modulePath).href;
  const code = `import {runReviewChild} from ${JSON.stringify(moduleUrl)}; await runReviewChild({stateRoot:${JSON.stringify(root)},runId:'run-1',timeoutMinutes:1,timeoutBinary:${JSON.stringify(timeoutBinary)},env:{PATH:'/usr/bin:/bin'}});`;
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
  it.each([124, 137])('passes foreground timeout arguments and records exit %i', async (exit) => {
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
  });
  it('refuses backfill before invoking any command', async () => {
    const { root, dir } = await setup('backfill', ['/bin/false']);
    await writeFile(
      join(dir, 'meta.json'),
      JSON.stringify({
        run_id: 'run-1',
        kind: 'backfill',
        cmd: ['/bin/sh', '-c', `touch ${join(root, 'executed')}`],
        worktree: root,
      }),
    );
    await start(root);
    expect(JSON.parse(await waitFor(join(dir, 'exit.json')))).toMatchObject({
      exit: 3,
      pre_vendor_refusal: true,
    });
    expect(await readFile(join(dir, 'review.ndjson'), 'utf8')).toContain(
      'submission proof is not bound',
    );
    await expect(readFile(join(root, 'executed'))).rejects.toMatchObject({ code: 'ENOENT' });
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
    await expect(readFile(join(dir, 'exit.json'))).rejects.toMatchObject({ code: 'ENOENT' });
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
