/**
 * `repair_tick.publish(c, q, item, run, record, fixed)` (repair_tick.py:728), the last
 * `RepairHarvestEffects` seam, composed from the ports that already exist. Inactive:
 * nothing imports this from a runtime entry point.
 *
 * What is bound here, offline:
 * - local Git: worktree, cherry-pick, ref, verify, diff and ancestry reads
 *   (`publicationWorktrees`, `publicationGitReads`, `publicationVerify`);
 * - the content gates: `repairHackDetector.ts` and `publicationSecretScan.ts`;
 * - files: journal, patch, fix-PR body and queue (`publicationFiles.ts`), provenance;
 * - the push, new here: `git push origin --force-with-lease=refs/heads/<b>:<expected>
 *   <sha>:refs/heads/<b>` in the clone, which shares its object store with the worktree.
 *   Python runs the same argv with `HEAD` in the worktree; the sha is what `HEAD` is.
 *   A failure is `RuntimeError` with `c.git`'s text.
 *
 * What stays injected, because it is the forge and the clock: `prInfo`/`listBranchPrs`
 * (`gh pr view|list`), `createPr` (`gh pr create`) and `newItem`. The composition adds no
 * behaviour: `publishRepair` and `finalizePublication` order the effects.
 */
import { pyStrip } from '../../ops/crq/deploy/gitGuards.js';
import { PyError } from '../../queue-runner/pyErrors.js';
import type { FixPrBacklog } from '../../queue-runner/fixPrBacklog.js';
import {
  finalizePublication,
  type PublicationFinalizeEffects,
} from '../../queue-runner/publicationFinalize.js';
import {
  publishRepair,
  type PublicationPublishEffects,
} from '../../queue-runner/publicationPublish.js';
import type { RepairHarvestEffects } from '../../queue-runner/repairHarvest.js';
import { runGitIn } from './publishSource.js';
import { answered, clip, gitPublicationReads, pyStderr, pyText } from './publicationGitReads.js';
import type { RunGit } from './ledgerGit.js';
import { filePublicationEffects } from './publicationFiles.js';
import type { PublicationForgeReads } from './publicationForgeReads.js';
import { filePublicationProvenance } from './publicationProvenance.js';
import { gitPublicationRemoteReads } from './publicationRemoteReads.js';
import {
  gitPublicationSecretScan,
  type PublicationSecretScanOptions,
} from './publicationSecretScan.js';
import { gitPublicationVerify } from './publicationVerify.js';
import {
  gitPublicationWorktrees,
  type PublicationWorktreesOptions,
} from './publicationWorktrees.js';
import { inProcessDetector, runHackDetector, type DetectorRun } from './repairHackDetector.js';

type Rec = Record<string, unknown>;

export interface RepairHarvestPublishOptions extends PublicationWorktreesOptions {
  /** `c.STATE`. */
  readonly stateRoot: string;
  /** `c.REPO`, `owner/name`. */
  readonly repo: string;
  /** `c.iso()`. */
  readonly iso: () => string;
  /** The tick's backlog, shared with `refreshFixPrBacklog`. */
  readonly backlog: FixPrBacklog;
  /** `gh pr view` / `gh pr list`. */
  readonly forge: PublicationForgeReads;
  /** `gh pr create`: a non-zero exit throws `PyError('RuntimeError')`. */
  readonly createPr: PublicationFinalizeEffects['createPr'];
  /** `c.new_item(q, [], False, **fields)`. */
  readonly newItem: PublicationFinalizeEffects['newItem'];
  /** `c.CONFIG['repair'].get('fix_pr_cycles', 1)`. */
  readonly fixPrCycles?: number;
  readonly gitleaks: PublicationSecretScanOptions['gitleaks'];
  readonly match?: PublicationSecretScanOptions['match'];
  readonly detector?: DetectorRun;
}

/** `c.git('push', ...)` failure text: `' '.join(cmd[:6]) … exit N: stderr[:400]`. */
function pushFailure(args: readonly string[], code: number, stderr: string): PyError {
  return new PyError(
    'RuntimeError',
    `${['git', ...args].slice(0, 6).join(' ')} … exit ${code}: ${clip(pyStrip(stderr), 400)}`,
  );
}

