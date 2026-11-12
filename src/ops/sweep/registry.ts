// Sweep lane (WS-D, goals D1+D2+D4) — registry slice: the `sweep.planSweep`,
// `sweep.worktreeFor`, `sweep.unit`, `sweep.salvage` and `sweep.cleanup` op
// entries, typed
// against the FROZEN OpRegistryEntry (src/kernel/types.ts). gitMutex is a
// library utility, NOT an op — it must never appear here. The importers bind
// the REAL effects INPUT-DRIVEN — repoRoot (and, for the planner's ledger
// consult, root + storePath) cross the plain-JSON boundary from the
// DISPATCHED input; all four op modules load through DYNAMIC imports, so
// loading this registry never loads an op module: module scope imports only
// zod and types (the type-only imports are erased at compile time), keeping
// the lazy-import pattern. The zod schemas are registry-time mirrors of the
// lane's types and live HERE (the shared spot, the ledger registry's
// LedgerRecordInputSchema precedent) because `inputSchema` must exist
// eagerly while the ops may not.
//
// THE SELECTOR IS REQUIRED AT THE SCHEMA (UC §1 row 16 — no default): a
// selector-less input fails schema validation, which lands on the CLI's
// generic missing-required-field path (exit 2, no op ever ran) — the
// mapping is pinned at test/cli/i1.test.ts:196 ('missing required field:
// exit 2'). The op keeps its own library-level `failed` result for the
// same condition: the schema is the JSON/CLI boundary, the op-level check
// is the library boundary, and neither is allowed to default.
import { z } from 'zod';
import { BudgetSchema, SandboxPolicySchema, ToolPolicySchema } from '../../kernel/schema.js';
import { errorClassOf } from '../../driver/errors.js';
import { createDriverFactory, type DriverFactoryConfig } from '../../driver/factory.js';
import type { Op, OpRegistryEntry } from '../../kernel/types.js';
import type { ObservationWriter } from '../../kernel/observation.js';
import { LedgerThresholdsOverrideSchema } from '../ledger/registry.js';
import type { CleanupInput } from '../../adapters/git/cleanup.js';
import { fixerBudgetFault } from './internal/fixerBudget.js';
import type { PlanSweepInput, WorkUnit } from './planSweep.js';
import type { SalvageInput } from './salvage.js';
import type { SweepUnitDispatchInput, SweepUnitReport } from './unit.js';
import type { WorktreeForInput, WorktreeMutexConfig } from '../../adapters/git/worktreeFor.js';

// TYPE-ONLY re-export of the git-mutation mutex's config type: the helper
// itself is a LIBRARY utility, never a registered op, and lives in
// src/shared/gitMutex.ts (migration Phase 1.3). The re-export stays so
// consumers of WorktreeForInputSchema keep one import site for the config
// shape they need to build the input's mutex block.
export type { GitMutexConfig } from '../../shared/gitMutex.js';

/**
 * Registry-time mirror of {@link PlanSweepPackage}: a non-empty name and a
 * non-empty repo-root-relative path prefix. Strict: an unknown key must
 * fail loudly, not be silently stripped.
 */
const PlanSweepPackageSchema = z
  .object({
    name: z.string().min(1),
    path: z.string().min(1),
  })
  .strict();

/**
 * The REQUIRED selector — a discriminated union with NO default branch and
 * no literal fallback (UC §1 row 16). `mode` is the discriminator; an
 * unknown mode fails the union, an ABSENT selector fails the required-key
 * check. Segment/traversal safety of the package names (explicit) is the
 * op's library-level contract — the schema enforces the plain-JSON shape.
 */
export const PlanSweepSelectorSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('workspace-all') }).strict(),
  z.object({ mode: z.literal('changed-vs-base'), base: z.string().min(1) }).strict(),
  z.object({ mode: z.literal('explicit'), packages: z.array(z.string().min(1)).min(1) }).strict(),
]);

/**
 * Registry-time mirror of {@link PlanSweepLedgerConfig}: root + storePath
 * are REQUIRED (the registry-bound ledger store is built from them per
 * dispatch), thresholds reuse the LEDGER registry's override schema so the
 * pairwise invariant (escalateAt > suppressAt) has ONE definition — the
 * op-level resolved-pair validation still runs at the ledger query.
 */
