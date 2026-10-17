// selfhost/recompute-typecheck — cq-verify's IN-PROCESS typecheck recompute
// (residual R1, docs/protected-scope.md).
//
// It replaces `trust/dist/cli.js ratchet.recomputeTypecheck` in cq-verify's
// `compute` job. The CLI shell loads every op registry (src/cli/**,
// src/kernel/**, src/registry/** and their static imports, none of it
// protected), and the count it printed feeds the `cq/ratchet` verdict the
// promotion gate requires without recomputing it. Only this module's import
// closure runs now, and test/ops/gates/protectedPaths.test.ts holds all of
// it to policy/protected-paths.json.
//
// INPUT: the CLI op's own flags (`ratchet.recomputeTypecheck`), strict.
// OUTPUT: one JSON line, the same OpResult the CLI printed, so the compute
// step's validation (`.status == "ok"`, a numeric `.value.count`) is
// unchanged. Bad arguments or a throw are a failed result, never a count;
// exit codes follow I1 (./trusted-entry.ts).
import { pathToFileURL } from 'node:url';
import {
  recomputeTypecheck,
  type RecomputeTypecheckInput,
  type RecomputeTypecheckOutcome,
} from '../ops/ratchet/recomputeTypecheck.js';
import { RecomputeTypecheckCommandInputSchema as OpSchema } from '../ops/ratchet/recomputeTypecheckInput.js';
import { decimalFlag, parseEntryArgs, runEntry } from './trusted-entry.js';

/** `ratchet.recomputeTypecheck`'s own input schema, as `--name=value` flags. */
export const RecomputeArgsSchema = OpSchema.extend({
  timeoutMs: decimalFlag(OpSchema.shape.timeoutMs.unwrap()).exactOptional(),
}).strict();

/** Strict `--name=value` parsing: an unknown, repeated or empty flag throws. */
export function parseRecomputeArgs(argv: readonly string[]): RecomputeTypecheckInput {
  return parseEntryArgs(argv, RecomputeArgsSchema);
}

export interface RecomputeMainDeps {
  /** Seam for tests; production uses the real op. */
  recompute?: typeof recomputeTypecheck;
  write: (line: string) => void;
}

/** Parse, recompute, write ONE JSON line; return the I1 exit code. */
export function mainWith(argv: readonly string[], deps: RecomputeMainDeps): Promise<number> {
  return runEntry<RecomputeTypecheckOutcome>(
    () => (deps.recompute ?? recomputeTypecheck)(parseRecomputeArgs(argv)),
    deps.write,
  );
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const code = await mainWith(process.argv.slice(2), {
    write: (line) => process.stdout.write(line),
  });
  if (code !== 0) process.exitCode = code;
}
