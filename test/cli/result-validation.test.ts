// Result-validation gates (CX1 + 4530779 pins) — split from test/cli/i1.test.ts (pure move). Suite header: op-subcommands.test.ts; helpers: ./i1-helpers.ts.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { capture, makeTmpOpsRoot, opsRoot } from './i1-helpers.js';

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
    expect(human.err).toMatch(
      /invalid input for 'asyncthrow': schema gate threw — refinement exploded/,
    );
    expect(human.err).not.toMatch(/threw:/); // never the last-resort crash narration
    const machine = await capture(['asyncthrow', '--json'], { opsRoot: tmp });
    expect(machine.code).toBe(2);
    expect(JSON.parse(machine.out)).toMatchObject({
      error: { kind: 'invalid-input', subcommand: 'asyncthrow', exitCode: 2 },
    });
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
