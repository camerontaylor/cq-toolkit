// Dev lane — `dev.ready`: assemble the author-tier readiness record from
// dev.check's green run plus the review ledger (strategy §3, dev.ready row).
// The requirements are the assembly core's (record.ts assembleReadiness):
//   - ≥ 1 TERMINAL review cycle at the CURRENT identity (a blocked cycle,
//     or one at a stale base/head/dirty-sha, never counts);
//   - zero OPEN blocking findings (fixed or rejected close one; deferred
//     does not);
//   - a GREEN dev.check at the current identity;
//   - no untracked non-ignored files (outside every recorded scope).
//
// NOT-READY IS EXIT 3: the gaps are listed in the needs-human reason —
// never a silent pass, never a partial record. Ready returns the record
// whose `evidenceClass: 'author'` and verbatim caveat mark the tier it
// belongs to (strategy §2.4): this is the implementor's CLAIM a PR is
// opened from, not verification.
import { createHash } from 'node:crypto';
import type { Op } from '../../kernel/types.js';
import type { DevEffects } from './effects.js';
import { branchFromRevParse, gitOut, requireGitOut, requireGitOutRaw } from './effects.js';
import type { DevReadinessRecord } from './record.js';
import {
  DEFAULT_DEV_TARGET,
  assembleReadiness,
  objectInputFault,
  repoRootFault,
} from './record.js';

/** Git read wall-clock cap. */
export const GIT_TIMEOUT_MS = 60 * 1000;

/** Input of the `dev.ready` op (plain JSON; the registry schema mirrors it). */
export interface DevReadyInput {
  /** Repository the branch ledger lives in. */
  repoRoot: string;
  /** The intended PR target branch (default: the documented queue target). */
  target?: string;
}

/**
 * Build the `dev.ready` op over injected effects. Per call: recompute the
 * CURRENT identity (a readiness claim is only ever about the state on
 * disk right now), assemble from the ledger, and return the record or the
 * named gaps.
 */
export function makeDevReady(effects: DevEffects): Op<DevReadyInput, DevReadinessRecord> {
  return async (input) => {
    // Library boundary BEFORE any effect: the input itself, then repoRoot
    // (a null/undefined input maps to the failed taxonomy, never a
    // TypeError outside it).
    const objectFault = objectInputFault(input);
    if (objectFault !== null) return { status: 'failed', error: `dev.ready: ${objectFault}` };
    const rootFault = repoRootFault(input.repoRoot);
    if (rootFault !== null) return { status: 'failed', error: `dev.ready: ${rootFault}` };
    const target = input.target ?? DEFAULT_DEV_TARGET;

    const branch = branchFromRevParse(
      await effects.runCommand('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        timeoutMs: GIT_TIMEOUT_MS,
      }),
    );
    if (branch === null) {
      return {
        status: 'needs-human',
        reason:
          'dev.ready records evidence per branch and HEAD is detached — check out a branch and re-run',
      };
    }
    const head = gitOut(
      await effects.runCommand('git', ['rev-parse', 'HEAD'], { timeoutMs: GIT_TIMEOUT_MS }),
    );
    if (head === null) {
      return {
        status: 'needs-human',
        reason: 'git rev-parse HEAD failed — is this a git worktree?',
      };
    }
    const base = gitOut(
      await effects.runCommand('git', ['merge-base', `origin/${target}`, 'HEAD'], {
        timeoutMs: GIT_TIMEOUT_MS,
      }),
    );
    if (base === null) {
      return {
        status: 'needs-human',
        reason: `cannot pin the merge-base: 'origin/${target}' did not resolve — fetch the target and re-run`,
      };
    }
    // FAIL-CLOSED identity reads: a failed read is a refusal, never a
    // fabricated clean tree or empty file list.
    let dirtySha256: string;
    let untracked: string[];
    try {
      const dirtyDiff = await effects.runCommand(
        'git',
        ['diff', '--binary', '--full-index', 'HEAD'],
        {
          timeoutMs: GIT_TIMEOUT_MS,
        },
      );
      const diffText = requireGitOutRaw(dirtyDiff, 'diff --binary --full-index HEAD');
      dirtySha256 =
        diffText === '' ? 'clean-tree' : createHash('sha256').update(diffText).digest('hex');
      const untrackedOut = requireGitOut(
        await effects.runCommand('git', ['ls-files', '--others', '--exclude-standard'], {
          timeoutMs: GIT_TIMEOUT_MS,
        }),
        'ls-files --others',
      );
      untracked = untrackedOut.split('\n').filter((line) => line.trim() !== '');
    } catch (err) {
      return {
        status: 'needs-human',
        reason: `the diff identity could not be read — ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    let ledger;
    try {
      ledger = effects.openLedger(branch).load();
    } catch (err) {
      return {
        status: 'needs-human',
        reason: `the branch dev-record could not be read — ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const assembled = assembleReadiness({
      branch,
      target,
      identity: { base, head, dirtySha256 },
      ledger,
      untracked,
      nowIso: effects.nowIso(),
    });
    if (!assembled.ready) {
      return {
        status: 'needs-human',
        reason: `NOT READY — ${String(assembled.gaps.length)} gap(s): ${assembled.gaps
          .map((gap) => `${gap.field}: ${gap.detail}`)
          .join(' | ')}`,
      };
    }
    return { status: 'ok', value: assembled.record };
  };
}
