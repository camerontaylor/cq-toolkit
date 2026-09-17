// Analyze lane G3 — test evidence for the playbook verifier: exit 0 is the
// ONLY pass; a numeric non-zero exit is a fail whose reason carries the
// captured output excerpt; an unobservable exit (null) is indeterminate and
// NEVER a pass (I5); a crashed runner is indeterminate too. The command
// crosses the injected runner verbatim. All through INJECTED runners — no
// subprocess is spawned.
import { describe, expect, test } from 'vitest';
import type { RawCheckOutput, RunCheck } from '../../../../src/ops/gates/checkRunner.js';
import type { VerifierCommand } from '../../../../src/ops/analyze/playbooks/format.js';
import { makePlaybookVerifier } from '../../../../src/ops/analyze/playbooks/verifier.js';

/** A fake runner returning one canned raw output and recording the command. */
function fakeRunner(response: RawCheckOutput): RunCheck & { commands: unknown[] } {
  const runner = async (cmd: Parameters<RunCheck>[0]) => {
    runner.commands.push(cmd);
    return response;
  };
  runner.commands = [] as unknown[];
  return runner as RunCheck & { commands: unknown[] };
}

const COMMAND: VerifierCommand = {
  command: 'npm',
  args: ['test'],
  cwd: 'ws',
  timeoutMs: 5_000,
};

describe('makePlaybookVerifier (the exit-to-verdict contract)', () => {
  test('exit 0 is a pass, with no reason field', async () => {
    const run = fakeRunner({ stdout: 'all green\n', stderr: '', exitCode: 0 });
    const outcome = await makePlaybookVerifier(run)(COMMAND);
    expect(outcome).toEqual({ verdict: 'pass', exitCode: 0 });
    expect(run.commands).toEqual([COMMAND]);
  });

  test('a numeric non-zero exit is a fail; the reason carries the output excerpt', async () => {
    const run = fakeRunner({
      stdout: '3 failed, 10 passed\nFAIL src/a.ts\n',
      stderr: 'npm err tail\n',
      exitCode: 1,
    });
    const outcome = await makePlaybookVerifier(run)(COMMAND);
    expect(outcome.verdict).toBe('fail');
    if (outcome.verdict !== 'fail') return;
    expect(outcome.exitCode).toBe(1);
    expect(outcome.reason).toContain('exited 1');
    expect(outcome.reason).toContain('3 failed, 10 passed');
    expect(outcome.reason).toContain('npm err tail');
  });

  test('an unobservable exit (null) is indeterminate and NEVER a pass (I5)', async () => {
    const run = fakeRunner({ stdout: 'partial', stderr: 'killed', exitCode: null });
    const outcome = await makePlaybookVerifier(run)(COMMAND);
    expect(outcome.verdict).toBe('indeterminate');
    if (outcome.verdict !== 'indeterminate') return;
    expect(outcome.exitCode).toBeNull();
    expect(outcome.reason).toContain('unobservable');
    expect(outcome.reason).toContain('never a pass');
    expect(outcome.reason).toContain('killed');
  });

  test('a crashed runner is indeterminate, never a verdict', async () => {
    const run = async (): Promise<RawCheckOutput> => {
      throw new Error('seam gone');
    };
    const outcome = await makePlaybookVerifier(run)(COMMAND);
    expect(outcome.verdict).toBe('indeterminate');
    if (outcome.verdict !== 'indeterminate') return;
    expect(outcome.reason).toContain('seam gone');
  });

  test('the excerpt is bounded (a page of diagnostics cannot flood the quarantine record)', async () => {
    const flood = 'x'.repeat(10_000);
    const run = fakeRunner({ stdout: flood, stderr: '', exitCode: 2 });
    const outcome = await makePlaybookVerifier(run)(COMMAND);
    if (outcome.verdict !== 'fail') throw new Error('expected fail');
    const excerptStart = outcome.reason.indexOf('captured output: ');
    expect(excerptStart).toBeGreaterThanOrEqual(0);
    const excerpt = outcome.reason.slice(excerptStart + 'captured output: '.length);
    expect(excerpt.length).toBeLessThanOrEqual(200);
  });
});