export function repairHarvestPublish(
  options: RepairHarvestPublishOptions,
): Pick<RepairHarvestEffects, 'publish'> {
  const runGitFor: (repo: string) => RunGit = options.runGitFor ?? runGitIn;
  const git = { ...options, runGitFor };
  const reads = gitPublicationReads(git);
  const worktrees = gitPublicationWorktrees(git);
  const verifier = gitPublicationVerify(git);
  const remote = gitPublicationRemoteReads({ clone: options.clone, runGitFor });
  const scan = gitPublicationSecretScan({
    stateRoot: options.stateRoot,
    clone: options.clone,
    runGitFor,
    gitleaks: options.gitleaks,
    ...(options.match === undefined ? {} : { match: options.match }),
  });
  const files = filePublicationEffects({ stateRoot: options.stateRoot });
  const provenance = filePublicationProvenance({
    stateRoot: options.stateRoot,
    repo: options.repo,
  });
  const detector = options.detector ?? inProcessDetector;

  const publishing: PublicationPublishEffects = {
    iso: options.iso,
    readJournal: (jobId) => files.readJournal(jobId),
    revParseDefaultRef: () => reads.revParseDefaultRef(),
    makeWorktree: (name, sha) => worktrees.makeWorktree(name, sha),
    removeWorktree: (worktree) => worktrees.removeWorktree(worktree),
    revParseHead: (worktree) => reads.revParseHead(worktree),
    cherryPick: (worktree, sha) => worktrees.cherryPick(worktree, sha),
    verifyCherryPickHead: (worktree) => reads.verifyCherryPickHead(worktree),
    conflictedFiles: (worktree) => reads.conflictedFiles(worktree),
    stagedFiles: (worktree) => reads.stagedFiles(worktree),
    revListSince: (worktree, before) => reads.revListSince(worktree, before),
    verify: (worktree, before, claims, job) => verifier.verify(worktree, before, claims, job),
    diffSince: (worktree, target) => reads.diffSince(worktree, target),
    writePatch: (jobId, text) => files.writePatch(jobId, text),
    async hackDetector(_worktree, diff) {
      await runHackDetector(diff, detector);
    },
    secretScan: (jobId, target, head) => scan.secretScan(jobId, target, head),
    updateRef: (ref, sha) => worktrees.updateRef(ref, sha),
    writeJournal: (jobId, publication) => files.writeJournal(jobId, publication),
    saveQueue: (q) => files.saveQueue(q),
    lsRemoteHeads: (branch) => remote.lsRemoteHeads(branch),
    prInfo: (pr) => options.forge.prInfo(pr),
    listBranchPrs: (branch) => options.forge.listBranchPrs(branch),
    isAncestor: (older, newer) => reads.isAncestor(older, newer),
    async push(branch, expected, sha) {
      const args = [
        'push',
        'origin',
        `--force-with-lease=refs/heads/${branch}:${expected}`,
        `${sha}:refs/heads/${branch}`,
      ];
      const call = await runGitFor(options.clone)(args);
      const code = answered(call);
      pyText(call);
      if (code !== 0) throw pushFailure(args, code, pyStderr(call));
    },
    finalize: () => {
      throw new Error('finalize is bound per publish call');
    },
  };

  return {
    publish(q, item, run, record, fixed) {
      const finalizing: PublicationFinalizeEffects = {
        repo: options.repo,
        ...(options.fixPrCycles === undefined ? {} : { fixPrCycles: options.fixPrCycles }),
        iso: options.iso,
        listBranchPrs: (branch) => options.forge.listBranchPrs(branch),
        repairProvenance: (record, runId) => provenance.repairProvenance(record, runId),
        writeFixPrBody: (jobId, text) => files.writeFixPrBody(jobId, text),
        writeJournal: (jobId, publication) => files.writeJournal(jobId, publication),
        saveQueue: (queue) => files.saveQueue(queue),
        createPr: (request) => options.createPr(request),
        newItem: (queue, fields) => options.newItem(queue, fields),
      };
      return publishRepair(
        {
          ...publishing,
          finalize: (publication: Rec) =>
            finalizePublication(finalizing, options.backlog, q, item, run, record, publication),
        },
        q,
        item,
        run,
        record,
        fixed,
      );
    },
  };
}
