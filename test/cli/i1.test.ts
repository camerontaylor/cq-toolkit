// I1 conformance suite — test/cli/i1.test.ts.
//
// The full CLI contract is exercised end-to-end over the pure-op fixture
// family (test/fixtures/cli-ops — DI'd via the {opsRoot} override, never the
// repo's src/ops):
//   1. The I1 stream contract: stdout carries exactly ONE JSON artifact;
//      stderr carries failures-only `cq:` narration (human mode) and stays
//      EMPTY in --json mode.
//   2. Exit codes {0,1,2,3}: the frozen taxonomy maps mechanically
//      (ok→0; failed/indeterminate→1; needs-human/budget-exhausted→3),
//      usage errors (unknown subcommand/flag, positional tokens,
//      schema-invalid input) are CLI-detected → 2, runtime throws → 1.
//   3. run-plan goes through the governed kernel composition: reports parse
//      against RunReportSchema; ALL INPUT defects are usage errors (→2) —
//      a --plan path that is missing or not a regular file, corrupted plan
//      FILE CONTENT, and the kernel's own 'runPlan: ' input class (duplicate
//      job ids, resume without a journal dir) — while genuine RUNTIME throws
//      (a journal-dir pointing at a regular file) narrate 'run-plan threw:'
//      and exit 1. stdout stays empty on every non-artifact path.
//   4. Round-trip parity: invoking the op DIRECTLY through the registry and
//      through the CLI yields byte-identical results.
//   5. The narration contract is LINE-based: narrate() flattens embedded
//      newlines to the literal two-character `\n` escape (one prefixed line
//      always), and the direct-dispatch result-validation gate (CX1) keeps a
//      taxonomy-invalid or non-finite op result off stdout entirely.
// Deterministic throughout: no timers, no network, tmp dirs cleaned up.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { exitCodeForOpResult, exitCodeForRunReport } from '../../src/cli/exit.js';
import { parseFlags, runCli, type RunCliOptions } from '../../src/cli/main.js';
import { narrate, type CliIo } from '../../src/cli/output.js';
import { PlanSchema, RunReportSchema } from '../../src/kernel/schema.js';
import type { OpResult, RunReport } from '../../src/kernel/types.js';
import { get, list } from '../../src/registry/index.js';

const opsRoot = fileURLToPath(new URL('../fixtures/cli-ops/', import.meta.url));

/** One captured CLI run: exit code plus the raw stdout/stderr strings. */
interface CapturedRun {
  code: number;
  out: string;
  err: string;
}

/** Run the CLI over argv with a fake CliIo, returning {code, out, err}. */
async function capture(argv: string[], opts?: RunCliOptions): Promise<CapturedRun> {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const io: CliIo = {
    stdout: (chunk) => outChunks.push(chunk),
    stderr: (chunk) => errChunks.push(chunk),
  };
  const code = await runCli(argv, io, opts);
  return { code, out: outChunks.join(''), err: errChunks.join('') };
}

/** All-six-states counts table, zeros included (frozen RunCounts shape). */
function countsFor(jobs: Array<OpResult<unknown>>): RunReport['counts'] {
  const counts: RunReport['counts'] = {
    queued: 0,
    running: 0,
    blocked: 0,
    done: 0,
    failed: 0,
    'budget-exhausted': 0,
  };
  for (const result of jobs) {
    switch (result.status) {
      case 'ok':
        counts.done += 1;
        break;
      case 'needs-human':
        counts.blocked += 1;
        break;
      case 'budget-exhausted':
        counts['budget-exhausted'] += 1;
        break;
      default:
        counts.failed += 1;
    }
  }
  return counts;
}

/** A minimal valid RunReport over the given row results. */
function reportWith(...results: Array<OpResult<unknown>>): RunReport {
  return {
    runId: 'run-i1-unit',
    stoppedEarly: false,
    counts: countsFor(results),
    jobs: results.map((result, index) => ({ jobId: `j${index}`, op: `op-${index}`, result })),
  };
}

const tmpDirs: string[] = [];

