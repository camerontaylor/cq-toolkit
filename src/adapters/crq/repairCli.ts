/**
 * The `crq repair` entry point: Python `crq_repair.run`/`main` admission, up to
 * the point where the TS port ends.
 *
 * Ported here, in Python's order:
 * 1. argparse usage (`UsageArgumentParser`): a usage failure is exit 2 with the
 *    `{"error": {"kind": "usage", ...}}` artifact;
 * 2. the #1716 host-handover refusal: `state/runner-disabled` is read BEFORE
 *    config.json, the `state/repair` directory, the service lock and every
 *    alternate path (`--recover-job`, `--job`), so a handed-over host writes
 *    nothing, launches no provider and exits 0 with `refused`/`runner-disabled`;
 * 3. config.json read failure: exit 1 with the `failed` artifact;
 * 4. `repair.enabled`/`spend_authorization`: exit 0 `disabled`;
 * 5. the selector mode refusals (exit 2).
 *
 * Not ported (the drain itself; see `REPAIR_UNIT_MISSING_EFFECTS`): the budget
 * launcher, Paseo, ZAI_API_KEY and GLM-blackout admission, the service lock,
 * `--triage-dry-run`, `--recover-job`, an explicit `--job`, and the inbox
 * drain. Every invocation that would reach them returns the `failed` artifact
 * (exit 1) having written nothing, so `repair` is not a live unit command and
 * `crq-repair.service` stays on Python.
 *
 * One declared divergence: wherever argparse runs its help action (`-h`,
 * `--help` and its prefixes, and concatenated `-hx`, `-help`, `-h1`) Python
 * prints help text and exits 0 with no JSON; Node refuses with the usage
 * artifact ({@link HELP_REFUSAL}, exit 2). Help with `=value` (`-h=1`,
 * `--he=1`) is argparse's own usage error in both.
 *
 * Every path ends in exactly one JSON document on stdout, encoded as Python's
 * bare `json.dumps` (ASCII, `", "`/`": "` separators, insertion order).
 */
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  JsonNumber,
  JsonObject,
  parseJsonValue,
  type JsonValue,
} from '../../policy/crq/jsonValue.js';
import { pythonJsonText } from '../../policy/crq/pythonJson.js';
import { pythonRepr } from '../../policy/crq/prReviewFindings.js';
import { gateMessage } from '../../ops/crq/internal/repairPassGates.js';

export interface RepairArgs {
  readonly triageDryRun: boolean;
  readonly job: string | null;
  readonly sourceSha: string | null;
  readonly findingSha256: string | null;
  readonly recoverJob: string | null;
}

type ValueOption = 'job' | 'sourceSha' | 'findingSha256' | 'recoverJob';
type OptionKey = ValueOption | 'triageDryRun' | 'help';
/** argparse's `_option_string_actions`, in registration order (ambiguity lists use it). */
const OPTIONS: readonly (readonly [string, OptionKey])[] = [
  ['-h', 'help'],
  ['--help', 'help'],
  ['--triage-dry-run', 'triageDryRun'],
  ['--job', 'job'],
  ['--source-sha', 'sourceSha'],
  ['--finding-sha256', 'findingSha256'],
  ['--recover-job', 'recoverJob'],
];
const HELP_NAME = '-h/--help';
/** The usage message Node gives where Python's help action would print help. */
export const HELP_REFUSAL = 'help is not available from the Node runtime';

export type ParsedRepairArgv =
  | { readonly ok: true; readonly args: RepairArgs }
  | { readonly ok: false; readonly message: string };

/** One of argparse's `(action, option_string, sep, explicit_arg)` interpretations. */
interface OptionTuple {
  readonly name: string;
  readonly key: OptionKey;
  readonly sep: string | null;
  readonly explicit: string | null;
}

/** Python `str.partition('=')`: no separator leaves `sep`/`explicit` null. */
function partitionEquals(arg: string): readonly [string, string | null, string | null] {
  const at = arg.indexOf('=');
  return at < 0 ? [arg, null, null] : [arg.slice(0, at), '=', arg.slice(at + 1)];
}

/** argparse `_get_option_tuples` (abbreviations on), for `-x...` and `--x...`. */
function optionTuples(arg: string): OptionTuple[] {
  const [prefix, sep, explicit] = partitionEquals(arg);
  const tuples: OptionTuple[] = [];
  const longForm = arg[1] === '-';
  for (const [name, key] of OPTIONS) {
    if (!longForm && name === arg.slice(0, 2))
      tuples.push({ name, key, sep: '', explicit: arg.slice(2) });
    else if (name.startsWith(prefix)) tuples.push({ name, key, sep, explicit });
  }
  return tuples;
}

