// Gates lane C1+C2+C3 — registry slice: the `gates.checkRunner`,
// `gates.baselineProbe`, `gates.regressionGate`, `gates.hackDetector`,
// `gates.commitGate` and (W1.9) `gates.policyDiff` op entries, typed
// against the FROZEN OpRegistryEntry (src/kernel/types.ts). The probe's
// importer binds the default subprocess runner — the lane's only I/O
// wiring — through DYNAMIC imports, so loading the registry never loads an
// op module: module scope imports only zod and
// types (the type-only imports are erased at compile time), keeping the
// lazy-import pattern. The zod schemas are registry-time mirrors of the
// lane's types and live HERE (the shared spot, C1's CheckRunnerInputSchema
// precedent) because `inputSchema` must exist eagerly while the ops may
// not.
import { z } from 'zod';
import type { Op, OpRegistryEntry } from '../../kernel/types.js';
import type { BaselineProbeInput } from './baselineProbe.js';
import type { CheckFailure, CheckRunnerInput, FailureSet } from './checkRunner.js';
import type { CommitGateInput } from './commitGate.js';
import type { FingerprintConfig } from './fingerprint.js';
import type { HackDetectorInput } from './hackDetector.js';
import type { PolicyDiffInput, PolicyDiffOutcome } from './policyDiff.js';
import type { RegressionGateInput } from './regressionGate.js';
// Shared protected-path taxonomy helper: './protectedPaths.js'.
// gates.policyDiff helpers (W1.9), reached through './policyDiff.js': the
// workflow scanner './workflowScan.js' and the override record
// './overrideRecord.js'; the posture resolver './policyConfig.js' is bound
// by the importer below.

/**
 * Registry-time mirror of {@link CheckRunnerInput}: the full input, and
 * only it. `timeoutMs` defaults to 600_000 here — a 10-minute default
 * applied at the OP boundary only, so a JSON-dispatched check is capped
 * even when the input omits a timeout (a zod `.default`, not a minimum;
 * the library-level {@link CheckCommand} stays timeout-optional). The
 * concrete object is kept so the baseline-probe schema can COMPOSE its
 * adapter/command shapes from this single source.
 */
const CheckRunnerInputObject = z
  .object({
    adapter: z.enum(['vitest-json', 'eslint-json', 'tsc-lines']),
    // Strict: an unknown key inside command (a typo'd timeoutMS) must fail
    // loudly, not be silently stripped into an uncapped-looking input.
    command: z
      .object({
        command: z.string(),
        args: z.array(z.string()),
        cwd: z.string().exactOptional(),
        timeoutMs: z.number().int().positive().default(600_000),
      })
      .strict(),
  })
  .strict();

export const CheckRunnerInputSchema: z.ZodType<CheckRunnerInput> = CheckRunnerInputObject;

/**
 * Registry-time mirror of {@link BaselineProbeInput}: the full input, and
 * only it — no baseline or cache field exists to hide memoization behind
 * (I7). The adapter and command schemas are COMPOSED from
 * {@link CheckRunnerInputSchema}'s object (one source, no drift), including
 * its 600_000ms op-boundary `timeoutMs` DEFAULT (a zod `.default`, not a
 * minimum). Bail fields validate only — patterns are non-empty strings and
 * retries are bounded at this boundary — while the shipped defaults
 * (patterns, 2 retries) are applied by the op itself.
 */
export const BaselineProbeInputSchema: z.ZodType<BaselineProbeInput> = z
  .object({
    adapter: CheckRunnerInputObject.shape.adapter,
    command: CheckRunnerInputObject.shape.command,
    bail: z
      .object({
        // min(1): an empty pattern makes includes('') vacuously true —
        // a permanent bail on every attempt.
        bailPatterns: z.array(z.string().min(1)).exactOptional(),
        // Bounded at the JSON boundary: retries multiply wall clock.
        maxBailRetries: z.number().int().min(0).max(10).exactOptional(),
      })
      .strict()
      .exactOptional(),
  })
  .strict();

/** Registry-time mirror of {@link FingerprintConfig}: the full object, and only it. */
export const FingerprintConfigSchema: z.ZodType<FingerprintConfig> = z
  .object({
    lineBucketSize: z.number().int().positive().exactOptional(),
    columnBucketSize: z.number().int().positive().exactOptional(),
    offsetBucketSize: z.number().int().positive().exactOptional(),
    rootDir: z.string().exactOptional(),
    tool: z.string().exactOptional(),
  })
  .strict();

/** Registry-time mirror of {@link CheckFailure}: the full failure, and only it. */
export const CheckFailureSchema: z.ZodType<CheckFailure> = z
  .object({
    file: z.string().nullable(),
    line: z.number().nullable(),
    column: z.number().nullable(),
    ruleId: z.string().nullable(),
    message: z.string(),
    severity: z.enum(['error', 'warning']),
  })
  .strict();

/** Registry-time mirror of {@link FailureSet}: the full set, and only it. */
export const FailureSetSchema: z.ZodType<FailureSet> = z
  .object({
    tool: z.string(),
    failures: z.array(CheckFailureSchema),
    exitCode: z.number().nullable(),
    numTotalTests: z.number().int().nonnegative().exactOptional(),
    numPassedTests: z.number().int().nonnegative().exactOptional(),
    numPassed: z.number().int().nonnegative().exactOptional(),
    numSkippedTests: z.number().int().nonnegative().exactOptional(),
    numPendingTests: z.number().int().nonnegative().exactOptional(),
    numTodoTests: z.number().int().nonnegative().exactOptional(),
  })
  .strict();