const PlanSweepLedgerConfigSchema = z
  .object({
    root: z.string().min(1),
    storePath: z.string().min(1),
    thresholds: LedgerThresholdsOverrideSchema.exactOptional(),
  })
  .strict();

/**
 * One per-package baseline signature. The signature bound mirrors the
 * ledger's committed-entry bound (1..500 — the recipe's 8-hex output is
 * well within); the op itself stays lenient on this advisory data. The
 * optional `legacySignature` (scheme-1 signature, escalation-only) carries
 * the same bound.
 */
const PlanSweepBaselineSchema = z
  .object({
    package: z.string().min(1),
    signature: z.string().min(1).max(500),
    legacySignature: z.string().min(1).max(500).exactOptional(),
  })
  .strict();

/**
 * Registry-time mirror of {@link PlanSweepInput}: the full input, and only
 * it. `selector` is REQUIRED — this is where a selector-less dispatch dies
 * as a CLI arg error (exit 2) instead of ever reaching the op. `fixers`
 * must be a non-empty array of non-empty labels (the op additionally
 * deduplicates, set semantics). `packageFiles` maps package name → known
 * file-set; an empty-string path would be noise, so paths are min(1).
 */
export const PlanSweepInputSchema: z.ZodType<PlanSweepInput> = z
  .object({
    repoRoot: z.string().min(1),
    packages: z.array(PlanSweepPackageSchema),
    selector: PlanSweepSelectorSchema,
    fixers: z.array(z.string().min(1)).min(1),
    ledger: PlanSweepLedgerConfigSchema.exactOptional(),
    baselineSignatures: z.array(PlanSweepBaselineSchema).exactOptional(),
    packageFiles: z.record(z.string(), z.array(z.string().min(1))).exactOptional(),
  })
  .strict();

/**
 * Registry-time mirror of the OPTIONAL git-mutex binding shared by
 * `sweep.worktreeFor` and `sweep.cleanup` (one definition, so the
 * construction preconditions and the crash-recovery cross-field invariant
 * have exactly ONE — gitMutex itself is a library utility and is never
 * registered). The bounds mirror {@link makeGitMutex}'s construction
 * preconditions (staleMs ≥ 2000 — proper-lockfile's clamp floor; retries ≥ 0;
 * retryBaseMs ≥ 1) AND its crash-recovery cross-field invariant: the backoff
 * floor (retryBaseMs × (2^retries − 1)) must reach the stale window, using
 * the factory's shipped defaults for absent fields (30_000 / 9 / 100 — a
 * literal mirror; importing the constants would load the mutex module at
 * registry scope). The schema rejects an individually-valid but
 * collectively-insufficient triple at the arg-error boundary (exit 2)
 * instead of mid-dispatch.
 */
const MUTEX_DEFAULT_STALE_MS = 30_000;
const MUTEX_DEFAULT_RETRIES = 9;
const MUTEX_DEFAULT_RETRY_BASE_MS = 100;

const GitMutexBindingSchema: z.ZodType<WorktreeMutexConfig> = z
  .object({
    lockPath: z.string().min(1),
    staleMs: z.number().int().min(2000).exactOptional(),
    retries: z.number().int().min(0).exactOptional(),
    retryBaseMs: z.number().int().min(1).exactOptional(),
  })
  .strict()
  .refine(
    (m) => {
      const staleMs = m.staleMs ?? MUTEX_DEFAULT_STALE_MS;
      const retries = m.retries ?? MUTEX_DEFAULT_RETRIES;
      const retryBaseMs = m.retryBaseMs ?? MUTEX_DEFAULT_RETRY_BASE_MS;
      return retryBaseMs * (2 ** retries - 1) >= staleMs;
    },
    {
      message:
        'the mutex timings are individually valid but collectively insufficient — the retry backoff floor (retryBaseMs × (2^retries − 1), on the factory defaults for absent fields) must reach the stale window, or a crashed holder wedges the run',
    },
  );

export const WorktreeForInputSchema: z.ZodType<WorktreeForInput> = z
  .object({
    repoRoot: z.string().min(1),
    worktreesDir: z.string().min(1),
    runPrefix: z.string().min(1),
    kind: z.string().min(1),
    slug: z.string().min(1),
    base: z.string().min(1),
    mutex: GitMutexBindingSchema.exactOptional(),
    baselineCacheDirs: z.array(z.string().min(1)).exactOptional(),
  })
  .strict();

