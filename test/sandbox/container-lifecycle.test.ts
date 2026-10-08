// Fake CLI lifecycle regressions; no container daemon or sandbox is invoked.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

// Measured scheduling margin (final head, concurrent authorized testing):
// every launch chains several real stub-CLI spawns, and process spawn
// latency on the shared host reached ~9s per spawn at load ~104 on 6 cores —
// past the 5s vitest default.  File-scoped test scheduling margin only;
// the adapter's own launch timeouts under test are untouched.
vi.setConfig({ testTimeout: 120_000 });

import { containerAdapter } from '../../src/sandbox/backend.js';

const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function stub(
  start: string,
  cleanup = 'exit 0',
  create = "printf '%064d\\n' 1",
  state = 'false 0',
) {
  // The launcher lives OUTSIDE the workspace: a launcher inside the
  // model-writable workspace is refused by the adapter.
  const bin = await mkdtemp(join(tmpdir(), 'cq-container-stub-'));
  const dir = await mkdtemp(join(tmpdir(), 'cq-container-ws-'));
  scratch.push(bin, dir);
  const command = join(bin, 'docker');
  const log = join(bin, 'calls');
  await writeFile(
    command,
    `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
case "$1" in
  create) ${create} ;;
  start) ${start} ;;
  inspect) echo '${state}' ;;
  rm) ${cleanup} ;;
esac
`,
    { mode: 0o700 },
  );
  return {
    dir,
    log,
    adapter: containerAdapter({ image: 'test-image', allowUnpinnedImage: true, command }),
  };
}

const id = '1'.padStart(64, '0');

