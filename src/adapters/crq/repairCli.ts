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
import { gateMessage } from '../../ops/crq/internal/repairPassGates.js';

export interface RepairArgs {
  readonly triageDryRun: boolean;
  readonly job: string | null;
  readonly sourceSha: string | null;
  readonly findingSha256: string | null;
  readonly recoverJob: string | null;
}

type ValueOption = 'job' | 'sourceSha' | 'findingSha256' | 'recoverJob';
const OPTIONS: readonly (readonly [string, ValueOption | 'triageDryRun'])[] = [
  ['--triage-dry-run', 'triageDryRun'],
  ['--job', 'job'],
  ['--source-sha', 'sourceSha'],
  ['--finding-sha256', 'findingSha256'],
  ['--recover-job', 'recoverJob'],
];
const HELP = ['-h', '--help'];

export type ParsedRepairArgv =
  | { readonly ok: true; readonly args: RepairArgs }
  | { readonly ok: false; readonly message: string };

/** The flag half of `--flag=value` (argparse splits long options only). */
function flagPart(arg: string): string {
  const equals = arg.indexOf('=');
  return equals > 0 && arg.startsWith('--') ? arg.slice(0, equals) : arg;
}

/** argparse's `_parse_optional`: does this string look like an option flag? */
function optionLike(arg: string): boolean {
  if (!arg.startsWith('-') || arg === '-') return false;
  // A known option (exact, `=`-split or unique prefix) wins over the rules below.
  if (resolveFlag(flagPart(arg)) !== null) return true;
  // `_negative_number_matcher` (`-\.?\d`, a prefix match): with no option that
  // looks like a negative number, such a string is a value.
  if (/^-\.?\d/.test(arg)) return false;
  // An unknown option-shaped string containing a space is a value.
  if (arg.includes(' ')) return false;
  return true;
}

/** The long option `flag` names, by exact match or argparse's unique prefix. */
function resolveFlag(
  flag: string,
): readonly [string, ValueOption | 'triageDryRun'] | 'help' | null {
  if (!flag.startsWith('--') || flag === '--') return HELP.includes(flag) ? 'help' : null;
  const exact = OPTIONS.find(([name]) => name === flag);
  if (exact) return exact;
  if ('--help'.startsWith(flag)) return 'help';
  // Every option has a distinct third character, so a prefix is never ambiguous.
  const matches = OPTIONS.filter(([name]) => name.startsWith(flag));
  return matches.length === 1 ? matches[0]! : null;
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
    if (!optionLike(arg)) {
      extras.push(arg);
      continue;
    }
    const flag = flagPart(arg);
    const explicit = flag === arg ? null : arg.slice(flag.length + 1);
    const option = resolveFlag(flag);
    if (option === 'help') {
      // Python prints help text and exits 0 with no JSON artifact; the Node
      // runtime keeps its one-document contract and refuses instead.
      return { ok: false, message: 'help is not available from the Node runtime' };
    }
    if (option === null) {
      extras.push(arg);
      continue;
    }
    const [name, key] = option;
    if (key === 'triageDryRun') {
      if (explicit !== null)
        return { ok: false, message: `argument ${name}: ignored explicit argument '${explicit}'` };
      triageDryRun = true;
      continue;
    }
    if (explicit !== null) {
      values[key] = explicit;
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next === '--' || optionLike(next))
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