/**
 * Registry-time mirror of {@link SalvageInput}: the interrupted-trees
 * inventory the CALLER scanned. Element shape only — the traversal/flag/
 * control-char path rules and the journal semantics stay the op's
 * library-level contract (`failed` results); they are path-SAFETY and
 * classification rules, not plain-JSON shape. `discardDirty` is the
 * explicit-only flag: absent means dirty entries classify `preserve`.
 */
export const SalvageInputSchema: z.ZodType<SalvageInput> = z
  .object({
    repoRoot: z.string().min(1),
    entries: z.array(
      z
        .object({
          path: z.string().min(1),
          branch: z.string().min(1).exactOptional(),
          runPrefix: z.string().min(1).exactOptional(),
          journal: z
            .object({
              lastStep: z.string().min(1).exactOptional(),
              stepsTotal: z.number().int().min(0).exactOptional(),
              allTerminal: z.boolean().exactOptional(),
            })
            .strict()
            .exactOptional(),
        })
        .strict(),
    ),
    discardDirty: z.boolean().exactOptional(),
  })
  .strict();

/**
 * Registry-time mirror of {@link CleanupInput}. `olderThanMs` is REQUIRED
 * and bounds-checked here (integer ≥ 0) — an age cutoff is the op's one
 * numeric precondition. The mutex block reuses the shared
 * {@link GitMutexBindingSchema} (one definition of the timings invariant).
 * The dry-run default (true when absent) and the force/dirty ladder stay
 * the op's library-level contract.
 */
export const CleanupInputSchema: z.ZodType<CleanupInput> = z
  .object({
    repoRoot: z.string().min(1),
    worktreesDir: z.string().min(1),
    runPrefix: z.string().min(1),
    olderThanMs: z.number().int().min(0),
    dryRun: z.boolean().exactOptional(),
    force: z.boolean().exactOptional(),
    mutex: GitMutexBindingSchema.exactOptional(),
  })
  .strict();

/**
 * Registry-time mirror of {@link SweepUnitDispatchInput} — the registered
 * 'sweep.unit' op's dispatch input (the enriched plan job's input): the unit
 * (package/fixer/files) plus the run context plus the JSON-serializable
 * binding knobs. `driver` and `check` are OPTIONAL here (a plan can be
 * authored before its fixer/probe wiring is chosen — the sweep floor and the
 * builder's context-only enrichment parse) and REQUIRED at binding time:
 * bindingsFromDispatch refuses without them, and the dispatch seam folds the
 * refusal into an honest `failed` naming the field. Strict: an unknown key
 * must fail loudly.
 */
