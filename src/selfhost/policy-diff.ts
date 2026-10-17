// selfhost/policy-diff — cq-policy's IN-PROCESS PR-level policy check
// (residual R1, docs/protected-scope.md; ADR-0004 D-G).
//
// It replaces `trust/dist/cli.js gates.policyDiff` in cq-policy's `judge`
// job. The CLI shell loads every op registry (src/cli/**, src/kernel/**,
// src/registry/** and their static imports, none of it protected), so it
// could forge the `cq/policy` verdict that merge-time D11 rests on. Only
// this module's import closure runs now, and
// test/ops/gates/protectedPaths.test.ts holds all of it to
// policy/protected-paths.json. The gate's own recompute (promote-gate.ts)
// was already in-process.
//
// POSTURE: resolved from the project env exactly as the `gates.policyDiff`
// registry importer does (src/ops/gates/registry.ts): no per-call opt-in,
// never from argv, so a subject cannot relax its own check. An invalid
// value is a failed result, never a fallback.
//
// INPUT: the op's own schema (../ops/gates/policyDiffInput.ts, which the
// registry shares), so it carries no `authorization`: the gate binds one
// in-process, and a PR-level check never carries one. It deliberately does
// not import the gates registry, whose lazy importers reach ops no trusted
// job runs.
// OUTPUT: the same OpResult the CLI printed, as one JSON line, so the judge
// step's validation and check-run steps are unchanged; exit codes follow I1
// (./trusted-entry.ts).
import { pathToFileURL } from 'node:url';
import { resolveProtectedPathsConfig } from '../ops/gates/policyConfig.js';
import {
  createPolicyDiff,
  type PolicyDiffInput,
  type PolicyDiffOutcome,
} from '../ops/gates/policyDiff.js';
import { PolicyDiffInputObject as OpSchema } from '../ops/gates/policyDiffInput.js';
import { decimalFlag, parseEntryArgs, runEntry } from './trusted-entry.js';

/** `gates.policyDiff`'s own input schema, as `--name=value` flags. */
export const PolicyDiffArgsSchema = OpSchema.extend({
  pr: decimalFlag(OpSchema.shape.pr.unwrap()).exactOptional(),
  ownerId: decimalFlag(OpSchema.shape.ownerId.unwrap()).exactOptional(),
}).strict();

/** Strict `--name=value` parsing: an unknown, repeated or empty flag throws. */
export function parsePolicyDiffArgs(argv: readonly string[]): PolicyDiffInput {
  return parseEntryArgs(argv, PolicyDiffArgsSchema);
}

export interface PolicyDiffMainDeps {
  env: Readonly<Record<string, string | undefined>>;
  /** Seam for tests; production uses the real factory. */
  create?: typeof createPolicyDiff;
  write: (line: string) => void;
}

/** Parse, judge, write ONE JSON line; return the I1 exit code. */
export function mainWith(argv: readonly string[], deps: PolicyDiffMainDeps): Promise<number> {
  return runEntry<PolicyDiffOutcome>(async () => {
    const input = parsePolicyDiffArgs(argv);
    let config;
    try {
      config = resolveProtectedPathsConfig({ env: deps.env });
    } catch (error) {
      // The registry importer's mapping: an invalid posture is failed (1).
      return { status: 'failed', error: error instanceof Error ? error.message : String(error) };
    }
    return (deps.create ?? createPolicyDiff)(config)(input);
  }, deps.write);
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const code = await mainWith(process.argv.slice(2), {
    env: process.env,
    write: (line) => process.stdout.write(line),
  });
  if (code !== 0) process.exitCode = code;
}
