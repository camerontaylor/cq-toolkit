// Plan subcommands — one per shipped plan (T4.3; ws-i scope item 2).
//
// THE GENERATION CONTRACT: the subcommand surface is DERIVED from the plan
// registry (src/plans/registry.ts, reached through the CLI's sanctioned
// registry boundary — src/registry/plans.ts). Adding a plan FILE
// `src/plans/<name>.ts` exporting `plan` registers `<name>` as a subcommand
// with no CLI edit, so the two surfaces cannot drift; there is exactly ONE
// dispatch block for all of them. This module is the generic dispatcher: it
// maps the shared governed-run flags (RunPlanOptionsSchema — the run-plan
// knobs minus `--plan`) onto the registry entry's plan and delegates to the
// recorded governed composition (runPlanThroughKernel: runPlan +
// withBudgetStop, I9). No plan logic lives here or anywhere under src/cli/**.
//
// THE PLAN IS THE REGISTRY FLOOR: a shipped plan is a parameterized BUILDER
// whose real instance needs per-run data the frozen Job schema cannot carry
// (a sweep's fan-out report, a review-loop's fetched state), so the CLI runs
// the entry's discoverable floor instance — the honest, schema-valid,
// agent-free pass. Real runs author the builder in the SDK / entry modules;
// `run-plan --plan=<file>` remains the way to run an arbitrary plan JSON.
import { getPlan, listPlans } from '../registry/plans.js';
import { EXIT_CODES } from './exit.js';
import { narrate, type CliIo, type NarrationMode } from './output.js';
import { RunPlanOptionsSchema, parseRunPlanInput, runPlanThroughKernel } from './run-plan.js';

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
 * Run one plan SUBCOMMAND (a name the plan registry registers): parse the
 * shared governed-run flags, resolve the registry entry's floor plan, and run
 * it through the governed composition. Arg-shaped problems are narrated exits
 * 2; runtime throws (including an importer that throws) propagate to main.ts's
 * catch → 1. main.ts resolves the name first, so the missing-entry path here
 * can only be a registry race — reported as an unknown subcommand (exit 2),
 * never a silent no-op.
 */
export async function runPlanEntryCommand(
  name: string,
  flags: Record<string, unknown>,
  io: CliIo,
  mode: NarrationMode,
  opts?: { opsRoot?: string; plansRoot?: string },
): Promise<number> {
  const parsed = parseRunPlanInput(name, flags, io, mode, RunPlanOptionsSchema);
  if (!parsed.ok) return parsed.code;
  const entry = await getPlan(
    name,
    opts?.plansRoot === undefined ? {} : { plansRoot: opts.plansRoot },
  );
  if (entry === undefined) {
    narrate(io, `unknown subcommand '${name}' (try --help)`);
    return EXIT_CODES.usage;
  }
  const plan = await entry.importer();
  return runPlanThroughKernel(name, plan, parsed.input, io, mode, opts);
}