export const SweepUnitDispatchInputSchema: z.ZodType<SweepUnitDispatchInput> = z
  .object({
    repoRoot: z.string().min(1),
    worktreesDir: z.string().min(1).exactOptional(),
    install: z
      .object({
        command: z.string().min(1),
        args: z.array(z.string()),
        timeoutMs: z.number().int().min(1).exactOptional(),
      })
      .strict()
      .exactOptional(),
    runPrefix: z.string().min(1),
    base: z.string().min(1),
    package: z.string().min(1),
    fixer: z.string().min(1),
    files: z.array(z.string()),
    kind: z.string().min(1).exactOptional(),
    slug: z.string().min(1).exactOptional(),
    mode: z.enum(['fix', 'prep']).exactOptional(),
    taskLoop: z
      .object({
        source: z.enum(['tests', 'static']).exactOptional(),
        denylistPatternsFile: z.string().min(1).exactOptional(),
        relatedArgs: z
          .array(z.string())
          .refine(
            (args) => args.includes('{files}'),
            'relatedArgs must include a standalone {files} token',
          )
          .exactOptional(),
        protectTests: z.boolean().exactOptional(),
        wallMs: z.number().int().positive().exactOptional(),
        pushFailed: z.boolean().exactOptional(),
      })
      .strict()
      .exactOptional(),
    proposeOnly: z.boolean().exactOptional(),
    mutex: GitMutexBindingSchema.exactOptional(),
    sandboxPolicy: SandboxPolicySchema.exactOptional(),
    gitTimeoutMs: z.number().int().min(1).exactOptional(),
    // The caller's run-state trust vouch (review-debt #174): explicitly
    // supplied, it authorizes the strand-retry's scanned-commit record.
    runStateDir: z.string().min(1).exactOptional(),
    push: z.boolean().exactOptional(),
    stagePathAllowlist: z
      .object({ patterns: z.array(z.string().min(1)).min(1) })
      .strict()
      .exactOptional(),
    driver: z
      .object({
        // PLAN DATA names NO executable and NO lane (ADR-0002 §2.5, P1):
        // {provider, model} is the factory's RESOLUTION INPUT; the lane and
        // its construction knobs (subprocess binary/routing table/sessions
        // dir) live in the deployment's DriverFactoryConfig. The S4b-B2
        // keys (binary, routingTable, sessionsDir) are REMOVED in this
        // bump — the strict schema rejects plans carrying them.
        provider: z.string().min(1),
        model: z.string().min(1),
        toolPolicy: ToolPolicySchema.exactOptional(),
        // Fail closed (PR #246 review): wallClockMs is REQUIRED — the only
        // cap sweep.unit enforces while the fixer runs; maxTokens/maxUsd are
        // optional post-run landing gates; maxAttempts is refused (the
        // rescue lane owns attempts). See internal/fixerBudget.ts.
        budget: BudgetSchema.superRefine((budget, ctx) => {
          const fault = fixerBudgetFault(budget);
          if (fault !== null) ctx.addIssue({ code: 'custom', message: `driver.budget: ${fault}` });
        }),
      })
      .strict()
      .exactOptional(),
    check: z
      .object({
        adapter: z.enum([
          'vitest-json',
          'eslint-json',
          'tsc-lines',
          'oxfmt-check',
          'oxlint-json',
          'ruff-json',
          'knip-json',
          'test-narrow',
        ]),
        cwd: z
          .string()
          .refine(
            (path) =>
              !path.startsWith('/') && !path.includes('\\') && !path.split('/').includes('..'),
            'cwd must be repository-relative',
          )
          .exactOptional(),
        command: z.string().min(1),
        args: z.array(z.string()),
        timeoutMs: z.number().int().min(1).exactOptional(),
      })
      .strict()
      .exactOptional(),
    promptTemplate: z.string().min(1).exactOptional(),
  })
  .strict();

