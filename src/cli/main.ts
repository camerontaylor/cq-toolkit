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
// --tags=["a"] → an array). A positional (non-flag) token is a usage error;
// a duplicate flag is a usage error (both exit 2).
//
// KEY-SPELLING ASYMMETRY: op subcommands map flags by EXACT schema key
// (--msg=, or --maxUsd= if a schema had such a field) — parseFlags keeps
// keys verbatim. run-plan is the ONE exception: its schema defines
// kebab-case aliases (--ops-root, --journal-dir, --max-usd, --max-tokens,
// --stop-on-error) normalized inside runPlanCommand; see run-plan.ts.
//
// RESERVED MODE FLAGS: --json and --help/-h are recognized for EVERY
// subcommand and never reach input validation. --help renders the
// subcommand's input schema as plain text (the one sanctioned non-JSON
// stdout surface, like the legacy --help) and exits 0. --json switches
// narration to machine mode (NarrationMode 'json': stderr stays EMPTY,
// stdout carries the artifact). A VALUED reserved spelling (`--json=x`,
// `--help=x`, `--h=x`) is a usage error (exit 2) on EVERY subcommand — the
// raw-token gate runs before the help/mode branches — while the bare
// spellings keep their mode/help behavior.
//
// EXIT CODES: 0 ok; 1 failed/thrown; 2 usage — arg-shaped errors the CLI
// detects itself, never derived from the taxonomy; 3 needs-human/budget.
// runCli NEVER throws: every path returns a number, and a runtime throw
// (op crash, journal failure, registry defect) is caught per subcommand,
// narrated, and returned as 1 with stdout left EMPTY — no result ever
// existed.
import { get, list } from '../registry/index.js';
import { OpResultSchema } from '../kernel/schema.js';
import type { OpRegistryEntry } from '../kernel/types.js';
import { EXIT_CODES, exitCodeForOpResult } from './exit.js';
import {
  assertJsonLossless,
  narrate,
  narrateOpResult,
  processIo,
  writeResultJson,
  type CliIo,
  type NarrationMode,
} from './output.js';
import { RunPlanInputSchema, runPlanCommand } from './run-plan.js';

/** Options for embedding the CLI (tests, tools): the ops-root DI override. */
export interface RunCliOptions {
  opsRoot?: string;
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
 * Parse flag tokens into a plain flags record. `--key=value` / bare
 * `--key` (true) / `-h` (single-dash short flags, boolean true). Values are
 * JSON.parse'd when they parse, else raw strings. Keys stay VERBATIM: ops
 * match them against schema keys exactly; run-plan normalizes its
 * kebab-case aliases itself. Positional tokens land in `unknown` — the
 * caller turns a non-empty array into a usage error. Duplicate flags throw
 * (the caller narrates + exits 2).
 */
export function parseFlags(tokens: string[]): { flags: Record<string, unknown>; unknown: string[] } {
  const flags: Record<string, unknown> = {};
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
      flags[key] = JSON.parse(rawValue);
    } catch {
      flags[key] = rawValue;
    }
  };
  for (const token of tokens) {
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      put('--', eq === -1 ? token.slice(2) : token.slice(2, eq), eq === -1 ? undefined : token.slice(eq + 1), token);
    } else if (token.startsWith('-')) {
      const eq = token.indexOf('=');
      put('-', eq === -1 ? token.slice(1) : token.slice(1, eq), eq === -1 ? undefined : token.slice(eq + 1), token);
    } else {
      unknown.push(token); // positional → usage error at the call site
    }
  }
  return { flags, unknown };
}

/**
 * Subcommand names for the help surface: sorted registry entry names with
 * 'run-plan' appended (deduped — the built-in wins if an op ever takes the
 * name).
 */
export function subcommandNames(entries: OpRegistryEntry[]): string[] {
  const names = entries.map((entry) => entry.name).sort();
  if (!names.includes('run-plan')) names.push('run-plan');
  return names;
}

/**
 * The reserved mode-flag keys: `--json` (narration mode) and `--help`/`-h`
 * (the help surface) are recognized for EVERY subcommand and never reach any
 * op input as data.
 */
const RESERVED_FLAG_KEYS: readonly string[] = ['json', 'help', 'h'];

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

const JSON_VALUES_NOTE = 'flag values are JSON-parsed when they parse as JSON, else kept as raw strings.';

