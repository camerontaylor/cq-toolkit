// T4.2 I1 conformance suite — test/cli/conformance.test.ts.
//
// The deliverable's sample: a PURE op, an AGENTIC-class op and a PLAN, each
// through the REAL dispatcher (runCli over the repo's own registry), plus the
// full result-taxonomy → exit-code matrix over the hermetic fixture family.
// Pinned for every invocation:
//   - stdout parses as JSON (the ONE artifact per invocation);
//   - human narration touches stderr only (stdout never carries a `cq:` line);
//   - `--json` keeps stderr EMPTY (machine mode);
//   - each frozen taxonomy value maps to its exit code
//     (ok→0; failed/indeterminate→1; needs-human/budget-exhausted→3), and an
//     invalid op result (a status outside the frozen five) is exit 1 with an
//     EMPTY stdout (no artifact ever existed).
//
// Hermetic throughout: the AGENTIC sample is `sweep.unit` with no driver/check
// config — the binding refusal fires BEFORE any spawn — and the plan runs two
// fixture ops (test/fixtures/cli-ops) through the governed kernel, so no
// network, model, or real filesystem target is touched. Deterministic: tmp
// dirs only, cleaned up.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { runCli } from '../../src/cli/main.js';
import type { CliIo } from '../../src/cli/output.js';

const fixtureOps = fileURLToPath(new URL('../fixtures/cli-ops/', import.meta.url));

interface CapturedRun {
  code: number;
  out: string;
  err: string;
}

/** Run the CLI over argv with a fake CliIo, returning {code, out, err}. */
async function capture(argv: string[], opts?: { opsRoot?: string }): Promise<CapturedRun> {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const io: CliIo = {
    stdout: (chunk) => outChunks.push(chunk),
    stderr: (chunk) => errChunks.push(chunk),
  };
  const code = await runCli(argv, io, opts);
  return { code, out: outChunks.join(''), err: errChunks.join('') };
}