const registryEntries: OpRegistryEntry[] = [
  {
    name: 'sweep.planSweep',
    inputSchema: PlanSweepInputSchema,
    // The dispatch seam re-validates input through inputSchema.parseAsync
    // before invoking the op, so the erased op typing is safe here. The
    // importer resolves the op module through a DYNAMIC import and binds
    // the REAL effects INPUT-DRIVEN — the returned op constructs
    // makeSubprocessSweepPlannerDeps(repoRoot) per dispatch, so repoRoot
    // (and the ledger consult's root + storePath) always come from the
    // dispatched input; no op wiring exists at registry module scope.
    importer: () =>
      import('./planSweep.js').then(
        (m) =>
          (async (input: PlanSweepInput) =>
            m.makePlanSweep(m.makeSubprocessSweepPlannerDeps(input.repoRoot))(input)) as Op<
            unknown,
            unknown
          >,
      ),
  },
  {
    name: 'sweep.worktreeFor',
    inputSchema: WorktreeForInputSchema,
    // Same seam, same input-driven binding: the worktree effects adapter is
    // bound to the dispatched input's repoRoot per call.
    importer: () =>
      import('../../adapters/git/worktreeFor.js').then(
        (m) =>
          (async (input: WorktreeForInput) =>
            m.makeWorktreeFor(m.makeSubprocessWorktreeEffects(input.repoRoot))(input)) as Op<
            unknown,
            unknown
          >,
      ),
  },
  {
    name: 'sweep.unit',
    inputSchema: SweepUnitDispatchInputSchema,
    // The dispatch seam re-validates input through inputSchema.parseAsync
    // before invoking the op, so the erased op typing is safe here. The
    // importer resolves the unit-composition module and binds the REAL
    // effects INPUT-DRIVEN (the worktreeFor precedent): the subprocess
    // worktree adapter, the real probe runner, and the real git push — all
    // constructed per dispatch from the dispatched input; the registry
    // entry carries no run state. THE DRIVER FACTORY MEDIATES CONSTRUCTION
    // (ADR-0002 §2.5 — createDriverFactory is NOT a lane module): the
    // DEFAULT binding resolves role 'fixer' to the ai-sdk lane for the
    // default providers (zai/anthropic/openai/deepseek); the subprocess
    // lane (or claude-agent/acp) runs ONLY when the deployment's factory
    // config binds it — a sweep that wants the CLI lane binds it explicitly
    // in the deployment's DriverFactoryConfig (bindings + lanes.subprocess
    // knobs), never in plan JSON. The FACTORY owns the served-model
    // assertion; no lane class is constructed here, statically or
    // dynamically. A binding refusal (no driver or check config) is an
    // honest `failed` naming the field; a factory RESOLVE throw is a §2.9
    // PRE-DISPATCH failure (an unbound provider/role is classified
    // 'config') → `needs-human` naming the provider/role.
    importer: makeSweepUnitImporter(undefined),
  },
  {
    name: 'sweep.salvage',
    inputSchema: SalvageInputSchema,
    // The salvage effects are repo-independent (the probes take the entry
    // path directly), so the binding is constructed per dispatch with no
    // input fields — still input-driven in the family sense: nothing is
    // wired at registry module scope.
    importer: () =>
      import('./salvage.js').then(
        (m) =>
          (async (input: SalvageInput) =>
            m.makeSalvage(m.makeSubprocessSalvageEffects())(input)) as Op<unknown, unknown>,
      ),
  },
  {
    name: 'sweep.cleanup',
    inputSchema: CleanupInputSchema,
    // Same seam, same input-driven binding: the cleanup effects adapter is
    // bound to the dispatched input's repoRoot per call (its listings reuse
    // the worktreeFor adapter's parsers; worktree remove carries NO force
    // flag unless the op's explicit force reached the effect).
    importer: () =>
      import('../../adapters/git/cleanup.js').then(
        (m) =>
          (async (input: CleanupInput) =>
            m.makeCleanup(m.makeSubprocessCleanupEffects(input.repoRoot))(input)) as Op<
            unknown,
            unknown
          >,
      ),
  },
];

/** Sweep-lane op registry (planSweep, worktreeFor, unit, salvage, cleanup). */
export const registry: OpRegistryEntry[] = makeRegistry();

/**
 * ADR-0008 T30: build the sweep-lane registry with a RUNTIME observation
 * writer. The `sweep.unit` entry's importer closes over the writer and adds
 * it to makeSweepUnitOp's RESOLVED RUNTIME BINDINGS only (the
 * {@link SweepUnitBindings.observationWriter} seam) — a callback is NEVER
 * serialized into plan JSON or the dispatch input. The exported default
 * `registry` is `makeRegistry()`: existing callers retain their behavior
 * unchanged. The fix composition caller is makeFixRun (src/ops/fix/runFix.ts).
 *
 * A deployment may also pass its `DriverFactoryConfig` here (ADR-0002 §2.5):
 * the lane bindings and per-lane construction knobs are DEPLOYMENT data, not
 * plan JSON, so a sweep that wants the subprocess/claude-agent/acp lane binds
 * it at this boundary. The dispatch-time alias-notice wiring still wins over
 * the deployment's own sink (the host's narration contract is per dispatch).
 */
export function makeRegistry(
  options: {
    /** ADR-0008 composition observation writer (src/kernel/observation.ts). */
    observationWriter?: ObservationWriter;
    /** The observation `runId` the writer was opened with (required with a writer). */
    observationRunId?: string;
    /**
     * The deployment's driver factory configuration (role→provider→lane
     * bindings plus per-lane construction knobs). Runtime-only deployment
     * data — never plan JSON.
     */
    driverFactory?: DriverFactoryConfig;
    /**
     * The deployment's run snapshot; the per-dispatch `wiring.cqEnv` still
     * wins when present, and absent both the factory reads ambient.
     * Runtime-only deployment data — never plan JSON.
     */
    cqEnv?: DriverFactoryConfig['cqEnv'];
  } = {},
): OpRegistryEntry[] {
  const observation = observationOf(options);
  return registryEntries.map((entry) =>
    entry.name !== 'sweep.unit'
      ? entry
      : {
          ...entry,
          importer: makeSweepUnitImporter(observation, options.driverFactory, options.cqEnv),
        },
  );
}

