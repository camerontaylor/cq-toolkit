/**
 * `repair_tick.publish` (repair_tick.py:665-753): the initial publication of
 * verified repairs, journal absent. Inactive: nothing imports this outside
 * tests.
 *
 * Every read and effect is injected. This module has no Git, forge, disk or
 * clock access. The cherry-pick replay is modelled as the sequence of Git
 * facts Python reads (`CHERRY_PICK_HEAD`, the conflicted and staged name
 * lists), so the stale-versus-retry decision is pinned without a repository;
 * binding those effects to real `git` in the publish worktree, `verify`,
 * `hack_detector`, `secret_scan`, `make_worktree` and the journal and queue
 * writes is the remaining runtime work, see `docs/crq/tick-slot-missing-effects.md`.
 *
 * The order is the contract (pinned by `test/queue-runner/publicationPublish.test.ts`):
 *
 * 1. `record.jobs[0]`'s journal is read first; a present journal is
 *    `recoverPublication` (no worktree, no replay) and nothing else.
 * 2. Before any worktree: the PR is read for an open-PR run, a closed or
 *    merged PR marks the record `stale`, and so does a target that does not
 *    descend from `record.base`.
 * 3. A conflicting or empty cherry-pick marks `stale`; any other failure
 *    propagates so a later tick retries. Each replayed repair is verified
 *    over its own claimed range, then the final range is hack-scanned and
 *    secret-scanned, both before anything is journaled.
 * 4. An open-PR publication re-reads the PR and refuses if it moved. A branch
 *    publication names its branch from the *item* (#2288): a backfill item
 *    keeps the counted `crq/fix-backfill-` prefix whatever its run id.
 * 5. The prepared head is pinned by `refs/crq/publication/<run>`, then the
 *    journal, then `record.publication` and the queue are saved, all before
 *    any remote mutation. The fast-forward refusal follows the journal, so a
 *    refused publication is recovered (and refused again) by the next tick.
 * 6. The push is leased on the checked remote head (the PR target, `''` for a
 *    new branch) and followed by `finalize`. The worktree is always removed.
 */
import { BACKFILL_BRANCH, BACKFILL_ITEM } from './fixPrBacklog.js';
import { excText, isPyError, PyError } from './pyErrors.js';
import {
  recoverPublication,
  type PublicationRecoveryEffects,
  type RecoveryPrInfo,
} from './publicationRecovery.js';
import { truthy } from './repairBackfill.js';

type Rec = Record<string, unknown>;

/** The `crq/fix-` prefix of an ordinary (non-backfill) fix branch. */
export const FIX_BRANCH_PREFIX = 'crq/fix-';

export const STALE_PR_CLOSED = 'PR closed or merged before repair publication';
export const STALE_NOT_FAST_FORWARD = 'head moved non-fast-forward; await new pin review';
export const STALE_DOES_NOT_APPLY = 'repair does not apply to current target: ';
export const REFUSE_SECRET_SCAN = 'publication secret scan failed';
export const REFUSE_PR_MOVED = 'PR moved during publication; retry on fresh head';
export const REFUSE_NOT_FAST_FORWARD = 'publication would not fast-forward the checked remote head';

/** A publish worktree: `c.make_worktree(name, sha)`. */
export interface PublishWorktree {
  readonly path: string;
  readonly branch: string;
}

