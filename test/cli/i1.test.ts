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
//      FILE CONTENT, and the kernel's own input-validation class ('runPlan: '
//      — duplicate job ids, resume without a journal dir; 'journal: ' — the
//      runId filename-safety assert on a schema-valid but journal-unsafe plan
//      id, e.g. 'bad/id', under --journal-dir) — while genuine RUNTIME throws
//      (a journal-dir pointing at a regular file) narrate 'run-plan threw:'
//      and exit 1. stdout stays empty on every non-artifact path.
//   4. Round-trip parity: invoking the op DIRECTLY through the registry and
//      through the CLI yields byte-identical results.
//   5. The narration contract is LINE-based: narrate() flattens embedded
//      newlines to the literal two-character `\n` escape (one prefixed line
//      always), and the direct-dispatch result-validation gate (CX1) keeps a
//      taxonomy-invalid or non-finite op result off stdout entirely.
// Deterministic throughout: no timers, no network, tmp dirs cleaned up.
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, test } from 'vitest';
import { exitCodeForOpResult, exitCodeForRunReport } from '../../src/cli/exit.js';
import { parseFlags, runCli, type RunCliOptions } from '../../src/cli/main.js';
import { narrate, type CliIo } from '../../src/cli/output.js';
import { JournalEventSchema, PlanSchema, RunReportSchema } from '../../src/kernel/schema.js';
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

