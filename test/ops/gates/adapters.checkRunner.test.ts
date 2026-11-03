// Split provenance: test/ops/gates/adapters.test.ts was split by subject into
// sibling files; this file carries the checkRunner op, the real subprocess
// runner, the registry entry and the check-cancellation cases.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, test, vi } from 'vitest';
import {
  makeCheckRunner,
  subprocessRunCheck,
  type RunCheck,
} from '../../../src/ops/gates/index.js';
import { CheckRunnerInputSchema, registry } from '../../../src/ops/gates/registry.js';
import { fixture } from './adapters.helpers.js';

describe('makeCheckRunner over a fake injected runner (no subprocesses)', () => {
  const command = { command: 'eslint', args: ['--format', 'json', 'bad.ts'] };

  function runnerOf(stdout: string, exitCode: number | null): RunCheck {
    return async () => ({ stdout, stderr: '', exitCode });
  }

  test('parsed verdict → ok with the exact FailureSet', async () => {
    const run = makeCheckRunner(runnerOf(fixture('eslint.json'), 1));
    await expect(run({ adapter: 'eslint-json', command })).resolves.toEqual({
      status: 'ok',
      value: {
        tool: 'eslint',
        failures: [
          {
            file: '/private/tmp/cq-gates-fixtures.TA8IFi/bad.ts',
            line: 1,
            column: 7,
            ruleId: '@typescript-eslint/no-unused-vars',
            message: "'unused' is assigned a value but never used.",
            severity: 'error',
          },
          {
            file: '/private/tmp/cq-gates-fixtures.TA8IFi/bad.ts',
            line: 4,
            column: 7,
            ruleId: 'prefer-const',
            message: "'greeting' is never reassigned. Use 'const' instead.",
            severity: 'error',
          },
        ],
        exitCode: 1,
      },
    });
  });

  test('indeterminate verdict → indeterminate with the reason as detail', async () => {
    const run = makeCheckRunner(runnerOf(fixture('vitest-truncated.json'), 1));
    const result = await run({ adapter: 'vitest-json', command });
    expect(result.status).toBe('indeterminate');
    expect(result).toMatchObject({ detail: expect.any(String) });
  });

  test('a thrown runner → failed, never a crash or a fake verdict', async () => {
    const run = makeCheckRunner(async () => {
      throw new Error('spawn ENOENT');
    });
    await expect(run({ adapter: 'eslint-json', command })).resolves.toEqual({
      status: 'failed',
      error: 'spawn ENOENT',
    });
  });

  test('a rejected non-Error throw still yields failed evidence', async () => {
    const run = makeCheckRunner(async () => {
      throw 'boom';
    });
    await expect(run({ adapter: 'eslint-json', command })).resolves.toEqual({
      status: 'failed',
      error: 'boom',
    });
  });

  test('the same empty capture is clean for tsc-lines but indeterminate for vitest-json', async () => {
    const run = makeCheckRunner(async () => ({ stdout: '', stderr: '', exitCode: 0 }));
    await expect(run({ adapter: 'tsc-lines', command })).resolves.toEqual({
      status: 'ok',
      value: { tool: 'tsc', failures: [], exitCode: 0 },
    });
    const vitestResult = await run({ adapter: 'vitest-json', command });
    expect(vitestResult.status).toBe('indeterminate');
  });
});

describe('subprocessRunCheck (real runner over process.execPath, no external binaries)', () => {
  test('captures stdout and a zero exit', async () => {
    await expect(
      subprocessRunCheck({ command: process.execPath, args: ['-e', "console.log('hello')"] }),
    ).resolves.toEqual({ stdout: 'hello\n', stderr: '', exitCode: 0, signal: null });
  });

  test('maps a real exit code through', async () => {
    await expect(
      subprocessRunCheck({ command: process.execPath, args: ['-e', 'process.exit(3)'] }),
    ).resolves.toEqual({ stdout: '', stderr: '', exitCode: 3, signal: null });
  });

  test('a check past timeoutMs resolves quickly with exitCode null (SIGKILL, never clean)', async () => {
    const result = await subprocessRunCheck({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 10_000)'],
      timeoutMs: 300,
    });
    expect(result.exitCode).toBeNull();
    expect(result.signal).toBe('SIGKILL');
  });

  test('a spawn failure yields exitCode null, not a rejection', async () => {
    await expect(
      subprocessRunCheck({ command: 'definitely-not-a-real-check-binary', args: [] }),
    ).resolves.toMatchObject({ exitCode: null });
  });
});

