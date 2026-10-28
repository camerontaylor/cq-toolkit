// The CLI dispatcher — I1 slice B.
//
// THE NO-LOGIC-IN-CLI CLAIM: this module only DISPATCHES, maps flags,
// renders, and maps exit codes. All semantics live in the registry (op
// discovery, input schemas, lazy importers) and the kernel (runner, budget
// governor, frozen taxonomy). Import boundary (lint-enforced next slice):
// src/cli/** may import only ../registry/**, ../kernel/**, intra-CLI ./…
// modules, and node: builtins — NO zod (schemas are accessed STRUCTURALLY
// via `as unknown as` casts), NO ../ops, NO ../driver, NO ../harness,
// NO ../plans, NO package imports.
//
// ARG GRAMMAR (parseFlags): argv[0] names the subcommand (or is a global
// --help/-h); every further token must be a flag. `--key=value`, or a bare
// `--key` (= boolean true). Values are JSON.parse'd when they parse, else
// kept as raw strings (--packages=helpers → "helpers", --max-usd=2 → 2,
// --tags=["a"] → an array) — EXCEPT a numeric-LOOKING token whose text is
// not the canonical decimal form of its Number ('1e000005', '01', '1.50'):
// it stays the raw string so hex cluster ids round-trip (#386). A
// positional (non-flag) token is a usage error; a duplicate flag is a
// usage error (both exit 2).
//
// PLAN SUBCOMMANDS (T4.3): every name the plan registry discovers is ALSO a
// subcommand, generated at dispatch time (src/cli/plans.ts) — never a
// hand-written list, so a new src/plans/<name>.ts registers itself. A plan
// subcommand takes run-plan's governed-run flags minus --plan AND the
// run-plan-reserved --ops-root (RunPlanCommandSchema) and runs the registry
// entry's floor plan through the SAME governed composition. Resolution order:
// op registry first (the pre-T4.3 surface is unchanged), then the plan
// registry.
//
// KEY-SPELLING ASYMMETRY: op subcommands map flags by EXACT schema key
// (--msg=, or --maxUsd= if a schema had such a field) — parseFlags keeps
// keys verbatim. run-plan is the ONE exception: its schema defines
// kebab-case aliases (--ops-root, --journal-dir, --max-usd, --max-tokens,
// --stop-on-error) normalized inside runPlanCommand; see run-plan.ts.
//
// RESERVED MODE FLAGS: --json, --fail-on-verdict and --help/-h are recognized
// for EVERY subcommand and never reach input validation. --help renders the
// subcommand's input schema as plain text (the one sanctioned non-JSON
// stdout surface, like the legacy --help) and exits 0. --json switches
// narration to machine mode (NarrationMode 'json': stderr stays EMPTY,
// stdout carries ONE JSON artifact). --fail-on-verdict is an exit-code
// opt-in: an `ok` op result whose value is an object with `verdict: 'fail'`
// (or, for run-plan/plan subcommands, any ok row with such a value) exits 1
// instead of 0; every other result maps unchanged and stdout is identical.
// A VALUED reserved spelling (`--json=x`, `--help=x`, `--h=x`,
// `--fail-on-verdict=x`) is a usage error (exit 2) on EVERY subcommand — the
// raw-token gate runs before the help/mode branches — while the bare
// spellings keep their mode/help behavior.
//
// MACHINE-MODE ERROR ARTIFACTS (the exact error matrix): when the bare
// `--json` or `-json` flag is present the exit code still carries the verdict, stderr
// stays EMPTY, and every error site writes ONE JSON error artifact to stdout
// in place of the (never-written) result:
//   { "error": { "kind": "usage" | "invalid-input" | "invalid-result" |
//                "thrown", "subcommand": "<name>" | null,
//                "message": "<text>", "exitCode": <n> } }
// An error artifact REPLACES the empty stream; it never joins a result
// artifact, so "stdout is one JSON artifact" (I1) holds on every --json path.
//   kind 'invalid-input' (the input was well-formed CLI syntax but defective):
//     - op input-validation failure                      → exit 2
//     - run-plan / plan-subcommand input defects (every  → exit 2
//       exit-2 class in run-plan.ts and plans.ts)
//   kind 'invalid-result':
//     - op invalid-result gates (result-schema mirror +  → exit 1
//       JSON-losslessness probes)
//   kind 'thrown':
//     - op throw                                         → exit 1
//     - run-plan / plan-subcommand thrown                → exit 1
//     - the plan-lock refusal (transient)                → exit 3
//     - the runCli last-resort catch                     → exit 1
//   kind 'usage' (arg-shaped; detected before the mode flag is parsed, so the
//   raw argv is scanned for either bare JSON alias):
//     - missing subcommand / unknown subcommand
//     - flag-syntax errors (duplicate flags), positional tokens
//     - valued-reserved rejections (--json=x / --help=x / --h=x /
//       --fail-on-verdict=x)
//     - --ops-root passed to an op or plan subcommand
//   Human mode keeps the one `cq:` stderr narration line on every path (the
//   failures-only convention) and leaves stdout empty on these paths.
//
// EXIT CODES: 0 ok; 1 failed/thrown; 2 usage — arg-shaped errors the CLI
// detects itself, never derived from the taxonomy; 3 needs-human/budget.
// runCli NEVER throws: every path returns a number, and a runtime throw
// (op crash, journal failure, registry defect) is caught per subcommand and
// returned as 1 with no RESULT artifact on stdout — none ever existed (human
// mode narrates on stderr; --json mode writes the error artifact above).
export { installProcessSignalCleanup } from '../kernel/governor.js';
import { get, list } from '../registry/index.js';
import { getPlan } from '../registry/plans.js';
import { OpResultSchema } from '../kernel/schema.js';
import type { OpRegistryEntry } from '../kernel/types.js';
import { EXIT_CODES, exitCodeForOpResult } from './exit.js';
import {
  assertJsonLossless,
  narrate,
  narrateOpResult,
  processIo,
  reportError,
  writeResultJson,
  type CliIo,
  type NarrationMode,
} from './output.js';
import { listPlanNames, runPlanEntryCommand } from './plans.js';
import { RunPlanCommandSchema, RunPlanInputSchema, runPlanCommand } from './run-plan.js';