// 4530779 behavior pins: the safeParseAsync input gate (registry schemas may
// carry ASYNC refinements), the full lossless-result probe set on the direct
// path, and the reserved-key valued-flag rejection. Tmp fixture families are
// generated .js under <repo>/node_modules (ESM via "type":"module", zod
// bare-importable) with INLINE importers — the same shape as the inf probe
// above; no nested './op.js' importers are needed here (the fixture family
// pins that convention). The asyncfam schemas carry .strict() because
// registration now enforces it (see the registry strictness gate); the async
// refinement rides the same schema — exactly what the safeParseAsync gate
// pins.
describe('4530779 pins: async-schema gate, lossless-result probes, reserved valued flags', () => {
  test('async-refinement schema ACCEPTED: exit 0 with the artifact (safeParseAsync gate)', async () => {
    // zod 4: a schema carrying an ASYNC refinement throws on a PLAIN
    // safeParse ($ZodAsyncError — 'Encountered Promise during synchronous
    // parse'), so before the gate this dispatch surfaced as a spurious
    // exit-1 'threw:'; the safeParseAsync gate accepts exactly what the
    // runner's parseAsync accepts.
    const tmp = await makeTmpOpsRoot('cq-i1-asyncok-');
    await mkdir(join(tmp, 'asyncfam'), { recursive: true });
    await writeFile(
      join(tmp, 'asyncfam', 'registry.js'),
      [
        "import { z } from 'zod';",
        'export const registry = [',
        "  { name: 'asyncok', inputSchema: z.object({}).strict().refine(async () => true), importer: async () => async () => ({ status: 'ok', value: 'async-ran' }) },",
        '];',
        '',
      ].join('\n'),
    );
    const { code, out, err } = await capture(['asyncok'], { opsRoot: tmp });
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({ status: 'ok', value: 'async-ran' });
    expect(err).toBe('');
  });

  test('async-refinement schema REJECTING: usage error (2) with the flattened message, not a throw', async () => {
    // Same spelling, rejecting refinement: safeParseAsync resolves with a
    // failed check — the narration is the ordinary usage line (issueMessage
    // flattening), stdout stays empty, and the old $ZodAsyncError shape
    // (exit 1 'threw:') stays gone.
    const tmp = await makeTmpOpsRoot('cq-i1-asyncbad-');
    await mkdir(join(tmp, 'asyncfam'), { recursive: true });
    await writeFile(
      join(tmp, 'asyncfam', 'registry.js'),
      [
        "import { z } from 'zod';",
        'export const registry = [',
        "  { name: 'asyncbad', inputSchema: z.object({}).strict().refine(async () => false), importer: async () => async () => ({ status: 'ok', value: 'never-runs' }) },",
        '];',
        '',
      ].join('\n'),
    );
    const { code, out, err } = await capture(['asyncbad'], { opsRoot: tmp });
    expect(code).toBe(2);
    expect(out).toBe('');
    expect(err).toMatch(/invalid input for 'asyncbad': Invalid input/);
    expect(err).not.toMatch(/threw/);
  });

  test('async-refinement schema THROWING: still the usage path (2), and machine mode keeps stderr EMPTY (review-debt #83)', async () => {
    // safeParseAsync can THROW (a refinement/transform that throws is a
    // throw, not issues) — before the schema gate got its own mode-aware
    // try, the escape reached the last-resort 'cq: threw:' narration even
    // under --json, cracking the empty-stderr machine protocol. The throw
    // is still an input-validation fault: usage path, exit 2.
    const tmp = await makeTmpOpsRoot('cq-i1-asyncthrow-');
    await mkdir(join(tmp, 'throwfam'), { recursive: true });
    await writeFile(
      join(tmp, 'throwfam', 'registry.js'),
      [
        "import { z } from 'zod';",
        'export const registry = [',
        "  { name: 'asyncthrow', inputSchema: z.object({}).strict().refine(() => { throw new Error('refinement exploded'); }), importer: async () => async () => ({ status: 'ok', value: 'never-runs' }) },",
        '];',
        '',
      ].join('\n'),
    );
    const human = await capture(['asyncthrow'], { opsRoot: tmp });
    expect(human.code).toBe(2);
    expect(human.out).toBe('');
    expect(human.err).toMatch(/invalid input for 'asyncthrow': schema gate threw — refinement exploded/);
    expect(human.err).not.toMatch(/threw:/); // never the last-resort crash narration
    const machine = await capture(['asyncthrow', '--json'], { opsRoot: tmp });
    expect(machine.code).toBe(2);
    expect(machine.out).toBe('');
    expect(machine.err).toBe(''); // machine mode: stderr stays EMPTY, protocol intact
  });

  test('lossless-result probes: a Map-valued ok result → exit 1, stdout empty, invalid result', async () => {
    // The SILENTLY-lossy class the stringify probe passes (Map stringifies
    // as {}): assertJsonLossless — the runner's mirror walk — must reject it
    // before any artifact is emitted.
    const tmp = await makeTmpOpsRoot('cq-i1-map-');
    await mkdir(join(tmp, 'mapfam'), { recursive: true });
    await writeFile(
      join(tmp, 'mapfam', 'registry.js'),
      [
        "import { z } from 'zod';",
        'export const registry = [',
        "  { name: 'mapresult', inputSchema: z.object({}).strict(), importer: async () => async () => ({ status: 'ok', value: { m: new Map() } }) },",
        '];',
        '',
      ].join('\n'),
    );
    const { code, out, err } = await capture(['mapresult'], { opsRoot: tmp });
    expect(code).toBe(1);
    expect(out).toBe('');
    expect(err).toMatch(/mapresult returned an invalid result/);
    expect(err).toMatch(/non-plain object of type 'Map'/);
  });

  test('lossless-result probes: ok WITHOUT a value → exit 1, stdout empty', async () => {
    // `{ status: 'ok', value: undefined }` is lossy, not absent data: the
    // frozen ok variant REQUIRES its value (the journal's ok-without-value
    // record is rejected on read), so it can never become an artifact either.
    // The EXPLICIT undefined spelling is required for teeth: a MISSING value
    // key is already rejected by OpResultSchema at the schema gate (zod 4
    // treats z.unknown() as presence-required), so only `value: undefined`
    // passes that gate and reaches the dedicated required-value probe
    // (main.ts, "ok result without a 'value'").
    const tmp = await makeTmpOpsRoot('cq-i1-novalue-');
    await mkdir(join(tmp, 'novaluefam'), { recursive: true });
    await writeFile(
      join(tmp, 'novaluefam', 'registry.js'),
      [
        "import { z } from 'zod';",
        'export const registry = [',
        "  { name: 'novalue', inputSchema: z.object({}).strict(), importer: async () => async () => ({ status: 'ok', value: undefined }) },",
        '];',
        '',
      ].join('\n'),
    );
    const { code, out, err } = await capture(['novalue'], { opsRoot: tmp });
    expect(code).toBe(1);
    expect(out).toBe('');
    expect(err).toMatch(/novalue returned an invalid result/);
    // Pin the required-value probe's own message — this exact narration is
    // unreachable through the schema gate, so it IS the proof this test
    // exercised the dedicated check.
    expect(err).toMatch(/ok result without a 'value'/);
  });

  test('reserved key WITH a value (--json=yes) on an op: usage error 2, stdout empty', async () => {
    // A VALUED reserved spelling on an op subcommand would otherwise be
    // silently stripped before the schema sees it (silent input loss for an
    // op declaring the key) — it is rejected outright instead. The BARE
    // spellings keep their mode/help behavior: the '--json mode' pin above
    // (['boom','--json'] → machine mode, stderr empty) already exercises
    // bare --json through this same gate.
    const { code, out, err } = await capture(['echo', '--msg=hi', '--json=yes'], { opsRoot });
    expect(code).toBe(2);
    expect(out).toBe('');
    expect(err).toMatch(/reserved/);
    expect(err).toMatch(/--json is a reserved CLI flag/);
  });

  test('valued reserved flags win over the help/mode branches: ops and run-plan alike (r3 F2)', async () => {
    // The raw-token gate is hoisted ABOVE the per-subcommand help/mode
    // branches: a bare --help on the same invocation no longer shadows a
    // valued reserved spelling, and run-plan no longer silently downgrades
    // --json=yes to human mode — every valued spelling is the same usage
    // error. Bare spellings keep their behavior (the run-plan --help pin
    // above and the '--json mode' pin above cover those).
    const opHelp = await capture(['echo', '--help', '--json=yes'], { opsRoot });
    expect(opHelp.code).toBe(2);
    expect(opHelp.out).toBe(''); // no help artifact — the gate fired first
    expect(opHelp.err).toMatch(/--json is a reserved CLI flag/);
    const runPlanHelp = await capture(['run-plan', '--help', '--json=yes'], { opsRoot });
    expect(runPlanHelp.code).toBe(2);
    expect(runPlanHelp.out).toBe('');
    expect(runPlanHelp.err).toMatch(/--json is a reserved CLI flag/);
    const runPlanValued = await capture(['run-plan', '--plan=p', '--json=yes'], { opsRoot });
    expect(runPlanValued.code).toBe(2);
    expect(runPlanValued.out).toBe('');
    expect(runPlanValued.err).toMatch(/--json is a reserved CLI flag/);
    // ...and a valued --help spelling is rejected too (not just --json).
    const helpValued = await capture(['echo', '--help=x'], { opsRoot });
    expect(helpValued.code).toBe(2);
    expect(helpValued.out).toBe('');
    expect(helpValued.err).toMatch(/--help is a reserved CLI flag/);
    // The '=true' spelling has TEETH the '=x' spelling lacks: JSON-parsed,
    // it makes parsed.flags.help === true, so the help branch WOULD have
    // rendered (exit 0) if the raw-token gate did not precede it.
    const helpValuedTrue = await capture(['echo', '--help=true'], { opsRoot });
    expect(helpValuedTrue.code).toBe(2); // reserved, not the help surface
    expect(helpValuedTrue.out).toBe(''); // no help artifact — the gate precedes help
    expect(helpValuedTrue.err).toMatch(/--help is a reserved CLI flag/);
  });
});

