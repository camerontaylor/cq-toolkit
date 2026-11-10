import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readCqEnv } from '../../../src/config/env.js';
import { registry } from '../../../src/ops/config/registry.js';
import { buildConfigShowReport, type ConfigShowReport } from '../../../src/ops/config/show.js';

// The runner may export unrelated CQ_* names; start every test from a clean slate.
beforeEach(() => {
  for (const name of Object.keys(process.env))
    if (name.startsWith('CQ_')) vi.stubEnv(name, undefined);
});
afterEach(() => vi.unstubAllEnvs());

async function run(input: unknown): Promise<unknown> {
  const entry = registry.find((e) => e.name === 'config');
  if (entry === undefined) throw new Error('config op missing');
  const op = await entry.importer();
  return op(entry.inputSchema.parse(input));
}

const dummy = ['dummy', 'value', 'three'].join('-');

describe('config op', () => {
  test('registers as `config` with a strict input', () => {
    expect(registry.map((e) => e.name)).toEqual(['config']);
    expect(registry[0]?.inputSchema.safeParse({ nope: 1 }).success).toBe(false);
  });

  test('report shows value, source, hides secrets', () => {
    const report = buildConfigShowReport({
      CQ_SANDBOX: 'off',
      CQ_AUTOMATION_TOKEN: dummy,
    });
    const byName = new Map(report.keys.map((k) => [k.name, k]));
    expect(byName.get('CQ_SANDBOX')).toEqual({ name: 'CQ_SANDBOX', value: 'off', source: 'env' });
    expect(byName.get('CQ_AUTOMATION_TOKEN')).toEqual({
      name: 'CQ_AUTOMATION_TOKEN',
      value: 'set',
      source: 'env',
    });
    expect(byName.get('CQ_RUN_TOOL')).toEqual({
      name: 'CQ_RUN_TOOL',
      value: null,
      source: 'default',
    });
    expect(JSON.stringify(report)).not.toContain(dummy);
  });

  test('ok with no problems; warnings do not fail without --strict', async () => {
    vi.stubEnv('CQ_SANBOX', 'off');
    const result = (await run({})) as { status: string; value: { warnings: unknown[] } };
    expect(result.status).toBe('ok');
    expect(result.value.warnings).toHaveLength(1);
  });

  test('binds the supplied snapshot for values and strict diagnostics', async () => {
    const snapshot = readCqEnv({ CQ_SANDBOX: 'off', CQ_SANBOX: 'off' });
    vi.stubEnv('CQ_SANDBOX', 'docker');
    const op = await registry[0]!.importer({ cqEnv: snapshot });
    const result = (await op({})) as { status: string; value: ConfigShowReport };
    expect(result.status).toBe('ok');
    expect(result.value.keys.find((key) => key.name === 'CQ_SANDBOX')).toEqual({
      name: 'CQ_SANDBOX',
      value: 'off',
      source: 'env',
    });
    expect(result.value.warnings).toEqual(snapshot.warnings);
    expect(await op({ strict: true })).toMatchObject({ status: 'failed' });
    const clean = await registry[0]!.importer({ cqEnv: readCqEnv({}) });
    vi.stubEnv('CQ_SANBOX', 'off');
    expect(await clean({ strict: true })).toMatchObject({ status: 'ok' });
  });

  test('strict fails on warnings', async () => {
    vi.stubEnv('CQ_SANBOX', 'off');
    const result = (await run({ strict: true })) as { status: string; error: string };
    expect(result.status).toBe('failed');
    expect(result.error).toContain(
      'cq: warning: unknown name CQ_SANBOX (did you mean CQ_SANDBOX?)',
    );
  });

  test('errors are reported in full (ok result; the CLI maps them to exit 2)', async () => {
    vi.stubEnv('CQ_SANDBOX', 'of');
    vi.stubEnv('CQ_RUN_TOOL', 'maybe');
    for (const input of [{}, { strict: true }]) {
      const result = (await run(input)) as { status: string; value: { errors: unknown[] } };
      expect(result.status).toBe('ok');
      expect(result.value.errors).toHaveLength(2);
    }
  });
});
