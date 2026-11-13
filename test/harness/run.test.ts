// The closed git forms must inherit the same cancellation, retention and
// environment boundary as shell commands. Executable shims keep these tests
// independent of git's timing while exercising the real run-tool route.
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { buildChildEnv } from '../../src/shared/proc.js';
import { defaultHarnessConfig } from '../../src/harness/config.js';
import type { HarnessConfig } from '../../src/harness/config.js';
import { runArgvCommand } from '../../src/harness/run.js';
import { buildTools } from '../../src/harness/tools.js';
import { harnessRunGate } from '../../src/sandbox/index.js';

afterEach(() => vi.unstubAllEnvs());

function config(timeoutMs = 10_000, maxOutputChars?: number): HarnessConfig {
  return {
    ...defaultHarnessConfig,
    tools: {
      ...defaultHarnessConfig.tools,
      bash: {
        enabled: true,
        commandPatterns: ['git diff', 'git log', 'env'],
        timeoutMs,
        ...(maxOutputChars === undefined ? {} : { maxOutputChars }),
      },
    },
  };
}

async function withGitShim(body: string, testBody: (workspace: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'harness-run-'));
  try {
    const bin = join(root, 'bin');
    await mkdir(bin);
    const file = join(bin, 'git');
    await writeFile(file, `#!/bin/sh\n${body}\n`);
    await chmod(file, 0o755);
    vi.stubEnv('PATH', `${bin}:${process.env['PATH'] ?? ''}`);
    await testBody(root);
  } finally {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
}

