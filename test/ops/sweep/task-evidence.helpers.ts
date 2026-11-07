// Split provenance: test/ops/sweep/task-evidence.test.ts was split into
// task-evidence.{failed-refs,failed-ref-errors,ref-identity,m6a-trailers,m5b4-correlation,prompt-projection}.test.ts
// plus this shared fixtures module. The fixtures below moved unchanged.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { OpInvocation, WorkerResult } from '../../../src/driver/types.js';
import { runTaskLoop } from '../../../src/ops/sweep/taskLoop.js';

export const exec = promisify(execFile);

export const UNIT = { package: 'alpha', fixer: 'fix', files: ['src/a.ts'] };
export const PROBE = {
  verdict: 'failing' as const,
  attempts: 1,
  failureSet: {
    tool: 'vitest',
    exitCode: 1,
    failures: [
      {
        file: 'src/a.ts',
        line: 1,
        column: 1,
        ruleId: null,
        message: 'broken',
        severity: 'error' as const,
      },
    ],
  },
};
export const EFFECTS = {
  broader: async () => ({
    final: {
      verdict: 'clean' as const,
      attempts: 1,
      failureSet: { tool: 'vitest', exitCode: 0, failures: [] },
    },
    treeSha: 'b'.repeat(40),
  }),
  commit: async () => 'c'.repeat(40),
  verify: async () => {},
  publish: async () => {},
};

export function loopBindings(invocations: OpInvocation[]): Parameters<typeof runTaskLoop>[0] {
  return {
    driver: {
      run: async (invocation: OpInvocation): Promise<WorkerResult> => {
        invocations.push(invocation);
        return {
          structuredOutput: { outcome: 'code-bug', summary: 'repair', confidence: 0.9 },
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          denials: [],
          stopReason: 'complete',
        };
      },
    },
    prompt: () => 'fix it',
    // The gated tree and the broader probe's tree are the same 'b' tree: the
    // loop binds the commit to what the path/tamper gates inspected.
    git: async (args: string[]) => ({
      code: 0,
      stdout: args.includes('write-tree') ? `${'b'.repeat(40)}\n` : '',
      stderr: '',
    }),
    runCheck: async () => ({
      stdout: JSON.stringify({
        success: true,
        numTotalTests: 1,
        testResults: [
          {
            name: 's.test.js',
            status: 'passed',
            assertionResults: [{ fullName: 'p', status: 'passed' }],
          },
        ],
      }),
      stderr: '',
      exitCode: 0,
    }),
    adapter: 'vitest-json' as const,
    checkCommand: () => ({ command: 'node', args: ['check'], cwd: '/tmp/unused' }),
    budget: { wallClockMs: 60_000 },
    runPrefix: 'run/x',
    scanPrompt: async () => {},
    modelSpec: { provider: 'fixture', model: 'scripted' },
  } as unknown as Parameters<typeof runTaskLoop>[0];
}

export const runLoop = (invocations: OpInvocation[]) =>
  runTaskLoop(
    loopBindings(invocations),
    UNIT,
    { path: '/tmp/unused', branch: 'run/x' } as never,
    PROBE,
    'run/x',
    EFFECTS,
  );
