// Gates lane C2 — registry-slice test evidence: the two NEW entries
// (gates.baselineProbe, gates.regressionGate) validate the full input and
// only it — strict unknown-key rejection is load-bearing here, because a
// smuggled baseline/cache field on the probe would silently violate I7 —
// and their importers resolve to ops (the probe bound to the subprocess
// runner, the gate bound to the pure decision op).
import { describe, expect, test } from 'vitest';
import {
  BaselineProbeInputSchema,
  CheckRunnerInputSchema,
  RegressionGateInputSchema,
  registry,
} from '../../../src/ops/gates/registry.js';

/** A minimal valid gate input: two empty FailureSets. */
const EMPTY_FAILURE_SET = { tool: 'eslint', failures: [], exitCode: 0 };

describe('gates registry: the two C2 entries', () => {
  test('the registry names the lane ops in order (C3 appends after the C1+C2 slice)', () => {
    expect(registry.map((entry) => entry.name)).toEqual([
      'gates.checkRunner',
      'gates.baselineProbe',
      'gates.regressionGate',
      'gates.hackDetector',
      'gates.commitGate',
      'gates.policyDiff',
    ]);
  });
});

describe('BaselineProbeInputSchema (full input, and only it)', () => {
  const VALID = {
    adapter: 'tsc-lines',
    command: { command: 'tsc', args: ['--noEmit'] },
  };

  test('parses the full input, applying the 600_000ms op-boundary timeout default', () => {
    expect(BaselineProbeInputSchema.parse(VALID)).toEqual({
      adapter: 'tsc-lines',
      command: { command: 'tsc', args: ['--noEmit'], timeoutMs: 600_000 },
    });
  });

  test('accepts the optional bail object (patterns, bounded retry count)', () => {
    expect(
      BaselineProbeInputSchema.safeParse({
        ...VALID,
        bail: { bailPatterns: ['custom doom'], maxBailRetries: 0 },
      }).success,
    ).toBe(true);
  });

  test('bounds bail values: maxBailRetries 10 accepted, 11 rejected; an empty pattern is rejected', () => {
    expect(
      BaselineProbeInputSchema.safeParse({ ...VALID, bail: { maxBailRetries: 10 } }).success,
    ).toBe(true);
    expect(
      BaselineProbeInputSchema.safeParse({ ...VALID, bail: { maxBailRetries: 11 } }).success,
    ).toBe(false);
    expect(
      BaselineProbeInputSchema.safeParse({ ...VALID, bail: { bailPatterns: [''] } }).success,
    ).toBe(false);
  });

  test('a typo inside command (timeoutMS, wrong case) is REJECTED, not silently stripped', () => {
    expect(
      BaselineProbeInputSchema.safeParse({
        ...VALID,
        command: { command: 'tsc', args: ['--noEmit'], timeoutMS: 5 },
      }).success,
    ).toBe(false);
    expect(
      CheckRunnerInputSchema.safeParse({
        adapter: 'tsc-lines',
        command: { command: 'tsc', args: ['--noEmit'], timeoutMS: 5 },
      }).success,
    ).toBe(false);
  });

  test('REJECTS a smuggled baseline or cache field (strict unknown keys, I7)', () => {
    expect(
      BaselineProbeInputSchema.safeParse({ ...VALID, baseline: { fingerprints: [] } }).success,
    ).toBe(false);
    expect(BaselineProbeInputSchema.safeParse({ ...VALID, cache: true }).success).toBe(false);
  });

  test('rejects a bad adapter, bad args, and a missing command', () => {
    expect(
      BaselineProbeInputSchema.safeParse({ adapter: 'grep-json', command: VALID.command }).success,
    ).toBe(false);
    expect(
      BaselineProbeInputSchema.safeParse({ ...VALID, command: { command: 'tsc', args: [7] } })
        .success,
    ).toBe(false);
    expect(BaselineProbeInputSchema.safeParse({ adapter: 'tsc-lines' }).success).toBe(false);
  });

  test('rejects invalid bail values: negative, fractional, non-string patterns, unknown keys', () => {
    expect(
      BaselineProbeInputSchema.safeParse({ ...VALID, bail: { maxBailRetries: -1 } }).success,
    ).toBe(false);
    expect(
      BaselineProbeInputSchema.safeParse({ ...VALID, bail: { maxBailRetries: 1.5 } }).success,
    ).toBe(false);
    expect(
      BaselineProbeInputSchema.safeParse({ ...VALID, bail: { bailPatterns: [7] } }).success,
    ).toBe(false);
    expect(BaselineProbeInputSchema.safeParse({ ...VALID, bail: { memoize: true } }).success).toBe(
      false,
    );
  });
});

