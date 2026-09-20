// PR family registry slice (goal D3) — the `pr.assemblePrs` and
// `pr.runReport` op entries, typed against the FROZEN OpRegistryEntry
// (src/kernel/types.ts). THE LAZY RULE (gates/merge precedent, kept
// exactly): module scope imports ONLY zod plus type-only imports (erased at
// compile time) — loading this registry never loads an op module or the gh
// subprocess transport; every op is reached through its entry's dynamic
// import at dispatch. That rule is also why the zod mirrors live HERE (the
// shared spot) rather than being imported from the op modules.
//
// DRIFT PINNING: every mirror is annotated `z.ZodType<T>` against the op's
// hand-written input type (type-only import) — a schema whose output drifts
// from the type fails typecheck.
//
// THE PREFIX RULES AS REFINEMENTS (the fleet's namespace, UC row 22): every
// PR head — tracker AND per-package — must start `<runPrefix>/`. The
// cross-field check cannot be a per-field string rule, so it rides a
// `.refine` on the composed object; the op re-checks at its own boundary
// (the library-level `failed` contract) and names the offending entry.
//
// EFFECTS ARE BOUND PER DISPATCH (the merge importer precedent): each
// entry's importer dynamically imports the op module AND ghEffects.js and
// binds makeSubprocessPrEffects from the INPUT's plain-JSON repoRoot — the
// registry entry carries no repo state. The construction is inert
// (closure-only; gh spawns only when an effect is CALLED), so resolving an
// entry never touches env, the network, or the filesystem.
import { z } from 'zod';
import type { Op, OpRegistryEntry } from '../../kernel/types.js';
import type { AssemblePrsInput } from './assemblePrs.js';
import type { EnsureTrackerBranchInput } from './ensureTrackerBranch.js';
import type { RunReportInput } from './runReport.js';

/**
 * Registry-time mirror of one per-package entry: non-empty name, branch,
 * title; an optional body. Strict: an unknown key must fail loudly, not be
 * silently stripped.
 */
const AssemblePrsPackageSchema = z
  .object({
    name: z.string().min(1),
    branch: z.string().min(1),
    title: z.string().min(1),
    body: z.string().exactOptional(),
  })
  .strict();

export const AssemblePrsInputSchema: z.ZodType<AssemblePrsInput> = z
  .object({
    repoRoot: z.string().min(1),
    runPrefix: z.string().min(1),
    base: z.string().min(1),
    tracker: z.object({ title: z.string().min(1), branch: z.string().min(1) }).strict(),
    packages: z.array(AssemblePrsPackageSchema),
    draft: z.boolean().exactOptional(),
  })
  .strict()
  .refine((input) => input.tracker.branch.startsWith(`${input.runPrefix}/`), {
    message:
      "tracker.branch must start with '<runPrefix>/' — the tracker PR lives under the run prefix (UC row 22: one tracker per run, in the run's namespace)",
  })
  .refine((input) => input.packages.every((pkg) => pkg.branch.startsWith(`${input.runPrefix}/`)), {
    message:
      "every packages[].branch must start with '<runPrefix>/' — the fleet's per-package PR branches live under the run prefix",
  });

export const EnsureTrackerBranchInputSchema: z.ZodType<EnsureTrackerBranchInput> = z
  .object({
    repoRoot: z.string().min(1),
    runPrefix: z.string().min(1),
    base: z.string().min(1),
    branch: z.string().min(1),
  })
  .strict()
  .refine((input) => input.branch.startsWith(`${input.runPrefix}/`), {
    message:
      "branch must start with '<runPrefix>/' — the tracker branch lives under the run prefix (UC row 22: one tracker per run, in the run's namespace)",
  });

export const RunReportInputSchema: z.ZodType<RunReportInput> = z
  .object({
    repoRoot: z.string().min(1),
    runPrefix: z.string().min(1),
    tracker: z.object({ number: z.number().int().positive() }).strict().exactOptional(),
    packages: z.array(
      z.object({ name: z.string().min(1), number: z.number().int().positive() }).strict(),
    ),
  })
  .strict();

/** PR family op registry (D3: tracker-first assembly + the fleet run report). */
export const registry: OpRegistryEntry[] = [
  {
    name: 'pr.ensureTrackerBranch',
    inputSchema: EnsureTrackerBranchInputSchema,
    // The tracker-branch leg binds the REAL git subprocess effects from the
    // dispatched input's plain-JSON repoRoot (the assemblePrs importer
    // precedent): resolution is inert (closure-only; git spawns only when an
    // effect is called).
    importer: () =>
      import('./ensureTrackerBranch.js').then(
        (m) =>
          (async (input: EnsureTrackerBranchInput) =>
            m.makeEnsureTrackerBranch(m.makeSubprocessTrackerBranchEffects(input.repoRoot))(
              input,
            )) as Op<unknown, unknown>,
      ),
  },
  {
    name: 'pr.assemblePrs',
    inputSchema: AssemblePrsInputSchema,
    // The dispatch seam re-validates input through inputSchema.parseAsync
    // before invoking the op, so the erased op typing is safe here. The
    // importer resolves the op module AND the real gh subprocess effects
    // and binds them INPUT-DRIVEN — repoRoot crosses the plain-JSON
    // boundary from the DISPATCHED input; nothing is wired at registry
    // module scope, and the effects construction is inert (closure-only).
    importer: () =>
      Promise.all([import('./assemblePrs.js'), import('./ghEffects.js')]).then(
        ([m, effects]) =>
          (async (input: AssemblePrsInput) =>
            m.makeAssemblePrs(effects.makeSubprocessPrEffects(input.repoRoot))(input)) as Op<
            unknown,
            unknown
          >,
      ),
  },
  {
    name: 'pr.runReport',
    inputSchema: RunReportInputSchema,
    // Same seam, same input-driven binding: the run report's readiness
    // reads (and the optional tracker update) run through the real gh
    // subprocess effects bound to the dispatched input's repoRoot.
    importer: () =>
      Promise.all([import('./runReport.js'), import('./ghEffects.js')]).then(
        ([m, effects]) =>
          (async (input: RunReportInput) =>
            m.makeRunReport(effects.makeSubprocessPrEffects(input.repoRoot))(input)) as Op<
            unknown,
            unknown
          >,
      ),
  },
];