/**
 * Options for embedding the CLI (tests, tools): the ops-root and plan-root
 * DI overrides.
 */
export interface RunCliOptions {
  opsRoot?: string;
  /** Plan-registry root override (the plan subcommands; default src/plans|dist/plans). */
  plansRoot?: string;
}

/** Message of an unknown throwable, for narration lines. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Flattened zod issue message, accessed STRUCTURALLY — no zod import (the
 * CLI boundary bans it): `<path>: <message>` joined by '; '.
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
 * The canonical-decimal check for numeric-LOOKING raw flag values (#386).
 *
 * A raw token whose JSON.parse yields a number is still kept as a raw
 * STRING unless its text is the canonical decimal form of that number —
 * `String(Number(raw)) === raw` — i.e. exactly what JS's own number →
 * string conversion would print back. '2' → 2 ('2' === '2'); '1e000005',
 * '0e123456', '123e4567', '01', '1.50', '+1', '.5', '1.' → raw strings
 * (Number() accepts them; String() round-trips them differently, or to
 * Infinity/NaN-class text). This is what keeps 8-hex cluster ids that are
 * all digits plus one 'e' (`1e000005`) — and leading-zero ids (`01234567`)
 * — verbatim strings through `analyze.fix --clusterId=…`, while ordinary
 * numeric flags (`--maxUsd=2`, `--concurrency=3`) still parse as numbers.
 */
function isCanonicalDecimal(raw: string): boolean {
  const n = Number(raw);
  if (!Number.isFinite(n)) return false; // '1e999999...' → Infinity: never canonical
  return String(n) === raw;
}

/**
 * Parse flag tokens into a plain flags record. `--key=value` / bare
 * `--key` (true) / `-h` (single-dash short flags, boolean true). Values are
 * JSON.parse'd when they parse AND the result is faithful: a value that
 * parses to a number whose raw text is not its canonical decimal form
 * (`String(Number(raw)) !== raw`, e.g. '1e000005', '01', '1.50') is kept as
 * the raw string instead (#386 — hex-shaped cluster ids must round-trip),
 * as is anything that fails to parse. Other JSON values (objects, arrays,
 * strings, booleans, null) parse as themselves. Keys stay VERBATIM: ops
 * match them against schema keys exactly; run-plan normalizes its
 * kebab-case aliases itself. Positional tokens land in `unknown` — the
 * caller turns a non-empty array into a usage error. Duplicate flags throw
 * (the caller narrates + exits 2).
 */
