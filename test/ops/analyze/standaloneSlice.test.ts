// Lane C — THE STANDALONE SLICE, end to end on a fresh fixture repository:
//
//   analyze.init → cq.json (its tsc command pointed at THIS repo's real
//   node_modules/.bin/tsc) → commit → analyze.run (REAL tsc) → one TS2322
//   cluster → analyze.fix preview (one planned edit, nothing written) →
//   analyze.fix --apply (attended approval) → the file changes and the
//   recheck (REAL tsc again) reports 1 → 0.
//
// Every op is resolved through the REGISTRY (the same entries the CLI
// dispatches). The ast-grep scan runs on the REAL binary when one is on PATH
// and on a scripted runner (the engine's documented wire shape, computed from
// the same bytes) otherwise — the compiler is always real.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import type { Op } from '../../../src/kernel/types.js';
import type { CheckCommand, RunCheck } from '../../../src/ops/gates/checkRunner.js';
import { subprocessRunCheck } from '../../../src/ops/gates/checkRunner.js';
import type { AnalyzeFixInput, AnalyzeFixReport } from '../../../src/ops/analyze/fix.js';
import { makeAnalyzeFix } from '../../../src/ops/analyze/fix.js';
import type { AnalyzeInitInput, AnalyzeInitReport } from '../../../src/ops/analyze/init.js';
import { registry } from '../../../src/ops/analyze/registry.js';
import type { AnalyzeRunInput, AnalyzeRunReport } from '../../../src/ops/analyze/run.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TSC = join(REPO_ROOT, 'node_modules', '.bin', 'tsc');
const AST_GREP_AVAILABLE = spawnSync('ast-grep', ['--version'], { stdio: 'ignore' }).status === 0;

const RULE = [
  'id: forty-two',
  'language: TypeScript',
  'rule:',
  '  pattern: \'"forty-two"\'',
  "fix: '42'",
].join('\n');

/** Resolve an op through the analyze registry entry, validating input like the CLI. */
async function viaRegistry<I, R>(name: string): Promise<(input: I) => ReturnType<Op<I, R>>> {
  const entry = registry.find((candidate) => candidate.name === name);
  if (entry === undefined) throw new Error(`${name} is not registered`);
  const op = (await entry.importer()) as Op<unknown, R>;
  return async (input: I) => op(await entry.inputSchema.parseAsync(input));
}

/** Scripted ast-grep (the engine's wire shape); everything else runs for real. */
const scriptedAstGrep: RunCheck = async (cmd: CheckCommand) => {
  if (cmd.command !== 'ast-grep') return subprocessRunCheck(cmd);
  const separator = cmd.args.indexOf('--');
  const matches: object[] = [];
  for (const file of cmd.args.slice(separator + 1)) {
    const bytes = readFileSync(join(cmd.cwd ?? '.', file));
    const index = bytes.indexOf(Buffer.from('"forty-two"', 'utf8'));
    if (index !== -1) {
      matches.push({
        file,
        replacement: '42',
        replacementOffsets: { start: index, end: index + '"forty-two"'.length },
      });
    }
  }
  return { stdout: JSON.stringify(matches), stderr: '', exitCode: 0 };
};

async function standaloneSlice(mode: 'real' | 'scripted'): Promise<void> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cq-standalone-')));
  const git = (args: string[]) =>
    execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  try {
    git(['init', '-q']);
    git(['config', 'user.email', 'standalone@example.invalid']);
    git(['config', 'user.name', 'standalone test']);
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'index.ts'), 'const n: number = "forty-two";\nexport { n };\n');
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, target: 'es2022', types: [] },
        include: ['src'],
      }),
    );

    // init: detection writes the tsc check; point it at this repo's tsc.
    const init = await viaRegistry<AnalyzeInitInput, AnalyzeInitReport>('analyze.init');
    const initialized = await init({ dir });
    expect(initialized.status).toBe('ok');
    if (initialized.status !== 'ok') return;
    expect(initialized.value.config.checks.map((check) => check.adapter)).toEqual(['tsc-lines']);
    const config = initialized.value.config;
    const tscCheck = config.checks[0];
    if (tscCheck === undefined) throw new Error('no tsc check written');
    tscCheck.command.command = TSC;
    writeFileSync(join(dir, 'cq.json'), `${JSON.stringify(config, null, 2)}\n`);
    git(['add', '.']);
    git(['commit', '-q', '-m', 'fixture']);

    // run: the real compiler, real dataflow → one TS2322 cluster.
    const run = await viaRegistry<AnalyzeRunInput, AnalyzeRunReport>('analyze.run');
    const analysis = await run({ dir });
    expect(analysis.status, JSON.stringify(analysis)).toBe('ok');
    if (analysis.status !== 'ok') return;
    expect(analysis.value.failureCount).toBe(1);
    expect(analysis.value.clusters).toHaveLength(1);
    const cluster = analysis.value.clusters[0];
    expect(cluster?.ruleId).toBe('TS2322');
    expect(cluster?.files).toEqual(['src/index.ts']);
    const clusterId = cluster?.id ?? '';

    // fix: preview (nothing written), then the attended apply + recheck.
    const fix =
      mode === 'real'
        ? await viaRegistry<AnalyzeFixInput, AnalyzeFixReport>('analyze.fix')
        : makeAnalyzeFix({ run: scriptedAstGrep });
    const preview = await fix({ dir, clusterId, rule: RULE });
    expect(preview.status, JSON.stringify(preview)).toBe('ok');
    if (preview.status !== 'ok') return;
    expect(preview.value.mode).toBe('preview');
    expect(
      preview.value.preview.kind === 'cluster-codemod' && preview.value.preview.plannedEdits,
    ).toBe(1);
    expect(readFileSync(join(dir, 'src', 'index.ts'), 'utf8')).toContain('"forty-two"');

    const applied = await fix({
      dir,
      clusterId,
      rule: RULE,
      apply: true,
      previewDigest: preview.value.preview.digest,
    });
    expect(applied.status, JSON.stringify(applied)).toBe('ok');
    if (applied.status !== 'ok') return;
    expect(applied.value.mode).toBe('applied');
    expect(readFileSync(join(dir, 'src', 'index.ts'), 'utf8')).toBe(
      'const n: number = 42;\nexport { n };\n',
    );
    expect(applied.value.recheck).toMatchObject({ before: 1, after: 0, resolved: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('the standalone slice on a fresh repository (init → run → fix → apply → recheck)', () => {
  test('real tsc; scripted ast-grep wire', { timeout: 180_000 }, () => standaloneSlice('scripted'));

  test.runIf(AST_GREP_AVAILABLE)(
    'real tsc; REAL ast-grep binary; every op via the registry',
    { timeout: 180_000 },
    () => standaloneSlice('real'),
  );
});