/** The observation options a makeRegistry-built sweep.unit importer closes over. */
type SweepObservation = ReturnType<typeof observationOf>;

function observationOf(options: {
  observationWriter?: ObservationWriter;
  observationRunId?: string;
}): { writer: ObservationWriter; runId: string } | undefined {
  return options.observationWriter === undefined
    ? undefined
    : {
        writer: options.observationWriter,
        runId: options.observationRunId ?? options.observationWriter.compositionRunId,
      };
}

/**
 * The sweep.unit importer with the T30 observation closure and the
 * deployment's driver factory config bound. Split from the array literal so
 * makeRegistry rebuilds the entry with the writer/config without duplicating
 * the dynamic module load or touching any other entry.
 */
function makeSweepUnitImporter(
  observation: SweepObservation,
  driverFactory?: DriverFactoryConfig,
  cqEnv?: DriverFactoryConfig['cqEnv'],
) {
  return async (wiring?: {
    onDeprecatedAlias?: (message: string) => void;
    cqEnv?: DriverFactoryConfig['cqEnv'];
  }): Promise<Op<unknown, unknown>> => {
    const m = await import('./unit.js');
    return (async (input: SweepUnitDispatchInput) => {
      try {
        const bindings = m.bindingsFromDispatch(
          input,
          createDriverFactory(
            factoryConfigOf(driverFactory, wiring?.onDeprecatedAlias, wiring?.cqEnv ?? cqEnv),
          ),
        );
        // ADR-0008 T30: the injected observation writer rides the RESOLVED
        // RUNTIME BINDINGS — never the serialized dispatch input (no
        // callback ever reaches plan JSON). Unit identity is the dispatched
        // package (the planned unit's identity).
        if (observation !== undefined) {
          bindings.observationWriter = observation.writer;
          bindings.observationRunId = observation.runId;
          bindings.observationUnitId = `${input.package}/${input.fixer}`;
        }
        const unitOp: Op<WorkUnit, SweepUnitReport> = m.makeSweepUnitOp(bindings);
        return await unitOp({
          package: input.package,
          fixer: input.fixer,
          files: input.files,
        });
      } catch (err) {
        // A CLASSIFIED throw (errorClassOf → 'config'/'auth') is the
        // factory's pre-dispatch refusal — an unbound provider/role is
        // deployment CONFIGURATION, the human's to arrange (review-debt
        // #186 / ADR-0002 §2.9), never `failed` (which would claim the
        // fixer ran and broke). Unclassified field refusals stay honest
        // `failed`s naming the field.
        if (errorClassOf(err) !== undefined) {
          return {
            status: 'needs-human',
            reason: err instanceof Error ? err.message : String(err),
          };
        }
        return {
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }) as unknown as Op<unknown, unknown>;
  };
}

/**
 * Compose the factory config at the registry boundary: the deployment's own
 * config (bindings/lanes) with the dispatch-time alias-notice sink and run
 * snapshot laid over it. The wiring sink is the host's per-dispatch
 * narration contract, so it wins over a deployment-level
 * `onDeprecatedAlias`; absent wiring keeps the deployment's sink (or the
 * library default when there is no config at all). The snapshot follows the
 * same layering for the session-logs read: the per-dispatch `wiring.cqEnv`
 * wins, then the deployment's `cqEnv`, then the ambient read. Both layers
 * preserve the deployment's other options unchanged.
 */
function factoryConfigOf(
  driverFactory: DriverFactoryConfig | undefined,
  onDeprecatedAlias: ((message: string) => void) | undefined,
  cqEnv?: DriverFactoryConfig['cqEnv'],
): DriverFactoryConfig {
  const sink = onDeprecatedAlias === undefined ? {} : { onDeprecatedAlias };
  if (cqEnv === undefined) return { ...driverFactory, ...sink };
  return { ...driverFactory, ...sink, cqEnv };
}

// Shared task and stage-path helpers: './tasks.js', './stagePaths.js', './taskLoop.js'.