/**
 * Registry-time mirror of {@link RegressionGateInput}: the full input, and
 * only it — two FailureSets plus optional fingerprint config, all plain
 * JSON, with the FailureSet schema shared so the gate's input can never
 * drift from what `gates.checkRunner` produces.
 */
export const RegressionGateInputSchema: z.ZodType<RegressionGateInput> = z
  .object({
    base: FailureSetSchema,
    final: FailureSetSchema,
    config: FingerprintConfigSchema.exactOptional(),
  })
  .strict();

/**
 * Registry-time mirror of {@link HackDetectorInput}: the full input, and
 * only it. Pattern/regex sources validate as non-empty strings only — the
 * op compiles them with `new RegExp` and owns the `failed` mapping for
 * sources that do not compile; callers own their trustworthiness.
 */
export const HackDetectorInputSchema: z.ZodType<HackDetectorInput> = z
  .object({
    diff: z.string(),
    suppressionPatterns: z
      .array(
        z
          .object({
            name: z.string().min(1),
            pattern: z.string().min(1),
            flags: z.string().exactOptional(),
            requiresReason: z.boolean().exactOptional(),
          })
          .strict(),
      )
      .exactOptional(),
    tamper: z
      .object({
        testFilePatterns: z.array(z.string().min(1)).exactOptional(),
        detectDeletedTests: z.boolean().exactOptional(),
        detectNewSkipOnly: z.boolean().exactOptional(),
        skipOnlyPattern: z.string().min(1).exactOptional(),
        detectTautologies: z.boolean().exactOptional(),
      })
      .strict()
      .exactOptional(),
  })
  .strict();

/**
 * Registry-time mirror of {@link CommitGateInput}: the full input, and
 * only it. Regex-source fields are `.min(1)` — an empty pattern source
 * compiles and matches EVERYTHING vacuously, so it is rejected here as
 * config noise, not silently enforced as a rule that always fires. The
 * shipped default taxonomy lives in the commitGate module and is applied
 * by the op, not duplicated here.
 */
export const CommitGateInputSchema: z.ZodType<CommitGateInput> = z
  .object({
    message: z.string(),
    config: z
      .object({
        subjectPattern: z.string().min(1).exactOptional(),
        requireSubject: z.boolean().exactOptional(),
        trailers: z
          .array(
            z
              .object({
                name: z.string().min(1),
                required: z.boolean().exactOptional(),
                oneOf: z.array(z.string().min(1)).exactOptional(),
                pattern: z.string().min(1).exactOptional(),
              })
              .strict(),
          )
          .exactOptional(),
        outcomeTrailer: z.string().min(1).exactOptional(),
        implications: z
          .array(
            z
              .object({ outcomeValue: z.string().min(1), subjectPattern: z.string().min(1) })
              .strict(),
          )
          .exactOptional(),
      })
      .strict()
      .exactOptional(),
  })
  .strict();

/**
 * Registry-time mirror of {@link PolicyDiffInput} (W1.9, D11): the full
 * input, and only it. STRICT and deliberately WITHOUT a posture field — the
 * posture comes from the project env / per-call opt-in at dispatch
 * (RS-15 Annex B §B.1), never from plan JSON or op input, so a subject
 * cannot relax its own check. Numeric ids are positive integers.
 */
export const PolicyDiffInputSchema: z.ZodType<PolicyDiffInput> = z
  .object({
    repo: z.string().min(1),
    trustRef: z.string().min(1),
    subject: z.string().min(1),
    subjectKind: z.enum(['pr', 'push']),
    base: z.string().min(1),
    pr: z.number().int().positive().exactOptional(),
    repository: z.string().min(1).exactOptional(),
    ownerId: z.number().int().positive().exactOptional(),
    labelEventsPath: z.string().min(1).exactOptional(),
    settleRef: z.string().min(1).exactOptional(),
  })
  .strict();

/** Gates-lane op registry (C1 runner; C2 probe + gate; C3 hack detector + commit gate). */
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
    // Same seam contract as checkRunner: the importer resolves BOTH the op
    // module and the runner through dynamic imports — no op wiring exists
    // at registry module scope.
    importer: () =>
      Promise.all([import('./baselineProbe.js'), import('./checkRunner.js')]).then(
        ([m, runner]) => m.makeBaselineProbe(runner.subprocessRunCheck) as Op<unknown, unknown>,
      ),
  },
  {
    name: 'gates.regressionGate',
    inputSchema: RegressionGateInputSchema,
    importer: () =>
      import('./regressionGate.js').then((m) => m.regressionGate as Op<unknown, unknown>),
  },
  {
    name: 'gates.hackDetector',
    inputSchema: HackDetectorInputSchema,
    // Pure decision op — no injected defaults, the importer IS the op.
    importer: () => import('./hackDetector.js').then((m) => m.hackDetector as Op<unknown, unknown>),
  },
  {
    name: 'gates.commitGate',
    inputSchema: CommitGateInputSchema,
    importer: () => import('./commitGate.js').then((m) => m.commitGate as Op<unknown, unknown>),
  },
  {
    name: 'gates.policyDiff',
    inputSchema: PolicyDiffInputSchema,
    // The D11 policy check (W1.9). The posture is resolved ONCE per dispatch
    // from the project env (the per-call opt-in is W3.6's CLI flag) and bound
    // into the op; an invalid posture value is `failed`, never a fallback.
    importer: () =>
      Promise.all([import('./policyDiff.js'), import('./policyConfig.js')]).then(([m, cfg]) => {
        const op: Op<PolicyDiffInput, PolicyDiffOutcome> = async (input) => {
          let config;
          try {
            config = cfg.resolveProtectedPathsConfig({ env: process.env });
          } catch (err) {
            return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
          }
          return m.createPolicyDiff(config)(input);
        };
        return op as Op<unknown, unknown>;
      }),
  },
];