export function parseFlags(tokens: string[]): {
  flags: Record<string, unknown>;
  unknown: string[];
} {
  // Prototype-free record: a plain `{}` makes `--__proto__=...` invoke the
  // inherited `__proto__` ACCESSOR instead of creating an own property (the
  // own-property duplicate check evaded, inherited `help`/`json` truthiness
  // visible). Object.create(null) has no prototype, so every assignment —
  // `__proto__` included — creates an own data property. Consumers use
  // prototype-agnostic operations only (Object.hasOwn, Object.keys,
  // Object.entries, spread) — none rely on `{}`-prototype methods.
  const flags: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const unknown: string[] = [];
  const put = (dash: string, key: string, rawValue: string | undefined, token: string): void => {
    if (key === '') {
      unknown.push(token); // '-' or '--' or '--=x' — not a usable flag
      return;
    }
    if (Object.hasOwn(flags, key)) {
      throw new Error(`duplicate flag ${dash}${key}`);
    }
    if (rawValue === undefined) {
      flags[key] = true;
      return;
    }
    try {
      const parsed: unknown = JSON.parse(rawValue);
      // #386: a number that the raw text does not denote canonically is kept
      // as the raw string — the token the user typed IS the id; Number()
      // would silently rewrite exponent/leading-zero forms.
      flags[key] = typeof parsed === 'number' && !isCanonicalDecimal(rawValue) ? rawValue : parsed;
    } catch {
      flags[key] = rawValue;
    }
  };
  for (const token of tokens) {
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      put(
        '--',
        eq === -1 ? token.slice(2) : token.slice(2, eq),
        eq === -1 ? undefined : token.slice(eq + 1),
        token,
      );
    } else if (token.startsWith('-')) {
      const eq = token.indexOf('=');
      put(
        '-',
        eq === -1 ? token.slice(1) : token.slice(1, eq),
        eq === -1 ? undefined : token.slice(eq + 1),
        token,
      );
    } else {
      unknown.push(token); // positional → usage error at the call site
    }
  }
  return { flags, unknown };
}

/**
 * Subcommand names for the help surface: the sorted, deduped union of the op
 * entry names, the plan-registry names (generated — never hand-listed), and
 * the built-in 'run-plan' (appended; the built-in wins if an entry ever took
 * the name).
 */
export function subcommandNames(
  entries: OpRegistryEntry[],
  planNames: readonly string[] = [],
): string[] {
  const names = [...new Set([...entries.map((entry) => entry.name), ...planNames])].sort();
  if (!names.includes('run-plan')) names.push('run-plan');
  return names;
}

/**
 * The reserved mode-flag keys: `--json` (narration mode), `--fail-on-verdict`
 * (the verdict exit-code opt-in) and `--help`/`-h` (the help surface) are recognized for EVERY subcommand and never reach any
 * op input as data.
 */
const RESERVED_FLAG_KEYS: readonly string[] = ['json', 'help', 'h', 'fail-on-verdict'];

/**
 * The first reserved key that arrived WITH an explicit `=value`, or
 * `undefined` when none did. A raw-token scan is required because bare
 * `--json` and `--json=true` are indistinguishable in the parsed flags
 * record (both parse to `true`): the bare spellings keep their mode/help
 * behavior, while an explicit `=value` would otherwise be silently dropped —
 * stripped for an op whose schema declares the key (silent input loss), and
 * swallowed by run-plan's normalizer (silent downgrade of `--json=yes` to
 * human mode). The caller hoists this scan over EVERY subcommand's help/mode
 * branches, so a valued spelling is a usage error on ops and run-plan alike.
 */
function reservedFlagWithValue(tokens: readonly string[]): string | undefined {
  for (const token of tokens) {
    if (!token.startsWith('-')) continue;
    const eq = token.indexOf('=');
    if (eq === -1) continue;
    const key = token.slice(token.startsWith('--') ? 2 : 1, eq);
    if (RESERVED_FLAG_KEYS.includes(key)) return key;
  }
  return undefined;
}

// --- Help rendering (plain text — the sanctioned non-JSON stdout surface) --