describe('RegressionGateInputSchema (full input, and only it)', () => {
  const VALID = { base: EMPTY_FAILURE_SET, final: EMPTY_FAILURE_SET };

  test('parses a full input with failures and an optional config', () => {
    const withFailures = {
      base: {
        tool: 'eslint',
        exitCode: 1,
        failures: [
          {
            file: 'src/a.ts',
            line: 5,
            column: 1,
            ruleId: 'prefer-const',
            message: 'm',
            severity: 'error',
          },
        ],
      },
      final: { ...EMPTY_FAILURE_SET, exitCode: null },
      config: { lineBucketSize: 25, rootDir: '/work/repo' },
    };
    expect(RegressionGateInputSchema.safeParse(withFailures).success).toBe(true);
    expect(RegressionGateInputSchema.parse(VALID)).toEqual(VALID);
  });

  test('rejects FailureSets that do not mirror the C1 type', () => {
    expect(RegressionGateInputSchema.safeParse({ final: EMPTY_FAILURE_SET }).success).toBe(false);
    expect(
      RegressionGateInputSchema.safeParse({
        ...VALID,
        base: { tool: 5, failures: [], exitCode: 0 },
      }).success,
    ).toBe(false);
    expect(
      RegressionGateInputSchema.safeParse({
        ...VALID,
        base: {
          tool: 'eslint',
          failures: [
            { file: null, line: null, column: null, ruleId: null, message: 'm', severity: 'fatal' },
          ],
          exitCode: 1,
        },
      }).success,
    ).toBe(false);
    expect(
      RegressionGateInputSchema.safeParse({
        ...VALID,
        base: { tool: 'eslint', failures: [], exitCode: '0' },
      }).success,
    ).toBe(false);
  });

  test('rejects invalid config: zero/fractional buckets and unknown keys anywhere', () => {
    expect(
      RegressionGateInputSchema.safeParse({ ...VALID, config: { lineBucketSize: 0 } }).success,
    ).toBe(false);
    expect(
      RegressionGateInputSchema.safeParse({ ...VALID, config: { offsetBucketSize: 2.5 } }).success,
    ).toBe(false);
    expect(
      RegressionGateInputSchema.safeParse({ ...VALID, config: { memoize: true } }).success,
    ).toBe(false);
    expect(RegressionGateInputSchema.safeParse({ ...VALID, config: { rootDir: 7 } }).success).toBe(
      false,
    );
    expect(RegressionGateInputSchema.safeParse({ ...VALID, config: {} }).success).toBe(true);
  });

  test('rejects a smuggled top-level field (strict unknown keys)', () => {
    expect(
      RegressionGateInputSchema.safeParse({ ...VALID, verdict: 'no-regression' }).success,
    ).toBe(false);
  });
});

describe('the C2 importers resolve', () => {
  test('gates.baselineProbe resolves to an op (subprocess-bound runner behind the seam)', async () => {
    const entry = registry.find((candidate) => candidate.name === 'gates.baselineProbe');
    if (!entry) {
      throw new Error('gates.baselineProbe missing from the registry');
    }
    expect(typeof entry.inputSchema).toBe('object');
    const op = await entry.importer();
    expect(typeof op).toBe('function');
  });

  test('gates.regressionGate resolves to an op (pure decision, no wiring)', async () => {
    const entry = registry.find((candidate) => candidate.name === 'gates.regressionGate');
    if (!entry) {
      throw new Error('gates.regressionGate missing from the registry');
    }
    const op = await entry.importer();
    expect(typeof op).toBe('function');
    const result = await op({ base: EMPTY_FAILURE_SET, final: EMPTY_FAILURE_SET });
    expect(result).toEqual({
      status: 'ok',
      value: {
        verdict: 'no-regression',
        novelFailures: [],
        fixedFailures: [],
        preExistingCount: 0,
      },
    });
  });
});