// 4bdffd1 pins — the machine-mode silence matrix (a bare --json resolves the
// NarrationMode right after parsing; from there the exit code carries the
// verdict and BOTH streams behave: stdout stays artifact-or-empty, stderr
// stays EMPTY on every post-parse error path, while usage-class errors that
// precede/outside the mode scope still narrate), the null-prototype flags
// record, URL-escaped registry discovery ('#' mid-path), reserved-schema
// enforcement at registration, and the stat-error classification.
describe('4bdffd1 pins: silence matrix, null-proto flags, URL-escape, reserved schema, stat classification', () => {
  test('machine mode: missing plan + --json → exit 2 with stdout AND stderr EMPTY; human mode narrates', async () => {
    const dir = await makeTmpDir('cq-i1-silent-');
    const missing = join(dir, 'absent.json');
    const json = await capture(['run-plan', `--plan=${missing}`, `--ops-root=${opsRoot}`, '--json']);
    expect(json.code).toBe(2);
    expect(json.out).toBe(''); // no artifact — the run never started
    expect(json.err).toBe(''); // machine mode: the exit code IS the verdict
    // The same defect in human mode keeps the failures-only narration.
    const human = await capture(['run-plan', `--plan=${missing}`, `--ops-root=${opsRoot}`]);
    expect(human.code).toBe(2);
    expect(human.out).toBe('');
    expect(human.err).toMatch(/invalid input for 'run-plan'/);
    expect(human.err).toMatch(/not a readable file/);
  });

  test('machine mode: op input-validation failure + --json → exit 2, stderr empty', async () => {
    const { code, out, err } = await capture(['echo', '--json'], { opsRoot }); // missing required --msg
    expect(code).toBe(2);
    expect(out).toBe('');
    expect(err).toBe(''); // suppressed — the human-mode twin is the 'missing required field' pin above
  });

  test('machine mode: op invalid-result gate (garbage) + --json → exit 1, stderr empty', async () => {
    const { code, out, err } = await capture(['garbage', '--json'], { opsRoot });
    expect(code).toBe(1);
    expect(out).toBe(''); // the invalid result never became an artifact
    expect(err).toBe('');
  });

  test('machine mode: usage-class errors still narrate — unknown subcommand + --json → exit 2 WITH the line', async () => {
    const { code, out, err } = await capture(['no-such-op', '--json'], { opsRoot });
    expect(code).toBe(2);
    expect(out).toBe('');
    expect(err).toMatch(/unknown subcommand 'no-such-op'/);
  });

  test('parseFlags: null-prototype record — --__proto__ lands as an own key, not the inherited accessor', () => {
    const { flags } = parseFlags(['--__proto__={"x":1}', '--real=2']);
    // OWN keys only, in insertion order: the old plain-{} record invoked the
    // inherited __proto__ ACCESSOR (no own property created, prototype
    // polluted instead); Object.create(null) makes every spelling an own
    // data property, keeping the duplicate check and reserved-key strips
    // sound.
    expect(Object.keys(flags)).toEqual(['__proto__', 'real']);
    // No prototype → no inherited truthiness: the reserved strips see
    // exactly what was passed, never phantom help/json keys.
    expect(flags.help).toBeUndefined();
    expect(flags.json).toBeUndefined();
  });

  test('URL-escape: a registry whose ABSOLUTE path contains # imports through the escaped FILE URL', async () => {
    // 4bdffd1: node parses import specifiers with URL semantics, so a '#'
    // mid-path TRUNCATES a raw fs specifier ('#t/...' reads as a fragment —
    // '…/cq#t/ops/fam/registry.js' resolves as '…/cq'); scanOps therefore
    // selects the percent-escaped FILE URL (pathToFileURL) exactly when
    // /[#?%]/ matches the path. This pin exercises BOTH spellings with
    // native node semantics (a child `node -e`, the subprocess-fixture
    // pattern): the raw path must FAIL, the escaped URL — the exact
    // specifier scanOps builds for a '#' path — must import and its inline
    // importer must run.
    //
    // WHY list({opsRoot}) is not the probe: the vitest module runner, which
    // interposes every import in this suite, cannot resolve ANY '#' module
    // id (raw or percent-escaped — the runner's own resolver, not node's),
    // so scanOps' import of a '#' registry fails UNDER THE RUNNER and the
    // absent-family classification silently tolerates it (list() → []);
    // real node — production — has no such limitation. The child process IS
    // real node, so the halves below pin the production behavior the fix
    // ships; the list() assertion at the end only pins scan tolerance (no
    // throw), which holds under both resolvers. Inline importer on purpose
    // (no nested relative importers — the 4530779 file-URL nested-import
    // caveat stays out of the probe).
    const base = await makeTmpOpsRoot('cq-i1-hash-'); // under node_modules → zod resolvable
    const hashedRoot = join(base, '#t', 'ops');
    await mkdir(join(hashedRoot, 'fam'), { recursive: true });
    const registryPath = join(hashedRoot, 'fam', 'registry.js');
    await writeFile(
      registryPath,
      [
        "import { z } from 'zod';",
        'export const registry = [',
        "  { name: 'hashop', inputSchema: z.object({}).strict(), importer: async () => async () => ({ status: 'ok', value: 'from-hash-path' }) },",
        '];',
        '',
      ].join('\n'),
    );
    const execFileAsync = promisify(execFile);
    // (a) RAW fs path: the '#' fragment truncation makes the import fail…
    const rawArgs = [
      '--input-type=module',
      '-e',
      'await import(process.argv[1]);',
      registryPath,
    ];
    await expect(execFileAsync(process.execPath, rawArgs)).rejects.toThrow();
    // (b) …and the ESCAPED FILE URL — the exact specifier form scanOps
    // selects for a '#' path — imports natively: the op resolves and runs.
    const escapedArgs = [
      '--input-type=module',
      '-e',
      [
        'const mod = await import(process.argv[1]);',
        'const entry = mod.registry[0];',
        "if (entry.name !== 'hashop') throw new Error('wrong op: ' + entry.name);",
        'const op = await entry.importer();',
        "console.log(JSON.stringify(await op({})));",
      ].join('\n'),
      pathToFileURL(registryPath).href,
    ];
    const { stdout } = await execFileAsync(process.execPath, escapedArgs);
    expect(JSON.parse(stdout)).toEqual({ status: 'ok', value: 'from-hash-path' });
    // (c) Scan tolerance: list() over the '#' root never throws (under the
    // runner the family classifies as absent — see the header note; under a
    // native resolver it would resolve the family — either way, no throw).
    await expect(list({ opsRoot: hashedRoot })).resolves.toBeDefined();
  });

  test('reserved-schema enforcement: an entry declaring the reserved json key rejects at scan', async () => {
    // json/help/h are reserved on EVERY subcommand and stripped before any
    // schema sees input — a schema declaring one could never receive it
    // through its subcommand, so registration rejects loudly instead of
    // shipping an op whose field is unreachable.
    const tmp = await makeTmpOpsRoot('cq-i1-reservedschema-');
    await mkdir(join(tmp, 'reservedfam'), { recursive: true });
    await writeFile(
      join(tmp, 'reservedfam', 'registry.js'),
      [
        "import { z } from 'zod';",
        'export const registry = [',
        "  { name: 'jsonop', inputSchema: z.object({ json: z.string() }), importer: async () => async () => ({ status: 'ok', value: null }) },",
        '];',
        '',
      ].join('\n'),
    );
    await expect(list({ opsRoot: tmp })).rejects.toThrow(/reserved CLI key 'json'/);
  });

  test('a CYCLIC plan file is an invalid plan (exit 2), never a narrated runtime crash (review-debt #84)', async () => {
    // topoOrder throws 'topoOrder: dependency cycle among jobs: …' for a
    // PlanSchema-valid but cyclic plan — a plan-INPUT defect. Before the
    // classifier knew the prefix, this surfaced as a CLI crash (exit 1,
    // 'cq: run-plan threw:') instead of the documented invalid-plan path.
    const { planPath } = await writePlanFile({
      id: 'i1-cycle',
      jobs: [
        { id: 'a', op: 'echo', input: { msg: 'hi' }, dependsOn: ['b'] },
        { id: 'b', op: 'echo', input: { msg: 'lo' }, dependsOn: ['a'] },
      ],
    });
    const { code, out, err } = await capture(['run-plan', `--plan=${planPath}`, `--ops-root=${opsRoot}`]);
    expect(code).toBe(2);
    expect(out).toBe('');
    expect(err).toMatch(/invalid input for 'run-plan': topoOrder: dependency cycle among jobs/);
    expect(err).not.toMatch(/threw:/);
  });

  // Root bypasses directory permission bits, so the EACCES precondition
  // below cannot be produced when running as root — this test skips there
  // (the classification it pins is POSIX-permission-based).
  const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;

  test.skipIf(IS_ROOT)(
    'stat classification: a non-ENOENT stat error (chmod-000 dir) is a runtime throw → exit 1, not usage',
    async () => {
      const dir = await makeTmpDir('cq-i1-statclass-');
      const planPath = join(dir, 'plan.json');
      await writeFile(planPath, JSON.stringify(singleJobPlan('echo')));
      await chmod(dir, 0o000); // stat(<dir>/plan.json) now fails with EACCES
      try {
        // Only ENOENT/ENOTDIR mean "cannot be a readable plan file" (the
        // input-defect class → 2); ANY other stat error is runtime
        // knowledge, rethrown to main.ts's catch → narrated exit 1.
        const { code, out, err } = await capture(['run-plan', `--plan=${planPath}`, `--ops-root=${opsRoot}`]);
        expect(code).toBe(1);
        expect(out).toBe('');
        expect(err).toMatch(/run-plan threw:/);
        expect(err).not.toMatch(/not a readable file/);
      } finally {
        await chmod(dir, 0o755); // restore before afterEach's rm cleanup
      }
    },
  );
});

