// Plan subcommands — one per shipped plan (T4.3; ws-i scope item 2).
//
// THE GENERATION CONTRACT: the subcommand surface is DERIVED from the plan
// registry (src/plans/registry.ts, reached through the CLI's sanctioned
// registry boundary — src/registry/plans.ts). Adding a plan FILE
// `src/plans/<name>.ts` exporting `plan` registers `<name>` as a subcommand
// with no CLI edit, so the two surfaces cannot drift; there is exactly ONE
// dispatch block for all of them. This module is the generic dispatcher: it
// maps the plan-command flag surface (RunPlanCommandSchema — the run-plan
// knobs minus `--plan` and the run-plan-reserved `--ops-root`) onto the
// registry entry's plan and delegates to the recorded governed composition
// (runPlanThroughKernel: runPlan + withBudgetStop, I9). No plan logic lives
// here or anywhere under src/cli/**.
//
// THE PLAN IS THE REGISTRY FLOOR: a shipped plan is a parameterized BUILDER
// whose real instance needs per-run data the frozen Job schema cannot carry
// (a sweep's fan-out report, a review-loop's fetched state), so the CLI runs
// the entry's discoverable floor instance — the honest, schema-valid,
// agent-free pass. Real runs author the builder in the SDK / entry modules;
// `run-plan --plan=<file>` remains the way to run an arbitrary plan JSON.
import { PlanSchema } from '../kernel/schema.js';
import type { PlanRegistryEntry } from '../kernel/types.js';
import { listPlans } from '../registry/plans.js';
import { EXIT_CODES } from './exit.js';
import { narrate, type CliIo, type NarrationMode } from './output.js';
import {
  RunPlanCommandSchema,
  issueMessage,
  parseRunPlanInput,
  runPlanThroughKernel,
} from './run-plan.js';

/**
 * The plan-subcommand names, sorted — the CLI's plan surface, generated from
 * the plan registry (never a hand-written list). `plansRoot` is the
 * embedding/test DI override; the default root is the plan registry's own.
 */
export async function listPlanNames(plansRoot?: string): Promise<string[]> {
  const entries = await listPlans(plansRoot === undefined ? {} : { plansRoot });
  return entries.map((entry) => entry.name).sort();
}

/**
 * Run one plan SUBCOMMAND from its ALREADY-RESOLVED registry entry: parse the
 * shared governed-run flags, resolve the entry's floor plan, and run it
 * through the governed composition. The entry is passed in (main.ts resolves
 * it once for the dispatch/help decision) — no second registry scan, so no
 * name-keyed TOCTOU between the two lookups. Arg-shaped problems are narrated
 * exits 2; runtime throws (an importer that throws, a journal failure)
 * propagate to main.ts's catch → 1.
 */
export async function runPlanEntryCommand(
  entry: PlanRegistryEntry,
  flags: Record<string, unknown>,
  io: CliIo,
  mode: NarrationMode,
  opts?: { opsRoot?: string; plansRoot?: string },
): Promise<number> {
  const parsed = parseRunPlanInput(entry.name, flags, io, mode, RunPlanCommandSchema);
  if (!parsed.ok) return parsed.code;
  // The registry floor is validated with the SAME kernel schema run-plan
  // applies to a plan FILE (PlanSchema.parse in runPlanCommand): a malformed
  // floor is an input-class defect (exit 2, no artifact), not an opaque
  // kernel throw. An importer that THROWS stays a runtime throw → exit 1.
  const imported = await entry.importer();
  const checked = PlanSchema.safeParse(imported);
  if (!checked.success) {
    if (mode !== 'json') {
      narrate(
        io,
        `invalid input for '${entry.name}': the registry floor is not a valid plan: ${issueMessage(checked.error)}`,
      );
    }
    return EXIT_CODES.usage;
  }
  return runPlanThroughKernel(entry.name, checked.data, parsed.input, io, mode, opts);
}
