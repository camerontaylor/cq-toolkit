// recomputeTypecheck — the trusted typecheck-count recompute (W1.7,
// ADR-0004 D-B "Ratchet: typecheck-count (trusted recompute)").
//
// typecheck-count is NOT taken from the head's measurement leg: the verifier
// recomputes it with the TRUST-REF toolchain over the subject's tree as
// data. Three properties make that hold:
//   - ATTRIBUTE-FREE EXTRACTION: the subject tree is materialized with
//     `ls-tree -r -z` + `cat-file --batch` (./git.js), never `git archive`
//     (which honours head-controlled `.gitattributes`: `export-ignore`
//     silently drops error files, `export-subst` rewrites content; critic r2
//     R2-2) and never a checkout (smudge filters). Symlinks and gitlinks are
//     skipped, so a head symlink cannot point tsc at runner paths. Tracked
//     `node_modules` paths are refused, so head declarations cannot shadow
//     the trusted dependency install.
//   - TRUSTED TOOLCHAIN OUTSIDE THE TREE: the tree lands in
//     `<scratch>/tree`, which has no `node_modules` of its own; module and
//     `@types` resolution walk up to `<scratch>/node_modules`, a symlink to
//     the TRUST checkout's install (`npm ci --ignore-scripts`). The compiler
//     binary is the trust checkout's `typescript/bin/tsc`, run by this
//     process's node with an argv array (no shell).
//   - NO HEAD CODE RUNS: tsc executes no project code and the tsc CLI does
//     not load `compilerOptions.plugins` (RS-4 T-21). The head's tsconfig
//     graph is in the definition set, so a head that edits it is
//     needs-human at the verifier; an unedited one equals the trust ref's.
//
// The caller runs this in a job that holds NO credential (the compute half
// of D-B's compute/sign split): a head tsconfig can still steer which files
// tsc reads. Diagnostics are never returned beyond the count (R2-4).
// Residual (D-J): suppression pragmas and ambient declarations in head
// SOURCE are content, not definition, and still lower the count.
import { mkdir, readdir, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Op } from '../../kernel/types.js';
import { subprocessRunCheck } from '../gates/checkRunner.js';
import { typecheckCount } from './adapters/typecheckCount.js';
import { extractTreeAttributeFree, gitRevParse } from './git.js';
import { classifyTscCapture } from './sources.js';

/** Default wall-clock budget for the recompute's tsc run; a timeout is a failure. */
export const RECOMPUTE_TIMEOUT_MS = 10 * 60 * 1000;

export interface RecomputeTypecheckInput {
  /** The TRUSTED checkout: its git objects hold the subject, its node_modules the toolchain. */
  repo: string;
  /** The commit whose tree is recomputed. */
  subject: string;
  /** A scratch directory that must not exist yet (or be empty). */
  scratch: string;
  /** tsc wall-clock budget in ms (default {@link RECOMPUTE_TIMEOUT_MS}). */
  timeoutMs?: number;
}

export interface RecomputeTypecheckOutcome {
  /** The error count, or null when tsc produced no usable evidence (I5: never a pass). */
  count: number | null;
  /** The resolved subject SHA. */
  subject: string;
  /** Regular files extracted, and entries skipped (symlinks, gitlinks). */
  files: number;
  skipped: number;
  /** tsc's exit code (null: killed, timed out, spawn failure). */
  exitCode: number | null;
}

/** Error message of an unknown throwable. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The recompute op. */
export const recomputeTypecheck: Op<RecomputeTypecheckInput, RecomputeTypecheckOutcome> = async (
  input,
) => {
  const repo = resolve(input.repo);
  const scratch = resolve(input.scratch);
  const tree = join(scratch, 'tree');
  let subject: string;
  let extracted: { files: number; skipped: unknown[] };
  try {
    subject = await gitRevParse(repo, input.subject);
    await mkdir(scratch, { recursive: true });
    if ((await readdir(scratch)).length > 0) {
      return { status: 'failed', error: `ratchet recompute: scratch '${scratch}' is not empty` };
    }
    extracted = await extractTreeAttributeFree(repo, subject, tree);
    // The trust toolchain sits OUTSIDE the extracted tree: resolution walks
    // up from <scratch>/tree to <scratch>/node_modules.
    await symlink(join(repo, 'node_modules'), join(scratch, 'node_modules'), 'dir');
  } catch (err) {
    return { status: 'failed', error: `ratchet recompute: ${messageOf(err)}` };
  }
  const raw = await subprocessRunCheck({
    command: process.execPath,
    args: [
      join(repo, 'node_modules', 'typescript', 'bin', 'tsc'),
      '--noEmit',
      '-p',
      join(tree, 'tsconfig.json'),
      '--pretty',
      'false',
    ],
    cwd: tree,
    timeoutMs: input.timeoutMs ?? RECOMPUTE_TIMEOUT_MS,
  });
  const evidence = classifyTscCapture(raw);
  const count = evidence === null ? null : (typecheckCount.extract(evidence)?.value ?? null);
  return {
    status: 'ok',
    value: {
      count,
      subject,
      files: extracted.files,
      skipped: extracted.skipped.length,
      exitCode: raw.exitCode,
    },
  };
};