export interface PublicationPublishEffects extends Omit<PublicationRecoveryEffects, 'finalize'> {
  /** `c.iso()`. */
  iso(): string;
  /** `json.loads(journal.read_text())` of `state/repair/<job>/publication.json`; `null` when absent. */
  readJournal(jobId: unknown): Promise<Rec | null>;
  /** `c.git('rev-parse', DEFAULT_REF)`. */
  revParseDefaultRef(): Promise<string>;
  /** `c.make_worktree('publish-' + run, target)`. */
  makeWorktree(name: string, sha: string): Promise<PublishWorktree>;
  /** `c.remove_worktree(wt, branch)`; runs on every exit after `makeWorktree`. */
  removeWorktree(worktree: PublishWorktree): Promise<void>;
  /** `wt_git(wt, 'rev-parse', 'HEAD')`. */
  revParseHead(worktree: PublishWorktree): Promise<string>;
  /** `wt_git(wt, 'cherry-pick', sha)`; a Git failure is `PyError('RuntimeError')`. */
  cherryPick(worktree: PublishWorktree, sha: string): Promise<void>;
  /** `wt_git(wt, 'rev-parse', '--verify', 'CHERRY_PICK_HEAD')`; absent is `PyError('RuntimeError')`. */
  verifyCherryPickHead(worktree: PublishWorktree): Promise<void>;
  /** `wt_git(wt, 'diff', '--name-only', '--diff-filter=U')`, stripped. */
  conflictedFiles(worktree: PublishWorktree): Promise<string>;
  /** `wt_git(wt, 'diff', '--cached', '--name-only')`, stripped. */
  stagedFiles(worktree: PublishWorktree): Promise<string>;
  /** `wt_git(wt, 'rev-list', '--reverse', before + '..HEAD').splitlines()`. */
  revListSince(worktree: PublishWorktree, before: string): Promise<readonly string[]>;
  /** `verify(wt, before, claims, job)`; a rejected range is `PyError('ValueError')`. */
  verify(
    worktree: PublishWorktree,
    before: string,
    claims: readonly string[],
    job: unknown,
  ): Promise<void>;
  /** `wt_git(wt, 'diff', target + '..HEAD')`, stripped. */
  diffSince(worktree: PublishWorktree, target: string): Promise<string>;
  /** `(STATE/repair/<job>/publication.patch).write_text(text)`. */
  writePatch(jobId: unknown, text: string): Promise<void>;
  /**
   * `hack_detector(cq_bin, diff, wt)`; any `ValueError` (a rejection or an
   * unavailable detector) is rewrapped as `publication <message>`.
   */
  hackDetector(worktree: PublishWorktree, diff: string): Promise<void>;
  /** `c.secret_scan(target, head, <job>/publication-secret-scan.json)[0]`. */
  secretScan(jobId: unknown, target: string, head: string): Promise<boolean>;
  /** `c.git('update-ref', 'refs/crq/publication/' + run, head)`. */
  updateRef(ref: string, sha: string): Promise<void>;
  /** `atomic(STATE/repair/<job>/publication.json, publication)`; must snapshot the value. */
  writeJournal(jobId: unknown, publication: Rec): Promise<void>;
  /** `c.save_queue(q)`. */
  saveQueue(q: Rec): Promise<void>;
  /** `finalize_publication(c, q, item, run, record, publication)`. */
  finalize(publication: Rec): Promise<void>;
}

/** `d[key]`: a missing key is a `KeyError`. */
function req(o: Rec, key: string): unknown {
  if (!Object.hasOwn(o, key)) throw new PyError('KeyError', `'${key}'`);
  return o[key];
}

