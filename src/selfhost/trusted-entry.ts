// selfhost/trusted-entry — the carrier contract of the trusted selfhost
// entry points (residual R1, docs/protected-scope.md).
//
// The trusted verdict jobs run `trust/dist/selfhost/<entry>.js` rather than
// `trust/dist/cli.js <op>`, so only each entry's own import closure executes
// (the CLI shell loads every op registry). This module is what those entries
// share, and it reimplements the CLI's two contracts without importing it:
//   - argv: `--name=value` only, each flag at most once, never empty,
//     validated by the entry's strict zod schema. Values stay strings
//     (unlike the CLI, nothing is JSON-parsed), so the schema decides each
//     type.
//   - I1 (policy/DOCTRINE.md): stdout is ONE JSON line, the OpResult; exit
//     0 ok, 1 failed or thrown, 2 arg error, 3 needs-human. An arg error
//     still prints a failed result, so a workflow that validates stdout
//     reads a failure, never nothing.
import { z } from 'zod';
import type { OpResult } from '../kernel/types.js';

/**
 * A numeric flag: a plain decimal string (no sign, exponent, hex, space or
 * leading zero) piped into `target`, the op schema's own number field, so
 * the bounds stay the op's.
 */
export function decimalFlag<T extends z.ZodType<number, number>>(
  target: T,
): z.ZodPipe<z.ZodPipe<z.ZodString, z.ZodTransform<number, string>>, T> {
  return z
    .string()
    .regex(/^(?:0|[1-9][0-9]*)$/, 'must be a decimal integer')
    .transform(Number)
    .pipe(target);
}

/** An argv fault: the I1 usage class (exit 2). */
export class EntryUsageError extends Error {
  override name = 'EntryUsageError';
}

/**
 * Parse `--name=value` flags into `schema`'s output. An unknown form, a
 * repeated or empty flag, or a schema issue throws an
 * {@link EntryUsageError} naming the flag.
 */
export function parseEntryArgs<S extends z.ZodType>(
  argv: readonly string[],
  schema: S,
): z.infer<S> {
  const values: Record<string, string> = {};
  for (const arg of argv) {
    const match = /^--([A-Za-z]+)=(.*)$/s.exec(arg);
    const flag = match?.[1];
    const value = match?.[2];
    if (flag === undefined || value === undefined) {
      throw new EntryUsageError(`unknown argument ${JSON.stringify(arg)}`);
    }
    if (Object.hasOwn(values, flag)) throw new EntryUsageError(`--${flag} given more than once`);
    if (value === '') throw new EntryUsageError(`--${flag} needs a value`);
    values[flag] = value;
  }
  const parsed = schema.safeParse(values);
  if (!parsed.success) {
    throw new EntryUsageError(
      parsed.error.issues
        .map((i) => `--${i.path.map(String).join('.') || '(args)'}: ${i.message}`)
        .join('; '),
    );
  }
  return parsed.data;
}

/** The I1 exit code of one result: the CLI's `exitCodeForOpResult`, restated. */
export function exitCodeFor(result: OpResult<unknown>): 0 | 1 | 3 {
  switch (result.status) {
    case 'ok':
      return 0;
    case 'needs-human':
    case 'budget-exhausted':
      return 3;
    case 'failed':
    case 'indeterminate':
      return 1;
    default:
      // A status this carrier predates fails rather than passing.
      return 1;
  }
}

/**
 * Run one entry: compute the result, write it as ONE JSON line, return the
 * I1 exit code. A throw is a failed result (exit 2 for an
 * {@link EntryUsageError}, else 1), never an empty stdout.
 */
export async function runEntry<T>(
  compute: () => Promise<OpResult<T>>,
  write: (line: string) => void,
): Promise<number> {
  let result: OpResult<T>;
  let code: number;
  try {
    result = await compute();
    code = exitCodeFor(result);
  } catch (error) {
    result = { status: 'failed', error: error instanceof Error ? error.message : String(error) };
    code = error instanceof EntryUsageError ? 2 : 1;
  }
  write(`${JSON.stringify(result)}\n`);
  return code;
}
