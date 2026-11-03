// Lane C S4 — `analyze.fix` over a REAL git repository with a SCRIPTED
// runner (the checks and the ast-grep scan answer from the bytes on disk; no
// compiler or ast-grep binary needed) and a FAKE driver factory (no model).
// Pinned: selection, preview (no write), the attended apply + recheck on all
// three paths (cluster rule, rule over files, agent patch), and every
// refusal's taxonomy.
//
// Split provenance: test/ops/analyze/fix.test.ts was split into eight subject
// test files in this directory and this shared fixture module:
// fix.patchTargets.test.ts, fix.schema.test.ts, fix.agentProposal.test.ts,
// fix.agentProposalRefusal.test.ts, fix.applyPreconditions.test.ts,
// fix.previewApply.test.ts, fix.ruleOverFiles.test.ts and
// fix.selection.test.ts.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import type { DriverFactory } from '../../../src/driver/factory.js';
import type { Driver, OpInvocation, WorkerResult } from '../../../src/driver/types.js';
import type { CheckCommand, RunCheck } from '../../../src/ops/gates/checkRunner.js';
import { makeAnalyzeRun } from '../../../src/ops/analyze/run.js';

export const BAD = 'const n: number = "forty-two";\nexport { n };\n';
export const GOOD = 'const n: number = 42;\nexport { n };\n';
export const RULE = JSON.stringify({
  id: 'forty-two',
  language: 'TypeScript',
  rule: { pattern: '"forty-two"' },
  fix: '42',
});
export const CHECKS = [
  { adapter: 'tsc-lines' as const, command: { command: 'tsc', args: ['--noEmit'], cwd: '.' } },
];
const CONFIG = JSON.stringify({ schemaVersion: 2, checks: CHECKS });

/** The scripted runner: tsc from the file bytes; ast-grep by literal pattern. */
export function scriptedRunner(
  hooks: { onTsc?: () => void } = {},
): RunCheck & { calls: CheckCommand[] } {
  const calls: CheckCommand[] = [];
  const run = (async (cmd: CheckCommand) => {
    calls.push(cmd);
    const cwd = cmd.cwd ?? '.';
    if (cmd.command === 'ast-grep') {
      const rule = JSON.parse(cmd.args[3] ?? '{}') as { rule?: { pattern?: string }; fix?: string };
      const pattern = Buffer.from(rule.rule?.pattern ?? '', 'utf8');
      const targets = cmd.args.slice(cmd.args.indexOf('--') + 1);
      const matches: object[] = [];
      for (const file of targets) {
        const bytes = readFileSync(join(cwd, file));
        let index = bytes.indexOf(pattern);
        while (index !== -1) {
          matches.push({
            file,
            replacement: rule.fix ?? '',
            replacementOffsets: { start: index, end: index + pattern.length },
          });
          index = bytes.indexOf(pattern, index + 1);
        }
      }
      return { stdout: JSON.stringify(matches), stderr: '', exitCode: 0 };
    }
    hooks.onTsc?.();
    const text = readFileSync(join(cwd, 'src', 'index.ts'), 'utf8');
    return text.includes('"forty-two"')
      ? {
          stdout:
            "src/index.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.\n",
          stderr: '',
          exitCode: 1,
        }
      : { stdout: '', stderr: '', exitCode: 0 };
  }) as RunCheck & { calls: CheckCommand[] };
  run.calls = calls;
  return run;
}

export const repos: string[] = [];
export async function fixture(options: { commit?: boolean; config?: boolean } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cq-fix-')));
  repos.push(dir);
  const git = (args: string[]) =>
    execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  git(['init', '-q']);
  git(['config', 'user.email', 'fix@example.invalid']);
  git(['config', 'user.name', 'fix test']);
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'index.ts'), BAD);
  writeFileSync(join(dir, 'tsconfig.json'), '{}\n');
  if (options.config !== false) writeFileSync(join(dir, 'cq.json'), CONFIG);
  if (options.commit !== false) {
    git(['add', '.']);
    git(['commit', '-q', '-m', 'base']);
  }
  const analysis = await makeAnalyzeRun(scriptedRunner())({
    dir,
    checks: CHECKS,
  });
  if (analysis.status !== 'ok')
    throw new Error(`fixture analysis failed: ${JSON.stringify(analysis)}`);
  const clusterId = analysis.value.clusters[0]?.id ?? '';
  return { dir, git, clusterId, sidecarPath: analysis.value.sidecarPath };
}
afterEach(() => {
  for (const dir of repos.splice(0)) rmSync(dir, { recursive: true, force: true });
});

export const source = (dir: string) => readFileSync(join(dir, 'src', 'index.ts'), 'utf8');

/** A fake driver factory returning a canned proposal. */
export function fakeFactory(output: unknown, stopReason: WorkerResult['stopReason'] = 'complete') {
  const invocations: OpInvocation[] = [];
  const driver = {
    run: async (invocation: OpInvocation): Promise<WorkerResult> => {
      invocations.push(invocation);
      return {
        stopReason,
        structuredOutput: output,
        usage: { inputTokens: 1, outputTokens: 1 },
        denials: [],
      } as unknown as WorkerResult;
    },
  } as unknown as Driver;
  const factory: DriverFactory = {
    resolve: (request) => ({ driver, lane: 'ai-sdk' as const, modelSpec: request.modelSpec }),
  };
  return { factory, invocations };
}

export const PATCH = [
  'diff --git a/src/index.ts b/src/index.ts',
  '--- a/src/index.ts',
  '+++ b/src/index.ts',
  '@@ -1,2 +1,2 @@',
  '-const n: number = "forty-two";',
  '+const n: number = 42;',
  ' export { n };',
  '',
].join('\n');
export const MODEL = { provider: 'zai', model: 'glm-test' };
