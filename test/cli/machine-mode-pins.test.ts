// 4bdffd1 CLI pins (silence matrix, null-proto flags, URL-escape, reserved schema, stat classification) — split from test/cli/i1.test.ts (pure move). Suite header: op-subcommands.test.ts; helpers: ./i1-helpers.ts.
import { execFile } from 'node:child_process';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, test } from 'vitest';
import { parseFlags } from '../../src/cli/main.js';
import { KnownUsageSummarySchema } from '../../src/kernel/schema.js';
import type { CliErrorArtifact } from '../../src/cli/output.js';
import { list } from '../../src/registry/index.js';
import { makeTmpPlansRoot } from './registry.helpers.js';
import {
  capture,
  makeTmpDir,
  makeTmpOpsRoot,
  opsRoot,
  singleJobPlan,
  writePlanFile,
} from './i1-helpers.js';

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
    const json = await capture([
      'run-plan',
      `--plan=${missing}`,
      `--ops-root=${opsRoot}`,
      '--json',
    ]);
    expect(json.code).toBe(2);
    // no RESULT artifact — the run never started; the ONE stdout artifact is the error
    expect(JSON.parse(json.out)).toMatchObject({
      error: { kind: 'invalid-input', subcommand: 'run-plan', exitCode: 2 },
    });
    expect(json.err).toBe(''); // machine mode: stderr stays empty
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
    expect(JSON.parse(out)).toMatchObject({
      error: { kind: 'invalid-input', subcommand: 'echo', exitCode: 2 },
    });
    expect(err).toBe(''); // suppressed — the human-mode twin is the 'missing required field' pin above
  });

  test('machine mode: op invalid-result gate (garbage) + --json → exit 1, stderr empty', async () => {
    const { code, out, err } = await capture(['garbage', '--json'], { opsRoot });
    expect(code).toBe(1);
    // the invalid result never became a RESULT artifact: the error artifact replaces it
    expect(JSON.parse(out)).toMatchObject({
      error: { kind: 'invalid-result', subcommand: 'garbage', exitCode: 1 },
    });
    expect(err).toBe('');
  });

  test('machine mode: usage-class errors write the usage error artifact — unknown subcommand + --json → exit 2', async () => {
    const { code, out, err } = await capture(['no-such-op', '--json'], { opsRoot });
    expect(code).toBe(2);
    expect(err).toBe('');
    const parsed = JSON.parse(out) as { error: { kind: string; message: string } };
    expect(parsed.error.kind).toBe('usage');
    expect(parsed.error.message).toMatch(/unknown subcommand 'no-such-op'/);
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
    const rawArgs = ['--input-type=module', '-e', 'await import(process.argv[1]);', registryPath];
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
        'console.log(JSON.stringify(await op({})));',
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

  test.each(['json', 'help', 'h', 'fail-on-verdict'])(
    'reserved-schema enforcement: %s rejects at scan',
    async (key) => {
      // json/help/h/fail-on-verdict are reserved on EVERY subcommand and stripped before any
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
          `  { name: 'jsonop', inputSchema: z.object({ [${JSON.stringify(key)}]: z.string() }), importer: async () => async () => ({ status: 'ok', value: null }) },`,
          '];',
          '',
        ].join('\n'),
      );
      await expect(list({ opsRoot: tmp })).rejects.toThrow(new RegExp(`reserved CLI key '${key}'`));
    },
  );

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
    const { code, out, err } = await capture([
      'run-plan',
      `--plan=${planPath}`,
      `--ops-root=${opsRoot}`,
    ]);
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
        const { code, out, err } = await capture([
          'run-plan',
          `--plan=${planPath}`,
          `--ops-root=${opsRoot}`,
        ]);
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

// #1195: spend on every exit where it is known — the machine-mode error
// artifact of a THROWN op carries the op's validated usage carrier (the
// carrier review.run attaches to its rejections), and a bare throw keeps the
// artifact carrier-free.
describe('#1195 thrown-exit usage carrier', () => {
  test('machine mode: an op that throws WITH a settled-usage carrier writes it on the error artifact', async () => {
    const { code, out, err } = await capture(['spendthrow', '--json'], { opsRoot });
    expect(code).toBe(1);
    // The error artifact replaced the (never-existing) result: single stdout
    // artifact, no `status` key, stderr empty.
    const artifact = JSON.parse(out) as CliErrorArtifact;
    expect(artifact.error).toMatchObject({ kind: 'thrown', subcommand: 'spendthrow', exitCode: 1 });
    expect(Object.hasOwn(artifact, 'status')).toBe(false);
    // The carrier is schema-valid (the kernel's own validator) and exact.
    expect(KnownUsageSummarySchema.parse(artifact.error.usageSummary)).toEqual({
      usage: { input: 120, output: 40, cacheRead: 8, cacheWrite: 0 },
      knownCount: 1,
      unknownCount: 0,
      unpricedCount: 1,
    });
    expect(err).toBe('');
  });

  test('machine mode: a BARE throw keeps the artifact carrier-free (no regression)', async () => {
    const { code, out, err } = await capture(['plainthrow', '--json'], { opsRoot });
    expect(code).toBe(1);
    const artifact = JSON.parse(out) as CliErrorArtifact;
    expect(artifact.error).toMatchObject({
      kind: 'thrown',
      subcommand: 'plainthrow',
      exitCode: 1,
    });
    expect(Object.hasOwn(artifact.error, 'usageSummary')).toBe(false);
    expect(err).toBe('');
  });

  test('human mode: the spendthrow narration is unchanged (one cq: line, stdout empty)', async () => {
    const { code, out, err } = await capture(['spendthrow'], { opsRoot });
    expect(code).toBe(1);
    expect(out).toBe('');
    expect(err).toBe('cq: spendthrow threw: spendthrow: deliberate throw after settled spend\n');
  });

  test('machine mode: a plan-subcommand runtime throw carries its usage carrier too', async () => {
    // A plan importer that rejects with the carrier escapes runPlanEntryCommand
    // to the plan-subcommand thrown site — the second thrown exit.
    const root = await makeTmpPlansRoot('cq-i1-spendplan-');
    await writeFile(
      join(root, 'spendplan.js'),
      [
        'export const plan = {',
        "  name: 'spendplan',",
        '  importer: async () => {',
        "    const error = new Error('spendplan: importer threw after settled spend');",
        '    error.usageSummary = { knownCount: 0, unknownCount: 1, unpricedCount: 1 };',
        '    throw error;',
        '  },',
        '};',
        '',
      ].join('\n'),
    );
    const { code, out, err } = await capture(['spendplan', '--json'], {
      opsRoot,
      plansRoot: root,
    });
    expect(code).toBe(1);
    const artifact = JSON.parse(out) as CliErrorArtifact;
    expect(artifact.error).toMatchObject({ kind: 'thrown', subcommand: 'spendplan', exitCode: 1 });
    expect(KnownUsageSummarySchema.parse(artifact.error.usageSummary)).toEqual({
      knownCount: 0,
      unknownCount: 1,
      unpricedCount: 1,
    });
    expect(err).toBe('');
  });
});