async function poll<T>(probe: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await probe();
    if (result !== undefined) return result;
    if (Date.now() > deadline) throw new Error('process probe timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function readPid(workspace: string): Promise<number | undefined> {
  const text = await readFile(join(workspace, 'pid.txt'), 'utf8').catch(() => '');
  return text.endsWith('\n') ? Number(text.trim()) : undefined;
}

async function terminated(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
  // An orphan zombie is already terminated, even if the CI init process has
  // not reaped its pid yet. It cannot execute or keep the output pipes open.
  if (process.platform === 'linux') {
    const status = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
    return /^\d+ \(.*\) Z /.test(status);
  }
  return false;
}

function run(workspace: string, harness = config(), envNames: readonly string[] = []) {
  const tool = buildTools(harness, workspace, 'workspace-write', {
    ...harnessRunGate(),
    declaredEnvNames: envNames,
  }).find((candidate) => candidate.name === 'bash');
  if (tool === undefined) throw new Error('run fixture missing tool');
  return tool;
}

describe('no-shell run lifecycle', { timeout: 30_000 }, () => {
  test('argv bytes reach the child literally without shell expansion', async () => {
    const args = ['$HOME', '; echo injected', '*.txt', '{a,b}'];
    const outcome = await runArgvCommand(
      process.execPath,
      ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...args],
      { cwd: tmpdir(), env: buildChildEnv(process.env), maxBytes: 1_024, timeoutMs: 10_000 },
    );
    expect(outcome).toMatchObject({ kind: 'exit', code: 0, stdout: JSON.stringify(args) });
  });

  test.each(['git diff', 'git log -n 1'])('%s receives constant pinned argv', async (command) => {
    await withGitShim('printf "%s\\n" "$@"', async (workspace) => {
      const result = await run(workspace).execute({ command });
      expect(result).toMatchObject({ ok: true, exitCode: 0 });
      if (result.ok) {
        expect(result.output).toContain(
          '--no-pager\n--literal-pathspecs\n-c\ncore.fsmonitor=false',
        );
        expect(result.output).toContain('--no-ext-diff\n--no-textconv\n--no-color');
        expect(result.output.endsWith('\n--\n')).toBe(true);
      }
    });
  });

  test.each(['git diff', 'git log -n 1'])(
    '%s pre-abort never starts the executable',
    async (command) => {
      await withGitShim('echo ran > marker.txt', async (workspace) => {
        const controller = new AbortController();
        controller.abort();
        const result = await run(workspace).execute({ command }, { signal: controller.signal });
        expect(result).toMatchObject({ ok: true, exitCode: null, killed: true });
        await expect(readFile(join(workspace, 'marker.txt'))).rejects.toMatchObject({
          code: 'ENOENT',
        });
      });
    },
  );

  test.skipIf(process.platform === 'win32')(
    'closed git abort kills its descendant process group',
    async () => {
      await withGitShim('sleep 60 & echo $! > pid.txt; wait', async (workspace) => {
        const controller = new AbortController();
        const pending = run(workspace).execute(
          { command: 'git diff' },
          { signal: controller.signal },
        );
        try {
          const pid = await poll(() => readPid(workspace));
          expect(await terminated(pid)).toBe(false);
          controller.abort();
          expect(await pending).toMatchObject({ ok: true, exitCode: null, killed: true });
          await poll(async () => ((await terminated(pid)) ? true : undefined), 2_000);
        } finally {
          controller.abort();
          await pending;
        }
      });
    },
  );

  test.skipIf(process.platform === 'win32')(
    'closed git timeout kills its descendant process group',
    async () => {
      // Only a trial that observes the actual descendant proves group killing.
      for (const timeoutMs of [300, 2_000, 8_000]) {
        let observed = false;
        await withGitShim('sleep 60 & echo $! > pid.txt; wait', async (workspace) => {
          const result = await run(workspace, config(timeoutMs)).execute({ command: 'git diff' });
          expect(result).toMatchObject({ ok: true, exitCode: null, killed: true });
          const pid = await readPid(workspace);
          if (pid === undefined) return;
          observed = true;
          await poll(async () => ((await terminated(pid)) ? true : undefined), 2_000);
        });
        if (observed) return;
      }
      throw new Error('no timeout trial started the descendant');
    },
  );

  test('no-shell output is retained within the configured cap', async () => {
    await withGitShim('printf "%0800d" 0', async (workspace) => {
      const result = await run(workspace, config(10_000, 100)).execute({ command: 'git diff' });
      expect(result).toMatchObject({ ok: true, exitCode: 0, truncated: true });
      if (result.ok) expect(result.output).toHaveLength(100);
    });
  });

  test('no-shell buffer overflow keeps draining and marks truncation', async () => {
    const outcome = await runArgvCommand(
      process.execPath,
      ['-e', 'process.stdout.write("x".repeat(10000)); process.stderr.write("err")'],
      { cwd: tmpdir(), env: buildChildEnv(process.env), maxBytes: 64, timeoutMs: 10_000 },
    );
    expect(outcome).toMatchObject({
      kind: 'exit',
      code: 0,
      stdout: 'x'.repeat(64),
      stderr: 'err',
      overflowed: true,
    });
  });

  test('no-shell nonzero exit and spawn error remain distinct outcomes', async () => {
    await withGitShim('echo diagnostic >&2; exit 7', async (workspace) => {
      const result = await run(workspace).execute({ command: 'git diff' });
      expect(result).toMatchObject({ ok: true, exitCode: 7, killed: false });
      if (result.ok) expect(result.output).toContain('diagnostic');
    });
    const outcome = await runArgvCommand('/cq-no-such-executable', [], {
      cwd: tmpdir(),
      env: buildChildEnv(process.env),
      maxBytes: 64,
    });
    expect(outcome).toMatchObject({ kind: 'spawn-error', error: { code: 'ENOENT' } });
  });

  test('a completed exit survives an abort while a descendant holds the pipes', async () => {
    // The child exits at once but an inherited pipe keeps `close` pending; an
    // abort inside that window must not relabel the finished command `killed`.
    // The abort is armed from the child's OWN exit signal (a marker written
    // immediately before it exits) rather than a fixed delay, so a slow child
    // start cannot race the abort past the exit event on a loaded runner.
    const dir = await mkdtemp(join(tmpdir(), 'cq-run-exit-'));
    try {
      const exited = join(dir, 'exited');
      const script = [
        "const { spawn } = require('node:child_process');",
        "const { writeFileSync } = require('node:fs');",
        "spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'inherit' });",
        'setTimeout(() => {',
        `  writeFileSync(${JSON.stringify(exited)}, 'exit 5');`,
        '  process.exit(5);',
        '}, 200);',
      ].join(' ');
      const controller = new AbortController();
      const pending = runArgvCommand(process.execPath, ['-e', script], {
        cwd: tmpdir(),
        env: buildChildEnv(process.env),
        maxBytes: 1_024,
        timeoutMs: 20_000,
        signal: controller.signal,
      });
      // Wait for the marker (bounded), then give the parent's `exit` delivery a
      // beat before aborting: the descendant still holds the pipes either way.
      const deadline = Date.now() + 15_000;
      for (;;) {
        try {
          await readFile(exited);
          break;
        } catch (error) {
          if (Date.now() > deadline) throw error;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      setTimeout(() => controller.abort(), 250);
      expect(await pending).toMatchObject({ kind: 'exit', code: 5 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('shared run core environment boundary', { timeout: 30_000 }, () => {
  test.each(['env', 'git diff', 'git log -n 1'])(
    '%s scrubs secrets and forwards explicitly allowed names',
    async (command) => {
      await withGitShim('env', async (workspace) => {
        vi.stubEnv('CQ_SANDBOX', 'off'); // Explicit passthrough opts into the sandbox policy.
        vi.stubEnv('CQ_RUN_ENV_PASSTHROUGH', 'RUN_TEST_CONFIGURED_CANARY');
        vi.stubEnv('CQ_RUN_TEST_SECRET', 'must-not-leak');
        vi.stubEnv('RUN_TEST_EXPLICIT_CANARY', 'explicit-visible');
        vi.stubEnv('RUN_TEST_CONFIGURED_CANARY', 'configured-visible');
        const result = await run(workspace, config(), ['RUN_TEST_EXPLICIT_CANARY']).execute({
          command,
        });
        expect(result).toMatchObject({ ok: true, exitCode: 0 });
        if (result.ok) {
          expect(result.output).not.toContain('CQ_RUN_TEST_SECRET=');
          expect(result.output).not.toContain('must-not-leak');
          expect(result.output).not.toContain('CQ_SANDBOX=');
          expect(result.output).not.toContain('CQ_RUN_ENV_PASSTHROUGH=');
          expect(result.output).toContain('RUN_TEST_EXPLICIT_CANARY=explicit-visible');
          expect(result.output).toContain('RUN_TEST_CONFIGURED_CANARY=configured-visible');
          expect(result.output).toContain('PATH=');
        }
      });
    },
  );
});