/** The structural shape of a zod 4 `.def` (accessed without importing zod). */
interface ZodDefLike {
  type?: unknown;
  innerType?: unknown;
  element?: unknown;
  value?: unknown;
  options?: unknown;
}

function defOf(schema: unknown): ZodDefLike | undefined {
  const def = (schema as { def?: unknown } | null | undefined)?.def;
  if (typeof def !== 'object' || def === null) return undefined;
  return def as ZodDefLike;
}

/**
 * Defensive type describer over a zod 4 schema's `.def` structure: recurse
 * into innerType (optional/default) and element/value (array); render
 * `string?` for optionals, `string[]` for arrays of strings; anything
 * unrecognized renders as 'value'.
 */
function describeType(schema: unknown): string {
  const def = defOf(schema);
  if (def === undefined || typeof def.type !== 'string') return 'value';
  switch (def.type) {
    case 'string':
    case 'number':
    case 'boolean':
      return def.type;
    case 'object':
      return 'object';
    case 'optional': {
      const inner = describeType(def.innerType);
      return inner === 'value' ? 'value' : `${inner}?`;
    }
    case 'default':
      return describeType(def.innerType);
    case 'array':
      return `${describeType(def.element ?? def.value)}[]`;
    default:
      return 'value';
  }
}

const JSON_VALUES_NOTE =
  'flag values are JSON-parsed when they parse as JSON, else kept as raw strings.';

function renderGlobalHelp(names: string[]): string {
  return [
    'usage: cq <subcommand> [--key=value ...] [--json] [--fail-on-verdict]',
    '',
    'subcommands:',
    ...names.map((name) => `  ${name}`),
    '',
    "run `cq <subcommand> --help` for a subcommand's flags.",
    JSON_VALUES_NOTE,
    '',
  ].join('\n');
}

/**
 * camelCase → kebab-case at RENDER time, for run-plan's help only: run-plan's
 * CLI flags are the kebab-case aliases of its camelCase schema keys
 * (--ops-root for opsRoot), so its help shows the canonical flag forms a user
 * actually types. Op-schema help keeps the exact schema keys (identity).
 */
