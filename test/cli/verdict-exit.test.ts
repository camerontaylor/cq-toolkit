// Lane E — `--fail-on-verdict`: the opt-in exit-code mapping for an `ok`
// result whose value carries `verdict: 'fail'` (a regression gate's "the op
// ran" vs "the gate passed"). Hermetic: the fixture family under
// test/fixtures/cli-verdict-ops plus tmp plan registries.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { exitCodeForOpResult, exitCodeForRunReport, hasFailVerdict } from '../../src/cli/exit.js';
import { runCli } from '../../src/cli/main.js';
import type { CliIo } from '../../src/cli/output.js';
import type { RunReport } from '../../src/kernel/types.js';

const opsRoot = fileURLToPath(new URL('../fixtures/cli-verdict-ops/', import.meta.url));

interface Captured {
  code: number;
  out: string;
  err: string;
}

async function capture(
  argv: string[],
  opts?: { opsRoot?: string; plansRoot?: string },
): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { stdout: (c) => out.push(c), stderr: (c) => err.push(c) };
  const code = await runCli(argv, io, { opsRoot, ...opts });
  return { code, out: out.join(''), err: err.join('') };
}

/** The per-job results of a RunReport artifact (runId and timings differ per run). */
function jobResults(out: string): unknown[] {
  return (JSON.parse(out) as { jobs: { result: unknown }[] }).jobs.map((job) => job.result);
}

