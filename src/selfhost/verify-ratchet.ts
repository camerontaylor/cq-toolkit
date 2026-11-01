// PR-only advisory ratchet verifier.
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import type { OpResult } from '../kernel/types.js';
import { resolveProtectedPathsConfig } from '../ops/gates/policyConfig.js';
import {
  createVerifyRatchet,
  verifyRatchet,
  type VerifyRatchetOutcome,
} from '../ops/ratchet/verifyRatchet.js';
import { ghNameOk } from '../adapters/forge-github/gh.js';
import { EntryUsageError, parseEntryArgs, runEntry } from './trusted-entry.js';

/** The verifier's own input, as the CLI schema has it, plus the repository identity. */
const ArgsSchema = z
  .object({
    repo: z.string().min(1),
    repository: z.string().min(1),
    repositoryId: z.coerce.number().int().positive(),
    trustRef: z.string().regex(/^[0-9a-f]{40}$/),
    subject: z.string().min(1),
    subjectKind: z.literal('pr'),
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
  verify?: typeof verifyRatchet;
}

/** Advisory verification for a PR; no promotion or settle-ledger reads. */
export async function verifySubject(
  deps: VerifyDeps,
  args: VerifyArgs,
): Promise<OpResult<VerifyRatchetOutcome>> {
  const result = await (deps.verify ?? verifyRatchet)({
    repo: args.repo,
    trustRef: args.trustRef,
    subject: args.subject,
    subjectKind: args.subjectKind,
    base: args.base,
    measureConclusion: args.measureConclusion,
    ...(args.measurementPath === undefined ? {} : { measurementPath: args.measurementPath }),
    ...(args.typecheckCount === undefined ? {} : { typecheckCount: args.typecheckCount }),
  });
  return result;
}

export interface VerifyMainDeps extends VerifyDeps {
  env?: Readonly<Record<string, string | undefined>>;
  write: (line: string) => void;
}

/** Parse, verify, write ONE JSON line; return the I1 exit code (./trusted-entry.ts). */
export function mainWith(argv: readonly string[], deps: VerifyMainDeps): Promise<number> {
  return runEntry<VerifyRatchetOutcome>(() => {
    const args = parseVerifyArgs(argv);
    return verifySubject(
      {
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
    write: (line) => process.stdout.write(line),
  });
  if (code !== 0) process.exitCode = code;
}