afterEach(async () => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

/** Fresh tmp dir (OS tmpdir — nothing in it needs module resolution), auto-cleaned. */
async function makeTmpDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/**
 * Fresh tmp OPS ROOT under <repo>/node_modules (so a generated registry.js is
 * ESM via the repo's "type":"module" and can bare-import 'zod'), auto-cleaned.
 * Same pattern as test/cli/registry.test.ts.
 */
async function makeTmpOpsRoot(prefix: string): Promise<string> {
  const parent = fileURLToPath(new URL('../../node_modules/', import.meta.url));
  const dir = await mkdtemp(join(parent, prefix));
  tmpDirs.push(dir);
  return dir;
}

/** Write a plan file (and journal dir path) into a fresh tmp dir. */
async function writePlanFile(plan: unknown): Promise<{ dir: string; planPath: string; journalDir: string }> {
  const dir = await makeTmpDir('cq-i1-plan-');
  const planPath = join(dir, 'plan.json');
  await writeFile(planPath, typeof plan === 'string' ? plan : JSON.stringify(plan));
  return { dir, planPath, journalDir: join(dir, 'journal') };
}

/** One single-job plan over the fixture ops. */
function singleJobPlan(op: string): unknown {
  return { id: 'i1-plan', jobs: [{ id: 'a', op, input: op === 'echo' ? { msg: 'hi' } : {} }] };
}

describe('op subcommands (I1 stream + exit-code contract)', () => {
  test('pure op, ok: one JSON artifact on stdout, silent stderr, exit 0', async () => {
    const { code, out, err } = await capture(['echo', '--msg=hello'], { opsRoot });
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({ status: 'ok', value: { echo: 'hello' } });
    expect(err).toBe(''); // failures-only narration: ok rows are silent
  });

  test('taxonomy → exit codes: failed/indeterminate → 1, needs-human/budget → 3', async () => {
    const cases = [
      { name: 'boom', status: 'failed', code: 1 },
      { name: 'indet', status: 'indeterminate', code: 1 },
      { name: 'needshuman', status: 'needs-human', code: 3 },
      { name: 'budget', status: 'budget-exhausted', code: 3 },
    ] as const;
    for (const c of cases) {
      const { code, out, err } = await capture([c.name], { opsRoot });
      expect(code).toBe(c.code);
      expect(JSON.parse(out).status).toBe(c.status);
      // Human-mode narration: one `cq: <name>: <status> — <detail>` line.
      expect(err).toContain(`cq: ${c.name}: ${c.status} — `);
    }
  });

  test('--json mode: narration suppressed (stderr empty), artifact unchanged, exit 1 on failed', async () => {
    const { code, out, err } = await capture(['boom', '--json'], { opsRoot });
    expect(code).toBe(1);
    expect(err).toBe(''); // machine mode: stderr stays EMPTY
    expect(JSON.parse(out).status).toBe('failed');
  });

  test('unknown subcommand: exit 2, no stdout, narrated to stderr', async () => {
    const { code, out, err } = await capture(['no-such-op'], { opsRoot });
    expect(code).toBe(2);
    expect(out).toBe('');
    expect(err).toMatch(/unknown subcommand/);
  });

  test('unknown flag and positional tokens: exit 2, stdout empty', async () => {
    // echo's schema is .strict(): an unrecognized key is schema-invalid input → 2.
    const flagged = await capture(['echo', '--msg=x', '--nope=1'], { opsRoot });
    expect(flagged.code).toBe(2);
    expect(flagged.out).toBe('');
    // A positional (non-flag) token is a usage error the CLI detects itself → 2.
    const positional = await capture(['echo', 'positional'], { opsRoot });
    expect(positional.code).toBe(2);
    expect(positional.out).toBe('');
  });

  test('missing required field: exit 2 (no op ever ran)', async () => {
    const { code, out, err } = await capture(['echo'], { opsRoot }); // no --msg
    expect(code).toBe(2);
    expect(out).toBe('');
    expect(err).toMatch(/invalid input for 'echo'/);
  });

  test('global --help lists subcommands incl. run-plan; exits 0', async () => {
    const { code, out } = await capture(['--help'], { opsRoot });
    expect(code).toBe(0);
    expect(out).toContain('run-plan');
  });

  test('op subcommand --help renders the exact schema keys plus the reserved --json/--help flags', async () => {
    const { code, out } = await capture(['echo', '--help'], { opsRoot });
    expect(code).toBe(0);
    expect(out).toContain('--msg=');
    // --json is accepted for EVERY subcommand (it drives narration mode) and
    // is listed in op help alongside --help (PR 64 r1 fix).
    expect(out).toContain('--json');
    expect(out).toContain('--help');
  });

  test('--ops-root on an OP subcommand: reserved run-plan flag → exit 2, stdout empty', async () => {
    // Op inputs own their schema keys — no hidden flag collision: the flag is
    // rejected as a usage error BEFORE input validation, whatever the schema.
    const { code, out, err } = await capture(['echo', '--msg=x', '--ops-root=/tmp/whatever'], { opsRoot });
    expect(code).toBe(2);
    expect(out).toBe('');
    expect(err).toMatch(/--ops-root is a run-plan flag/);
  });

  test('run-plan --help renders kebab-case canonical flag forms', async () => {
    const { code, out } = await capture(['run-plan', '--help'], { opsRoot });
    expect(code).toBe(0);
    expect(out).toContain('--plan=');
    expect(out).toContain('--ops-root=');
  });
});

describe('result-validation gate (CX1) — no artifact for an invalid op result', () => {
  test('garbage: a taxonomy-invalid verdict (status nope) → exit 1, stdout EMPTY', async () => {
    // Ops load from RUNTIME registries where TypeScript's return type is no
    // guarantee: the direct-dispatch path validates the returned value with
    // OpResultSchema BEFORE any stdout artifact or exit-code derivation.
    const { code, out, err } = await capture(['garbage'], { opsRoot });
    expect(code).toBe(1);
    expect(out).toBe(''); // the invalid result never became an artifact
    expect(err).toMatch(/garbage returned an invalid result/);
    expect(err).toMatch(/status/); // the zod issue names the offending path
  });

  test('non-finite number in an otherwise-valid result → exit 1, stdout empty', async () => {
    // The JSON-losslessness probe (the runner's pre-journal check) applied on
    // the direct path: {status:'ok', value:{x: Infinity}} passes the schema
    // but cannot survive serialization, so it must never reach stdout.
    const tmp = await makeTmpOpsRoot('cq-i1-inf-');
    await mkdir(join(tmp, 'inf'), { recursive: true });
    await writeFile(
      join(tmp, 'inf', 'registry.js'),
      [
        "import { z } from 'zod';",
        'export const registry = [',
        "  { name: 'inf', inputSchema: z.object({}).strict(), importer: async () => async () => ({ status: 'ok', value: { x: Infinity } }) },",
        '];',
        '',
      ].join('\n'),
    );
    const { code, out, err } = await capture(['inf'], { opsRoot: tmp });
    expect(code).toBe(1);
    expect(out).toBe('');
    expect(err).toMatch(/inf returned an invalid result/);
    expect(err).toMatch(/non-finite number/);
  });
});

describe('line-based narration (embedded newlines flatten to the literal escape)', () => {
  test('narrate: one call is exactly ONE `cq:` line, newlines flattened to literal \\n', () => {
    const errChunks: string[] = [];
    const io: CliIo = { stdout: () => {}, stderr: (chunk) => errChunks.push(chunk) };
    narrate(io, 'line1\nline2');
    // The two-character escape `\n` (backslash + n), not a real newline.
    expect(errChunks.join('')).toBe('cq: line1\\nline2\n');
  });

  test('e2e: the boom two-line error text narrates as ONE stderr line', async () => {
    const { err } = await capture(['boom'], { opsRoot });
    const lines = err.split('\n');
    expect(lines).toHaveLength(2); // exactly one content line + the trailing newline
    expect(lines[1]).toBe('');
    expect(lines[0]).toBe('cq: boom: failed — boom: deliberate fixture failure\\nsecond line of the failure');
  });
});

describe('run-plan through the governed kernel', () => {
  test('happy path: one done job, report parses, human narration counts', async () => {
    const { planPath, journalDir } = await writePlanFile(singleJobPlan('echo'));
    const { code, out, err } = await capture([
      'run-plan',
      `--plan=${planPath}`,
      `--ops-root=${opsRoot}`,
      `--journal-dir=${journalDir}`,
      '--concurrency=1',
    ]);
    expect(code).toBe(0);
    const report = RunReportSchema.parse(JSON.parse(out));
    expect(report.counts.done).toBe(1);
    expect(report.jobs[0]?.result.status).toBe('ok');
    expect(err).toContain('cq: done 1'); // the renderHuman summary line
  });

  test('--json: stderr stays empty, report unchanged', async () => {
    const { planPath } = await writePlanFile(singleJobPlan('echo'));
    const { code, out, err } = await capture([
      'run-plan',
      `--plan=${planPath}`,
      `--ops-root=${opsRoot}`,
      '--json',
    ]);
    expect(code).toBe(0);
    expect(err).toBe('');
    expect(RunReportSchema.parse(JSON.parse(out)).counts.done).toBe(1);
  });

  test('failing job: exit 1 with a failed row, narrated', async () => {
    const { planPath } = await writePlanFile(singleJobPlan('boom'));
    const { code, out, err } = await capture([
      'run-plan',
      `--plan=${planPath}`,
      `--ops-root=${opsRoot}`,
    ]);
    expect(code).toBe(1);
    const report = RunReportSchema.parse(JSON.parse(out));
    expect(report.jobs[0]?.result.status).toBe('failed');
    expect(err).toContain('boom');
  });

  test('needs-human job exits 3; op-returned budget row also exits 3', async () => {
    // needs-human row → 3 (waiting on a human).
    const human = await capture(['run-plan', `--plan=${(await writePlanFile(singleJobPlan('needshuman'))).planPath}`, `--ops-root=${opsRoot}`]);
    expect(human.code).toBe(3);
    expect(RunReportSchema.parse(JSON.parse(human.out)).jobs[0]?.result.status).toBe('needs-human');
    // The budget fixture RETURNS budget-exhausted as its op verdict — an
    // op-returned row, NOT a governor trip (no caps configured, so
    // withBudgetStop annotates nothing); exitCodeForRunReport still maps the
    // row to 3.
    const budget = await capture(['run-plan', `--plan=${(await writePlanFile(singleJobPlan('budget'))).planPath}`, `--ops-root=${opsRoot}`]);
    expect(budget.code).toBe(3);
    expect(RunReportSchema.parse(JSON.parse(budget.out)).jobs[0]?.result.status).toBe('budget-exhausted');
  });

  test('unknown op name in the plan: exit 1 with a failed row', async () => {
    const { planPath } = await writePlanFile(singleJobPlan('no-such-op'));
    const { code, out } = await capture([
      'run-plan',
      `--plan=${planPath}`,
      `--ops-root=${opsRoot}`,
    ]);
    expect(code).toBe(1);
    const report = RunReportSchema.parse(JSON.parse(out));
    expect(report.jobs[0]?.result.status).toBe('failed');
  });

  test('input defects are usage errors (2): corrupt content, missing file, directory path', async () => {
    // Unparseable content = corrupted INPUT → exit 2 (arg-shaped, narrated).
    const corrupt = await writePlanFile('not json');
    const corruptRun = await capture(['run-plan', `--plan=${corrupt.planPath}`, `--ops-root=${opsRoot}`]);
    expect(corruptRun.code).toBe(2);
    expect(corruptRun.out).toBe('');
    expect(corruptRun.err).toMatch(/invalid input for 'run-plan'/);

    // A MISSING plan file is the same input-defect class → 2 (previously a
    // thrown 1 — the stale pin this suite once carried; PR 64 r1 flipped it).
    const dir = await makeTmpDir('cq-i1-missingplan-');
    const missingRun = await capture(['run-plan', `--plan=${join(dir, 'absent.json')}`, `--ops-root=${opsRoot}`]);
    expect(missingRun.code).toBe(2);
    expect(missingRun.out).toBe('');
    expect(missingRun.err).toMatch(/invalid input for 'run-plan'/);
    expect(missingRun.err).toMatch(/not a readable file/);

    // A DIRECTORY where a plan file should be is not a regular file → also an
    // input defect → 2 (the stat gate precedes the read; no EISDIR throw).
    const dirPlan = join(dir, 'plan-dir');
    await mkdir(dirPlan);
    const dirRun = await capture(['run-plan', `--plan=${dirPlan}`, `--ops-root=${opsRoot}`]);
    expect(dirRun.code).toBe(2);
    expect(dirRun.out).toBe('');
    expect(dirRun.err).toMatch(/invalid input for 'run-plan'/);
    expect(dirRun.err).toMatch(/not a readable file/);
  });

  test('duplicate job ids: PlanSchema-valid file, kernel input-class throw → exit 2', async () => {
    // PlanSchema does not cross-validate job ids, so this file parses — the
    // duplicate surfaces in the kernel, whose message starts with 'runPlan: '
    // (the input-validation class) → narrated usage error, stdout empty.
    const dupPlan = {
      id: 'i1-dup',
      jobs: [
        { id: 'same', op: 'echo', input: { msg: 'a' } },
        { id: 'same', op: 'echo', input: { msg: 'b' } },
      ],
    };
    expect(() => PlanSchema.parse(dupPlan)).not.toThrow();
    const { planPath } = await writePlanFile(dupPlan);
    const { code, out, err } = await capture(['run-plan', `--plan=${planPath}`, `--ops-root=${opsRoot}`]);
    expect(code).toBe(2);
    expect(out).toBe('');
    expect(err).toMatch(/invalid input for 'run-plan': runPlan: duplicate job id 'same'/);
  });

  test('--resume without --journal-dir: kernel input-class throw → exit 2', async () => {
    const { planPath } = await writePlanFile(singleJobPlan('echo'));
    const { code, out, err } = await capture([
      'run-plan',
      `--plan=${planPath}`,
      `--ops-root=${opsRoot}`,
      '--resume',
    ]);
    expect(code).toBe(2);
    expect(out).toBe('');
    expect(err).toMatch(/invalid input for 'run-plan': runPlan: resume: true requires journalDir/);
  });

  test('a genuine runtime throw stays 1: --journal-dir pointing at a regular file', async () => {
    // The plan path is fine; the JOURNAL open (mkdir) fails (EEXIST/ENOTDIR)
    // mid-run — not an input defect (no 'runPlan: ' prefix) — so it
    // propagates to main.ts's catch: narrated `run-plan threw: …`, exit 1,
    // stdout empty.
    const { planPath, journalDir } = await writePlanFile(singleJobPlan('echo'));
    await writeFile(journalDir, 'a regular file, not a journal directory');
    const thrown = await capture([
      'run-plan',
      `--plan=${planPath}`,
      `--ops-root=${opsRoot}`,
      `--journal-dir=${journalDir}`,
    ]);
    expect(thrown.code).toBe(1);
    expect(thrown.out).toBe('');
    expect(thrown.err).toMatch(/cq: run-plan threw:/);
  });
});

describe('exit-code unit mapping (mechanical, no interpretation)', () => {
  test('exitCodeForOpResult over all five frozen statuses', () => {
    const cases: Array<[OpResult<unknown>, 0 | 1 | 3]> = [
      [{ status: 'ok', value: null }, 0],
      [{ status: 'failed', error: 'x' }, 1],
      [{ status: 'indeterminate', detail: 'x' }, 1],
      [{ status: 'needs-human', reason: 'x' }, 3],
      [{ status: 'budget-exhausted' }, 3],
    ];
    for (const [result, expected] of cases) {
      expect(exitCodeForOpResult(result)).toBe(expected);
    }
  });

  test('exitCodeForRunReport: all-ok → 0; failed-only → 1', () => {
    expect(exitCodeForRunReport(reportWith({ status: 'ok', value: 1 }, { status: 'ok', value: 2 }))).toBe(0);
    expect(exitCodeForRunReport(reportWith({ status: 'failed', error: 'x' }))).toBe(1);
  });

  test('exitCodeForRunReport: needs-human dominates failed (→ 3)', () => {
    const mixed = reportWith({ status: 'failed', error: 'x' }, { status: 'needs-human', reason: 'y' });
    expect(exitCodeForRunReport(mixed)).toBe(3);
    // …and dominates an UNKNOWN status too — the thrown-class default branch
    // (defense against a taxonomy the CLI predates) never outranks row 3.
    const unknownMixed = reportWith(
      { status: 'nope' } as unknown as OpResult<unknown>,
      { status: 'needs-human', reason: 'y' },
    );
    expect(exitCodeForRunReport(unknownMixed)).toBe(3);
  });

  test('unknown-status defaults: junk never maps as ok (thrown-class → 1)', () => {
    // exitCodeForOpResult's default branch: an out-of-taxonomy status maps
    // like a throw (1), never silently as ok (cast — unreachable for the
    // frozen union, which is exactly why the defense exists).
    expect(exitCodeForOpResult({ status: 'nope' } as unknown as OpResult<unknown>)).toBe(1);
    // exitCodeForRunReport's unknown-status row → 1 as well.
    expect(exitCodeForRunReport(reportWith({ status: 'nope' } as unknown as OpResult<unknown>))).toBe(1);
  });

  test('exitCodeForRunReport: honest budget stop with no such rows → 3', () => {
    const stopped: RunReport = {
      ...reportWith({ status: 'ok', value: null }),
      stoppedEarly: true,
      earlyStopReason: 'budget',
    };
    expect(exitCodeForRunReport(stopped)).toBe(3);
  });
});

describe('flag parsing + round-trip parity', () => {
  test('parseFlags: JSON-parsed values, verbatim keys, positionals, duplicate rejection', () => {
    expect(parseFlags(['--msg=hello'])).toEqual({ flags: { msg: 'hello' }, unknown: [] });
    expect(parseFlags(['--max-usd=2'])).toEqual({ flags: { 'max-usd': 2 }, unknown: [] });
    expect(parseFlags(['--tags=["a","b"]'])).toEqual({ flags: { tags: ['a', 'b'], }, unknown: [] });
    expect(parseFlags(['--flag'])).toEqual({ flags: { flag: true }, unknown: [] });
    expect(parseFlags(['positional'])).toEqual({ flags: {}, unknown: ['positional'] });
    expect(() => parseFlags(['--a=1', '--a=2'])).toThrow(/duplicate flag/);
  });

  test('duplicate flag e2e: usage error (2), stdout empty — op and run-plan alike', async () => {
    // parseFlags rejects duplicate keys as a usage error at the dispatcher
    // level (before any schema or op runs): narrated, exit 2, no artifact.
    const op = await capture(['echo', '--msg=a', '--msg=b'], { opsRoot });
    expect(op.code).toBe(2);
    expect(op.out).toBe('');
    expect(op.err).toMatch(/duplicate flag --msg/);
    const runPlan = await capture(['run-plan', '--plan=p', '--plan=p'], { opsRoot });
    expect(runPlan.code).toBe(2);
    expect(runPlan.out).toBe('');
    expect(runPlan.err).toMatch(/duplicate flag --plan/);
  });

  test('round-trip parity: the op invoked directly and via the CLI agree exactly', async () => {
    // Registry entries cover every op name (invariant the scaffold asserts).
    expect((await list({ opsRoot })).map((entry) => entry.name)).toContain('echo');
    const entry = await get('echo', { opsRoot });
    if (entry === undefined) throw new Error('fixture family: no registry entry named echo');
    const op = await entry.importer();
    const direct: OpResult<unknown> = await op({ msg: 'hello' });

    const viaCli = await capture(['echo', '--msg=hello'], { opsRoot });
    expect(viaCli.code).toBe(0);
    const cliResult: unknown = JSON.parse(viaCli.out);
    // The echo fixture op is deterministic — the two results must be
    // byte-identical JSON (status equal, value deep-equal, nothing modulo).
    expect(cliResult).toEqual(direct);
    expect(JSON.stringify(cliResult)).toBe(JSON.stringify(direct));
  });
});

// PlanSchema is the kernel-side plan file contract runPlanCommand enforces;
// pin the fixture plans used above against it.
describe('plan file schema', () => {
  test('the fixture plan shape parses against PlanSchema', () => {
    const plan = PlanSchema.parse(singleJobPlan('echo'));
    expect(plan.id).toBe('i1-plan');
    expect(plan.jobs).toHaveLength(1);
  });
});
