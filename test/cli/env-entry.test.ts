// C3a: the CLI reads the CQ_* environment once, before dispatch. Errors list
// together and exit 2; warnings print once on stderr; --json keeps stdout one
// JSON artifact.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { readCqEnv } from '../../src/config/env.js';
import { resolveSandboxConfig } from '../../src/sandbox/config.js';
import { capture, makeTmpDir, opsRoot } from './i1-helpers.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

const warningLines = (err: string): string[] =>
  err.split('\n').filter((line) => line.startsWith('cq: warning:'));

describe('cq config exit codes', () => {
  test('invalid values and denied names exit 2 with the report on stdout', async () => {
    vi.stubEnv('CQ_SANDBOX', 'of');
    vi.stubEnv('CQ_RUN_TOOL', 'maybe');
    const run = await capture(['config']);
    expect(run.code).toBe(2);
    expect(JSON.parse(run.out)).toHaveProperty('value.errors');
    expect(run.err.match(/cq: error:/g)).toHaveLength(2);
    vi.unstubAllEnvs();
    vi.stubEnv('CQ_APPROVAL_KEY_X', 'x');
    expect((await capture(['config', '--strict'])).code).toBe(2);
  });

  test('--strict with only warnings exits 1; without --strict exits 0', async () => {
    vi.stubEnv('CQ_SANBOX', 'off');
    expect((await capture(['config', '--strict'])).code).toBe(1);
    expect((await capture(['config'])).code).toBe(0);
  });
});

describe('cq config --json exit codes', () => {
  const asJson = (out: string): unknown => JSON.parse(out);

  test('invalid values and denied names exit 2 with one JSON artifact and empty stderr', async () => {
    vi.stubEnv('CQ_SANDBOX', 'of');
    const bad = await capture(['config', '--json']);
    expect(bad.code).toBe(2);
    expect(asJson(bad.out)).toHaveProperty('value.errors');
    expect(bad.err).toBe('');
    vi.unstubAllEnvs();
    vi.stubEnv('CQ_APPROVAL_KEY_X', 'x');
    const denied = await capture(['config', '--json']);
    expect(denied.code).toBe(2);
    expect(() => asJson(denied.out)).not.toThrow();
  });

  test('--strict with only warnings exits 1, clean exits 0, stdout stays JSON', async () => {
    vi.stubEnv('CQ_SANBOX', 'off');
    const strict = await capture(['config', '--json', '--strict']);
    expect(strict.code).toBe(1);
    expect(() => asJson(strict.out)).not.toThrow();
    expect((await capture(['config', '--json'])).code).toBe(0);
    vi.unstubAllEnvs();
    const clean = await capture(['config', '--json', '--strict']);
    expect(clean.code).toBe(0);
    expect(() => asJson(clean.out)).not.toThrow();
  });
});

describe('cq config entry snapshot', () => {
  const showTs = fileURLToPath(new URL('../../src/ops/config/show.ts', import.meta.url));

  /** A fixture `config` family that mutates the ambient env before the real op loads. */
  async function writeConfigFixture(): Promise<string> {
    const tmp = await makeTmpDir('cq-config-entry-');
    await writeFile(join(tmp, 'package.json'), '{"type":"module"}\n');
    await mkdir(join(tmp, 'config'), { recursive: true });
    await writeFile(
      join(tmp, 'config', 'registry.js'),
      [
        'const { makeConfigShow } = await import(' + JSON.stringify(showTs) + ');',
        'const schema = {',
        '  parse: (value) => value,',
        '  safeParseAsync: async (value) => ({ success: true, data: value }),',
        '  parseAsync: async (value) => value,',
        '};',
        'export const registry = [',
        '  {',
        "    name: 'config',",
        '    inputSchema: schema,',
        '    importer: async (wiring) => {',
        "      process.env.CQ_SANDBOX = 'required'; // ambient drift AFTER entry",
        '      return makeConfigShow(wiring?.cqEnv);',
        '    },',
        '  },',
        '];',
        '',
      ].join('\n'),
    );
    return tmp;
  }

  test('reports the entry value when the ambient env changes before the op loads', async () => {
    vi.stubEnv('CQ_SANDBOX', 'off');
    const run = await capture(['config', '--json'], { opsRoot: await writeConfigFixture() });
    expect(run.code).toBe(0);
    const report = JSON.parse(run.out) as {
      value: { keys: Array<{ name: string; value: unknown; source: string }> };
    };
    expect(report.value.keys.find((key) => key.name === 'CQ_SANDBOX')).toMatchObject({
      value: 'off',
      source: 'env',
    });
    // Control: the fixture really did mutate the ambient environment after entry.
    expect(process.env['CQ_SANDBOX']).toBe('required');
  });
});

describe('CLI env entry', () => {
  test('a misspelled CQ_SANDBOX keeps the sandbox required and warns exactly once', async () => {
    vi.stubEnv('CQ_SANBOX', 'off');
    const run = await capture(['echo', '--msg=hi'], { opsRoot });
    expect(run.code).toBe(0);
    const warnings = warningLines(run.err);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('CQ_SANDBOX');
    const cqEnv = readCqEnv({ CQ_SANBOX: 'off' });
    expect(resolveSandboxConfig({ cqEnv }).mode).toBe('required');
  });

  test('two invalid values exit 2 and list both errors before dispatch', async () => {
    vi.stubEnv('CQ_SANDBOX', 'of');
    vi.stubEnv('CQ_RUN_TOOL', 'maybe');
    const run = await capture(['echo', '--msg=hi'], { opsRoot });
    expect(run.code).toBe(2);
    expect(run.out).toBe('');
    const errors = run.err.split('\n').filter((line) => line.startsWith('cq: error:'));
    expect(errors).toHaveLength(2);
    expect(errors.join('\n')).toContain('CQ_SANDBOX');
    expect(errors.join('\n')).toContain('CQ_RUN_TOOL');
  });

  test('--json: invalid values give one JSON error artifact and exit 2', async () => {
    vi.stubEnv('CQ_SANDBOX', 'of');
    vi.stubEnv('CQ_RUN_TOOL', 'maybe');
    const run = await capture(['echo', '--msg=hi', '--json'], { opsRoot });
    expect(run.code).toBe(2);
    const parsed = JSON.parse(run.out) as { error: { message: string; exitCode: number } };
    expect(parsed.error.exitCode).toBe(2);
    expect(parsed.error.message).toContain('CQ_SANDBOX');
    expect(parsed.error.message).toContain('CQ_RUN_TOOL');
  });

  test('--json: warnings stay off stderr and stdout stays valid JSON', async () => {
    vi.stubEnv('CQ_SANBOX', 'off');
    const run = await capture(['echo', '--msg=hi', '--json'], { opsRoot });
    expect(run.code).toBe(0);
    expect((JSON.parse(run.out) as { status: string }).status).toBe('ok');
    expect(run.err).toBe('');
  });

  test('identity names never warn', async () => {
    for (const name of ['CQ_WORK_ID', 'CQ_ROLE', 'CQ_TASK', 'CQ_RUN_ID', 'CQ_PARENT_WORK_ID']) {
      vi.stubEnv(name, 'x');
    }
    const run = await capture(['echo', '--msg=hi'], { opsRoot });
    expect(run.code).toBe(0);
    expect(warningLines(run.err)).toEqual([]);
  });
});
