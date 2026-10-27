// selfhost/verify-ratchet — cq-verify's IN-PROCESS ratchet verdict
// (readiness T2; ADR-0004 D-C.3; docs/d11-decisive-authorization.md).
//
// It replaces `trust/dist/cli.js ratchet.verifyRatchet` in cq-verify's
// `judge` job, for two reasons:
//   - D11 (T2): a definition change on the merge-queue tip may promote only
//     when every admitted PR that changed it carries an honoured record. The
//     strict CLI schema cannot carry a D11Authorization, so this entry binds
//     one in-process with the promotion gate's own closure and evidence
//     (promote-gate.ts `bindQueueAuthorization`): one object and one
//     predicate (`authorizePaths`) for the gate's policy pass and for the
//     `cq/ratchet` verdict the gate requires on the tip.
//   - Residual R1 (docs/protected-scope.md): the trusted verdict no longer
//     loads the CLI registry; only this module's import closure runs.
//
// PR subjects bind no authorization, so a definition change stays
// needs-human there, exactly as before. `cq/ratchet` is not required at
// merge, and the gate re-judges the queue tip, so a PR-level record would
// add nothing decisive.
//
// FAIL CLOSED: an unreadable owner id, label events or settle ledger, an
// absent or invalid C3 attestation, a closure the gate would refuse, or a
// git fault while binding leaves every definition change unauthorized, so
// the verdict is exactly what the CLI carrier gave.
//
// OUTPUT: one JSON line, the same OpResult the CLI carrier printed, so
// cq-verify's validation and check-run steps are unchanged. gh reads
// GH_TOKEN (the job's read-only token) for the evidence reads only.
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import type { OpResult } from '../kernel/types.js';
import type { D11Authorization } from '../ops/gates/d11Authorization.js';
import { resolveProtectedPathsConfig } from '../ops/gates/policyConfig.js';
import {
  createVerifyRatchet,
  verifyRatchet,
  type VerifyRatchetOutcome,
} from '../ops/ratchet/verifyRatchet.js';
import { ghNameOk, makeGhRunner, type GhFn } from '../adapters/forge-github/gh.js';
import { EntryUsageError, parseEntryArgs, runEntry } from './trusted-entry.js';
import { bindQueueAuthorization, realGateGit, type GateGit } from './promote-gate.js';

/** The verifier's own input, as the CLI schema has it, plus the repository identity. */
const ArgsSchema = z
  .object({
    repo: z.string().min(1),
    repository: z.string().min(1),
    repositoryId: z.coerce.number().int().positive(),
    trustRef: z.string().regex(/^[0-9a-f]{40}$/),
    subject: z.string().min(1),
    subjectKind: z.enum(['pr', 'push']),
    base: z.string().min(1),
    measureConclusion: z.string().min(1),
    measurementPath: z.string().min(1).exactOptional(),
    typecheckCount: z.coerce.number().int().nonnegative().exactOptional(),
  })
  .strict();

export type VerifyArgs = z.infer<typeof ArgsSchema>;

/** Strict `--name=value` parsing: an unknown, repeated or empty flag throws. */
export function parseVerifyArgs(argv: readonly string[]): VerifyArgs {
  const args = parseEntryArgs(argv, ArgsSchema);
  const [owner = '', name = '', ...extra] = args.repository.split('/');
  if (extra.length > 0 || !ghNameOk(owner) || !ghNameOk(name)) {
    throw new EntryUsageError(
      `--repository must be <owner>/<name> — got ${JSON.stringify(args.repository)}`,
    );
  }
  return args;
}

export interface VerifyDeps {
  gh: GhFn;
  git: GateGit;
  /** Seams for tests; production uses the real ones. */
  bind?: typeof bindQueueAuthorization;
  verify?: typeof verifyRatchet;
}

/**
 * The verdict for one subject. A push subject is judged with the gate's
 * D11 authorization over `main..subject`; a PR subject with none. Never
 * throws for an evidence fault: the binding fails closed instead.
 */
export async function verifyWithAuthorization(
  deps: VerifyDeps,
  args: VerifyArgs,
): Promise<OpResult<VerifyRatchetOutcome>> {
  const [owner = '', name = ''] = args.repository.split('/');
  const lines: string[] = [];
  let authorization: D11Authorization | undefined;
  if (args.subjectKind === 'push') {
    try {
      const main = await deps.git.revParse(args.repo, args.base);
      authorization = await (deps.bind ?? bindQueueAuthorization)(
        { gh: deps.gh, git: deps.git },
        {
          repo: args.repo,
          owner,
          name,
          repositoryId: args.repositoryId,
          trustRef: args.trustRef,
        },
        main,
        args.subject,
        lines,
      );
    } catch (error) {
      lines.push(
        `d11: evidence could not be bound (${error instanceof Error ? error.message : String(error)}) — no authorization`,
      );
    }
  }
  const result = await (deps.verify ?? verifyRatchet)({
    repo: args.repo,
    trustRef: args.trustRef,
    subject: args.subject,
    subjectKind: args.subjectKind,
    base: args.base,
    measureConclusion: args.measureConclusion,
    ...(args.measurementPath === undefined ? {} : { measurementPath: args.measurementPath }),
    ...(args.typecheckCount === undefined ? {} : { typecheckCount: args.typecheckCount }),
    ...(authorization === undefined ? {} : { authorization }),
  });
  // Journal the evidence (D-G.4 "journalled and echoed") whenever a
  // definition change made it matter: the check run's summary carries it.
  if (result.status === 'ok' && result.value.definitionChanges.length > 0) {
    const evidence = [...lines, ...(authorization?.report ?? [])];
    if (args.subjectKind === 'pr') evidence.push('d11: PR subject — no authorization is bound');
    return {
      status: 'ok',
      value: { ...result.value, reasons: [...result.value.reasons, ...evidence] },
    };
  }
  return result;
}

export interface VerifyMainDeps extends Pick<VerifyDeps, 'bind' | 'verify'> {
  env?: Readonly<Record<string, string | undefined>>;
  makeGh: () => GhFn;
  git: GateGit;
  write: (line: string) => void;
}

/** Parse, verify, write ONE JSON line; return the I1 exit code (./trusted-entry.ts). */
export function mainWith(argv: readonly string[], deps: VerifyMainDeps): Promise<number> {
  return runEntry<VerifyRatchetOutcome>(() => {
    const args = parseVerifyArgs(argv);
    return verifyWithAuthorization(
      {
        gh: deps.makeGh(),
        git: deps.git,
        ...(deps.bind === undefined ? {} : { bind: deps.bind }),
        verify:
          deps.verify ??
          createVerifyRatchet(resolveProtectedPathsConfig({ env: deps.env ?? process.env })),
      },
      args,
    );
  }, deps.write);
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const code = await mainWith(process.argv.slice(2), {
    makeGh: () => makeGhRunner(),
    git: realGateGit,
    write: (line) => process.stdout.write(line),
  });
  if (code !== 0) process.exitCode = code;
}
