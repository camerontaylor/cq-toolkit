// Fake CLI lifecycle regressions; no container daemon or sandbox is invoked.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

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
  const dir = await mkdtemp(join(tmpdir(), 'cq-container-stub-'));
  scratch.push(dir);
  const command = join(dir, 'docker');
  const log = join(dir, 'calls');
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
  return { dir, log, adapter: containerAdapter({ image: 'test-image', command }) };
}

const id = '1'.padStart(64, '0');

describe('daemon-owned container lifetime', () => {
  test('a timed-out attach removes the immutable created ID', async () => {
    const { adapter, dir, log } = await stub('exec /bin/sleep 2');
    const result = await adapter.launch({
      workspace: dir,
      argv: ['/bin/true'],
      network: 'model-only',
      timeoutMs: 100,
    });
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.spawnError).toBeUndefined();
    const calls = (await readFile(log, 'utf8')).trim().split('\n');
    expect(calls[0]).toMatch(/^create --name cq-sandbox-/);
    expect(calls[0]).not.toContain('--rm');
    expect(calls.slice(1)).toEqual([`start --attach ${id}`, `rm --force ${id}`]);
  });

  test('failed cleanup cannot return a successful child outcome', async () => {
    const { adapter, dir, log } = await stub(
      'echo child-output',
      'echo daemon-unreachable >&2; exit 1',
    );
    const result = await adapter.launch({ workspace: dir, argv: ['/bin/true'], network: 'allow' });
    expect(result.ok).toBe(false);
    expect(result.spawnError).toMatch(/container cleanup unconfirmed.*daemon-unreachable/);
    expect(await readFile(log, 'utf8')).toContain(`rm --force ${id}`);
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
    expect(await readFile(log, 'utf8')).toContain(`rm --force ${id}`);
  });

  test('a still-running container cannot produce a successful launch', async () => {
    const { adapter, dir, log } = await stub('exit 0', 'exit 0', "printf '%064d\\n' 1", 'true 0');
    const result = await adapter.launch({ workspace: dir, argv: ['/bin/true'], network: 'allow' });
    expect(result.ok).toBe(false);
    expect(result.spawnError).toMatch(/child exit could not be confirmed/);
    expect(await readFile(log, 'utf8')).toContain(`rm --force ${id}`);
  });

  test('failed create never starts and still attempts cleanup by its unique name', async () => {
    const { adapter, dir, log } = await stub('exit 0', 'exit 0', 'exit 1');
    const result = await adapter.launch({ workspace: dir, argv: ['/bin/true'], network: 'allow' });
    expect(result.ok).toBe(false);
    const calls = await readFile(log, 'utf8');
    expect(calls).not.toContain('start --attach');
    expect(calls).toMatch(/rm --force cq-sandbox-/);
  });

  test('invalid creation identity never starts a container', async () => {
    const { adapter, dir, log } = await stub('exit 0', 'exit 0', 'echo invalid-id');
    const result = await adapter.launch({ workspace: dir, argv: ['/bin/true'], network: 'allow' });
    expect(result.ok).toBe(false);
    expect(result.spawnError).toMatch(/no valid immutable container ID/);
    const calls = await readFile(log, 'utf8');
    expect(calls).not.toContain('start --attach');
    expect(calls).toMatch(/rm --force cq-sandbox-/);
  });
});
