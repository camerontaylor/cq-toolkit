// Lane E — machine-mode (`--json`) ERROR ARTIFACTS: every error site writes
// ONE `{ error: { kind, subcommand, message, exitCode } }` object to stdout
// and nothing to stderr; human mode keeps its `cq:` stderr line with empty
// stdout. Hermetic: fixture family + tmp plan files/registries.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { runCli } from '../../src/cli/main.js';
import type { CliIo } from '../../src/cli/output.js';

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

interface ErrorArtifact {
  error: { kind: string; subcommand: string | null; message: string; exitCode: number };
}

/** Assert the ONE-error-artifact contract and return the parsed artifact. */
function expectErrorArtifact(run: Captured, kind: string, exitCode: number): ErrorArtifact {
  expect(run.code).toBe(exitCode);
  expect(run.err).toBe('');
  expect(run.out.endsWith('\n')).toBe(true);
  const parsed = JSON.parse(run.out) as ErrorArtifact;
  expect(Object.keys(parsed)).toEqual(['error']); // an error artifact never joins a result
  expect(Object.keys(parsed.error)).toEqual(['kind', 'subcommand', 'message', 'exitCode']);
  expect(parsed.error.kind).toBe(kind);
  expect(parsed.error.exitCode).toBe(exitCode);
  expect(typeof parsed.error.message).toBe('string');
  expect(parsed.error.message).not.toBe('');
  return parsed;
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

describe('--json error artifacts: post-parse sites', () => {
  test('op input validation → invalid-input, exit 2', async () => {
    const run = await capture(['verdictfail', '--bogus=1', '--json']);
    const { error } = expectErrorArtifact(run, 'invalid-input', 2);
    expect(error.subcommand).toBe('verdictfail');
    expect(error.message).toMatch(/invalid input for 'verdictfail'/);
  });

  test('op invalid result (status outside the taxonomy) → invalid-result, exit 1', async () => {
    const run = await capture(['garbage', '--json']);
    const { error } = expectErrorArtifact(run, 'invalid-result', 1);
    expect(error.subcommand).toBe('garbage');
    expect(error.message).toMatch(/garbage returned an invalid result/);
  });

  test('op throw → thrown, exit 1', async () => {
    const run = await capture(['throwop', '--json']);
    const { error } = expectErrorArtifact(run, 'thrown', 1);
    expect(error.subcommand).toBe('throwop');
    expect(error.message).toBe('throwop threw: deliberate op throw');
  });

  test('run-plan input defect (missing plan file) → invalid-input, exit 2', async () => {
    const dir = await tmpDir('cq-json-errors-');
    const run = await capture(['run-plan', `--plan=${join(dir, 'absent.json')}`, '--json']);
    const { error } = expectErrorArtifact(run, 'invalid-input', 2);
    expect(error.subcommand).toBe('run-plan');
    expect(error.message).toMatch(/not a readable file/);
  });

  test('run-plan input defect (schema-invalid flags) → invalid-input, exit 2', async () => {
    const run = await capture(['run-plan', '--json']); // --plan is required
    const { error } = expectErrorArtifact(run, 'invalid-input', 2);
    expect(error.subcommand).toBe('run-plan');
  });

  test('run-plan thrown → thrown, exit 1', async () => {
    // A unreadable-but-present plan path is a runtime read failure; use a
    // directory-as-journal collision instead: --journal-dir pointing at a FILE
    // makes the journal open throw (a runtime failure, not an input defect).
    const dir = await tmpDir('cq-json-errors-');
    const plan = join(dir, 'plan.json');
    await writeFile(
      plan,
      JSON.stringify({ id: 'p', jobs: [{ id: 'a', op: 'verdictpass', input: {} }] }),
    );
    const notADir = join(dir, 'file-not-dir');
    await writeFile(notADir, 'x');
    const run = await capture(['run-plan', `--plan=${plan}`, `--journal-dir=${notADir}`, '--json']);
    const { error } = expectErrorArtifact(run, 'thrown', 1);
    expect(error.subcommand).toBe('run-plan');
    expect(error.message).toMatch(/^run-plan threw: /);
  });

  test('plan subcommand: a malformed registry floor → invalid-input, exit 2', async () => {
    const dir = await tmpDir('cq-json-errors-plans-');
    await writeFile(join(dir, 'package.json'), '{"type":"module"}\n');
    await writeFile(
      join(dir, 'badfloor.js'),
      "export const plan = { name: 'badfloor', importer: async () => ({ id: 'badfloor' }) };\n",
    );
    const run = await capture(['badfloor', '--json'], { plansRoot: dir });
    const { error } = expectErrorArtifact(run, 'invalid-input', 2);
    expect(error.subcommand).toBe('badfloor');
  });

  test('plan subcommand: --ops-root → usage, exit 2', async () => {
    const dir = await tmpDir('cq-json-errors-plans-');
    await writeFile(join(dir, 'package.json'), '{"type":"module"}\n');
    await writeFile(
      join(dir, 'okfloor.js'),
      "export const plan = { name: 'okfloor', importer: async () => ({ id: 'okfloor', jobs: [] }) };\n",
    );
    const run = await capture(['okfloor', '--ops-root=/x', '--json'], { plansRoot: dir });
    const { error } = expectErrorArtifact(run, 'usage', 2);
    expect(error.subcommand).toBe('okfloor');
  });
});

describe('--json error artifacts: usage-class sites (detected before/while parsing)', () => {
  test('unknown subcommand → usage, exit 2', async () => {
    const { error } = expectErrorArtifact(await capture(['no-such-op', '--json']), 'usage', 2);
    expect(error.subcommand).toBe('no-such-op');
    expect(error.message).toMatch(/unknown subcommand 'no-such-op'/);
  });

  test('duplicate flag → usage, exit 2', async () => {
    const run = await capture(['verdictfail', '--x=1', '--x=2', '--json']);
    const { error } = expectErrorArtifact(run, 'usage', 2);
    expect(error.subcommand).toBe('verdictfail');
    expect(error.message).toMatch(/duplicate flag --x/);
  });

  test('positional token → usage, exit 2', async () => {
    const run = await capture(['verdictfail', 'stray', '--json']);
    const { error } = expectErrorArtifact(run, 'usage', 2);
    expect(error.message).toMatch(/unexpected positional argument 'stray'/);
  });

  test('valued reserved flag (--help=x) → usage, exit 2', async () => {
    const run = await capture(['verdictfail', '--help=x', '--json']);
    const { error } = expectErrorArtifact(run, 'usage', 2);
    expect(error.message).toMatch(/--help is a reserved CLI flag/);
  });

  test('--ops-root on an op subcommand → usage, exit 2', async () => {
    const run = await capture(['verdictfail', '--ops-root=/x', '--json']);
    const { error } = expectErrorArtifact(run, 'usage', 2);
    expect(error.message).toMatch(/--ops-root is a run-plan flag/);
  });

  test('a duplicate --json is itself a flag-syntax usage error that still honors machine mode', async () => {
    const run = await capture(['verdictfail', '--json', '--json']);
    const { error } = expectErrorArtifact(run, 'usage', 2);
    expect(error.message).toMatch(/duplicate flag --json/);
  });

  test('no subcommand with a stray --json token: subcommand is the first token, still usage', async () => {
    const run = await capture(['--json']);
    expectErrorArtifact(run, 'usage', 2);
  });
});

describe('human mode is unchanged: one cq: stderr line, empty stdout', () => {
  test.each([
    { argv: ['no-such-op'], code: 2, line: /^cq: unknown subcommand 'no-such-op'/ },
    { argv: [], code: 2, line: /^cq: missing subcommand/ },
    { argv: ['verdictfail', '--x=1', '--x=2'], code: 2, line: /^cq: duplicate flag --x/ },
    { argv: ['verdictfail', '--bogus=1'], code: 2, line: /^cq: invalid input for 'verdictfail'/ },
    { argv: ['garbage'], code: 1, line: /^cq: garbage returned an invalid result/ },
    { argv: ['throwop'], code: 1, line: /^cq: throwop threw: deliberate op throw/ },
  ])('$argv → exit $code', async ({ argv, code, line }) => {
    const run = await capture(argv);
    expect(run.code).toBe(code);
    expect(run.out).toBe('');
    expect(run.err).toMatch(line);
    expect(run.err.trimEnd().split('\n')).toHaveLength(1);
  });
});

describe('a result artifact is never joined by an error artifact', () => {
  test('--json op results stay exactly one result object (a failed result keeps its string `error`)', async () => {
    const run = await capture(['failedverdict', '--json']);
    expect(run.code).toBe(1);
    expect(run.err).toBe('');
    // OpResult 'failed' carries `error` as a STRING next to `status`; the
    // error artifact's `error` is an object with no `status` — the two shapes
    // are distinguishable and never co-occur in one stdout.
    expect(JSON.parse(run.out)).toEqual({ status: 'failed', error: 'deliberate' });
  });
});
