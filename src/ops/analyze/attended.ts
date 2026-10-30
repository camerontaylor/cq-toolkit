// Analyze lane — the ATTENDED approval authority (Lane C, S3): the local,
// human-at-the-keyboard producer of `VerifiedApprovals` that ADR-0003's
// authority (./approval.ts) has been waiting on for the ordinary CLI path.
//
// WHAT IT IS. `makeAttendedApprovalAuthority({ confirm })` builds a REAL
// `makeApprovalAuthority` — the same admission, exercise, single-use spend
// and write-through lock every other mutation path uses — over:
//   - a `VerifiedApprovals` whose `verifiedFor(subject)` asks the caller's
//     `confirm(subject)`; on `true` it reads the workspace state with the git
//     reader and returns `{ nonce: <fresh random>, state }`, else `undefined`
//     (no approval → the op refuses `needs-human`, nothing written);
//   - an in-memory, single-use nonce ledger (one process, one spend per
//     nonce; a replay is `spent`);
//   - `makeProcessLocalMutationLocks()` (one process; honest scope).
// The CLI-facing caller (`analyze.fix --apply`) binds `confirm` to the EXACT
// subject it previewed — op, workspace, targets and input digest — so the
// flag confirms that one edit and nothing else.
//
// WHAT IT GUARANTEES (unchanged ADR-0003 properties):
//   - exact-subject binding: the grant covers the op, workspace, sorted
//     targets and input digest `confirm` saw; a different subject at exercise
//     is refused;
//   - state binding: HEAD and tree cleanliness are read at admission and
//     RE-READ under the mutation lock at exercise; any drift refuses with the
//     nonce unspent;
//   - single use: each confirmation mints one random nonce, spent at most
//     once in the in-memory ledger; a grant is exercised at most once;
//   - the lock is held from the state re-check THROUGH the write.
//
// WHAT IT DOES NOT GUARANTEE (say it plainly):
//   - no signature, no cross-process ledger, no cross-process lock: the
//     approval lives and dies inside one process — it is a local
//     confirmation, not a token an unattended run could carry;
//   - the EXEMPT prefixes (default `.cq/`, the toolkit's own report area) are
//     not part of the state: files under them can change between admission
//     and exercise unobserved. A subject whose target lies under an exempt
//     prefix is therefore refused outright;
//   - every OTHER dirt — an untracked file anywhere else, a modified tracked
//     file — still refuses (`workspace dirty`, naming the paths): commit or
//     stash first. Ignored files stay out of scope (ADR-0003 §4c residual).
//
// WHO CAN CONFIRM. In `analyze.fix`, `apply: true` IS the confirmation: it
// is operator-declared and reachable from ANY registry dispatch (the CLI's
// `--apply`, an SDK call, or a plan job's JSON) — ADR-0003 §1's "attended,
// unsigned" row, where the human's presence is the mitigation. It binds to
// the preview THIS process computes (and, when `previewDigest` is given, to
// exactly the preview the caller reviewed; an agent patch always requires
// it). It is not a signed token and must not be treated as one by
// unattended automation.
//
// The registry's process-wide binding stays DENY-ALL for the plain ops
// (`analyze.applyRemediation`, `analyze.astGrepCodemod`,
// `analyze.playbookDispatch`); this authority is composed per call by the op
// that owns the attended flow, never bound globally.
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import type {
  ApprovalAuthority,
  ApprovalStateReader,
  ApprovalSubject,
  NonceLedger,
  VerifiedApprovals,
} from './approval.js';
import {
  makeApprovalAuthority,
  makeGitApprovalStateReader,
  makeProcessLocalMutationLocks,
} from './approval.js';

/** The default exempt prefixes: the toolkit's own report area. */
export const ATTENDED_DEFAULT_EXEMPT: readonly string[] = ['.cq/'];

// All attended flows in this process serialize mutations of the same workspace.
const attendedMutationLocks = makeProcessLocalMutationLocks();

/** Configuration of {@link makeAttendedApprovalAuthority}. */
export interface AttendedApprovalConfig {
  /**
   * The human's confirmation for ONE exact subject. Return `true` only when
   * this subject is the one the human approved (the CLI binds it to the
   * previewed op, workspace, targets and input digest). Called at admission;
   * a throw is treated as no approval.
   */
  confirm: (subject: ApprovalSubject) => boolean | Promise<boolean>;
  /**
   * Workspace-relative directory prefixes whose untracked or modified files
   * do not make the tree dirty. Default {@link ATTENDED_DEFAULT_EXEMPT}.
   * Targets under these prefixes are refused.
   */
  exempt?: readonly string[];
  /** Test seam: the state reader (default: the git reader with `exempt`). */
  readState?: ApprovalStateReader;
}

/**
 * The in-memory single-use nonce ledger: check-and-append in one synchronous
 * step (linearizable within the process).
 */
function makeSingleUseNonceLedger(): NonceLedger {
  const spent = new Set<string>();
  return {
    consume: (nonce) => {
      if (spent.has(nonce)) return Promise.resolve('spent' as const);
      spent.add(nonce);
      return Promise.resolve('consumed' as const);
    },
  };
}

/** True when the workspace-relative or absolute `target` lies inside an exempt prefix of `workspace`. */
function targetUnderExempt(
  workspace: string,
  target: string,
  exempt: readonly string[],
): string | undefined {
  const absolute = isAbsolute(target) ? target : resolve(workspace, target);
  return exempt.find((prefix) => {
    const base = resolve(workspace, prefix);
    return absolute === base || absolute.startsWith(base + sep);
  });
}

/**
 * Build the attended authority (see the module header for what it does and
 * does not guarantee). Each flow has its own confirmation and nonce ledger;
 * mutation locks are shared across attended authorities in this process.
 */
export function makeAttendedApprovalAuthority(config: AttendedApprovalConfig): ApprovalAuthority {
  const exempt = config.exempt ?? ATTENDED_DEFAULT_EXEMPT;
  const readState = config.readState ?? makeGitApprovalStateReader({ exempt });
  const approvals: VerifiedApprovals = {
    verifiedFor: async (subject) => {
      let workspace: string;
      try {
        workspace = realpathSync(subject.workspace);
      } catch {
        workspace = resolve(subject.workspace);
      }
      for (const target of subject.targets) {
        const prefix = targetUnderExempt(workspace, target, exempt);
        if (prefix !== undefined) {
          throw new Error(
            `target '${target}' lies under the exempt prefix '${prefix}', whose contents the attended state check does not observe — an attended approval never covers it`,
          );
        }
      }
      let confirmed: boolean;
      try {
        confirmed = (await config.confirm(subject)) === true;
      } catch {
        confirmed = false;
      }
      if (!confirmed) return undefined;
      // The state the human's confirmation is taken against: read NOW, by
      // the same reader admission and exercise use, so admission's drift
      // check compares like with like and the exercise re-check is the real
      // TOCTOU guard.
      const state = await readState.read(subject.workspace, subject);
      return { nonce: `attended-${randomBytes(16).toString('hex')}`, state };
    },
  };
  return makeApprovalAuthority({
    approvals,
    ledger: makeSingleUseNonceLedger(),
    locks: attendedMutationLocks,
    readState,
  });
}