/**
 * argparse `_parse_optional`: the interpretations of an option-like string,
 * `'unknown'` for an option-shaped string no option matches, or `null` for a
 * positional (a value).
 */
function parseOptional(arg: string): OptionTuple[] | 'unknown' | null {
  if (arg === '' || !arg.startsWith('-')) return null;
  const exact = OPTIONS.find(([name]) => name === arg);
  if (exact) return [{ name: exact[0], key: exact[1], sep: null, explicit: null }];
  if (arg.length === 1) return null;
  const [head, sep, explicit] = partitionEquals(arg);
  const split = sep === null ? undefined : OPTIONS.find(([name]) => name === head);
  if (split) return [{ name: split[0], key: split[1], sep, explicit }];
  const tuples = optionTuples(arg);
  if (tuples.length > 0) return tuples;
  // `_negative_number_matcher` (`-\.?\d`, a prefix match): with no option that
  // looks like a negative number, such a string is a value.
  if (/^-\.?\d/.test(arg)) return null;
  // An unknown option-shaped string containing a space is a value.
  return arg.includes(' ') ? null : 'unknown';
}

const ignored = (explicit: string): string =>
  `argument ${HELP_NAME}: ignored explicit argument ${pythonRepr(explicit)}`;

/**
 * argparse `consume_optional`'s walk over `-h`'s concatenated tail (`-hx`,
 * `-hh`, `-help`): the help action is queued and runs after the walk unless the
 * walk raises first. A tail that is not another `-h` becomes an extra.
 */
function shortHelpTail(
  first: { sep: string | null; explicit: string },
  extras: string[],
): string | null {
  let { sep, explicit } = first;
  for (;;) {
    if (explicit === '' || sep === '=' || explicit.startsWith('-')) return ignored(explicit);
    if (explicit[0] !== 'h') {
      extras.push(`-${explicit}`);
      return null;
    }
    explicit = explicit.slice(1);
    if (explicit === '') return null;
    sep = explicit[0] === '=' ? '=' : '';
    if (sep === '=') explicit = explicit.slice(1);
  }
}

/** The `crq_repair.run` argparse parser (Python 3.14 messages). */
export function parseRepairArgv(argv: readonly string[]): ParsedRepairArgv {
  const values: Record<ValueOption, string | null> = {
    job: null,
    sourceSha: null,
    findingSha256: null,
    recoverJob: null,
  };
  let triageDryRun = false;
  const extras: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--') {
      extras.push(...argv.slice(index));
      break;
    }
    const tuples = parseOptional(arg);
    if (tuples === null || tuples === 'unknown') {
      extras.push(arg);
      continue;
    }
    if (tuples.length > 1) {
      const matches = tuples.map((tuple) => tuple.name).join(', ');
      return { ok: false, message: `ambiguous option: ${arg} could match ${matches}` };
    }
    const { name, key, sep, explicit } = tuples[0]!;
    if (key === 'help' || key === 'triageDryRun') {
      const label = key === 'help' ? HELP_NAME : name;
      if (explicit !== null) {
        const error =
          name === '-h'
            ? shortHelpTail({ sep, explicit }, extras)
            : `argument ${label}: ignored explicit argument ${pythonRepr(explicit)}`;
        if (error !== null) return { ok: false, message: error };
      }
      if (key === 'help') {
        // Python prints help text and exits 0 with no JSON artifact; the Node
        // runtime keeps its one-document contract and refuses instead.
        return { ok: false, message: HELP_REFUSAL };
      }
      triageDryRun = true;
      continue;
    }
    if (explicit !== null) {
      values[key] = explicit;
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next === '--' || parseOptional(next) !== null)
      return { ok: false, message: `argument ${name}: expected one argument` };
    values[key] = next;
    index += 1;
  }
  if (extras.length > 0)
    return { ok: false, message: `unrecognized arguments: ${extras.join(' ')}` };
  return { ok: true, args: { triageDryRun, ...values } };
}

/** Python `str.isspace()` code points (`\x1c`-`\x1f` and U+0085 included, U+FEFF not). */
const PYTHON_SPACE = new Set<number>([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001,
  0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f,
  0x205f, 0x3000,
]);

/** `not text.strip()`: every character is Python whitespace. */
function pythonBlank(text: string): boolean {
  for (const char of text) if (!PYTHON_SPACE.has(char.codePointAt(0)!)) return false;
  return true;
}

export interface RepairCliEffects {
  /** The runner root: Python's `ROOT`, the unit's WorkingDirectory. */
  readonly root: string;
  readonly stderr: (line: string) => void;
}

