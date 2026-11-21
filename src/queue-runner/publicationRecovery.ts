/**
 * `repair_tick.recover_publication` (repair_tick.py:756-801): offline recovery
 * of a journaled repair publication after a crash between the journal write
 * and the remote effects. Inactive: nothing imports this outside tests.
 *
 * The function decides from three reads (the remote branch tip, the PR or the
 * branch's PRs, and ancestry) and performs at most one push and one finalize.
 * Every read and effect is injected; this module has no Git or forge access.
 * Binding `push` to the real leased push (`src/adapters/git/leasedPush.ts`) and
 * `finalize` to `finalizePublication` (`publicationFinalize.ts`) is the
 * remaining runtime work, see `docs/crq/tick-slot-missing-effects.md`.
 *
 * The invariants pinned here are the ones the Python lease test pins
 * (`test_repair_publication_lease.py`):
 *
 * - the push is leased on the journaled `target` for an open PR (the
 *   ls-remote read may already be stale after a maintainer reset) and on the
 *   verified remote tip otherwise, an absent branch leasing the empty value;
 * - a lease that is not an ancestor of the journaled `head` refuses before any
 *   push, so a reset to an ancestor is never resurrected;
 * - a present branch that differs from the journal without an open PR refuses;
 * - an open PR still at the journaled `target` while the earlier remote read
 *   says the prepared `head` is published refuses instead of finalizing on the
 *   stale read (a reset or a lagging PR view); a later tick re-reads both.
 */
import { truthy } from './repairBackfill.js';
import { PyError } from './pyErrors.js';

type Rec = Record<string, unknown>;

/** The forge view `c.pr_info(pr)` returns, restricted to what recovery reads. */
export interface RecoveryPrInfo {
  readonly state: unknown;
  readonly headRefName: unknown;
  readonly headRefOid: unknown;
}

/** One row of `gh pr list --head <branch> --state all --json number,url,state,headRefOid`. */
export interface RecoveryBranchPr {
  readonly headRefOid: unknown;
}

export interface PublicationRecoveryEffects {
  /** `c.git('ls-remote', '--heads', 'origin', 'refs/heads/<branch>')`, stripped; `''` when absent. */
  lsRemoteHeads(branch: string): Promise<string>;
  /** `c.pr_info(item['pr'])`. */
  prInfo(pr: unknown): Promise<RecoveryPrInfo>;
  /** `c.gh_json(['pr', 'list', '--head', <branch>, '--state', 'all', ...])`. */
  listBranchPrs(branch: string): Promise<readonly RecoveryBranchPr[]>;
  /** `c.is_ancestor(older, newer)`. */
  isAncestor(older: string, newer: string): Promise<boolean>;
  /**
   * `git push origin --force-with-lease=refs/heads/<branch>:<expected>
   * <sha>:refs/heads/<branch>`. `expected` is `''` for an absent branch. The
   * caller has already refused a lease that does not fast-forward to `sha`.
   */
  push(branch: string, expected: string, sha: string): Promise<void>;
  /** `finalize_publication(c, q, item, run, record, publication)`. */
  finalize(): Promise<void>;
}

export const STALE_NOT_PUBLISHABLE = 'PR no longer publishable';
export const STALE_HEAD_MOVED = 'head moved after prepared publication; needs new review';
export const REFUSE_PR_IDENTITY = 'fix PR identity or prepared head mismatch';
export const REFUSE_BRANCH_DIFFERS = 'existing fix branch differs from prepared publication';
export const REFUSE_STALE_REMOTE_READ = 'remote branch read is stale against the open PR head';
export const REFUSE_NOT_FAST_FORWARD = 'publication would not fast-forward the checked remote head';

/** `publication[key]`: a missing key is a `KeyError`, a non-string SHA a `TypeError`. */
function field(publication: Rec, key: string): unknown {
  if (!Object.hasOwn(publication, key)) throw new PyError('KeyError', `'${key}'`);
  return publication[key];
}

function sha(publication: Rec, key: string): string {
  const value = field(publication, key);
  if (typeof value !== 'string') throw new TypeError(`publication ${key} must be a str`);
  return value;
}

/** `remote.split()[0] if remote else None`. */
export function remoteHeadOf(lsRemote: string): string | null {
  const text = lsRemote.trim();
  return text === '' ? null : (text.split(/\s+/)[0] ?? null);
}

/**
 * Recover one journaled publication. Returns after `finalize`, after a
 * `stale` mark on `record`, or throws the `ValueError` Python raises (a
 * refusal is retryable by a later tick, nothing was pushed).
 */
export async function recoverPublication(
  effects: PublicationRecoveryEffects,
  item: Rec,
  record: Rec,
  publication: Rec,
): Promise<void> {
  const head = sha(publication, 'head');
  const branch = sha(publication, 'branch');
  const remoteHead = remoteHeadOf(await effects.lsRemoteHeads(branch));
  const openPr = truthy(field(publication, 'open_pr'));
  if (!Object.hasOwn(item, 'pr') && openPr) throw new PyError('KeyError', "'pr'");
  if (openPr) {
    const info = await effects.prInfo(item.pr);
    if (info.state !== 'OPEN' || info.headRefName !== branch) {
      Object.assign(record, { state: 'stale', error: STALE_NOT_PUBLISHABLE });
      return;
    }
    const prHead = String(info.headRefOid);
    if (prHead === head || (await effects.isAncestor(head, prHead))) {
      await effects.finalize();
      return;
    }
    if (prHead !== sha(publication, 'target')) {
      Object.assign(record, { state: 'stale', error: STALE_HEAD_MOVED });
      return;
    }
    // The earlier ls-remote read says the prepared head is published but the
    // open PR, read later, is still at the journaled target: the branch was
    // reset (or the PR view lags our own push) in between. Finalizing would
    // record commits as published that are not on the branch; refuse so a
    // later tick re-reads both.
    if (remoteHead === head) throw new PyError('ValueError', REFUSE_STALE_REMOTE_READ);
  } else {
    const prs = await effects.listBranchPrs(branch);
    if (prs.length > 0) {
      if (prs.length !== 1 || prs[0]!.headRefOid !== head)
        throw new PyError('ValueError', REFUSE_PR_IDENTITY);
      await effects.finalize();
      return;
    }
    if (remoteHead !== null && remoteHead !== head)
      throw new PyError('ValueError', REFUSE_BRANCH_DIFFERS);
  }
  if (remoteHead !== head) {
    // Open PR: lease on the journaled target (just verified equal to the PR
    // head; the ls-remote read may already be stale after a maintainer reset).
    // Branch only: lease on the verified tip, '' when the branch is absent.
    const expected = openPr ? sha(publication, 'target') : (remoteHead ?? '');
    if (expected !== '' && !(await effects.isAncestor(expected, head)))
      throw new PyError('ValueError', REFUSE_NOT_FAST_FORWARD);
    await effects.push(branch, expected, head);
  }
  await effects.finalize();
}
