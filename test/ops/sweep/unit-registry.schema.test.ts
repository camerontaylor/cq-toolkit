// Split provenance: test/ops/sweep/unit-registry.test.ts was split into
// unit-registry.{registry,schema,bindings,install-hooks,staging-policy,push,run-state,task-worker}.test.ts
// plus unit-registry.helpers.ts (shared fixtures). This file carries the
// dispatch-input schema accept/reject boundary.
import { describe, expect, test } from 'vitest';
import { SweepUnitDispatchInputSchema } from '../../../src/ops/sweep/registry.js';
import { VALID } from './unit-registry.helpers.js';

describe('sweep.unit registry entry (jSKJF)', () => {
  test('schema accepts a fully-wired input and rejects shape violations', () => {
    expect(SweepUnitDispatchInputSchema.safeParse(VALID).success).toBe(true);
    expect(
      SweepUnitDispatchInputSchema.safeParse({
        ...VALID,
        driver: { ...VALID.driver!, budget: undefined },
      }).success,
    ).toBe(false);
    expect(
      SweepUnitDispatchInputSchema.safeParse({
        ...VALID,
        driver: { ...VALID.driver!, budget: {} },
      }).success,
    ).toBe(false);
    // FAIL CLOSED (PR #246 review): wallClockMs — the only cap enforced
    // while the fixer runs — is REQUIRED, so a post-run landing gate alone
    // ({maxTokens} or {maxUsd}) is refused. maxAttempts — alone or beside
    // the deadline — is refused (each rescue redispatch is its own job), as
    // are unusable values.
    for (const budget of [
      { maxTokens: 1000 },
      { maxUsd: 0.5 },
      { maxTokens: 1000, maxUsd: 0.5 },
      { maxAttempts: 3 },
      { wallClockMs: 600_000, maxAttempts: 3 },
      { wallClockMs: 600_000, maxTokens: 0 },
      { wallClockMs: 1.5 },
      { wallClockMs: 2 ** 31 },
    ]) {
      expect(
        SweepUnitDispatchInputSchema.safeParse({ ...VALID, driver: { ...VALID.driver!, budget } })
          .success,
      ).toBe(false);
    }
    for (const budget of [
      { wallClockMs: 600_000 },
      { wallClockMs: 600_000, maxTokens: 1000 },
      { wallClockMs: 600_000, maxUsd: 0.5 },
    ]) {
      expect(
        SweepUnitDispatchInputSchema.safeParse({ ...VALID, driver: { ...VALID.driver!, budget } })
          .success,
      ).toBe(true);
    }
    // A context-only input (the builder's enrichment before knobs are layered) parses.
    expect(
      SweepUnitDispatchInputSchema.safeParse({
        repoRoot: '/repo',
        worktreesDir: 'worktrees',
        runPrefix: 'cq/09-16a',
        base: 'main',
        package: 'alpha',
        fixer: 'fix',
        files: [],
      }).success,
    ).toBe(true);
    // Unknown keys are refused (strict).
    expect(SweepUnitDispatchInputSchema.safeParse({ ...VALID, evil: true }).success).toBe(false);
    // The S4b-B2 keys are GONE from the plan-JSON driver config (ADR-0002
    // §2.3/§2.5 — plan data never names an executable or a lane): the strict
    // schema REJECTS each of binary/routingTable/sessionsDir; those knobs
    // moved into DriverFactoryConfig.lanes.subprocess.
    const baseDriver = { ...VALID.driver! };
    const bannedDrivers: Record<string, unknown>[] = [
      { ...baseDriver, binary: ['node', '/opt/agent.mjs'] },
      {
        ...baseDriver,
        routingTable: {
          endpoints: { 'cq-e2e': { baseUrlEnv: 'X', models: ['sweep-fake'] } },
        },
      },
      { ...baseDriver, sessionsDir: '/tmp/sweep-sessions' },
    ];
    for (const driver of bannedDrivers) {
      const key = Object.keys(driver).filter((candidate) => !(candidate in baseDriver));
      expect(
        SweepUnitDispatchInputSchema.safeParse({ ...VALID, driver }).success,
        `driver.${key.join(',')} must be rejected`,
      ).toBe(false);
    }
    // A driver section without a model is refused.
    const driverWithoutModel: Record<string, unknown> = { ...baseDriver };
    delete driverWithoutModel.model;
    expect(
      SweepUnitDispatchInputSchema.safeParse({
        ...VALID,
        driver: driverWithoutModel,
      } as unknown).success,
    ).toBe(false);
  });
});
