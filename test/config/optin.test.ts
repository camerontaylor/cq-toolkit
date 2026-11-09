// The registry `trust` flag is enforced: a per-call value for a trust key needs an
// in-process trustedOptIn(); JSON-derived objects (plan data, op input) cannot carry it.
import { describe, expect, test } from 'vitest';
import { CQ_ENV_REGISTRY } from '../../src/config/env-registry.js';
import type { CqEnvRegistry } from '../../src/config/env-registry.js';
import { trustedOptIn } from '../../src/config/optin.js';
import { resolveProtectedPathsConfig } from '../../src/ops/gates/policyConfig.js';
import { resolveSandboxConfig } from '../../src/sandbox/config.js';
import { errorClassOf } from '../../src/driver/errors.js';
import { PlanSchema } from '../../src/kernel/schema.js';
import { registry as mergeRegistry } from '../../src/ops/merge/registry.js';

const jsonOptIn = (o: unknown): never => JSON.parse(JSON.stringify(o)) as never;
const withFlag = (trust: boolean): CqEnvRegistry => ({
  ...CQ_ENV_REGISTRY,
  entries: CQ_ENV_REGISTRY.entries.map((e) =>
    ['CQ_SANDBOX', 'CQ_RUN_TOOL', 'CQ_MERGE_PROTECTED_PATHS'].includes(e.name)
      ? { ...e, trust }
      : e,
  ),
});

describe('trust flag enforcement', () => {
  test.each([
    ['CQ_SANDBOX', () => resolveSandboxConfig({ env: {}, optIn: { sandbox: 'off' } })],
    ['CQ_RUN_TOOL', () => resolveSandboxConfig({ env: {}, optIn: { run: 'off' } })],
    [
      'merge.protectedPaths',
      () => resolveProtectedPathsConfig({ env: {}, optIn: { 'merge.protectedPaths': 'advisory' } }),
    ],
  ])('a plain per-call value for %s is refused with config', (_n, call) => {
    let err: unknown;
    try {
      call();
    } catch (e) {
      err = e;
    }
    expect(errorClassOf(err)).toBe('config');
  });

  test('trustedOptIn still works', () => {
    expect(resolveSandboxConfig({ env: {}, optIn: trustedOptIn({ sandbox: 'off' }) }).mode).toBe(
      'off',
    );
    expect(
      resolveProtectedPathsConfig({
        env: {},
        optIn: trustedOptIn({ 'merge.protectedPaths': 'advisory' }),
      }).posture,
    ).toBe('advisory');
  });

  test('a JSON-derived object cannot carry the brand (plan data / op input path)', () => {
    const forged = jsonOptIn({ sandbox: 'off' });
    expect(() => resolveSandboxConfig({ env: {}, optIn: forged })).toThrow(/trustedOptIn/);
    // spreading a branded object also drops the brand
    const spread = { ...trustedOptIn({ sandbox: 'off' }) };
    expect(() => resolveSandboxConfig({ env: {}, optIn: spread })).toThrow(/trustedOptIn/);
  });

  test('neither the plan schema nor any merge op input schema has an optIn field', () => {
    const plan = {
      id: 'p',
      jobs: [{ id: 'j', op: 'merge.runPrs', input: {}, optIn: { sandbox: 'off' } }],
    };
    const unrecognised = (r: {
      success: boolean;
      error?: { issues: readonly unknown[] };
    }): boolean =>
      JSON.stringify(r.error?.issues ?? []).includes('unrecognized_keys') &&
      JSON.stringify(r.error?.issues ?? []).includes('optIn');
    expect(unrecognised(PlanSchema.safeParse(plan))).toBe(true);
    for (const entry of mergeRegistry) {
      expect(unrecognised(entry.inputSchema.safeParse({ optIn: { sandbox: 'off' } }))).toBe(true);
    }
  });

  test('the guard consults the flag: flipping trust changes behaviour', () => {
    const call = (registry: CqEnvRegistry): string =>
      resolveSandboxConfig({ env: {}, optIn: { sandbox: 'off' }, registry }).mode;
    expect(() => call(withFlag(true))).toThrow(/trustedOptIn/);
    expect(call(withFlag(false))).toBe('off');
    expect(
      resolveProtectedPathsConfig({
        env: {},
        optIn: { 'merge.protectedPaths': 'advisory' },
        registry: withFlag(false),
      }).posture,
    ).toBe('advisory');
  });
});