const tmpDirs: string[] = [];
afterEach(async () => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

async function tmpDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

describe('exit.ts mapping (mechanical)', () => {
  test('hasFailVerdict: only an object whose verdict is exactly the string "fail"', () => {
    expect(hasFailVerdict({ verdict: 'fail' })).toBe(true);
    expect(hasFailVerdict({ verdict: 'pass' })).toBe(false);
    expect(hasFailVerdict({ verdict: 'FAIL' })).toBe(false);
    expect(hasFailVerdict({ verdict: false })).toBe(false);
    expect(hasFailVerdict({})).toBe(false);
    expect(hasFailVerdict('fail')).toBe(false);
    expect(hasFailVerdict(null)).toBe(false);
    expect(hasFailVerdict(undefined)).toBe(false);
  });

  test('exitCodeForOpResult: the flag only upgrades ok+fail-verdict to 1', () => {
    const failing = { status: 'ok', value: { verdict: 'fail' } } as const;
    expect(exitCodeForOpResult(failing)).toBe(0);
    expect(exitCodeForOpResult(failing, {})).toBe(0);
    expect(exitCodeForOpResult(failing, { failOnVerdict: false })).toBe(0);
    expect(exitCodeForOpResult(failing, { failOnVerdict: true })).toBe(1);
    expect(
      exitCodeForOpResult({ status: 'ok', value: { verdict: 'pass' } }, { failOnVerdict: true }),
    ).toBe(0);
    // Non-ok statuses are untouched by the flag.
    expect(exitCodeForOpResult({ status: 'failed', error: 'x' }, { failOnVerdict: true })).toBe(1);
    expect(
      exitCodeForOpResult({ status: 'needs-human', reason: 'x' }, { failOnVerdict: true }),
    ).toBe(3);
  });

  test('exitCodeForRunReport: needs-human (3) and failed (1) rows dominate the verdict upgrade', () => {
    const report = (results: RunReport['jobs'][number]['result'][]): RunReport =>
      ({
        planId: 'p',
        runId: 'r',
        stoppedEarly: false,
        counts: {},
        jobs: results.map((result, i) => ({ jobId: `j${String(i)}`, op: 'o', result })),
      }) as unknown as RunReport;
    const failing = { status: 'ok', value: { verdict: 'fail' } } as const;
    const fine = { status: 'ok', value: { verdict: 'pass' } } as const;
    expect(exitCodeForRunReport(report([fine, failing]))).toBe(0);
    expect(exitCodeForRunReport(report([fine, failing]), { failOnVerdict: true })).toBe(1);
    expect(exitCodeForRunReport(report([fine, fine]), { failOnVerdict: true })).toBe(0);
    expect(
      exitCodeForRunReport(report([failing, { status: 'needs-human', reason: 'x' }]), {
        failOnVerdict: true,
      }),
    ).toBe(3);
  });
});

describe('op subcommands: --fail-on-verdict', () => {
  test('verdict fail: exit 0 without the flag, exit 1 with it; the artifact is identical', async () => {
    const plain = await capture(['verdictfail', '--json']);
    const gated = await capture(['verdictfail', '--json', '--fail-on-verdict']);
    expect(plain.code).toBe(0);
    expect(gated.code).toBe(1);
    expect(gated.out).toBe(plain.out);
    expect(JSON.parse(gated.out)).toEqual({ status: 'ok', value: { verdict: 'fail', n: 1 } });
    expect(plain.err).toBe('');
    expect(gated.err).toBe('');
  });

  test('flag order does not matter and human mode stays failures-only silent for an ok status', async () => {
    const { code, out, err } = await capture(['verdictfail', '--fail-on-verdict']);
    expect(code).toBe(1);
    expect(JSON.parse(out)).toMatchObject({ status: 'ok' });
    expect(err).toBe('');
  });

  test.each(['verdictpass', 'verdictnone', 'verdictcase', 'verdictscalar', 'verdictnested'])(
    '%s: not a failing verdict → exit 0 even with the flag',
    async (op) => {
      const { code, out } = await capture([op, '--fail-on-verdict', '--json']);
      expect(code).toBe(0);
      expect(JSON.parse(out)).toMatchObject({ status: 'ok' });
    },
  );

  test('a non-ok status keeps its mapping with the flag (failed → 1)', async () => {
    const { code } = await capture(['failedverdict', '--fail-on-verdict', '--json']);
    expect(code).toBe(1);
  });

  test('the flag never reaches op input (a strict schema would otherwise reject it)', async () => {
    const { code, out } = await capture(['verdictpass', '--fail-on-verdict']);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({ status: 'ok', value: { verdict: 'pass' } });
  });

  test.each(['--fail-on-verdict=true', '--fail-on-verdict=x', '--fail-on-verdict=false'])(
    'valued spelling %s is a usage error (exit 2), like the other reserved flags',
    async (spelling) => {
      const human = await capture(['verdictfail', spelling]);
      expect(human.code).toBe(2);
      expect(human.out).toBe('');
      expect(human.err).toMatch(/--fail-on-verdict is a reserved CLI flag/);

      const machine = await capture(['verdictfail', spelling, '--json']);
      expect(machine.code).toBe(2);
      expect(machine.err).toBe('');
      expect(JSON.parse(machine.out)).toMatchObject({
        error: { kind: 'usage', subcommand: 'verdictfail', exitCode: 2 },
      });
    },
  );

  test('--help lists --fail-on-verdict', async () => {
    const { code, out } = await capture(['verdictfail', '--help']);
    expect(code).toBe(0);
    expect(out).toContain('--fail-on-verdict');
  });
});

describe('run-plan and plan subcommands: --fail-on-verdict', () => {
  async function planFile(ops: string[]): Promise<string> {
    const dir = await tmpDir('cq-verdict-plan-');
    const path = join(dir, 'plan.json');
    await writeFile(
      path,
      JSON.stringify({
        id: 'verdict-plan',
        jobs: ops.map((op, i) => ({ id: `j${String(i)}`, op, input: {} })),
      }),
    );
    return path;
  }

  test('run-plan: any ok row with verdict fail → exit 1 with the flag, 0 without', async () => {
    const plan = await planFile(['verdictpass', 'verdictfail']);
    const plain = await capture(['run-plan', `--plan=${plan}`, '--json']);
    const gated = await capture(['run-plan', `--plan=${plan}`, '--json', '--fail-on-verdict']);
    expect(plain.code).toBe(0);
    expect(gated.code).toBe(1);
    expect(jobResults(gated.out)).toEqual(jobResults(plain.out)); // same artifact modulo runId
    expect(jobResults(gated.out)).toHaveLength(2);
    expect(gated.err).toBe('');
  });

  test('run-plan: all rows pass/absent → exit 0 with the flag', async () => {
    const plan = await planFile(['verdictpass', 'verdictnone']);
    const { code } = await capture(['run-plan', `--plan=${plan}`, '--fail-on-verdict']);
    expect(code).toBe(0);
  });

  test('run-plan: valued spelling is a usage error', async () => {
    const plan = await planFile(['verdictpass']);
    const { code, out, err } = await capture(['run-plan', `--plan=${plan}`, '--fail-on-verdict=1']);
    expect(code).toBe(2);
    expect(out).toBe('');
    expect(err).toMatch(/--fail-on-verdict is a reserved CLI flag/);
  });

  test('plan subcommand: the flag is accepted and maps rows the same way', async () => {
    const dir = await tmpDir('cq-verdict-plans-');
    await writeFile(join(dir, 'package.json'), '{"type":"module"}\n');
    await writeFile(
      join(dir, 'gatefloor.js'),
      "export const plan = { name: 'gatefloor', importer: async () => ({ id: 'gatefloor', jobs: [{ id: 'a', op: 'verdictfail', input: {} }] }) };\n",
    );
    const plain = await capture(['gatefloor', '--json'], { plansRoot: dir });
    const gated = await capture(['gatefloor', '--json', '--fail-on-verdict'], { plansRoot: dir });
    expect(plain.code).toBe(0);
    expect(gated.code).toBe(1);
    expect(jobResults(gated.out)).toEqual(jobResults(plain.out));
    expect(gated.err).toBe('');
    const valued = await capture(['gatefloor', '--fail-on-verdict=x'], { plansRoot: dir });
    expect(valued.code).toBe(2);
  });
});