describe('gates registry entry', () => {
  test('registry entries in order (C3 appends the hack detector + commit gate); the checkRunner schema validates the full input and only it', () => {
    expect(registry.map((entry) => entry.name)).toEqual([
      'gates.checkRunner',
      'gates.baselineProbe',
      'gates.regressionGate',
      'gates.hackDetector',
      'gates.commitGate',
      'gates.policyDiff',
    ]);
    const valid = { adapter: 'tsc-lines', command: { command: 'tsc', args: ['--noEmit'] } };
    expect(CheckRunnerInputSchema.parse(valid)).toEqual({
      adapter: 'tsc-lines',
      command: { command: 'tsc', args: ['--noEmit'], timeoutMs: 600_000 },
    });
    expect(
      CheckRunnerInputSchema.safeParse({ adapter: 'grep-json', command: valid.command }).success,
    ).toBe(false);
    expect(
      CheckRunnerInputSchema.safeParse({
        adapter: 'tsc-lines',
        command: { command: 'tsc', args: [7] },
      }).success,
    ).toBe(false);
    expect(
      CheckRunnerInputSchema.safeParse({ adapter: 'tsc-lines', command: { command: 9 } }).success,
    ).toBe(false);
    expect(
      CheckRunnerInputSchema.safeParse({
        adapter: 'tsc-lines',
        command: { command: 'tsc', args: ['--noEmit'], timeoutMs: 30_000 },
      }).success,
    ).toBe(true);
    expect(
      CheckRunnerInputSchema.safeParse({
        adapter: 'tsc-lines',
        command: { command: 'tsc', args: ['--noEmit'], timeoutMs: 0 },
      }).success,
    ).toBe(false);
  });

  test('an input without timeoutMs parses to the 600_000ms op-boundary floor', () => {
    const parsed = CheckRunnerInputSchema.parse({
      adapter: 'eslint-json',
      command: { command: 'eslint', args: ['--format', 'json', '.'] },
    });
    expect(parsed.command.timeoutMs).toBe(600_000);
  });

  test('the importer resolves to the subprocess-bound op', async () => {
    const entry = registry[0];
    if (entry === undefined) throw new Error('registry must contain the adapter op');
    expect(typeof entry.inputSchema).toBe('object');
    const op = await entry.importer();
    expect(typeof op).toBe('function');
  });
});

test('an already-aborted check never dispatches a child', async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await subprocessRunCheck(
    { command: process.execPath, args: ['-e', 'console.log("must not run")'] },
    { signal: controller.signal },
  );
  expect(result).toEqual({ stdout: '', stderr: 'check cancelled before dispatch', exitCode: null });
});
test('running check cancellation settles only after child exit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cq-check-cancel-'));
  const marker = join(dir, 'ready');
  const controller = new AbortController();
  const running = subprocessRunCheck(
    {
      command: process.execPath,
      args: [
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000)`,
      ],
      timeoutMs: 5000,
    },
    { signal: controller.signal },
  );
  let pid: number | undefined;
  try {
    await vi.waitFor(async () => {
      pid = Number(await readFile(marker, 'utf8'));
      expect(pid).toBeGreaterThan(0);
    });
    let settled = false;
    void running.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    controller.abort();
    await vi.waitFor(() => expect(settled).toBe(true), { timeout: 2000 });
    expect((await running).exitCode).toBeNull();
    expect(() => process.kill(pid!, 0)).toThrow();
  } finally {
    controller.abort();
    await running;
    await rm(dir, { recursive: true, force: true });
  }
});
