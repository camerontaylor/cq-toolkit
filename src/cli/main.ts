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
// stdout carries the artifact).
//
// EXIT CODES: 0 ok; 1 failed/thrown; 2 usage — arg-shaped errors the CLI
// detects itself, never derived from the taxonomy; 3 needs-human/budget.
// runCli NEVER throws: every path returns a number, and a runtime throw
// (op crash, missing plan file, registry defect) is caught per subcommand,
// narrated, and returned as 1 with stdout left EMPTY — no result ever
// existed.
import { get, list } from '../registry/index.js';
import type { OpRegistryEntry } from '../kernel/types.js';
import { EXIT_CODES, exitCodeForOpResult } from './exit.js';
import {
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
    ['--help'],
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
 * genuinely runtime failures (op crash, missing plan file, registry scan
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
      // Runtime throws (missing plan file, journal failure, plan corruption
      // raised by the runner) → narrated exit 1; arg-shaped failures are
      // narrated exits 2 INSIDE runPlanCommand.
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
  // Strip the reserved mode flags — the op's schema sees only its own keys
  // (ops map flags by EXACT schema key; see the header for the run-plan
  // kebab-case exception).
  const input: Record<string, unknown> = { ...parsed.flags };
  delete input['json'];
  delete input['help'];
  delete input['h'];
  // Validate FIRST: schema-invalid input is a usage error (exit 2, nothing
  // on stdout — no op ever ran).
  const check = entry.inputSchema.safeParse(input);
  if (!check.success) {
    narrate(io, `invalid input for '${sub}': ${issueMessage(check.error)}`);
    return EXIT_CODES.usage;
  }
  try {
    const op = await entry.importer();
    const result = await op(check.data);
    writeResultJson(io, result); // the ONE stdout artifact
    narrateOpResult(io, sub, result, mode); // failures-only; silent in json mode
    return exitCodeForOpResult(result);
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