const tmpDirs: string[] = [];
afterEach(async () => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

describe('taxonomy → exit code + I1 streams (fixture family)', () => {
  const cases = [
    { argv: ['echo', '--msg=hi'], status: 'ok', code: 0 },
    { argv: ['boom'], status: 'failed', code: 1 },
    { argv: ['indet'], status: 'indeterminate', code: 1 },
    { argv: ['needshuman'], status: 'needs-human', code: 3 },
    { argv: ['budget'], status: 'budget-exhausted', code: 3 },
  ] as const;

  test.each(cases)('$status → exit $code', async ({ argv, status, code }) => {
    const { code: actual, out, err } = await capture([...argv], { opsRoot: fixtureOps });
    expect(actual).toBe(code);
    const parsed: unknown = JSON.parse(out);
    expect(parsed).toMatchObject({ status });
    // Narration is stderr-only and failures-only.
    if (status !== 'ok') {
      expect(err).toContain(`cq: ${argv[0]}: ${status}`);
    } else {
      expect(err).toBe('');
    }
    expect(out).not.toContain('cq:');
  });

  test('an invalid op result never reaches stdout: exit 1, empty stdout', async () => {
    const { code, out, err } = await capture(['garbage'], { opsRoot: fixtureOps });
    expect(code).toBe(1);
    expect(out).toBe('');
    expect(err).toMatch(/invalid result/);
  });

  test('--json suppresses narration (stderr empty) while keeping the artifact', async () => {
    const { code, out, err } = await capture(['boom', '--json'], { opsRoot: fixtureOps });
    expect(code).toBe(1);
    expect(err).toBe('');
    expect(JSON.parse(out)).toMatchObject({ status: 'failed' });
  });

  test('usage errors are exit 2 with EMPTY stdout (unknown subcommand and schema-invalid input)', async () => {
    const unknown = await capture(['no-such-op'], { opsRoot: fixtureOps });
    expect(unknown.code).toBe(2);
    expect(unknown.out).toBe('');
    expect(unknown.err).toMatch(/unknown subcommand/);

    // Schema-invalid input (missing required field) → exit 2, no op ran.
    const missing = await capture(['echo'], { opsRoot: fixtureOps });
    expect(missing.code).toBe(2);
    expect(missing.out).toBe('');
    expect(missing.err).toMatch(/invalid input for 'echo'/);

    // The REAL registry's strict schema: an object-typed field handed a
    // non-object fails the same way (exit 2, empty stdout).
    const real = await capture(['gates.regressionGate', '--base=not-an-object']);
    expect(real.code).toBe(2);
    expect(real.out).toBe('');
    expect(real.err).toMatch(/invalid input for 'gates.regressionGate'/);
  });
});

describe('sample: pure op through the real registry', () => {
  test('gates.regressionGate: JSON stdout, silent stderr, exit 0', async () => {
    const empty = '{"tool":"tsc","failures":[],"exitCode":0}';
    const { code, out, err } = await capture([
      'gates.regressionGate',
      `--base=${empty}`,
      `--final=${empty}`,
    ]);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toMatchObject({
      status: 'ok',
      value: { verdict: 'no-regression' },
    });
    expect(err).toBe(''); // ok rows are silent in human mode
  });

  test('an indeterminate pure result narrates on stderr and exits 1', async () => {
    // An unobservable exit code (null) is I5 non-passing evidence → indeterminate.
    const { code, out, err } = await capture([
      'gates.regressionGate',
      '--base={"tool":"tsc","failures":[],"exitCode":null}',
      '--final={"tool":"tsc","failures":[],"exitCode":0}',
    ]);
    expect(code).toBe(1);
    expect(JSON.parse(out)).toMatchObject({ status: 'indeterminate' });
    expect(err).toContain('cq: gates.regressionGate: indeterminate');
  });
});

describe('sample: agentic-class op through the real registry', () => {
  test('sweep.unit without a driver config fails honestly before any spawn', async () => {
    const { code, out, err } = await capture([
      'sweep.unit',
      '--repoRoot=/nonexistent/conformance-repo',
      '--worktreesDir=/nonexistent/conformance-wt',
      '--runPrefix=cq/conformance',
      '--base=origin/main',
      '--package=pkg',
      '--fixer=fixer',
      '--files=["a.ts"]',
    ]);
    expect(code).toBe(1);
    expect(JSON.parse(out)).toMatchObject({ status: 'failed' });
    expect(err).toContain('cq: sweep.unit: failed');
    expect(out).not.toContain('cq:');
  });
});

describe('sample: plan through the governed kernel', () => {
  test('run-plan over the fixture ops yields a RunReport artifact + stderr narration', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cq-conformance-plan-'));
    tmpDirs.push(dir);
    const planPath = join(dir, 'plan.json');
    await writeFile(
      planPath,
      JSON.stringify({
        id: 'conformance-plan',
        jobs: [{ id: 'a', op: 'echo', input: { msg: 'hi' } }],
      }),
      'utf8',
    );
    const { code, out, err } = await capture([
      'run-plan',
      `--plan=${planPath}`,
      `--ops-root=${fixtureOps}`,
    ]);
    expect(code).toBe(0);
    const report = JSON.parse(out) as { runId: string; stoppedEarly: boolean; jobs: unknown[] };
    // The kernel decorates the plan id into a unique run id — assert the
    // prefix, not the volatile suffix.
    expect(report.runId.startsWith('conformance-plan')).toBe(true);
    expect(report.stoppedEarly).toBe(false);
    expect(report).toHaveProperty('jobs.0.result.status', 'ok');
    // The counts summary always reaches stderr (failures-only rows + summary).
    expect(err).toContain('cq: done 1');
  });

  test('run-plan --json keeps stderr empty', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cq-conformance-plan-json-'));
    tmpDirs.push(dir);
    const planPath = join(dir, 'plan.json');
    await writeFile(
      planPath,
      JSON.stringify({
        id: 'conformance-plan-json',
        jobs: [{ id: 'a', op: 'echo', input: { msg: 'hi' } }],
      }),
      'utf8',
    );
    const { code, out, err } = await capture([
      'run-plan',
      `--plan=${planPath}`,
      `--ops-root=${fixtureOps}`,
      '--json',
    ]);
    expect(code).toBe(0);
    expect(err).toBe('');
    expect(JSON.parse(out)).toHaveProperty('jobs.0.result.status', 'ok');
  });
});
