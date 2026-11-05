// Split provenance: test/ops/sweep/unit-registry.test.ts was split into
// unit-registry.{registry,schema,bindings,install-hooks,staging-policy,push,run-state,task-worker}.test.ts
// plus this shared fixtures module. Everything below the fixtures banner moved
// unchanged; this header is the original file header, kept with the family.
//
// Sweep lane (goal D4) — the registered 'sweep.unit' entry (jSKJF): schema,
// importer binding, and the shipped push leg. Pinned here:
//   1. THE REGISTRY SURFACE (the D2-era pin, updated): the sweep family
//      registers exactly five ops — planSweep, worktreeFor, unit, salvage,
//      cleanup — with 'sweep.unit' dispatchable by name.
//   2. SCHEMA ACCEPT/REJECT: a fully-wired dispatch input parses; unknown
//      keys, a model-less driver section, AND the removed S4b-B2 plan-JSON
//      driver keys (binary/routingTable/sessionsDir — plan data never names
//      an executable, ADR-0002 §2.5/§2.3) are rejected at the boundary.
//   3. THE IMPORTER RESOLVES and the binding refuses the two honest
//      misconfigurations (no driver / no check config) with `failed` naming
//      the field — never a silent no-op. bindingsFromDispatch binds a
//      FACTORY (ADR-0002 §2.5): it resolves role 'fixer' once and the
//      bindings carry resolved.driver + the RESOLVED modelSpec.
//   4. THE PUSH LEG (jSKJL): the shipped makePushBranch publishes a local
//      branch to a real LOCAL BARE origin (offline), with the args-array
//      `push origin <branch>` argv (no `-u`: no shared config write).
import { rmSync } from 'node:fs';
import { afterAll } from 'vitest';
import type { DriverFactory, ResolvedDriver } from '../../../src/driver/factory.js';
import type { Driver, OpInvocation, WorkerResult } from '../../../src/driver/types.js';
import type { SweepUnitDispatchInput } from '../../../src/ops/sweep/unit.js';

export const CLEANUP: string[] = [];

/**
 * Per-file binding: registers the temp-dir sweep on the CALLING test file, so
 * each file's own CLEANUP array is swept at that file's teardown.
 */
export function registerCleanup(): void {
  afterAll(() => {
    for (const dir of CLEANUP) rmSync(dir, { recursive: true, force: true });
  });
}

/**
 * A FAKE factory (ADR-0002 §2.5): bindingsFromDispatch resolves role 'fixer'
 * through it ONCE — the fake records nothing (the dispatch-shape assertions
 * live in test/plans/sweep.runtime.test.ts's capturing driver) but hands back a
 * distinguished driver + RESOLVED spec, so the tests can pin that the
 * bindings carry the RESOLVED form (never the input's raw spec).
 */
export const FAKE_RESOLVED: ResolvedDriver = {
  driver: {
    run: async (_invocation: OpInvocation): Promise<WorkerResult> => {
      throw new Error('fake factory driver: not dispatched in this suite');
    },
  } satisfies Driver,
  lane: 'ai-sdk',
  modelSpec: { provider: 'resolved-zai', model: 'resolved-model' },
};
export const fakeFactory: DriverFactory = { resolve: () => FAKE_RESOLVED };

/** A fully-wired dispatch input (the shape an enriched plan job carries). */
export const VALID: SweepUnitDispatchInput = {
  repoRoot: '/repo',
  worktreesDir: 'worktrees',
  runPrefix: 'cq/09-16a',
  base: 'main',
  package: 'alpha',
  fixer: 'fix',
  files: ['packages/alpha/test/suite.test.js'],
  driver: {
    provider: 'cq-e2e',
    model: 'sweep-fake',
    budget: { wallClockMs: 600_000, maxUsd: 1 },
  },
  check: {
    adapter: 'tsc-lines',
    command: 'node',
    args: ['scripts/check.js', '{package}'],
    timeoutMs: 30_000,
  },
};
