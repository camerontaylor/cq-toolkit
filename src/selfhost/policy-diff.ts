// selfhost/policy-diff — cq-policy's IN-PROCESS PR-level policy check
// (residual R1, docs/protected-scope.md; ADR-0004 D-G).
//
// It replaces `trust/dist/cli.js gates.policyDiff` in cq-policy's `judge`
// job. The CLI shell loads every op registry (src/cli/**, src/kernel/**,
// src/registry/** and their static imports, none of it protected), so it
// could forge the advisory `cq/policy` verdict. Only
// this module's import closure runs now, and
// test/ops/gates/protectedPaths.closure.test.ts holds all of it to
// policy/protected-paths.json.
//
// POSTURE: resolved from the entry's CqEnv snapshot exactly as the
// `gates.policyDiff` registry importer does (src/ops/gates/registry.ts): no
// per-call opt-in, never from argv, so a subject cannot relax its own check.
// An invalid value fails at the entry, never falls back.
//
// INPUT: the op's own schema (../ops/gates/policyDiffInput.ts, which the
// registry shares), so it carries no promotion `authorization`. It deliberately does
// not import the gates registry, whose lazy importers reach ops no trusted
// job runs.
// OUTPUT: the same OpResult the CLI printed, as one JSON line, so the judge
// step's validation and check-run steps are unchanged; exit codes follow I1
// (./trusted-entry.ts).
import type { CqEnv } from '../config/env.js';
import { pathToFileURL } from 'node:url';
import { resolveProtectedPathsConfig } from '../ops/gates/policyConfig.js';
import {
  createPolicyDiff,
  type PolicyDiffInput,
  type PolicyDiffOutcome,
} from '../ops/gates/policyDiff.js';
import { PolicyDiffInputObject as OpSchema } from '../ops/gates/policyDiffInput.js';
import { decimalFlag, parseEntryArgs, runEntry } from './trusted-entry.js';
import { SETTLE_STATE_PATH } from './config.js';

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
  /** Explicit entry environment (tests and callers); the entry snapshot is read from it. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Seam for tests; production uses the real factory. */
  create?: typeof createPolicyDiff;
  write: (line: string) => void;
  /** Seam for tests; production writes entry diagnostics to stderr. */
  stderr?: (text: string) => void;
}

/** Parse, judge, write ONE JSON line; return the I1 exit code. */
export function mainWith(argv: readonly string[], deps: PolicyDiffMainDeps): Promise<number> {
  return runEntry<PolicyDiffOutcome>(
    async (cqEnv: CqEnv) => {
      const input = parsePolicyDiffArgs(argv);
      // The entry snapshot (from deps.env when injected, else the process env)
      // is the only posture source; a later ambient read cannot change it.
      const config = resolveProtectedPathsConfig({ cqEnv });
      return (deps.create ?? createPolicyDiff)(config, { settleStatePath: SETTLE_STATE_PATH })(
        input,
      );
    },
    deps.write,
    {
      ...(deps.env === undefined ? {} : { env: deps.env }),
      ...(deps.stderr === undefined ? {} : { stderr: deps.stderr }),
    },
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
