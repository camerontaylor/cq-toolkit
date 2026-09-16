// Sweep lane (WS-D, goal D1) — registry slice: the `sweep.planSweep` and
// `sweep.worktreeFor` op entries, typed against the FROZEN OpRegistryEntry
// (src/kernel/types.ts). gitMutex is a library utility, NOT an op — it must
// never appear here. The importers bind the REAL effects INPUT-DRIVEN —
// repoRoot (and, for the planner's ledger consult, root + storePath) cross
// the plain-JSON boundary from the DISPATCHED input; both op modules load
// through DYNAMIC imports, so loading this registry never loads an op
// module: module scope imports only zod and types (the type-only imports
// are erased at compile time), keeping the lazy-import pattern. The zod
// schemas are registry-time mirrors of the lane's types and live HERE (the
// shared spot, the ledger registry's LedgerRecordInputSchema precedent)
// because `inputSchema` must exist eagerly while the ops may not.
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
import type { PlanSweepInput } from './planSweep.js';
import type { WorktreeForInput } from './worktreeFor.js';

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
 * Registry-time mirror of {@link WorktreeForInput} (the git-mutex binding
 * only — gitMutex itself is a library utility and is never registered).
 * The mutex bounds mirror {@link makeGitMutex}'s construction preconditions
 * (staleMs ≥ 2000 — proper-lockfile's clamp floor; retries ≥ 0;
 * retryBaseMs ≥ 1): the schema rejects what the mutex would throw on, at
 * the arg-error boundary instead of mid-dispatch. The worktree segment /
 * traversal rules (kind, slug, runPrefix) stay the op's library-level
 * contract (`failed` results) — they are path-SAFETY rules about DERIVED
 * values, not plain-JSON shape.
 */
export const WorktreeForInputSchema: z.ZodType<WorktreeForInput> = z
  .object({
    repoRoot: z.string().min(1),
    worktreesDir: z.string().min(1),
    runPrefix: z.string().min(1),
    kind: z.string().min(1),
    slug: z.string().min(1),
    base: z.string().min(1),
    mutex: z
      .object({
        lockPath: z.string().min(1),
        staleMs: z.number().int().min(2000).exactOptional(),
        retries: z.number().int().min(0).exactOptional(),
        retryBaseMs: z.number().int().min(1).exactOptional(),
      })
      .strict()
      .exactOptional(),
    baselineCacheDirs: z.array(z.string().min(1)).exactOptional(),
  })
  .strict();

/** Sweep-lane op registry (planSweep + worktreeFor). */
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
];
