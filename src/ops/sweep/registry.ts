// Sweep lane (WS-D, goals D1+D2) — registry slice: the `sweep.planSweep`,
// `sweep.worktreeFor`, `sweep.salvage` and `sweep.cleanup` op entries, typed
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
import type { Op, OpRegistryEntry } from '../../kernel/types.js';
import { LedgerThresholdsOverrideSchema } from '../ledger/registry.js';
import type { CleanupInput } from './cleanup.js';
import type { PlanSweepInput } from './planSweep.js';
import type { SalvageInput } from './salvage.js';
import type { WorktreeForInput, WorktreeMutexConfig } from './worktreeFor.js';

// TYPE-ONLY re-export of the git-mutation mutex's config type: gitMutex.ts
// is a LIBRARY utility, never a registered op, and this reference is the
// family convention's HELPER-REFERENCE excusal (the ledger registry's
// type-only imports of ledger.js are the precedent) — it marks the module
// as registry-referenced so the completeness heuristic does not demand a
// `sweep.gitMutex` entry. Consumers of WorktreeForInputSchema need the
// config shape to build the input's mutex block anyway.
export type { GitMutexConfig } from './gitMutex.js';

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
const PlanSweepSelectorSchema = z.discriminatedUnion('mode', [
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
 * well within); the op itself stays lenient on this advisory data.
 */
const PlanSweepBaselineSchema = z
  .object({
    package: z.string().min(1),
    signature: z.string().min(1).max(500),
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

/** Sweep-lane op registry (planSweep, worktreeFor, salvage, cleanup). */
export const registry: OpRegistryEntry[] = [
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
      import('./worktreeFor.js').then(
        (m) =>
          (async (input: WorktreeForInput) =>
            m.makeWorktreeFor(m.makeSubprocessWorktreeEffects(input.repoRoot))(input)) as Op<
            unknown,
            unknown
          >,
      ),
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
      import('./cleanup.js').then(
        (m) =>
          (async (input: CleanupInput) =>
            m.makeCleanup(m.makeSubprocessCleanupEffects(input.repoRoot))(input)) as Op<
            unknown,
            unknown
          >,
      ),
  },
];
