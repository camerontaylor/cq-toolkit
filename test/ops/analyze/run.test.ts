// Lane C S2 — `analyze.run`: probe → collect → cluster → report with REAL
// dataflow, over a SCRIPTED check runner (no subprocess). Pinned: checks from
// cq.json or the input, dir-relative failure paths, multi-tool merge, the
// report pair under .cq/analysis (a sidecar the remediation path can parse),
// the honest empty result, and every refusal's taxonomy.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { CheckCommand, RunCheck } from '../../../src/ops/gates/checkRunner.js';
import { parseAnalysisSidecar } from '../../../src/ops/analyze/renderAnalysisReport.js';
import { AnalyzeRunInputSchema } from '../../../src/ops/analyze/registry.js';
import { makeAnalyzeRun, resolveChecks } from '../../../src/ops/analyze/run.js';
import { CheckRunnerInputSchema } from '../../../src/ops/gates/registry.js';

const dirs: string[] = [];
function project(files: Record<string, string>): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cq-run-')));
  dirs.push(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const TSC_CHECK = {
  adapter: 'tsc-lines' as const,
  command: { command: 'node_modules/.bin/tsc', args: ['--noEmit', '--pretty', 'false'], cwd: '.' },
};
const CONFIG = JSON.stringify({ schemaVersion: 2, checks: [TSC_CHECK] });
const TS2322 =
  "src/index.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.\n";

/** A runner answering by adapter-shaped canned output; records every command. */
function scripted(
  answers: Array<{ stdout: string; exitCode: number | null; stderr?: string }>,
): RunCheck & { calls: CheckCommand[] } {
  const calls: CheckCommand[] = [];
  const run = (async (cmd: CheckCommand) => {
    calls.push(cmd);
    const answer = answers[calls.length - 1] ?? { stdout: '', exitCode: 0 };
    return { stdout: answer.stdout, stderr: answer.stderr ?? '', exitCode: answer.exitCode };
  }) as RunCheck & { calls: CheckCommand[] };
  run.calls = calls;
  return run;
}

describe('analyze.run — the dataflow', () => {
  test('cq.json check → one TS2322 cluster; report pair under .cq/analysis; sidecar parses', async () => {
    const dir = project({ 'cq.json': CONFIG, 'src/index.ts': 'const n: number = "x";\n' });
    const run = scripted([{ stdout: TS2322, exitCode: 1 }]);
    const result = await makeAnalyzeRun(run)({ dir });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    // The relative command resolves against the check's cwd (= dir).
    expect(run.calls[0]?.command).toBe(join(dir, 'node_modules/.bin/tsc'));
    expect(run.calls[0]?.cwd).toBe(dir);
    expect(result.value.checks).toEqual([
      { adapter: 'tsc-lines', tool: 'tsc', exitCode: 1, failures: 1 },
    ]);
    expect(result.value.failureCount).toBe(1);
    expect(result.value.clusters).toHaveLength(1);
    expect(result.value.clusters[0]).toMatchObject({
      ruleId: 'TS2322',
      tool: 'tsc',
      count: 1,
      confidence: 'low',
      files: ['src/index.ts'],
    });
    expect(result.value.configPath).toBe(join(dir, 'cq.json'));
    expect(result.value.sidecarPath.startsWith(join(dir, '.cq', 'analysis'))).toBe(true);
    expect(result.value.markdownPath.startsWith(join(dir, '.cq', 'analysis'))).toBe(true);
    const sidecar = parseAnalysisSidecar(readFileSync(result.value.sidecarPath, 'utf8'));
    expect(sidecar.reportFingerprint).toBe(result.value.reportFingerprint);
    expect(sidecar.evidence[0]?.targets.map((target) => target.file)).toEqual(['src/index.ts']);
    expect(readFileSync(result.value.markdownPath, 'utf8')).toContain('TS2322');
  });

  test('explicit checks override cq.json; two tools merge; absolute eslint paths become dir-relative', async () => {
    const dir = project({ 'src/index.ts': 'x\n', 'src/b.ts': 'y\n' });
    const eslintOut = JSON.stringify([
      {
        filePath: join(dir, 'src', 'b.ts'),
        messages: [
          { ruleId: 'eqeqeq', severity: 2, message: "Expected '==='", line: 1, column: 3 },
        ],
      },
    ]);
    const run = scripted([
      { stdout: TS2322, exitCode: 1 },
      { stdout: eslintOut, exitCode: 1 },
    ]);
    const result = await makeAnalyzeRun(run)({
      dir,
      checks: [
        TSC_CHECK,
        { adapter: 'eslint-json', command: { command: 'eslint', args: ['-f', 'json', '.'] } },
      ],
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    // A bare command name is left for PATH lookup.
    expect(run.calls[1]?.command).toBe('eslint');
    expect(result.value.failureCount).toBe(2);
    expect(result.value.clusters.map((cluster) => cluster.tool).sort()).toEqual(['eslint', 'tsc']);
    const eslint = result.value.clusters.find((cluster) => cluster.tool === 'eslint');
    expect(eslint?.files).toEqual(['src/b.ts']);
    const ids = result.value.clusters.map((cluster) => cluster.id);
    expect(ids).toEqual([...ids].sort());
    expect(result.value.configPath).toBeUndefined();
  });

  test('a check cwd below dir re-roots the reported paths to dir', async () => {
    const dir = project({ 'pkg/src/index.ts': 'x\n' });
    const run = scripted([{ stdout: TS2322, exitCode: 1 }]);
    const result = await makeAnalyzeRun(run)({
      dir,
      checks: [{ ...TSC_CHECK, command: { ...TSC_CHECK.command, command: 'tsc', cwd: 'pkg' } }],
    });
    expect(result.status === 'ok' && result.value.clusters[0]?.files).toEqual(['pkg/src/index.ts']);
  });

  test('a failure outside dir is counted per check but not clustered; reported as skippedOutsideDir', async () => {
    const dir = project({ 'cq.json': CONFIG, 'src/index.ts': 'x\n' });
    const outside = "../elsewhere/lib.ts(3,1): error TS2304: Cannot find name 'q'.\n" + TS2322;
    const result = await makeAnalyzeRun(scripted([{ stdout: outside, exitCode: 1 }]))({ dir });
    expect(result.status, JSON.stringify(result)).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value.checks[0]?.failures).toBe(2);
    expect(result.value.failureCount).toBe(1);
    expect(result.value.skippedOutsideDir).toBe(1);
    expect(result.value.outsideDirFiles).toEqual([join(dir, '..', 'elsewhere', 'lib.ts')]);
    expect(result.value.clusters.map((cluster) => cluster.ruleId)).toEqual(['TS2322']);
  });

  test('no failures behind exit 0 → honest ok, failureCount 0, an empty report pair', async () => {
    const dir = project({ 'cq.json': CONFIG });
    const result = await makeAnalyzeRun(scripted([{ stdout: '', exitCode: 0 }]))({ dir });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value.failureCount).toBe(0);
    expect(result.value.clusters).toEqual([]);
    expect(parseAnalysisSidecar(readFileSync(result.value.sidecarPath, 'utf8')).report).toEqual({
      clusters: [],
      noise: [],
    });
  });

  test('a custom out inside dir is honored', async () => {
    const dir = project({ 'cq.json': CONFIG, 'src/index.ts': 'x\n' });
    const result = await makeAnalyzeRun(scripted([{ stdout: TS2322, exitCode: 1 }]))({
      dir,
      out: 'reports/cq',
    });
    expect(
      result.status === 'ok' && result.value.sidecarPath.startsWith(join(dir, 'reports', 'cq')),
    ).toBe(true);
  });
});

describe('analyze.run — refusals keep the taxonomy', () => {
  test('v1 names the lossless migration with the project directory and never --force', async () => {
    const text = JSON.stringify({ schemaVersion: 1, checks: [TSC_CHECK] });
    const dir = project({ 'cq.json': text });
    const run = scripted([]);
    const result = await makeAnalyzeRun(run)({ dir });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain(`cq analyze.init --migrate --dir='${dir}'`);
      expect(result.error).not.toContain('--force');
    }
    expect(run.calls).toEqual([]);
    expect(readFileSync(join(dir, 'cq.json'), 'utf8')).toBe(text);
    expect(existsSync(join(dir, '.cq'))).toBe(false);
  });

  test('missing cq.json → failed naming analyze.init; nothing written', async () => {
    const dir = project({ 'src/index.ts': 'x\n' });
    const run = scripted([]);
    const result = await makeAnalyzeRun(run)({ dir });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error).toContain('analyze.init');
    expect(run.calls).toEqual([]);
    expect(existsSync(join(dir, '.cq'))).toBe(false);
  });

  test('invalid cq.json → failed naming the defect and analyze.init --force', async () => {
    const dir = project({
      'cq.json': JSON.stringify({ schemaVersion: 2, checks: [{ adapter: 'ruff' }] }),
    });
    const result = await makeAnalyzeRun(scripted([]))({ dir });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain('cq.json schema');
      expect(result.error).toContain('analyze.init');
    }
  });

  test('an unobservable exit (missing binary) → indeterminate with the PATH hint and stderr', async () => {
    const dir = project({ 'cq.json': CONFIG });
    const result = await makeAnalyzeRun(
      scripted([{ stdout: '', exitCode: null, stderr: 'spawn ENOENT' }]),
    )({
      dir,
    });
    expect(result.status).toBe('indeterminate');
    if (result.status === 'indeterminate') {
      expect(result.detail).toContain('check 1 (tsc-lines');
      expect(result.detail).toContain('on PATH');
      expect(result.detail).toContain('spawn ENOENT');
    }
  });

  test('an empty set behind a non-zero exit is indeterminate, never clean (I5)', async () => {
    const dir = project({ 'cq.json': CONFIG });
    const result = await makeAnalyzeRun(scripted([{ stdout: 'garbage', exitCode: 2 }]))({ dir });
    expect(result.status).toBe('indeterminate');
  });

  test('a runner throw → failed', async () => {
    const dir = project({ 'cq.json': CONFIG });
    const result = await makeAnalyzeRun(async () => {
      throw new Error('boom');
    })({ dir });
    expect(result.status).toBe('failed');
  });

  test('out outside dir (or dir itself) → failed', async () => {
    const dir = project({ 'cq.json': CONFIG });
    for (const out of ['..', '.', '/tmp']) {
      const result = await makeAnalyzeRun(scripted([{ stdout: TS2322, exitCode: 1 }]))({
        dir,
        out,
      });
      expect(result.status, out).toBe('failed');
    }
  });

  test('an out through a symlinked component is refused BEFORE anything is created outside', async () => {
    const dir = project({ 'cq.json': CONFIG });
    const external = realpathSync(mkdtempSync(join(tmpdir(), 'cq-run-external-')));
    dirs.push(external);
    symlinkSync(external, join(dir, 'reports'));
    const result = await makeAnalyzeRun(scripted([{ stdout: TS2322, exitCode: 1 }]))({
      dir,
      out: 'reports/analysis',
    });
    expect(result.status).toBe('failed');
    expect(existsSync(join(external, 'analysis'))).toBe(false);
  });

  test('a missing dir → failed', async () => {
    const result = await makeAnalyzeRun(scripted([]))({
      dir: join(tmpdir(), 'cq-run-missing-xyz'),
    });
    expect(result.status).toBe('failed');
  });

  test('the registry mirror: strict, checks non-empty when given', () => {
    expect(AnalyzeRunInputSchema.safeParse({ dir: '.' }).success).toBe(true);
    expect(AnalyzeRunInputSchema.safeParse({ dir: '.', checks: [] }).success).toBe(false);
    expect(AnalyzeRunInputSchema.safeParse({ dir: '.', checks: [TSC_CHECK] }).success).toBe(true);
    expect(AnalyzeRunInputSchema.safeParse({ dir: '.', bogus: 1 }).success).toBe(false);
  });
});

test('cq.json v2 metadata is not forwarded to the strict checkRunner input', async () => {
  const dir = project({
    'cq.json': JSON.stringify({
      schemaVersion: 2,
      checks: [{ ...TSC_CHECK, kind: 'static', relatedArgs: ['{files}'] }],
      roles: { worker: { provider: 'fixture', model: 'fixture' } },
    }),
  });
  const resolved = resolveChecks(dir, {});
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) return;
  expect(resolved.checks).toHaveLength(1);
  expect(CheckRunnerInputSchema.safeParse(resolved.checks[0]).success).toBe(true);
  expect(resolved.checks[0]).not.toHaveProperty('kind');
  expect(resolved.checks[0]).not.toHaveProperty('relatedArgs');
  const run = scripted([{ stdout: '', exitCode: 0 }]);
  const result = await makeAnalyzeRun(run)({ dir });
  expect(result.status).toBe('ok');
  expect(run.calls).toHaveLength(1);
});