export interface RepairCliResult {
  readonly exitCode: number;
  /** Exactly one JSON document, newline-terminated. */
  readonly stdout: string;
}

const PYTHON_DUMPS = { asciiOnly: true, sortKeys: false, spacedSeparators: true } as const;

function emit(exitCode: number, artifact: unknown): RepairCliResult {
  return { exitCode, stdout: `${pythonJsonText(artifact, PYTHON_DUMPS)}\n` };
}

function failure(message: string): { error: Record<string, unknown> } {
  return {
    error: { kind: 'failed', subcommand: null, message: message.slice(0, 200), exitCode: 1 },
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** `json.loads((ROOT / 'config.json').read_text())`: duplicates keep the last value. */
async function readConfig(root: string): Promise<JsonValue> {
  const text = utf8.decode(await readFile(join(root, 'config.json')));
  return parseJsonValue(text, {
    duplicates: 'last',
    parseConstant: (raw) =>
      JsonNumber.float(raw === 'NaN' ? Number.NaN : raw === 'Infinity' ? Infinity : -Infinity),
  });
}

/** The `.get()` on a value Python requires to be a dict; anything else raises. */
function dictGet(value: JsonValue | undefined, key: string, what: string): JsonValue | undefined {
  if (!(value instanceof JsonObject)) throw new TypeError(`${what} is not an object`);
  return value.get(key);
}

/** `crq_repair.run` + `main`: one JSON document on stdout, narration on stderr. */
export async function runRepairCli(
  argv: readonly string[],
  effects: RepairCliEffects,
): Promise<RepairCliResult> {
  const narrate = effects.stderr;
  const refuse = (code: number, reason: string): RepairCliResult => {
    narrate(`repair dispatch refused: ${reason}`);
    return emit(code, { status: 'refused', reason });
  };
  try {
    const parsed = parseRepairArgv(argv);
    if (!parsed.ok) {
      narrate(`repair dispatch refused: ${parsed.message}`);
      return emit(2, {
        error: { kind: 'usage', subcommand: null, message: parsed.message, exitCode: 2 },
      });
    }
    const args = parsed.args;
    // #1716: CLI admission before the config read, the state directory, the
    // lock and every alternate path. A handed-over host must not write or spend.
    if (await exists(join(effects.root, 'state', 'runner-disabled'))) {
      narrate(gateMessage({ stage: 'cli-dispatch' }));
      return emit(0, { status: 'refused', reason: 'runner-disabled' });
    }
    const config = await readConfig(effects.root);
    // `config.get('repair', {})`: absent is `{}`; any non-dict raises below.
    const repair =
      config instanceof JsonObject && !config.has('repair')
        ? new JsonObject([])
        : dictGet(config, 'repair', 'config.json');
    const enabled = dictGet(repair, 'enabled', 'config.repair');
    const authorization = dictGet(repair, 'spend_authorization', 'config.repair');
    if (enabled !== true || typeof authorization !== 'string' || pythonBlank(authorization)) {
      const reason = 'repair.enabled and a recorded spend_authorization are required';
      narrate(`repair dispatch disabled: ${reason}`);
      return emit(0, { status: 'disabled', reason });
    }
    const selectors = [args.job, args.sourceSha, args.findingSha256];
    const supplied = selectors.map((selector) => selector !== null);
    const anySupplied = supplied.some(Boolean);
    if (args.recoverJob !== null && (anySupplied || args.triageDryRun))
      return refuse(2, 'recovery selects exactly one job');
    if (args.recoverJob !== null && pythonBlank(args.recoverJob))
      return refuse(2, '--recover-job must not be empty');
    if (args.triageDryRun && anySupplied)
      return refuse(2, '--triage-dry-run takes no job selector');
    let mode: string;
    if (args.triageDryRun) mode = '--triage-dry-run';
    else {
      if (anySupplied && !supplied.every(Boolean))
        return refuse(2, '--job, --source-sha and --finding-sha256 go together');
      if (selectors.some((selector) => selector !== null && pythonBlank(selector)))
        return refuse(2, 'supplied selector values must not be empty');
      mode = args.recoverJob !== null ? '--recover-job' : anySupplied ? '--job' : 'the inbox drain';
    }
    // The port ends here: everything Python does next (launcher/Paseo/ZAI and
    // blackout admission, service.lock, the work itself) has no TS binding.
    const message = `repair ${mode} is not ported to the Node runtime; crq-repair.service stays on Python`;
    narrate(`repair dispatch failed: ${message}`);
    return emit(1, failure(message));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    narrate(`repair dispatch failed: ${message.slice(0, 300)}`);
    return emit(1, failure(message));
  }
}
