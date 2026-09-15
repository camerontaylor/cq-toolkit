// Gates lane C1+C2 — registry slice: the `gates.checkRunner`,
// `gates.baselineProbe`, and `gates.regressionGate` op entries, typed
// against the FROZEN OpRegistryEntry (src/kernel/types.ts). The probe's
// importer binds the default subprocess runner — the lane's only I/O
// wiring, sitting behind the injected RunCheck seam; the regression gate
// needs no wiring at all (pure decision op).
import { z } from 'zod';
import type { Op, OpRegistryEntry } from '../../kernel/types.js';
import type { BaselineProbeInput } from './baselineProbe.js';
import type { CheckRunnerInput } from './checkRunner.js';
import type { RegressionGateInput } from './regressionGate.js';
import { subprocessRunCheck } from './checkRunner.js';
import { FingerprintConfigSchema } from './fingerprint.js';
import { FailureSetSchema } from './regressionGate.js';

/**
 * Registry-time mirror of {@link CheckRunnerInput}: the full input, and only
 * it. `timeoutMs` defaults to 600_000 here — a 10-minute floor applied at
 * the OP boundary only, so a JSON-dispatched check can never run uncapped
 * (a watch-mode command hangs at most one timeout, not the job). The
 * library-level {@link CheckCommand} stays timeout-optional.
 */
export const CheckRunnerInputSchema: z.ZodType<CheckRunnerInput> = z
  .object({
    adapter: z.enum(['vitest-json', 'eslint-json', 'tsc-lines']),
    command: z.object({
      command: z.string(),
      args: z.array(z.string()),
      cwd: z.string().optional(),
      timeoutMs: z.number().int().positive().default(600_000),
    }),
  })
  .strict();

/**
 * Registry-time mirror of {@link BaselineProbeInput}: the full input, and
 * only it — no baseline or cache field exists to hide memoization behind
 * (I7). The command mirrors the checkRunner schema including the 600_000ms
 * op-boundary `timeoutMs` floor, for the same reason: a JSON-dispatched
 * check can never run uncapped. Bail fields validate only; the shipped
 * defaults (patterns, 2 retries) are applied by the op itself.
 */
export const BaselineProbeInputSchema: z.ZodType<BaselineProbeInput> = z
  .object({
    adapter: z.enum(['vitest-json', 'eslint-json', 'tsc-lines']),
    command: z.object({
      command: z.string(),
      args: z.array(z.string()),
      cwd: z.string().optional(),
      timeoutMs: z.number().int().positive().default(600_000),
    }),
    bail: z
      .object({
        bailPatterns: z.array(z.string()).optional(),
        maxBailRetries: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * Registry-time mirror of {@link RegressionGateInput}: the full input, and
 * only it — two FailureSets plus optional fingerprint config, all plain
 * JSON. Reuses {@link FailureSetSchema} so the gate's input can never drift
 * from what `gates.checkRunner` produces.
 */
export const RegressionGateInputSchema: z.ZodType<RegressionGateInput> = z
  .object({
    base: FailureSetSchema,
    final: FailureSetSchema,
    config: FingerprintConfigSchema.optional(),
  })
  .strict();

/** Gates-lane op registry (C1 runner; C2 adds the baseline probe + regression gate). */
export const registry: OpRegistryEntry[] = [
  {
    name: 'gates.checkRunner',
    inputSchema: CheckRunnerInputSchema,
    // The dispatch seam re-validates input through inputSchema.parseAsync
    // before invoking the op, so the erased op typing is safe here.
    importer: () =>
      import('./checkRunner.js').then(
        (m) => m.makeCheckRunner(m.subprocessRunCheck) as Op<unknown, unknown>,
      ),
  },
  {
    name: 'gates.baselineProbe',
    inputSchema: BaselineProbeInputSchema,
    // Same seam contract as checkRunner: the importer binds the default
    // subprocess runner; the op itself stays I/O-free beyond the seam.
    importer: () =>
      import('./baselineProbe.js').then(
        (m) => m.makeBaselineProbe(subprocessRunCheck) as Op<unknown, unknown>,
      ),
  },
  {
    name: 'gates.regressionGate',
    inputSchema: RegressionGateInputSchema,
    importer: () =>
      import('./regressionGate.js').then((m) => m.regressionGate as Op<unknown, unknown>),
  },
];
