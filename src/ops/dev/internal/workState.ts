// Dev lane — the ONE reading of the working state that every dev command
// records or checks against (dev.check, dev.review, dev.ready, pr.open):
// the branch, HEAD, the pinned immutable base, and the dirty identity.
//
// THE BASE PIN (strategy §3, dev.review row): `merge-base(origin/<target>,
// HEAD)`, or an explicit base resolved once to a commit sha. A stacked
// branch pins its stack parent by naming the parent as the target.
//
// THE DIRTY IDENTITY binds everything outside HEAD that a review or a gate
// can see: the exact staged patch, the exact unstaged patch (each read
// separately — an index/worktree split whose worktree equals HEAD is still
// dirty), and the untracked non-ignored path list. A tree with none of the
// three is `clean-tree`. Readiness compares this one value, so any record
// made with untracked files present can never match a ready (untracked-free)
// state.
//
// AUTHOR TIER (strategy §2.4): this is accidental-drift detection for the
// implementor's own records, not an isolation boundary — verification is
// required CI and the reviewer bots at the exact head.
import { createHash } from 'node:crypto';
import { HARDENED_DIFF_FLAGS } from '../../../shared/gitHarden.js';
import type { CommandResult, DevEffects } from '../effects.js';

/** Git read wall-clock cap. */
export const GIT_TIMEOUT_MS = 60 * 1000;

/** The dirty identity of a tree with no staged, unstaged, or untracked change. */
export const CLEAN_TREE = 'clean-tree';

/**
 * Diff flags for the identity reads: exact bytes (`--binary --full-index`)
 * under the shared hardened set minus `--text`, which would render binary
 * content lossily.
 */
export const IDENTITY_DIFF_FLAGS: readonly string[] = [
  '--binary',
  '--full-index',
  ...HARDENED_DIFF_FLAGS.filter((flag) => flag !== '--text'),
];

/** The working state a dev record is bound to. */
export interface WorkState {
  branch: string;
  head: string;
  /** The pinned immutable base (a full commit sha). */
  base: string;
  /** Exact staged patch bytes. */
  staged: string;
  /** Exact unstaged patch bytes. */
  unstaged: string;
  /** Untracked non-ignored paths, in git's order. */
  untracked: string[];
  /** sha256 over staged, unstaged and untracked, or {@link CLEAN_TREE}. */
  dirtySha256: string;
}

/** A work-state read: the state, or the reason it cannot be read (a needs-human cause). */
export type WorkStateRead = { ok: true; state: WorkState } | { ok: false; reason: string };

/** Run one git command in the repo (the effects adapter applies the global hardening). */
export function git(effects: DevEffects, args: readonly string[]): Promise<CommandResult> {
  return effects.runCommand('git', args, { timeoutMs: GIT_TIMEOUT_MS });
}

/** stdout of a git read that must succeed; throws naming the command otherwise. */
export function gitStdout(result: CommandResult, what: string): string {
  if (result.exitCode !== 0 || result.timedOut) {
    const why = result.timedOut
      ? 'timed out'
      : `exit ${result.exitCode === null ? 'none (killed)' : String(result.exitCode)}`;
    const tail = (result.stderr || result.stdout).trim().slice(0, 200);
    throw new Error(`git ${what} failed (${why})${tail === '' ? '' : ` — ${tail}`}`);
  }
  return result.stdout;
}

/** Split NUL-terminated git output (`-z`) into its entries. */
export function zList(stdout: string): string[] {
  return stdout.split('\0').filter((entry) => entry !== '');
}

/** The dirty identity of the three components (length-prefixed, so no two splits collide). */
export function dirtyIdentity(
  staged: string,
  unstaged: string,
  untracked: readonly string[],
): string {
  if (staged === '' && unstaged === '' && untracked.length === 0) return CLEAN_TREE;
  const hash = createHash('sha256');
  for (const part of [staged, unstaged, untracked.join('\0')]) {
    hash.update(`${String(part.length)}\0`).update(part);
  }
  return hash.digest('hex');
}

/**
 * Read the working state. A detached HEAD (no branch to record under), an
 * unresolvable base, or any failed read is a reason, never a guessed value:
 * a failed diff is not a clean tree and an unreadable file list is not an
 * empty one.
 */
export async function readWorkState(
  effects: DevEffects,
  pin: { target: string; base?: string },
): Promise<WorkStateRead> {
  try {
    const symbolic = await git(effects, ['symbolic-ref', '--quiet', 'HEAD']);
    if (symbolic.exitCode === 1) {
      return {
        ok: false,
        reason: 'HEAD is detached — dev records are kept per branch; check out a branch and re-run',
      };
    }
    const branchRef = gitStdout(symbolic, 'symbolic-ref HEAD').trim();
    if (!branchRef.startsWith('refs/heads/') || branchRef.length === 'refs/heads/'.length)
      return { ok: false, reason: 'HEAD does not name a local branch ref' };
    // --short may return heads/<name> when refs/<name> also exists.
    // Branch identity is the exact local ref suffix, never its ambiguous display name.
    const branch = branchRef.slice('refs/heads/'.length);
    const head = gitStdout(
      await git(effects, ['rev-parse', '--verify', 'HEAD']),
      'rev-parse HEAD',
    ).trim();
    // An explicit base is schema-validated hex, so it cannot read as an option.
    const baseRead =
      pin.base !== undefined
        ? await git(effects, ['rev-parse', '--verify', `${pin.base}^{commit}`])
        : await git(effects, ['merge-base', '--end-of-options', `origin/${pin.target}`, 'HEAD']);
    if (baseRead.exitCode !== 0) {
      return {
        ok: false,
        reason:
          pin.base !== undefined
            ? `the explicit base '${pin.base}' did not resolve to a commit — pin an immutable sha`
            : `cannot pin the merge-base: 'origin/${pin.target}' did not resolve — fetch the target and re-run`,
      };
    }
    const base = baseRead.stdout.trim();
    const staged = gitStdout(
      await git(effects, ['diff', '--cached', ...IDENTITY_DIFF_FLAGS]),
      'diff --cached',
    );
    const unstaged = gitStdout(await git(effects, ['diff', ...IDENTITY_DIFF_FLAGS]), 'diff');
    // The toolkit's own `/.cq/` state (this ledger included) is never part
    // of the reviewed or checked content, even where the repo does not
    // ignore it.
    const untracked = zList(
      gitStdout(
        await git(effects, ['ls-files', '-z', '--others', '--exclude-standard', '--exclude=/.cq/']),
        'ls-files --others',
      ),
    );
    return {
      ok: true,
      state: {
        branch,
        head,
        base,
        staged,
        unstaged,
        untracked,
        dirtySha256: dirtyIdentity(staged, unstaged, untracked),
      },
    };
  } catch (err) {
    return {
      ok: false,
      reason: `the working state could not be read — ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Re-read the state against the SAME pinned base and name what drifted
 * (empty when nothing did). A failed re-read is drift, never a match.
 */
export async function driftSince(effects: DevEffects, state: WorkState): Promise<string[]> {
  const again = await readWorkState(effects, { target: '', base: state.base });
  if (!again.ok) return [again.reason];
  const drifted: string[] = [];
  if (again.state.branch !== state.branch) drifted.push('the branch changed');
  if (again.state.head !== state.head) drifted.push('HEAD moved');
  if (again.state.dirtySha256 !== state.dirtySha256) {
    drifted.push('the staged, unstaged, or untracked state changed');
  }
  return drifted;
}
