// run-plan — the one non-op subcommand: run a plan JSON file through the
// governed kernel (I1 slice B).
//
// run-plan is a plan-running OP-LIKE surface: its input schema lives WITH
// the subcommand exactly like a family registry lives with its ops
// (src/ops/<family>/registry.ts). That is why THIS CLI file — and only this
// one — imports zod: it DEFINES an input schema, the same act a family
// registry performs. Everything else about the run — scheduling, governing,
// honest stop, the report — is kernel code; this module only maps flags →
// RunOptions, composes the recorded governed pipeline, and renders.
//
// FLAG SPELLING: the schema keys below are camelCase; the CLI flags are
// their kebab-case aliases, normalized BEFORE the schema parse (--ops-root →
// opsRoot, --journal-dir → journalDir, --max-usd → maxUsd, --max-tokens →
// maxTokens, --stop-on-error → stopOnError); --plan, --concurrency and
// --resume map 1:1. This kebab convenience is run-plan-ONLY: op subcommands
// map flags by EXACT schema key (the asymmetry is documented in main.ts).
//
// ERROR SHAPES (the 1-vs-2 line): all INPUT defects are exit 2 —
// schema-invalid flags; a --plan path that is missing or not a regular file;
// corrupted plan FILE CONTENT (unparseable JSON or a PlanSchema failure); and
// the kernel's own input-validation class — a thrown error whose message
// starts with 'runPlan: ' (duplicate job ids, the concurrency bound,
// resume:true without journalDir) or 'journal: ' (the runId filename-safety
// assert: a PlanSchema-valid plan whose id cannot become a journal file name,
// e.g. 'bad/id', thrown by assertSafeRunId inside runPlan when --journal-dir
// is set — the plan id is still the defective input). RUNTIME throws are
// exit 1 — anything else (a journal open/write failure, a file read that
// raced the stat gate) propagates to main.ts's catch, which narrates and
// returns 1 'thrown'. No result ever existed on a throw, so stdout stays
// empty.
//
// GOVERNED COMPOSITION (kernel README, "Budget governor") — I9 is not
// optional; every run goes through the recorded pipeline:
//   new BudgetGovernor(governorConfig(runOptions, {})) — or, when --resume
//   names a journal dir, seedFromRunLog(openRunLog(journalDir), plan.id,
//   { config }) so the resumed run continues the SAME budget (construction
//   site below)
//   withBudgetStop(await runPlan(plan, runOptions, governRegistry(view, governor)), plan, governor)
import { readFile, stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { z } from 'zod';
import {
  BudgetGovernor,
  governRegistry,
  governorConfig,
  seedFromRunLog,
  withBudgetStop,
} from '../kernel/governor.js';
import { openRunLog } from '../kernel/journal.js';
import { runPlan, type OpRegistryView } from '../kernel/runner.js';
import { PlanSchema } from '../kernel/schema.js';
import type { OpRegistryEntry, Plan, RunOptions, RunReport } from '../kernel/types.js';
import { list } from '../registry/index.js';
import { EXIT_CODES, exitCodeForRunReport } from './exit.js';
import {
  narrate,
  narrateRunReport,
  writeResultJson,
  type CliIo,
  type NarrationMode,
} from './output.js';

/**
 * run-plan's input schema — the kebab-case CLI flags above map onto these
 * camelCase keys (see the header). The reserved mode flags --json/--help
 * never reach this schema: main.ts handles them, and the normalizer below
 * ignores them defensively.
 */
export const RunPlanInputSchema = z
  .object({
    /** Path to a plan JSON file (flag: --plan, maps 1:1). */
    plan: z.string().min(1),
    /** Override the op registry root (DI for embedding/tests; flag: --ops-root). */
    opsRoot: z.string().optional(),
    /** Max jobs in flight — the ONE integer concurrency knob (flag: --concurrency, maps 1:1). */
    concurrency: z.number().int().min(1).default(4),
    /** Stop dispatching new jobs after the first non-ok terminal outcome (flag: --stop-on-error). */
    stopOnError: z.boolean().default(false),
    /** NDJSON journal directory; enables persistence and resume (flag: --journal-dir). */
    journalDir: z.string().optional(),
    /** Run-level USD cap, governed (flag: --max-usd). */
    // Zero-budget is expressible: the governor accepts maxUsd >= 0 (a valid
    // hard-zero spend ceiling); its DD-9 fail-loud covers unpriced maxUsd.
    maxUsd: z.number().min(0).optional(),
    /** Run-level token rollup cap, DD-9 (flag: --max-tokens). */
    maxTokens: z.number().int().positive().optional(),
    /** Resume an interrupted run from its journal; requires journalDir (flag: --resume, maps 1:1). */
    resume: z.boolean().default(false),
  })
  .strict();

/**
 * run-plan's governed-run OPTIONS without the plan-file key: the shared flag
 * surface of every plan SUBCOMMAND (`cq <plan-name> …`, src/cli/plans.ts),
 * where the plan itself is the registry's floor instance rather than a JSON
 * file. Derived by OMIT so the two surfaces cannot drift; `.omit` preserves
 * the `.strict()` catchall and every field default (probed against zod 4 — the
 * unknown-key rejection and the defaults ride along).
 */
export const RunPlanOptionsSchema = RunPlanInputSchema.omit({ plan: true });

/** The parsed options of one governed run (the plan-file key excluded). */
export type RunPlanOptions = z.infer<typeof RunPlanOptionsSchema>;

/** Message of an unknown throwable, for narration and `invalid input` lines. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** True when the throwable carries a zod-style `issues` array (structural probe). */
function hasIssues(err: unknown): boolean {
  return Array.isArray((err as { issues?: unknown } | null | undefined)?.issues);
}

/**
 * Flattened zod issue message, accessed STRUCTURALLY (this module may import
 * zod, but main.ts — which shares this formatting style — may not, so the
 * helper stays cast-based): `<path>: <message>` joined by '; '.
 */
function issueMessage(error: unknown): string {
  const issues = (error as { issues?: unknown } | null | undefined)?.issues;
  if (!Array.isArray(issues) || issues.length === 0) return 'invalid input';
  return issues
    .map((issue) => {
      const i = issue as { path?: unknown; message?: unknown };
      const path = Array.isArray(i.path) ? i.path.join('.') : '';
      const message = typeof i.message === 'string' ? i.message : 'invalid';
      return path === '' ? message : `${path}: ${message}`;
    })
    .join('; ');
}

/**
 * Mode-aware narration for run-plan's INPUT-defect exits (the suppression
 * matrix in main.ts's header): mode 'json' → nothing on stderr (machine
 * mode — the exit code carries the verdict); mode 'human' → the one `cq:`
 * stderr line. Runtime throws narrate in main.ts's catch, same matrix.
 */
function narrateIfHuman(io: CliIo, mode: NarrationMode, message: string): void {
  if (mode === 'json') return;
  narrate(io, message);
}

/**
 * The flag normalization + schema parse shared by run-plan and the plan
 * subcommands: kebab-case keys are normalized (--stop-on-error → stopOnError),
 * the reserved mode flags are ignored, a post-normalization duplicate is a
 * narrated exit 2, and a schema failure is a narrated exit 2 too.
 * `commandName` labels the narration (`invalid input for '<name>'`).
 *
 * The normalized record is NULL-PROTOTYPE (same idiom as parseFlags in
 * main.ts): a plain {} would route `--__proto__=…` through the inherited
 * __proto__ ACCESSOR — the key would never become an own property (the strict
 * schema would silently stop seeing it) and the parsed value would re-point
 * the record's prototype instead.
 */
export function parseRunPlanInput<T>(
  commandName: string,
  flags: Record<string, unknown>,
  io: CliIo,
  mode: NarrationMode,
  schema: z.ZodType<T>,
): { ok: true; input: T } | { ok: false; code: number } {
  const normalizedFlags: Record<string, unknown> = { __proto__: null };
  for (const [rawKey, value] of Object.entries(flags)) {
    const key = rawKey.replace(/-([a-z])/g, (_: string, c: string) => c.toUpperCase());
    if (key === 'json' || key === 'help' || key === 'h') continue;
    if (Object.hasOwn(normalizedFlags, key)) {
      narrateIfHuman(
        io,
        mode,
        `invalid input for '${commandName}': duplicate flag '--${rawKey}' after kebab-case normalization`,
      );
      return { ok: false, code: EXIT_CODES.usage };
    }
    normalizedFlags[key] = value;
  }
  const check = schema.safeParse(normalizedFlags);
  if (!check.success) {
    narrateIfHuman(io, mode, `invalid input for '${commandName}': ${issueMessage(check.error)}`);
    return { ok: false, code: EXIT_CODES.usage };
  }
  return { ok: true, input: check.data };
}

/**
 * The governed composition for ONE already-resolved Plan: the registry view
 * over the resolved ops root (the explicit --ops-root flag wins over the
 * runCli-level DI override), the recorded governor construction (fresh, or
 * resume-seeded from the journal dir), runPlan + withBudgetStop (I9 is not
 * optional), then the I1 output triple — the ONE stdout artifact, then
 * failures-only narration (silent in 'json' mode), then the mechanical exit
 * code. Shared by run-plan (a plan FILE) and the plan subcommands (a registry
 * floor plan); see run-plan.ts's header for the shared error taxonomy.
 *
 * Kernel-input-class throws (`runPlan: `/`journal: `/`topoOrder: `) are
 * narrated exits 2; any other throw propagates to the caller's catch → 1.
 */
export async function runPlanThroughKernel(
  commandName: string,
  plan: Plan,
  input: RunPlanOptions,
  io: CliIo,
  mode: NarrationMode,
  opts?: { opsRoot?: string },
): Promise<number> {
  // Registry view over the resolved ops root: the explicit --ops-root flag
  // (input.opsRoot) wins over the runCli-level DI override (opts.opsRoot).
  const opsRoot = input.opsRoot ?? opts?.opsRoot;
  const entries = await list(opsRoot === undefined ? {} : { opsRoot });
  const entryByName = new Map(entries.map((entry) => [entry.name, entry]));
  // Variance adapter (kernel runner.ts OpRegistryView note): the view returns
  // OpRegistryEntry<never, never> — the bottom instantiation — while the
  // registry's entries are instantiated at the default <unknown, unknown>,
  // and unknown does not widen DOWN to never. The runner only ever calls
  // parseAsync/importer through the bottom instantiation, so the documented
  // cast adapts (never touch kernel files for this).
  const view: OpRegistryView = {
    get: (name) => entryByName.get(name) as OpRegistryEntry<never, never> | undefined,
  };

  // Governed composition — the recorded seam, not optional (I9). The
  // construction is ordered AFTER the plan parse: seeding keys on plan.id.
  const runOptions: RunOptions = {
    concurrency: input.concurrency,
    stopOnError: input.stopOnError,
    ...(input.journalDir !== undefined ? { journalDir: input.journalDir } : {}),
    ...(input.maxUsd !== undefined ? { maxUsd: input.maxUsd } : {}),
    ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
    ...(input.resume ? { resume: true } : {}),
  };
  const config = governorConfig(runOptions, {});
  let governor: BudgetGovernor;
  if (input.resume === true && input.journalDir !== undefined) {
    // Resume continues the SAME budget, not a fresh one (kernel README,
    // "Composable with resume"): a plain `new BudgetGovernor(...)` here would
    // make a cumulative --max-tokens/--max-usd cap bind only to the resumed
    // process, discarding the prior runs' usage rollup and dispatch count.
    // seedFromRunLog seeds from ALL `<planId>--` journals in the dir,
    // oldest-first (the ordered concatenation seedFromJournal requires), so
    // the seeded cap can trip before the resumed run admits anything.
    // No `usdOf` is passed: USD seeding needs a price map the CLI does not
    // own (cost stays derived-only) — the token/rollup and dispatch-count
    // seeds, the caps this CLI exposes, work without it. (The kernel's DD-9
    // fail-loud applies on its own: a resumed run under --max-usd with
    // unpriced prior usage trips rather than fail open.)
    governor = await seedFromRunLog(openRunLog(input.journalDir), plan.id, { config });
  } else {
    // Fresh runs start at zero — unchanged.
    governor = new BudgetGovernor(config);
  }
  let rawReport: RunReport;
  try {
    rawReport = await runPlan(plan, runOptions, governRegistry(view, governor));
  } catch (err) {
    // Kernel-input-class throws are INPUT defects → exit 2, consistent with
    // the schema/content defects above: messages starting 'runPlan: '
    // (duplicate job ids, the concurrency bound, resume:true without
    // journalDir), messages starting 'journal: ' — the runId
    // filename-safety assert (assertSafeRunId, via makeRunId inside runPlan)
    // fires on a PlanSchema-valid plan whose id is journal-unsafe ('bad/id'):
    // the id would become `<runId>.ndjson`, so the defect is still the plan
    // INPUT, not a runtime failure — and messages starting 'topoOrder: '
    // (the kernel manifest's dependency-cycle throw, review-debt #84): a
    // CYCLIC PLAN FILE is an invalid plan, not a runtime crash, so it maps
    // to the documented usage path (exit 2) instead of a narrated exit 1.
    // Any other throw (a journal open/write failure, …) stays a RUNTIME
    // throw → propagates to the caller's catch → narrated exit 1.
    const message = messageOf(err);
    if (
      message.startsWith('runPlan: ') ||
      message.startsWith('journal: ') ||
      message.startsWith('topoOrder: ')
    ) {
      narrateIfHuman(io, mode, `invalid input for '${commandName}': ${message}`);
      return EXIT_CODES.usage;
    }
    throw err;
  }
  const report = withBudgetStop(rawReport, plan, governor);

  // Output: the ONE stdout artifact first, then failures-only narration
  // (silent in 'json' mode), then the mechanical exit code.
  writeResultJson(io, report);
  narrateRunReport(io, report, mode);
  return exitCodeForRunReport(report);
}

/**
 * Run one plan file through the governed kernel. Returns the process exit
 * code (never throws for arg-shaped problems — those are narrated exits;
 * runtime throws propagate to main.ts's catch → 1).
 */
export async function runPlanCommand(
  flags: Record<string, unknown>,
  io: CliIo,
  mode: NarrationMode,
  opts?: { opsRoot?: string },
): Promise<number> {
  const parsed = parseRunPlanInput('run-plan', flags, io, mode, RunPlanInputSchema);
  if (!parsed.ok) return parsed.code;
  const input = parsed.input;

  // INPUT defect (exit 2), not a runtime throw: a --plan path that does not
  // exist or is not a regular file is arg-shaped, consistent with the other
  // input defects (reviewer A medium 2 — schema-invalid content was already
  // 2 while a missing/directory plan path surfaced as a thrown 1).
  // Stat-error classification: only ENOENT (missing path) and ENOTDIR (a
  // non-directory path component) mean "this path cannot be a readable plan
  // file" — arg-shaped → treated as the input defect below. Any OTHER stat
  // error (EACCES, EIO, …) is a RUNTIME failure, not knowledge about the
  // argument: it is rethrown and propagates to main.ts's catch → exit 1
  // 'thrown'.
  let planStat: Stats | undefined;
  try {
    planStat = await stat(input.plan);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;
    planStat = undefined;
  }
  if (planStat === undefined || !planStat.isFile()) {
    narrateIfHuman(
      io,
      mode,
      `invalid input for 'run-plan': plan file ${input.plan} is not a readable file`,
    );
    return EXIT_CODES.usage;
  }

  // The file exists and is regular (per the stat gate); a read error here is
  // a post-gate race or permission failure — a RUNTIME throw, not an arg
  // error: it propagates to main.ts's catch → narrated + exit 1 'thrown'
  // (stdout stays empty — no result ever existed). Arg-shaped errors are 2;
  // runtime throws are 1.
  const raw = await readFile(input.plan, 'utf8');
  let plan: Plan;
  try {
    // Corrupted file CONTENT is corrupted INPUT → exit 2, never a throw.
    plan = PlanSchema.parse(JSON.parse(raw));
  } catch (err) {
    // A zod error is flattened to the one-line issue form (narration stays
    // line-based); a JSON.parse error narrates its own message.
    const detail = hasIssues(err) ? issueMessage(err) : messageOf(err);
    narrateIfHuman(
      io,
      mode,
      `invalid input for 'run-plan': plan file '${input.plan}' is not a valid plan: ${detail}`,
    );
    return EXIT_CODES.usage;
  }

  return runPlanThroughKernel('run-plan', plan, input, io, mode, opts);
}