function renderGlobalHelp(names: string[]): string {
  return [
    'usage: cq <subcommand> [--key=value ...] [--json]',
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
 * the schema exposes no `.shape`, render a generic line instead of field
 * lines.
 */
function renderSubHelp(
  name: string,
  schema: unknown,
  extraFlags: readonly string[],
  notes: readonly string[],
  renderKey: (key: string) => string = (key) => key,
): string {
  const lines: string[] = [`usage: cq ${name} [--key=value ...]`, '', 'flags:'];
  const shape = (schema as unknown as { shape?: Record<string, unknown> }).shape;
  if (typeof shape === 'object' && shape !== null && !Array.isArray(shape)) {
    for (const [key, value] of Object.entries(shape)) {
      lines.push(`  --${renderKey(key)}=${describeType(value)}`);
    }
  } else {
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
    // --json is accepted for EVERY subcommand (it drives narration mode) and
    // --help is the reserved help flag — list both, like renderRunPlanHelp.
    ['--json', '--help'],
    [JSON_VALUES_NOTE],
  );
}

function renderRunPlanHelp(): string {
  return renderSubHelp(
    'run-plan',
    RunPlanInputSchema,
    ['--json', '--help'],
    [
      JSON_VALUES_NOTE,
      'run-plan accepts kebab-case aliases for its camelCase keys (--ops-root, --journal-dir, --max-usd, --max-tokens, --stop-on-error); op subcommands take EXACT schema keys.',
    ],
    camelToKebab, // render the kebab-case canonical flag forms, not schema keys
  );
}

// --- Dispatch --------------------------------------------------------------

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
  if (argv.length === 0) {
    narrate(io, 'missing subcommand (try --help)');
    return EXIT_CODES.usage;
  }
  const sub = argv[0];
  // Global help: --help/-h as the leading argument (lenient about what
  // follows — help wins).
  if (sub === '--help' || sub === '-h') {
    io.stdout(renderGlobalHelp(subcommandNames(await list({ opsRoot }))));
    return EXIT_CODES.ok;
  }

  // Flag syntax first: duplicate flags throw here → narrated usage error (2);
  // positional tokens are a usage error too.
  let parsed: ReturnType<typeof parseFlags>;
  try {
    parsed = parseFlags(argv.slice(1));
  } catch (err) {
    narrate(io, `${messageOf(err)} (try --help)`);
    return EXIT_CODES.usage;
  }
  if (parsed.unknown.length > 0) {
    narrate(io, `unexpected positional argument '${parsed.unknown[0]}' (try --help)`);
    return EXIT_CODES.usage;
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
    narrate(
      io,
      `--${reservedKey} is a reserved CLI flag ` +
        '(op input schemas must not declare reserved keys: json, help, h)',
    );
    return EXIT_CODES.usage;
  }
  // Reserved mode flags — never part of any op input.
  const wantsHelp = parsed.flags['help'] === true || parsed.flags['h'] === true;
  const mode: NarrationMode = parsed.flags['json'] === true ? 'json' : 'human';

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
      return await runPlanCommand(parsed.flags, io, mode, opts);
    } catch (err) {
      narrate(io, `run-plan threw: ${messageOf(err)}`);
      return EXIT_CODES.thrown;
    }
  }

  // --- Op subcommands -------------------------------------------------------
  const entry = await get(sub, { opsRoot });
  if (entry === undefined) {
    // Unknown subcommand: narrate to stderr, NOTHING on stdout, exit 2.
    narrate(io, `unknown subcommand '${sub}' (try --help)`);
    return EXIT_CODES.usage;
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
    narrate(io, '--ops-root is a run-plan flag (op inputs own their schema keys)');
    return EXIT_CODES.usage;
  }
  // Strip the reserved mode flags — the op's schema sees only its own keys
  // (ops map flags by EXACT schema key; see the header for the run-plan
  // kebab-case exception).
  const input: Record<string, unknown> = { ...parsed.flags };
  delete input['json'];
  delete input['help'];
  delete input['h'];
  // Validate FIRST: schema-invalid input is a usage error (exit 2, nothing
  // on stdout — no op ever ran). safeParseAsync, not safeParse: registry
  // schemas may carry ASYNC refinements/transforms (the runner dispatches
  // through parseAsync, and the direct path must accept exactly what the
  // runner accepts) — a sync parse throws on those
  // (`Encountered Promise during synchronous parse`), surfacing as a
  // spurious exit-1 'thrown' instead of a usage error. Failures of async
  // schemas stay usage errors (2). The run-plan schema path stays on plain
  // safeParse (static, sync — see run-plan.ts).
  const check = await entry.inputSchema.safeParseAsync(input);
  if (!check.success) {
    narrate(io, `invalid input for '${sub}': ${issueMessage(check.error)}`);
    return EXIT_CODES.usage;
  }
  try {
    const op = await entry.importer();
    // The op's TypeScript return type is no runtime guarantee: ops load from
    // RUNTIME registries, so the direct-dispatch path validates the returned
    // value with the kernel's own mirror before ANY stdout artifact or
    // exit-code derivation (the plan path gets the same two probes via
    // runPlan's executeOp; this is their direct-path counterpart).
    const raw: unknown = await op(check.data);
    const checked = OpResultSchema.safeParse(raw);
    if (!checked.success) {
      narrate(io, `${sub} returned an invalid result: ${issueMessage(checked.error)}`);
      return EXIT_CODES.thrown;
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
    // instances, function/symbol members, undefined array elements.
    try {
      JSON.stringify(checked.data, (_key, value: unknown) => {
        if (typeof value === 'number' && !Number.isFinite(value)) {
          throw new Error(`non-finite number ${String(value)}`);
        }
        return value;
      });
      if (checked.data.status === 'ok' && checked.data.value === undefined) {
        throw new Error("ok result without a 'value'");
      }
      assertJsonLossless(checked.data);
    } catch (probeErr) {
      narrate(io, `${sub} returned an invalid result: ${messageOf(probeErr)}`);
      return EXIT_CODES.thrown;
    }
    writeResultJson(io, checked.data); // the ONE stdout artifact
    narrateOpResult(io, sub, checked.data, mode); // failures-only; silent in json mode
    return exitCodeForOpResult(checked.data);
  } catch (err) {
    // Thrown (uncaught exception) → 1, decided HERE (the caller of the
    // exit-code functions); stdout stays empty — no result ever existed.
    narrate(io, `${sub} threw: ${messageOf(err)}`);
    return EXIT_CODES.thrown;
  }
}

/**
 * Run the CLI over `argv` (process.argv minus node/script). Never throws:
 * every path returns an exit code ({0,1,2,3}; see src/cli/exit.ts).
 */
export async function runCli(argv: string[], io?: CliIo, opts?: RunCliOptions): Promise<number> {
  const sink = io ?? processIo;
  try {
    return await dispatchCli(argv, sink, opts);
  } catch (err) {
    // Last-resort catch (registry scan defect, …): a runtime throw outside a
    // subcommand's own scope → narrated exit 1 'thrown'.
    narrate(sink, `threw: ${messageOf(err)}`);
    return EXIT_CODES.thrown;
  }
}