describe('daemon-owned container lifetime', () => {
  test('a timed-out attach removes the immutable created ID', async () => {
    const { adapter, dir, log } = await stub('exec /bin/sleep 2');
    const result = await adapter.launch({
      workspace: dir,
      argv: ['/usr/bin/true'],
      network: 'model-only',
      timeoutMs: 100,
    });
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.spawnError).toBeUndefined();
    const calls = (await readFile(log, 'utf8')).trim().split('\n');
    expect(calls[0]).toMatch(/^create --name cq-sandbox-/);
    expect(calls[0]).not.toContain('--rm');
    expect(calls.slice(1)).toEqual([`start --attach ${id}`, `rm --force --volumes ${id}`]);
  });

  test('failed cleanup cannot return a successful child outcome', async () => {
    const { adapter, dir, log } = await stub(
      'echo child-output',
      'echo daemon-unreachable >&2; exit 1',
    );
    const result = await adapter.launch({
      workspace: dir,
      argv: ['/usr/bin/true'],
      network: 'allow',
    });
    expect(result.ok).toBe(false);
    expect(result.spawnError).toMatch(/container cleanup unconfirmed.*daemon-unreachable/);
    expect(await readFile(log, 'utf8')).toContain(`rm --force --volumes ${id}`);
  });

  test('daemon exit status wins over a successful attach CLI', async () => {
    const { adapter, dir, log } = await stub(
      'echo child-output',
      'exit 0',
      "printf '%064d\\n' 1",
      'false 7',
    );
    const result = await adapter.launch({ workspace: dir, argv: ['/bin/false'], network: 'allow' });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(7);
    expect(result.stdout).toContain('child-output');
    expect(await readFile(log, 'utf8')).toContain(`rm --force --volumes ${id}`);
  });

  test('a still-running container cannot produce a successful launch', async () => {
    const { adapter, dir, log } = await stub('exit 0', 'exit 0', "printf '%064d\\n' 1", 'true 0');
    const result = await adapter.launch({
      workspace: dir,
      argv: ['/usr/bin/true'],
      network: 'allow',
    });
    expect(result.ok).toBe(false);
    expect(result.spawnError).toMatch(/child exit could not be confirmed/);
    expect(await readFile(log, 'utf8')).toContain(`rm --force --volumes ${id}`);
  });

  test('failed create never starts and still attempts cleanup by its unique name', async () => {
    const { adapter, dir, log } = await stub('exit 0', 'exit 0', 'exit 1');
    const result = await adapter.launch({
      workspace: dir,
      argv: ['/usr/bin/true'],
      network: 'allow',
    });
    expect(result.ok).toBe(false);
    const calls = await readFile(log, 'utf8');
    expect(calls).not.toContain('start --attach');
    expect(calls).toMatch(/rm --force --volumes cq-sandbox-/);
  });

  test('invalid creation identity never starts a container', async () => {
    const { adapter, dir, log } = await stub('exit 0', 'exit 0', 'echo invalid-id');
    const result = await adapter.launch({
      workspace: dir,
      argv: ['/usr/bin/true'],
      network: 'allow',
    });
    expect(result.ok).toBe(false);
    expect(result.spawnError).toMatch(/no valid immutable container ID/);
    const calls = await readFile(log, 'utf8');
    expect(calls).not.toContain('start --attach');
    expect(calls).toMatch(/rm --force --volumes cq-sandbox-/);
  });

  test('a slow create is not cut off by a short attach budget', async () => {
    // Rationing P0: `create` ran under the request (attach) budget, so a
    // short child deadline could kill the control-plane call before any ID
    // existed.  Control-plane calls keep their own fixed budget.
    const { adapter, dir, log } = await stub(
      'echo attached',
      'exit 0',
      "/bin/sleep 1; printf '%064d\\n' 1",
    );
    const result = await adapter.launch({
      workspace: dir,
      argv: ['/usr/bin/true'],
      network: 'model-only',
      timeoutMs: 100,
    });
    const calls = (await readFile(log, 'utf8')).trim().split('\n');
    expect(calls[0]).toMatch(/^create --name cq-sandbox-/);
    expect(calls[1]).toBe(`start --attach ${id}`);
    expect(result.spawnError).toBeUndefined();
  });

  test('the container CLI env is fixed; the child env rides only in a private env file', async () => {
    // Codex P1: a passthrough DOCKER_HOST/HOME/PATH landed in the CLI's OWN
    // environment and could retarget the daemon, config, or credential
    // helpers the probe certified.  The stub records its own env and copies
    // the env file it was handed during create.
    const rec = await mkdtemp(join(tmpdir(), 'cq-container-rec-'));
    scratch.push(rec);
    const { adapter, dir, log } = await stub(
      'exit 0',
      'exit 0',
      `env > '${rec}/cli-env'; while [ "$1" != --env-file ]; do shift; done; cp "$2" '${rec}/child-env'; echo "$2" > '${rec}/env-path'; printf '%064d\\n' 1`,
    );
    const result = await adapter.launch({
      workspace: dir,
      argv: ['/usr/bin/true'],
      network: 'model-only',
      parentEnv: {
        PATH: `${dir}/bin`,
        HOME: dir,
        DOCKER_HOST: 'tcp://unprobed.invalid:2375',
        KEEP: 'yes',
      },
      envPassthrough: ['DOCKER_HOST', 'KEEP'],
    });
    expect(result.ok).toBe(true);
    const cliEnv = await readFile(`${rec}/cli-env`, 'utf8');
    expect(cliEnv).not.toContain('DOCKER_HOST=');
    expect(cliEnv).not.toContain('KEEP=');
    expect(cliEnv).not.toContain(`PATH=${dir}/bin`);
    expect(cliEnv).not.toContain(`HOME=${dir}\n`);
    const childEnv = await readFile(`${rec}/child-env`, 'utf8');
    expect(childEnv).toContain('DOCKER_HOST=tcp://unprobed.invalid:2375\n');
    expect(childEnv).toContain('KEEP=yes\n');
    expect(childEnv).toContain(`HOME=${dir}\n`);
    // The env file is gone once create has read it — before any start.
    const envPath = (await readFile(`${rec}/env-path`, 'utf8')).trim();
    await expect(readFile(envPath, 'utf8')).rejects.toThrow(/ENOENT/);
    const calls = await readFile(log, 'utf8');
    expect(calls).toMatch(/--entrypoint=\/usr\/bin\/true test-image$/m);
    expect(calls).not.toContain('unprobed.invalid');
  });

  test('a child env value with a line break is refused before any CLI call', async () => {
    const { adapter, dir, log } = await stub('exit 0');
    const result = await adapter.launch({
      workspace: dir,
      argv: ['/usr/bin/true'],
      network: 'model-only',
      parentEnv: { PATH: '/usr/bin:/bin', KEEP: 'a\nDOCKER_HOST=tcp://x' },
      envPassthrough: ['KEEP'],
    });
    expect(result.ok).toBe(false);
    expect(result.spawnError).toMatch(/line break or NUL/);
    await expect(readFile(log, 'utf8')).rejects.toThrow(/ENOENT/);
  });
});