// b2602ca successor pins (PR 64 wave-4): resume SEEDS the governor from the
// journal (a cumulative --max-tokens cap must bind the resumed run to its
// prior runs' usage — I9 honesty), and run-plan's kebab→camel normalizer
// keeps the null-prototype flags record so --__proto__ reaches the strict
// schema as the unknown key it is (exit 2), instead of vanishing through the
// inherited accessor.
describe('resume seeds the governor; null-proto run-plan flags (wave-4)', () => {
  /**
   * Hand-written prior-run journal, field-for-field against the frozen
   * JournalEventSchema: run-started (runId/at/planId), job-started
   * (runId/at/jobId/op/attempt — REQUIRED: the seed's usage fold counts only
   * a finish that CLOSES an open start), job-finished (runId/at/jobId/opId/
   * inputsHash/result/usage). The file name is `<planId>--<seg>--<hex>` —
   * the candidate tail shape journal.candidateRunsForPlan requires. The
   * inputsHash is deliberately NOT the current job input's hash, so replay's
   * ok-skip is defeated and the job is genuinely re-dispatched into the
   * (hopefully seeded) governor.
   */
  async function writePriorJournal(journalDir: string, planId: string): Promise<void> {
    const runId = `${planId}--0001--abcd`;
    const at = '2026-01-01T00:00:00.000Z';
    const events = [
      { type: 'run-started', runId, at, planId },
      { type: 'job-started', runId, at, jobId: 'a', op: 'echo', attempt: 1 },
      {
        type: 'job-finished',
        runId,
        at,
        jobId: 'a',
        opId: 'echo',
        inputsHash: 'prior-run-hash-not-the-current-inputs',
        result: { status: 'ok', value: { echo: 'hi' } },
        usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ];
    for (const event of events) {
      expect(() => JournalEventSchema.parse(event)).not.toThrow();
    }
    await mkdir(journalDir, { recursive: true });
    await writeFile(
      join(journalDir, `${runId}.ndjson`),
      events.map((event) => JSON.stringify(event)).join('\n') + '\n',
    );
  }

  test('resume + seeded usage trips --max-tokens: exit 3, earlyStopReason budget (without the seed this exits 0)', async () => {
    const { planPath, journalDir } = await writePlanFile({
      id: 'i1-resume',
      jobs: [
        { id: 'a', op: 'echo', input: { msg: 'hi' } },
        { id: 'b', op: 'echo', input: { msg: 'again' }, dependsOn: ['a'] },
      ],
    });
    await writePriorJournal(journalDir, 'i1-resume');
    const { code, out } = await capture([
      'run-plan',
      `--plan=${planPath}`,
      `--ops-root=${opsRoot}`,
      `--journal-dir=${journalDir}`,
      '--resume',
      '--max-tokens=10',
    ]);
    // The seeded 100-token rollup (echo reports no usage of its own) trips
    // the 10-token cap AT SEED: job a's re-dispatch is refused
    // (budget-exhausted) and b, gated behind a, is re-marked by the
    // honest-stop pass → earlyStopReason 'budget' → exit 3.
    expect(code).toBe(3);
    const report = RunReportSchema.parse(JSON.parse(out));
    expect(report.stoppedEarly).toBe(true);
    expect(report.earlyStopReason).toBe('budget');
    expect(report.counts['budget-exhausted']).toBe(2);
    expect(report.jobs.map((row) => row.result.status)).toEqual([
      'budget-exhausted',
      'budget-exhausted',
    ]);
  });

  test('the same journal + cap WITHOUT --resume starts at zero: exit 0 (the pin has teeth)', async () => {
    const { planPath, journalDir } = await writePlanFile({
      id: 'i1-resume',
      jobs: [
        { id: 'a', op: 'echo', input: { msg: 'hi' } },
        { id: 'b', op: 'echo', input: { msg: 'again' }, dependsOn: ['a'] },
      ],
    });
    await writePriorJournal(journalDir, 'i1-resume');
    const { code, out } = await capture([
      'run-plan',
      `--plan=${planPath}`,
      `--ops-root=${opsRoot}`,
      `--journal-dir=${journalDir}`,
      '--max-tokens=10',
    ]);
    expect(code).toBe(0); // fresh governor — the prior run's usage is not loaded
    const report = RunReportSchema.parse(JSON.parse(out));
    expect(report.counts.done).toBe(2);
  });

  test('run-plan null-proto normalizer: --__proto__ is an OWN key → the strict schema rejects it (exit 2)', async () => {
    // With the plain-{} record this flag silently vanished (inherited
    // __proto__ accessor) and the run proceeded to stat('p') — the narration
    // said "not a readable file". The null-proto record makes the key an own
    // property, so RunPlanInputSchema's unknown-key check fires: the exact
    // narration below is the proof the flag was SEEN, not dropped.
    const { code, out, err } = await capture([
      'run-plan',
      '--plan=p',
      '--__proto__={"plan":"/etc/passwd"}',
    ]);
    expect(code).toBe(2);
    expect(out).toBe('');
    expect(err).toMatch(/invalid input for 'run-plan'/);
    expect(err).toMatch(/Unrecognized key: "__proto__"/);
    expect(err).not.toMatch(/not a readable file/);
  });
});

// Lossless PARITY PIN (r3 F3): src/cli/output.ts's assertJsonLossless and the
// kernel runner's pre-journal walk (src/kernel/runner.ts) are deliberate
// line-identical mirrors — the direct-dispatch gate and the plan-path gate
// must keep REJECTING the same values, or the two dispatch paths disagree
// about what may become an artifact/journal line. This suite holds them
// together behaviorally: every corpus member must be rejected by BOTH layers
// (corpus statuses verified against both walks before inclusion — e.g.
// `Object.create(null)` carrying only a string member is ACCEPTED by both
// (the documented null-prototype normalization) and is therefore excluded;
// the null-proto member below carries a Map so both walks reject it).
describe('lossless parity pin: the CLI walk and the kernel walk reject the same corpus', () => {
  test('every lossy member: direct dispatch → exit 1 with empty stdout; run-plan → failed rows', async () => {
    const corpus = [
      { name: 'lossmap', expr: 'new Map()', pattern: "non-plain object of type 'Map'" },
      { name: 'lossdate', expr: 'new Date(0)', pattern: "non-plain object of type 'Date'" },
      { name: 'lossset', expr: 'new Set([1])', pattern: "non-plain object of type 'Set'" },
      { name: 'lossnullproto', expr: 'Object.assign(Object.create(null), { m: new Map() })', pattern: "non-plain object of type 'Map'" },
      // The hidden-key family (PR #31 review, Codex P1 + review-debt #76):
      // the member walk sees only enumerable string-keyed values, so these
      // shapes passed while JSON.stringify disagreed with the walk — a
      // symbol key is DROPPED by stringify; a non-enumerable 'toJSON' is
      // INVOKED by it (the journal/artifact would reconstruct the hook's
      // output); any non-enumerable member is invisible data.
      { name: 'losssymbolkey', expr: "{ x: 1, [Symbol('hidden')]: 2 }", pattern: 'symbol-keyed own member' },
      {
        name: 'losshiddentojson',
        expr:
          "(() => { const o = { x: 1 }; Object.defineProperty(o, 'toJSON', { value: () => ({ x: 2 }), enumerable: false }); return o; })()",
        pattern: "non-enumerable own 'toJSON'",
      },
      // The array-side family (PR #103 review, Codex P1): arrays carrying
      // anything but indices and length diverge from stringify the same
      // ways objects do.
      { name: 'lossarrtojson', expr: "(() => { const a = [1]; Object.defineProperty(a, 'toJSON', { value: () => ({ x: 2 }), enumerable: false }); return a; })()", pattern: "own 'toJSON' on an array" },
      { name: 'lossarrextra', expr: "(() => { const a = [1]; a.extra = 'gone'; return a; })()", pattern: "non-index own member 'extra' on an array" },
      { name: 'lossarrsymbol', expr: "(() => { const a = [1]; a[Symbol('leak')] = 2; return a; })()", pattern: 'symbol-keyed own member' },
      {
        name: 'losshiddenmember',
        expr:
          "(() => { const o = { x: 1 }; Object.defineProperty(o, 'hidden', { value: 3, enumerable: false }); return o; })()",
        pattern: "non-enumerable own member 'hidden'",
      },
    ];
    const tmp = await makeTmpOpsRoot('cq-i1-parity-');
    await mkdir(join(tmp, 'parityfam'), { recursive: true });
    await writeFile(
      join(tmp, 'parityfam', 'registry.js'),
      [
        "import { z } from 'zod';",
        'export const registry = [',
        ...corpus.map(
          (member) =>
            `  { name: '${member.name}', inputSchema: z.object({}).strict(), importer: async () => async () => ({ status: 'ok', value: ${member.expr} }) },`,
        ),
        '];',
        '',
      ].join('\n'),
    );

    // (a) Direct dispatch — the CLI-side walk rejects every member BEFORE any
    // stdout artifact: exit 1 (thrown class), stdout empty.
    for (const member of corpus) {
      const { code, out, err } = await capture([member.name], { opsRoot: tmp });
      expect(code, member.name).toBe(1);
      expect(out, member.name).toBe('');
      expect(err, member.name).toMatch(new RegExp(`${member.name} returned an invalid result`));
      expect(err, member.name).toMatch(new RegExp(member.pattern));
    }

    // (b) Plan path — the same ops through run-plan hit the kernel runner's
    // pre-journal walk (the other copy): each job records an honest failed
    // row instead of journaling a lossy result.
    const plan = {
      id: 'i1-parity',
      jobs: corpus.map((member, index) => ({ id: `p${index}`, op: member.name, input: {} })),
    };
    const { planPath } = await writePlanFile(plan);
    const { code, out } = await capture(['run-plan', `--plan=${planPath}`, `--ops-root=${tmp}`]);
    expect(code).toBe(1); // failed rows map to 1
    const report = RunReportSchema.parse(JSON.parse(out));
    expect(report.jobs).toHaveLength(corpus.length);
    expect(report.counts.failed).toBe(corpus.length);
    for (let index = 0; index < corpus.length; index++) {
      const row = report.jobs[index];
      expect(row?.op, `job ${index}`).toBe(corpus[index]?.name);
      expect(row?.result.status, `job ${index}`).toBe('failed');
      const error = row?.result.status === 'failed' ? row.result.error : '';
      // The runner's non-serializable-result marker naming the same walk
      // defect the direct path named above.
      expect(error, `job ${index}`).toMatch(/returned a non-serializable result/);
      expect(error, `job ${index}`).toMatch(new RegExp(corpus[index]?.pattern ?? ''));
    }
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

  test('--max-usd=0 is accepted: a zero-budget hard-zero cap does not reject the run (exit 0)', async () => {
    // RunPlanInputSchema used z.number().positive(), rejecting --max-usd=0 as
    // a usage error — but the governor explicitly accepts maxUsd >= 0 (a
    // valid hard-zero spend ceiling, src/kernel/governor.ts). The cap binds
    // only on PRICED spend: the echo fixture reports no usage, so nothing
    // trips and the trivial plan still passes (no journal: fresh governor
    // starts at zero — the seeded-DD-9 path never engages).
    const { planPath } = await writePlanFile(singleJobPlan('echo'));
    const { code, out, err } = await capture([
      'run-plan',
      `--plan=${planPath}`,
      `--ops-root=${opsRoot}`,
      '--max-usd=0',
    ]);
    expect(code).toBe(0);
    const report = RunReportSchema.parse(JSON.parse(out));
    expect(report.counts.done).toBe(1);
    expect(report.counts['budget-exhausted']).toBe(0);
    expect(report.stoppedEarly).toBe(false);
    expect(err).toContain('cq: done 1');
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

  test('journal-unsafe plan id + --journal-dir: kernel journal assert → exit 2, not 1', async () => {
    // PlanSchema accepts any string id, but a JOURNALED runId becomes a file
    // name (`<runId>.ndjson`), so makeRunId → assertSafeRunId throws
    // `journal: …` from inside runPlan for a schema-valid plan like
    // id 'bad/id'. The plan id is still the defective INPUT, so the
    // 'journal: ' classifier maps it to the usage path: exit 2, stdout empty,
    // stderr naming the journal assert — never the thrown-class exit 1.
    const { planPath, journalDir } = await writePlanFile({
      id: 'bad/id',
      jobs: [{ id: 'a', op: 'echo', input: { msg: 'hi' } }],
    });
    const { code, out, err } = await capture([
      'run-plan',
      `--plan=${planPath}`,
      `--ops-root=${opsRoot}`,
      `--journal-dir=${journalDir}`,
    ]);
    expect(code).toBe(2);
    expect(out).toBe('');
    expect(err).toMatch(/invalid input for 'run-plan': journal: /);
    expect(err).toMatch(/runId must match/);
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
