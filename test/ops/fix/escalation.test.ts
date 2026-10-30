import { expect, test } from 'vitest';
import {
  createEscalationState,
  nextEscalation,
  recordFixedFailures,
  rescueAllocation,
} from '../../../src/ops/fix/escalation.js';
import type { FailureSet } from '../../../src/ops/gates/checkRunner.js';
const policy = { workerAttempts: 2, rescueBase: 20, rescuePerFixed: 10, rescuePerPackageCap: 10 };
const request = {
  package: 'pkg',
  task: 'task',
  workerUsed: 2,
  rescueUsed: 0,
  canRescue: true,
  reason: 'related check failed',
};
const failures = (count: number): FailureSet => ({
  tool: 'tsc',
  exitCode: count ? 1 : 0,
  failures: Array.from({ length: count }, (_, i) => ({
    file: `src/${i}.ts`,
    line: 1,
    column: 1,
    ruleId: 'TS2322',
    message: 'invalid',
    severity: 'error' as const,
  })),
});
test('fresh rescue allocation ignores unresolved volume; verified distinct reductions earn only each tenth credit', () => {
  let state = createEscalationState();
  expect(rescueAllocation(state, policy)).toBe(20);
  expect(rescueAllocation(createEscalationState(209), policy)).toBe(20);
  expect(rescueAllocation(createEscalationState(210), policy)).toBe(21);
  state = recordFixedFailures(state, failures(100), failures(91));
  expect(state.fixedFingerprints).toHaveLength(9);
  expect(rescueAllocation(state, policy)).toBe(20);
  state = recordFixedFailures(state, failures(100), failures(90));
  expect(state.fixedFingerprints).toHaveLength(10);
  expect(rescueAllocation(state, policy)).toBe(21);
  state = recordFixedFailures(state, failures(100), failures(90));
  expect(state.fixedFingerprints).toHaveLength(10);
  expect(rescueAllocation(state, policy)).toBe(21);
  for (const seed of [-1, 0.1, NaN, Infinity])
    expect(() => createEscalationState(seed)).toThrow('nonnegative safe integer');
});
test('worker rounds precede rescue, broader regression bypasses worker retry, stop reasons forbid dispatch', () => {
  const state = createEscalationState();
  expect(nextEscalation(state, policy, { ...request, workerUsed: 0 }).decision).toMatchObject({
    tier: 'worker',
    attempt: 1,
  });
  expect(nextEscalation(state, policy, { ...request, workerUsed: 1 }).decision).toMatchObject({
    tier: 'worker',
    attempt: 2,
    reason: 'worker retry: related check failed',
  });
  expect(nextEscalation(state, policy, request).decision).toMatchObject({
    tier: 'rescue',
    attempt: 1,
  });
  expect(
    nextEscalation(state, policy, { ...request, workerUsed: 1, regression: true }).decision,
  ).toMatchObject({ tier: 'rescue', reason: 'broader regression; rescue: related check failed' });
  expect(nextEscalation(state, policy, { ...request, rescueUsed: 1 }).decision).toMatchObject({
    tier: 'rescue',
    attempt: 2,
  });
  expect(
    nextEscalation(state, policy, { ...request, workerUsed: 0, stopReason: 'parent cancelled' })
      .decision,
  ).toEqual({ tier: 'human', attempt: 0, reason: 'parent cancelled' });
  expect(nextEscalation(state, policy, { ...request, canRescue: false }).decision.reason).toContain(
    'role unavailable',
  );
  expect(state.events).toEqual([]);
});
test('atomic concurrent reservations obey shared pool and package caps including prototype-shaped package names', async () => {
  let state = createEscalationState();
  const bounded = { ...policy, rescueBase: 3, rescuePerPackageCap: 2 };
  const decisions = await Promise.all(
    ['__proto__', '__proto__', '__proto__', 'other', 'last'].map(async (packageName) => {
      const result = nextEscalation(state, bounded, { ...request, package: packageName });
      state = result.state;
      await Promise.resolve();
      return result.decision;
    }),
  );
  expect(decisions.map((d) => d.tier)).toEqual(['rescue', 'rescue', 'human', 'rescue', 'human']);
  expect(decisions[2]?.reason).toContain('per-package');
  expect(decisions[4]?.reason).toContain('run rescue pool');
  expect(state.perRunUsed).toBe(3);
  expect(state.perPackageUsed['__proto__']).toBe(2);
  expect(state.events).toHaveLength(5);
  expect(
    nextEscalation(createEscalationState(), { ...policy, rescueBase: 0 }, request).decision.tier,
  ).toBe('human');
  expect(
    nextEscalation(createEscalationState(), { ...policy, rescuePerPackageCap: 0 }, request).decision
      .tier,
  ).toBe('human');
});
test('occurrence fingerprints preserve multiplicity and distinguish signatures rather than counting task rows', () => {
  const before = failures(1);
  before.failures.push({ ...before.failures[0]! });
  const once = recordFixedFailures(createEscalationState(), before, failures(1));
  expect(once.fixedFingerprints).toHaveLength(1);
  const all = recordFixedFailures(once, before, failures(0));
  expect(all.fixedFingerprints).toHaveLength(2);
  expect(recordFixedFailures(all, before, failures(0)).fixedFingerprints).toHaveLength(2);
});

test('exhausting one package escalates it without spending another package rescue slot', () => {
  const bounded = { ...policy, rescueBase: 2, rescuePerPackageCap: 1 };
  const first = nextEscalation(createEscalationState(), bounded, request);
  const exhausted = nextEscalation(first.state, bounded, { ...request, rescueUsed: 1 });
  expect(exhausted.decision.tier).toBe('human');
  expect(exhausted.state.perRunUsed).toBe(1);
  const independent = nextEscalation(exhausted.state, bounded, { ...request, package: 'other' });
  expect(independent.decision).toMatchObject({ tier: 'rescue', attempt: 1 });
  expect(independent.state.perRunUsed).toBe(2);
  expect(first.state.perRunUsed).toBe(1);
});
