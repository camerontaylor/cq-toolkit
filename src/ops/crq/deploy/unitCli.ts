/**
 * The unit-transaction slice of `deploy-controller.py main`: the argument
 * contract, dispatch and error-to-exit mapping for `switch --unit U --runtime
 * node:<sha>` and `recover --record P`.
 *
 * Inactive and unimported. Everything effectful is injected: the controller
 * effects, the helper identity check / overlay load (`prepare`) and the live
 * adapter binding (`adapterFor`). Global options (`--root`, `--overlay`,
 * `--record-dir`, `--helper`, `--expect-helper-sha256`) are the caller's; only
 * `--json` and the subcommand tail are parsed here.
 *
 * Not ported (unreachable from the unit path): the checkout `switch --sha
 * --tag`, `rollback`, `health`, and `NoChangeRefused` (raised only by the
 * checkout helper). `NoChangeRefused` handling therefore has no TS twin.
 */
import { pythonJsonText } from '../../../policy/crq/pythonJson.js';
import type { PythonJsonInput } from '../../../policy/crq/pythonJson.js';
import { RecordRefused, UNIT_RUNTIMES } from './controllerRecords.js';
import {
  RecoveryRequired,
  recoverUnit,
  switchUnit,
  type TransactionEffects,
  type UnitAdapter,
} from './unitTransaction.js';

/** `LiveBindingRefused` / `FactoryRefused` / `CompletionError`: adapter binding refusals. */
export class AdapterBindingRefused extends Error {}

export interface UnitCliDeps {
  effects: TransactionEffects;
  /** `_load_helper` then `load_overlay`; throws as Python would (Refused, Error). */
  prepare(operation: 'switch' | 'recover'): Promise<void> | void;
  /** `live.production_adapter(effects, overlay, unit=, runtime=)`. */
  adapterFor(unit: string, runtime: string): UnitAdapter;
  /** Test seam: the transactions to dispatch to (default: the real ones). */
  transactions?: { switchUnit: typeof switchUnit; recoverUnit: typeof recoverUnit };
}

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

type Parsed =
  | { kind: 'switch'; json: boolean; unit?: string; runtime?: string; sha?: string; tag?: string }
  | { kind: 'recover'; json: boolean; record: string }
  | { kind: 'usage'; json: boolean; operation: string | null; message: string };

/** `json.dumps(value, indent=2, sort_keys=True)` plus print's newline. */
export function dumps(value: unknown): string {
  return (
    pythonJsonText(value as PythonJsonInput, { sortKeys: true, asciiOnly: true, indent: 2 }) + '\n'
  );
}

const errorArtifact = (
  kind: string,
  subcommand: string | null,
  message: string,
  exitCode: number,
) => ({
  error: { kind, subcommand, message, exitCode },
});

const clip = (text: string, n: number): string => Array.from(text).slice(0, n).join('');

/** argparse-shaped parse of the two unit subcommands. */
export function parseUnitArgs(argv: readonly string[]): Parsed {
  const json = argv.includes('--json');
  const rest = argv.filter((a) => a !== '--json');
  const operation = rest[0] ?? null;
  // argparse: errors raised by a subparser name it; the top-level parser's
  // (bad operation, unrecognized arguments) leave the subcommand null.
  const usage = (message: string, sub: string | null = operation): Parsed => ({
    kind: 'usage',
    json,
    operation: sub,
    message,
  });
  if (operation !== 'switch' && operation !== 'recover') {
    return usage(
      operation === null
        ? 'the following arguments are required: operation'
        : `argument operation: invalid choice: '${operation}'`,
      null,
    );
  }
  const allowed = operation === 'switch' ? ['--unit', '--runtime', '--sha', '--tag'] : ['--record'];
  const values = new Map<string, string>();
  for (let i = 1; i < rest.length; i += 1) {
    const raw = rest[i] as string;
    const eq = raw.indexOf('=');
    const flag = raw.startsWith('--') && eq > 0 ? raw.slice(0, eq) : raw;
    if (!allowed.includes(flag)) return usage(`unrecognized arguments: ${raw}`, null);
    let value: string | undefined;
    if (flag !== raw) value = raw.slice(eq + 1);
    else {
      value = rest[i + 1];
      if (value === undefined || value.startsWith('--')) {
        return usage(`argument ${flag}: expected one argument`);
      }
      i += 1;
    }
    values.set(flag, value);
  }
  if (operation === 'recover') {
    const record = values.get('--record');
    if (record === undefined) return usage('the following arguments are required: --record');
    return { kind: 'recover', json, record };
  }
  const unit = values.get('--unit');
  if (unit !== undefined && !UNIT_RUNTIMES.has(unit)) {
    return usage(`argument --unit: invalid choice: '${unit}'`);
  }
  return {
    kind: 'switch',
    json,
    ...(unit === undefined ? {} : { unit }),
    ...(values.has('--runtime') ? { runtime: values.get('--runtime') as string } : {}),
    ...(values.has('--sha') ? { sha: values.get('--sha') as string } : {}),
    ...(values.has('--tag') ? { tag: values.get('--tag') as string } : {}),
  };
}

/** Python `main` for the unit operations. */
export async function runUnitCli(argv: readonly string[], deps: UnitCliDeps): Promise<CliResult> {
  const parsed = parseUnitArgs(argv);
  if (parsed.kind === 'usage') {
    return {
      exitCode: 2,
      stdout: dumps(errorArtifact('usage', parsed.operation, parsed.message, 2)),
      stderr: parsed.json ? '' : `usage: ${parsed.message}\n`,
    };
  }
  const operation = parsed.kind;
  const binding = (unit: string, runtime: string): UnitAdapter => {
    try {
      return deps.adapterFor(unit, runtime);
    } catch (error) {
      if (error instanceof AdapterBindingRefused) throw new RecordRefused(clip(error.message, 400));
      throw error;
    }
  };
  try {
    await deps.prepare(operation);
    let record: unknown;
    if (parsed.kind === 'switch') {
      const { unit, runtime, sha, tag } = parsed;
      if (!unit && !runtime) {
        // Python routes a switch with neither to the checkout path.
        if (!sha || !tag) throw new RecordRefused('checkout switch requires --sha and --tag');
        throw new RecordRefused('checkout switch is not ported');
      }
      if (!unit || !runtime || sha || tag) {
        throw new RecordRefused('unit switch requires --unit and --runtime only');
      }
      record = await (deps.transactions?.switchUnit ?? switchUnit)(
        deps.effects,
        binding(unit, runtime),
        unit,
        runtime,
      );
    } else {
      record = await (deps.transactions?.recoverUnit ?? recoverUnit)(
        deps.effects,
        null,
        parsed.record,
        (unit, prior) => binding(unit, prior),
      );
    }
    return { exitCode: 0, stdout: dumps(record), stderr: '' };
  } catch (error) {
    if (error instanceof RecoveryRequired) {
      return {
        exitCode: 3,
        stdout: dumps(error.recovery),
        stderr: parsed.json ? '' : `recovery required: ${error.message}\n`,
      };
    }
    const refusal =
      error instanceof RecordRefused
        ? error.message
        : error instanceof Error
          ? clip(error.message, 400) || error.name
          : null;
    if (refusal === null) throw error;
    return {
      exitCode: 2,
      stdout: dumps(errorArtifact('refused', operation, refusal, 2)),
      stderr: parsed.json ? '' : `refused: ${refusal}\n`,
    };
  }
}