function list(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${what} must be a list`);
  return value;
}

function sha(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new TypeError(`${what} must be a str`);
  return value;
}

/** `str(exc)[:200]`, sliced by code point as Python does. */
function clip200(text: string): string {
  const points = Array.from(text);
  return points.length <= 200 ? text : points.slice(0, 200).join('');
}

/**
 * `publish`. `fixed` is the run's FIXED verdicts. Returns after `finalize`,
 * after a `stale` mark on `record`, or throws what Python raises; the caller
 * turns a throw into `publish_failed`.
 */
export async function publishRepair(
  effects: PublicationPublishEffects,
  q: Rec,
  item: Rec,
  run: string,
  record: Rec,
  fixed: readonly Rec[],
): Promise<void> {
  const jobs = list(req(record, 'jobs'), 'jobs');
  if (jobs.length === 0) throw new PyError('IndexError', 'list index out of range');
  const jobId = jobs[0];
  const journal = await effects.readJournal(jobId);
  if (journal !== null) {
    await recoverPublication(
      {
        ...bound(effects),
        finalize: () => effects.finalize(journal),
      },
      item,
      record,
      journal,
    );
    return;
  }
  // Python flattens the claimed commits up front (a missing key fails here,
  // before any read); the list itself is unused, each repair is replayed below.
  for (const v of fixed) list(req(v, 'commits'), 'commits');
  const openPr = truthy(req(record, 'open_pr'));
  let info: RecoveryPrInfo | null = null;
  if (openPr) info = await effects.prInfo(req(item, 'pr'));
  if (info !== null && info.state !== 'OPEN') {
    Object.assign(record, { state: 'stale', error: STALE_PR_CLOSED });
    return;
  }
  const target =
    info !== null ? sha(info.headRefOid, 'PR headRefOid') : await effects.revParseDefaultRef();
  if (info !== null && !(await effects.isAncestor(sha(req(record, 'base'), 'base'), target))) {
    Object.assign(record, { state: 'stale', error: STALE_NOT_FAST_FORWARD });
    return;
  }
  const wt = await effects.makeWorktree(`publish-${run}`, target);
  try {
    const translated: string[] = [];
    for (const v of fixed) {
      const before = await effects.revParseHead(wt);
      try {
        for (const commit of list(req(v, 'commits'), 'commits'))
          await effects.cherryPick(wt, sha(commit, 'commit'));
      } catch (exc) {
        // Only a recorded cherry-pick with conflicts or an empty index proves
        // a deterministic replay failure. Spawn, timeout, hook and other git
        // failures must remain retryable.
        if (!isPyError(exc, 'RuntimeError')) throw exc;
        try {
          await effects.verifyCherryPickHead(wt);
        } catch (absent) {
          if (isPyError(absent, 'RuntimeError')) throw exc;
          throw absent;
        }
        const conflicts = await effects.conflictedFiles(wt);
        const staged = await effects.stagedFiles(wt);
        if (conflicts !== '' || staged === '') {
          Object.assign(record, {
            state: 'stale',
            error: STALE_DOES_NOT_APPLY + clip200(excText(exc)),
          });
          return;
        }
        throw exc;
      }
      const claims = await effects.revListSince(wt, before);
      await effects.verify(wt, before, claims, req(v, 'job'));
      translated.push(...claims);
    }
    // Re-run content scan and secret scan over the final rebased publication.
    const diff = await effects.diffSince(wt, target);
    await effects.writePatch(jobId, `${diff}\n`);
    try {
      await effects.hackDetector(wt, diff);
    } catch (exc) {
      // `raise ValueError(...) from None`: a DetectorUnavailable too is
      // rewrapped as a plain ValueError.
      if (isPyError(exc, 'ValueError'))
        throw new PyError('ValueError', `publication ${exc.message}`);
      throw exc;
    }
    const head = await effects.revParseHead(wt);
    if (!(await effects.secretScan(jobId, target, head)))
      throw new PyError('ValueError', REFUSE_SECRET_SCAN);
    let remoteBranch: string;
    if (info !== null) {
      // A concurrent restack must not slip past the ancestry check.
      const latest = await effects.prInfo(req(item, 'pr'));
      if (
        latest.state !== 'OPEN' ||
        latest.headRefOid !== target ||
        latest.headRefName !== req(record, 'branch')
      )
        throw new PyError('ValueError', REFUSE_PR_MOVED);
      remoteBranch = sha(req(record, 'branch'), 'branch');
    } else {
      // The item's backfill status, not the run id, picks the prefix (#2288):
      // a prepared retry (`revalidated-` run) on a backfill item keeps the
      // counted backfill prefix or its PR escapes the cap on later ticks,
      // while ordinary fix PRs stay outside it.
      const backfill = typeof item.id === 'string' && item.id.startsWith(BACKFILL_ITEM);
      remoteBranch = (backfill ? BACKFILL_BRANCH : FIX_BRANCH_PREFIX) + run;
    }
    const publication: Rec = {
      head,
      target,
      branch: remoteBranch,
      commits: translated,
      open_pr: info !== null,
      at: effects.iso(),
    };
    await effects.updateRef(`refs/crq/publication/${run}`, head);
    await effects.writeJournal(jobId, publication);
    record.publication = publication;
    await effects.saveQueue(q); // durable identity before any remote mutation
    // The update must land on the exact remote tip checked above: a
    // maintainer reset to an ancestor would otherwise still fast-forward and
    // resurrect the commits they removed.
    const expected = info !== null ? target : '';
    if (expected !== '' && !(await effects.isAncestor(expected, head)))
      throw new PyError('ValueError', REFUSE_NOT_FAST_FORWARD);
    await effects.push(remoteBranch, expected, head);
    await effects.finalize(publication);
  } finally {
    await effects.removeWorktree(wt);
  }
}

/** The recovery subset of the publish effects, as explicit delegates (a class instance would lose its methods under spread). */
function bound(effects: PublicationPublishEffects): Omit<PublicationRecoveryEffects, 'finalize'> {
  return {
    lsRemoteHeads: (branch) => effects.lsRemoteHeads(branch),
    prInfo: (pr) => effects.prInfo(pr),
    listBranchPrs: (branch) => effects.listBranchPrs(branch),
    isAncestor: (older, newer) => effects.isAncestor(older, newer),
    push: (branch, expected, to) => effects.push(branch, expected, to),
  };
}