function camelToKebab(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

/**
 * One line per schema field (`  --<key>=<described type>`), then the extra
 * reserved flags, then the notes. `renderKey` maps a schema key to the flag
 * spelling shown (identity everywhere except run-plan — camelToKebab). When
 * a union exposes object alternatives, list each branch separately; when
 * the schema exposes no field shape, render a generic line.
 */
function renderSubHelp(
  name: string,
  schema: unknown,
  extraFlags: readonly string[],
  notes: readonly string[],
  renderKey: (key: string) => string = (key) => key,
): string {
  const lines: string[] = [`usage: cq ${name} [--key=value ...]`, '', 'flags:'];
  const renderFields = (branch: unknown): boolean => {
    const shape = (branch as { shape?: Record<string, unknown> } | null)?.shape;
    if (typeof shape !== 'object' || shape === null || Array.isArray(shape)) return false;
    for (const [key, value] of Object.entries(shape)) {
      lines.push(`  --${renderKey(key)}=${describeType(value)}`);
    }
    return true;
  };
  const def = defOf(schema);
  if (def?.type === 'union' && Array.isArray(def.options)) {
    for (const [index, branch] of def.options.entries()) {
      lines.push(`  input alternative ${String(index + 1)}:`);
      if (!renderFields(branch)) lines.push('  (this alternative does not expose a field list)');
    }
  } else if (!renderFields(schema)) {
    lines.push('  (the input schema does not expose a field list)');
  }
  for (const flag of extraFlags) lines.push(`  ${flag}`);
  lines.push('');
  for (const note of notes) lines.push(note);
  lines.push('');
  return lines.join('\n');
}

function renderOpHelp(name: string, inputSchema: unknown): string {
  return renderSubHelp(
    name,
    inputSchema,
    // --json (narration mode) and --fail-on-verdict (verdict exit code) are
    // accepted for EVERY subcommand and --help is the reserved help flag —
    // list all three, like renderRunPlanHelp.
    ['--json', '--fail-on-verdict', '--help'],
    [JSON_VALUES_NOTE],
  );
}

function renderRunPlanHelp(): string {
  return renderSubHelp(
    'run-plan',
    RunPlanInputSchema,
    ['--json', '--fail-on-verdict', '--help'],
    [
      JSON_VALUES_NOTE,
      'run-plan accepts kebab-case aliases for its camelCase keys (--ops-root, --journal-dir, --max-usd, --max-tokens, --stop-on-error); op subcommands take EXACT schema keys.',
    ],
    camelToKebab, // render the kebab-case canonical flag forms, not schema keys
  );
}

/**
 * Help for one plan SUBCOMMAND: the same governed-run flag surface as
 * run-plan (RunPlanCommandSchema — everything but --plan and the
 * run-plan-reserved --ops-root), rendered in its kebab-case canonical flag
 * forms. The trailing note names the registry floor the subcommand runs, so
 * the surface never implies a per-plan file argument.
 */
function renderPlanHelp(name: string): string {
  return renderSubHelp(
    name,
    RunPlanCommandSchema,
    ['--json', '--fail-on-verdict', '--help'],
    [
      JSON_VALUES_NOTE,
      `'${name}' runs the shipped '${name}' plan from the plan registry (its discoverable floor instance) through the governed kernel; use run-plan to run a plan JSON file.`,
      '--ops-root is reserved for run-plan (a plan subcommand runs the registry floor; embedders inject an ops root through the runCli DI).',
    ],
    camelToKebab,
  );
}

// --- Dispatch --------------------------------------------------------------

/** Bare aliases select machine mode even when flag parsing cannot finish. */
function rawNarrationMode(argv: readonly string[]): NarrationMode {
  return argv.some((token) => token === '--json' || token === '-json') ? 'json' : 'human';
}

/**
 * The dispatcher proper. Returns the process exit code on every path; only
 * genuinely runtime failures (op crash, journal failure, registry scan
 * defect) escape as throws — caught by runCli's top level → 1.
 */
async function dispatchCli(
  argv: readonly string[],
  io: CliIo,
  opts: RunCliOptions | undefined,
): Promise<number> {
  const opsRoot = opts?.opsRoot;
  // No subcommand at all: a usage error the CLI detects (exit 2, nothing on
  // stdout) — `--help` is the way to opt into the help surface.
  const sub = argv[0];
  // Usage errors below are detected BEFORE (or while) the flags parse, so the
  // machine-mode decision for THEM recognizes both bare JSON aliases
  // (the post-parse `mode` below is authoritative for everything after it).
  const rawMode = rawNarrationMode(argv);
  if (sub === undefined || sub === '--json' || sub === '-json') {
    return reportError(
      io,
      rawMode,
      'usage',
      null,
      'missing subcommand (try --help)',
      EXIT_CODES.usage,
    );
  }
  // Global help: --help/-h as the leading argument (lenient about what
  // follows — help wins).
  if (sub === '--help' || sub === '-h') {
    const opEntries = await list(opsRoot === undefined ? {} : { opsRoot });
    // A defective plan module must not turn pure help into a failure: degrade
    // to the op-only surface and surface the skip on stderr (the registry's
    // skippedFamilies visibility posture). Help itself stays exit 0.
    let planNames: string[] = [];
    try {
      planNames = await listPlanNames(opts?.plansRoot);
    } catch (err) {
      narrate(io, `plan registry scan failed — help lists op subcommands only: ${messageOf(err)}`);
    }
    io.stdout(renderGlobalHelp(subcommandNames(opEntries, planNames)));
    return EXIT_CODES.ok;
  }

  // Flag syntax first: duplicate flags throw here → narrated usage error (2);
  // positional tokens are a usage error too.
  let parsed: ReturnType<typeof parseFlags>;
  try {
    parsed = parseFlags(argv.slice(1));
  } catch (err) {
    return reportError(
      io,
      rawMode,
      'usage',
      sub,
      `${messageOf(err)} (try --help)`,
      EXIT_CODES.usage,
    );
  }
  if (parsed.unknown.length > 0) {
    return reportError(
      io,
      rawMode,
      'usage',
      sub,
      `unexpected positional argument '${parsed.unknown[0]}' (try --help)`,
      EXIT_CODES.usage,
    );
  }
  // A reserved key that arrived WITH an explicit `=value` never runs: the
  // strips below would otherwise silently drop it (exit 0, key gone) — for an
  // op whose schema declares the key that is silent input loss, and on
  // run-plan the normalizer would silently downgrade `--json=yes` to human
  // mode. The raw-token scan therefore sits HERE — after subcommand
  // identification, before every per-subcommand help/mode branch — so a
  // valued reserved spelling (`cq echo --help --json=yes`,
  // `cq run-plan --plan=p --json=yes`) is a usage error on EVERY subcommand.
  // Bare --json/--help/-h never carry `=`, so they never trip this scan and
  // keep their mode/help behavior byte-identical; the global help surface
  // (`cq --help`, help as the leading argument) stays lenient above it.
  const reservedKey = reservedFlagWithValue(argv.slice(1));
  if (reservedKey !== undefined) {
    return reportError(
      io,
      rawMode,
      'usage',
      sub,
      `--${reservedKey} is a reserved CLI flag ` +
        '(op input schemas must not declare reserved keys: json, help, h, fail-on-verdict)',
      EXIT_CODES.usage,
    );
  }
  // Reserved mode flags — never part of any op input.
  const wantsHelp = parsed.flags['help'] === true || parsed.flags['h'] === true;
  // Both JSON aliases parse to the same key; rawMode also covers early errors.
  const mode: NarrationMode =
    parsed.flags['json'] === true || rawMode === 'json' ? 'json' : 'human';
  const failOnVerdict = parsed.flags['fail-on-verdict'] === true;

  // --- 'run-plan': the one non-op subcommand -------------------------------
  if (sub === 'run-plan') {
    if (wantsHelp) {
      io.stdout(renderRunPlanHelp());
      return EXIT_CODES.ok;
    }
    try {
      // Input defects are narrated exits 2 INSIDE runPlanCommand (missing or
      // irregular plan file, corrupted content, and the kernel's own
      // 'runPlan: ' input-validation class); runtime throws (journal
      // open/write failure, a post-stat read race) escape as throws →
      // narrated exit 1 below.
      return await runPlanCommand(parsed.flags, io, mode, { ...opts, failOnVerdict });
    } catch (err) {
      // Runtime throw → 1; machine mode writes the error artifact instead.
      return reportError(
        io,
        mode,
        'thrown',
        sub,
        `run-plan threw: ${messageOf(err)}`,
        EXIT_CODES.thrown,
      );
    }
  }

  // --- Op subcommands -------------------------------------------------------
  const entry = await get(sub, opsRoot === undefined ? {} : { opsRoot });
  if (entry === undefined) {
    // --- Plan subcommands (generated from the plan registry) -----------------
    // Op lookup wins (the pre-T4.3 behavior is preserved): a plan name only
    // reaches this branch when no op registers it. The plan surface is
    // DERIVED — main.ts never hand-lists plan names.
    const planEntry = await getPlan(
      sub,
      opts?.plansRoot === undefined ? {} : { plansRoot: opts.plansRoot },
    );
    if (planEntry !== undefined) {
      if (wantsHelp) {
        io.stdout(renderPlanHelp(sub));
        return EXIT_CODES.ok;
      }
      // --ops-root is RESERVED for run-plan (the repo's CLI rule): a plan
      // subcommand runs the registry floor and takes no ops root flag — the
      // runCli-level { opsRoot } DI is the embedding seam. The schema omits
      // the key too (defense in depth); this check names the rule.
      if (Object.hasOwn(parsed.flags, 'ops-root')) {
        return reportError(
          io,
          mode,
          'usage',
          sub,
          '--ops-root is a run-plan flag (plan subcommands run the registry floor)',
          EXIT_CODES.usage,
        );
      }
      try {
        // Input defects are narrated exits 2 INSIDE runPlanEntryCommand (flag
        // schema, duplicates); runtime throws (an importer that throws, a
        // journal failure) escape as throws → narrated exit 1 below.
        return await runPlanEntryCommand(planEntry, parsed.flags, io, mode, {
          ...opts,
          failOnVerdict,
        });
      } catch (err) {
        // Runtime throw → 1; machine mode writes the error artifact instead.
        return reportError(
          io,
          mode,
          'thrown',
          sub,
          `${sub} threw: ${messageOf(err)}`,
          EXIT_CODES.thrown,
        );
      }
    }
    // Unknown subcommand: human mode narrates to stderr (stdout empty); json
    // mode writes the usage error artifact. Exit 2.
    return reportError(
      io,
      mode,
      'usage',
      sub,
      `unknown subcommand '${sub}' (try --help)`,
      EXIT_CODES.usage,
    );
  }
  if (wantsHelp) {
    io.stdout(renderOpHelp(sub, entry.inputSchema));
    return EXIT_CODES.ok;
  }
  // --ops-root is RESERVED for run-plan: an op subcommand receiving it is a
  // usage error (op inputs own their schema keys — no hidden flag collision
  // with a schema field). run-plan keeps the flag: RunPlanInputSchema.opsRoot
  // needs it, so this check is op-branch only. The runCli-level {opsRoot} DI
  // (embedding/tests) is unaffected — only the FLAG is reserved.
  if (Object.hasOwn(parsed.flags, 'ops-root')) {
    return reportError(
      io,
      mode,
      'usage',
      sub,
      '--ops-root is a run-plan flag (op inputs own their schema keys)',
      EXIT_CODES.usage,
    );
  }
  // Strip the reserved mode flags — the op's schema sees only its own keys
  // (ops map flags by EXACT schema key; see the header for the run-plan
  // kebab-case exception).
  const input: Record<string, unknown> = { ...parsed.flags };
  delete input['json'];
  delete input['help'];
  delete input['h'];
  delete input['fail-on-verdict'];
  // Validate FIRST: schema-invalid input is a usage error (exit 2, nothing
  // on stdout — no op ever ran). safeParseAsync, not safeParse: registry
  // schemas may carry ASYNC refinements/transforms (the runner dispatches
  // through parseAsync, and the direct path must accept exactly what the
  // runner accepts) — a sync parse throws on those
  // (`Encountered Promise during synchronous parse`), surfacing as a
  // spurious exit-1 'thrown' instead of a usage error. Failures of async
  // schemas stay usage errors (2). The run-plan schema path stays on plain
  // safeParse (static, sync — see run-plan.ts).
  // The schema gate runs in its OWN mode-aware try (review-debt #83):
  // safeParseAsync can THROW (a refinement/transform that throws is a
  // throw, not issues) — an escaped throw would reach the last-resort
  // 'cq: threw:' narration and crack the empty-stderr machine protocol
  // under --json. A throwing schema is still an input-validation fault:
  // the usage path (exit 2, stderr silent in machine mode) keeps the
  // documented protocol whatever the registry's schema does.
  let check: Awaited<ReturnType<typeof entry.inputSchema.safeParseAsync>>;
  try {
    check = await entry.inputSchema.safeParseAsync(input);
  } catch (err) {
    return reportError(
      io,
      mode,
      'invalid-input',
      sub,
      `invalid input for '${sub}': schema gate threw — ${messageOf(err)}`,
      EXIT_CODES.usage,
    );
  }
  if (!check.success) {
    return reportError(
      io,
      mode,
      'invalid-input',
      sub,
      `invalid input for '${sub}': ${issueMessage(check.error)}`,
      EXIT_CODES.usage,
    );
  }
  // Dispatch-time importer wiring (PR #238 review P2): the driver factory's
  // deprecated-alias notice is a `cq:` stderr line, so in machine mode it is
  // SUPPRESSED like every narration line in the header's matrix — a silent
  // sink rides the importer into the ops registries' DriverFactoryConfig.
  // Human mode passes none: the library default is byte-identical narration
  // (one `cq:`-prefixed stderr line).
  const importerWiring = mode === 'json' ? { onDeprecatedAlias: (): void => {} } : undefined;
  try {
    const op = await entry.importer(importerWiring);
    // The op's TypeScript return type is no runtime guarantee: ops load from
    // RUNTIME registries, so the direct-dispatch path validates the returned
    // value with the kernel's own mirror before ANY stdout artifact or
    // exit-code derivation (the plan path gets the same two probes via
    // runPlan's executeOp; this is their direct-path counterpart).
    const raw: unknown = await op(check.data);
    // I1 permits an optional run-report envelope on every status. Keep the
    // frozen result mirror strict: no other extension key is accepted.
    let base = raw;
    if (typeof raw === 'object' && raw !== null && Object.hasOwn(raw, 'report')) {
      const { report: _report, ...rest } = raw as Record<string, unknown>;
      base = rest;
    }
    const checked = OpResultSchema.safeParse(base);
    if (!checked.success) {
      return reportError(
        io,
        mode,
        'invalid-result',
        sub,
        `${sub} returned an invalid result: ${issueMessage(checked.error)}`,
        EXIT_CODES.thrown,
      );
    }
    // JSON-losslessness probes — the runner's full pre-journal gate applied
    // to the direct path, BEFORE any stdout artifact: (1) stringify with a
    // replacer that throws on non-finite numbers (an artifact that cannot
    // survive serialization must not be emitted); (2) the required-value
    // check — the frozen ok variant REQUIRES its value (the journal's
    // ok-without-value record is rejected on read), so `{status:'ok'}` with
    // an undefined value is lossy, not absent data; (3) the losslessness
    // walk (assertJsonLossless, the runner's mirror) rejecting the
    // silently-lossy values the schema probe passes — Maps, Dates, class
    // instances, function members, symbol-keyed or non-enumerable (hidden) members, undefined array elements.
    try {
      if (typeof raw === 'object' && raw !== null && Object.hasOwn(raw, 'report')) {
        JSON.stringify((raw as Record<string, unknown>).report, (_key, value: unknown) => {
          if (value === undefined) throw new Error('undefined member in report');
          return value;
        });
      }
      JSON.stringify(raw, (_key, value: unknown) => {
        if (typeof value === 'number' && !Number.isFinite(value)) {
          throw new Error(`non-finite number ${String(value)}`);
        }
        return value;
      });
      if (checked.data.status === 'ok' && checked.data.value === undefined) {
        throw new Error("ok result without a 'value'");
      }
      assertJsonLossless(raw);
    } catch (probeErr) {
      return reportError(
        io,
        mode,
        'invalid-result',
        sub,
        `${sub} returned an invalid result: ${messageOf(probeErr)}`,
        EXIT_CODES.thrown,
      );
    }
    writeResultJson(io, raw); // the ONE stdout artifact, including optional report
    narrateOpResult(io, sub, checked.data, mode); // failures-only; silent in json mode
    return exitCodeForOpResult(checked.data, { failOnVerdict });
  } catch (err) {
    // Thrown (uncaught exception) → 1, decided HERE (the caller of the
    // exit-code functions); no RESULT artifact ever existed. Human mode
    // narrates; machine mode writes the error artifact (mode is known here).
    return reportError(
      io,
      mode,
      'thrown',
      sub,
      `${sub} threw: ${messageOf(err)}`,
      EXIT_CODES.thrown,
    );
  }
}

/**
 * Run the CLI over `argv` (process.argv minus node/script). Never throws:
 * every path returns an exit code ({0,1,2,3}; see src/cli/exit.ts).
 * Dispatch buffers only its finite artifact/help text and narration, never
 * operation progress (operations receive no CliIo). Only after error
 * handling finishes are they sent to the real sinks. A sink failure returns 1
 * without retrying: it may already have accepted some or all of the artifact.
 */
export async function runCli(argv: string[], io?: CliIo, opts?: RunCliOptions): Promise<number> {
  const sink = io ?? processIo;
  let artifact: string | undefined;
  const narration: string[] = [];
  const buffered: CliIo = {
    stdout: (chunk) => {
      if (artifact !== undefined) throw new Error('CLI attempted a second stdout artifact');
      artifact = chunk;
    },
    stderr: (chunk) => {
      narration.push(chunk);
    },
  };
  let code: number;
  try {
    code = await dispatchCli(argv, buffered, opts);
  } catch (err) {
    // Last-resort catch (registry scan defect, …): a runtime throw outside a
    // subcommand's own scope. Preserve an already prepared artifact.
    code = EXIT_CODES.thrown;
    if (artifact === undefined) {
      reportError(
        buffered,
        rawNarrationMode(argv),
        'thrown',
        argv[0] ?? null,
        `threw: ${messageOf(err)}`,
        code,
      );
    }
  }
  // Emission is outside every catch that can construct an error artifact.
  try {
    if (artifact !== undefined) sink.stdout(artifact);
    for (const chunk of narration) sink.stderr(chunk);
  } catch {
    return EXIT_CODES.thrown;
  }
  return code;
}
