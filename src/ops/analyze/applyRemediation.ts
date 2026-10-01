// Analyze lane G2 — apply ONE cluster's remediation through the codemod
// path, under the SIDECAR CONTRACT: the sidecar that
// `analyze.renderAnalysisReport` published is the machine source of truth,
// and this op is its only sanctioned consumer for writes.
//
// THE HARD RULE (UC §1 row 9): remediation is NEVER auto-applied. An
// explicit cluster id AND an explicit approval flag are both required, and
// the plan runner's autonomous path (G3) never invokes this op. The order
// of operations below is fail-closed at EVERY step, in this pinned order:
//   1. Sidecar validity — missing, unreadable, or non-conforming (wrong
//      schemaVersion, drifted fingerprint, corrupt shape via the strict
//      parse) is `failed` with a clear error. Nothing is scanned, nothing
//      is written.
//   2. Staleness — the sidecar carries a coarse 32-bit content digest per
//      target file, captured at ANALYSIS time (the render op digests every
//      cluster member's file; see renderAnalysisReport.ts). Apply re-digests
//      the CURRENT bytes and ANY mismatch marks the whole sidecar stale:
//      `failed`, naming the file and both digests, with the re-render
//      remedy. Strict-on-any is deliberate: the analysis is a snapshot, and
//      trusting the un-drifted parts of a drifted snapshot is exactly how
//      wrong edits slip past. The loop's COMPLETENESS rides the parse-time
//      coverage contract (every report cluster's evidence must equal its
//      derived member-file set — a missing entry is a parse fault, so the
//      staleness loop cannot be silently skipped by a partial sidecar). The
//      digest is a STALENESS CHECK, not an identity proof (32-bit fnv
//      coarseness) — residual collision risk is bounded by the codemod
//      path's shape-match: an edit only lands where the consumer's ast-grep
//      rule still matches the CURRENT bytes.
//   3. Approval — `approved !== true` OR a missing clusterId REFUSES the op
//      as `needs-human`: a human decision is precisely the missing input,
//      and the reason names the required shape { clusterId, approved: true }
//      so the refusal is actionable. A well-formed approval with an UNKNOWN
//      cluster id is a different fault — `failed`, listing the ids the
//      sidecar actually carries. The flag is NECESSARY BUT NOT SUFFICIENT
//      since W4.3: it is a declared intent any plan author can write, so
//      the write phase below additionally requires an APPROVAL GRANT that
//      `approval.exercise` checks and consumes atomically at the mutation,
//      under the workspace mutation lock (ADR-0003 §4c; approval.ts). With
//      no authority bound — the shipped default, and the state the shared
//      registry adapter is in until the kernel's verified-approval wiring
//      lands — the write is refused `needs-human` with nothing written
//      (A16: a forged `approved: true` never reaches a byte on disk).
//      A DRY RUN writes nothing, so it needs no grant: it is the preview
//      the human uses BEFORE approving anything.
//   4. Remediation — scan the cluster's target files (planned edits) →
//      collision check (any overlap blocks the WHOLE apply) → dryRun ?
//      { diffs, planned edit count, no writes } : exercise the approval and
//      apply under the mutation lock, reporting the per-file results with
//      their after-digests. Splices are PREFLIGHTED (pure byte computations
//      before the write phase), so splice failures strand nothing; only
//      store write faults can strand, and the write phase rolls those back.
//      An EMPTY planned-edit set is an honest `ok` with `plannedEdits: 0`
//      and a `note` saying nothing matched — an empty plan is a real
//      outcome, never a silent success story (the fields that are zero are
//      right there in the result), and it never consumes an approval: there
//      is no write to approve.
//
// The cluster's targets are its member failures' file paths (nulls
// contribute no target), deduplicated and sorted; the evidence digests were
// captured per file, so a cluster with many members in one file is one
// target. Noise members are never targets (they are not in any cluster).
//
// I/O discipline: everything crosses the injected AnalyzeFileStore (the
// ledger lane's registry-bound store seam) and the gates' RunCheck runner;
// this module itself never imports node:fs. The store's containment keeps
// every read and write inside `dir` (default: the sidecar's directory —
// where the render op wrote it).
import { dirname, isAbsolute, relative } from 'node:path';
import type { Op } from '../../kernel/types.js';
import type { RunCheck } from '../gates/checkRunner.js';
import type { ApprovalAuthority, ApprovalSubject } from './approval.js';
import type { ApprovedMutation } from './approval.js';
import { approvalInputDigest, DENY_ALL_APPROVALS, withApprovedMutation } from './approval.js';
import type { AnalyzeFileStore } from './analysisStore.js';
import type { CodemodFileApplied, CodemodFileDiff } from './codemod/astGrep.js';
import {
  applyEditsToBytes,
  findCollision,
  makeAstGrepScan,
  renderUnifiedDiff,
} from './codemod/astGrep.js';
import { contentDigest, parseAnalysisSidecar } from './renderAnalysisReport.js';
import type { AnalysisSidecar } from './renderAnalysisReport.js';

/** JSON-serializable input of the `analyze.applyRemediation` op. */
export interface ApplyRemediationInput {
  /** The sidecar published by `analyze.renderAnalysisReport` (an op OUTPUT — never a convention path). */
  sidecarPath: string;
  /**
   * The containment root the target files resolve inside; defaults to the
   * sidecar's directory. The store refuses any read or write that resolves
   * outside it.
   */
  dir?: string;
  /**
   * The cluster to remediate. MISSING is a refusal (`needs-human`) — an
   * unspecified cluster is an unspecified human decision, not a whole-report
   * mandate.
   */
  clusterId?: string;
  /**
   * Disambiguator for the astronomically rare FNV-1a id collision (two
   * distinct signatures hashing to one 32-bit id — G1 pins a concrete
   * pair): REQUIRED by the op when the sidecar carries more than one
   * cluster with the requested id, and faulted when it does not match the
   * selected cluster.
   */
  signature?: string;
  /**
   * The DECLARED approval flag; anything but `true` refuses the op
   * (`needs-human`). NECESSARY BUT NOT SUFFICIENT: it is a field any plan
   * author writes, so on its own it authorizes nothing. The apply's write
   * phase additionally requires an approval GRANT exercised and consumed at
   * the mutation (ADR-0003 §4c, `approval.ts`); the dry run writes nothing
   * and needs no grant.
   */
  approved?: boolean;
  /** The consumer's ast-grep rule text (the mechanical remediation for this cluster). */
  rule: string;
  /** When true: scan, collision-check, and render diffs — write NOTHING. */
  dryRun: boolean;
  /** Wall-clock cap for the scan subprocess; the registry boundary defaults it to 600_000ms. */
  timeoutMs?: number;
}

/** Per-file report rows, mirroring the codemod op's shapes. */
export type RemediationFileDiff = CodemodFileDiff;
export type RemediationFileApplied = CodemodFileApplied;

/** The op's report — `mode` says which; `clusterId` names what was remediated. */
export type ApplyRemediationReport =
  | {
      mode: 'dry-run';
      clusterId: string;
      /** The deduplicated, sorted target files the rule scanned. */
      targets: string[];
      plannedEdits: number;
      unfixedMatches: number;
      files: RemediationFileDiff[];
      /** Present exactly when the plan is empty — the honest empty result. */
      note?: string;
    }
  | {
      mode: 'applied';
      clusterId: string;
      targets: string[];
      plannedEdits: number;
      unfixedMatches: number;
      files: RemediationFileApplied[];
      note?: string;
    };

/**
 * Build the `analyze.applyRemediation` op over an input-driven store
 * selector and the injected runner (the ledger store seam + the gates
 * runner seam). See the module header for the pinned, fail-closed order of
 * operations — every refusal above step 4 happens BEFORE any scan or write,
 * so a refused remediation has touched nothing.
 *
 * `approval` is the ADR-0003 approval seam, DEFAULTING TO THE DENY-ALL
 * authority: with nothing bound, an apply is refused `needs-human` at the
 * write and the flag alone never writes. The registry adapter that binds
 * the kernel's verified approvals is #238's file and is deliberately NOT
 * edited here; until it lands, this default is the honest fail-closed
 * state rather than a bypass.
 */
export function makeApplyRemediation(
  storeFor: (input: ApplyRemediationInput) => AnalyzeFileStore,
  run: RunCheck,
  approval: ApprovalAuthority = DENY_ALL_APPROVALS,
): Op<ApplyRemediationInput, ApplyRemediationReport> {
  return async (input) => {
    // ---- 1. Sidecar validity (fail closed before anything else moves).
    let store: AnalyzeFileStore;
    try {
      store = storeFor(input);
    } catch (err) {
      return { status: 'failed', error: `remediation failed closed — ${messageOf(err)}` };
    }
    // STORE-RELATIVE PATH DISCIPLINE: the store is rooted at the
    // sidecar's directory (or the explicit input.dir), so the sidecar must
    // be addressed RELATIVE TO THAT ROOT — the full input.sidecarPath would
    // double-root (root/root/…) for relative paths. sidecarPath is
    // expressible relative to the root whenever it lives inside it
    // (lexically, no fs needed); anything else is passed through verbatim
    // so the store's containment check faults it by its real name.
    const storeRoot = storeRootOf(input);
    const relativeSidecar = relative(storeRoot, input.sidecarPath);
    const sidecarStorePath =
      relativeSidecar === '' || relativeSidecar.startsWith('..') || isAbsolute(relativeSidecar)
        ? input.sidecarPath
        : relativeSidecar;
    let sidecar: AnalysisSidecar;
    try {
      sidecar = parseAnalysisSidecar(await store.readText(sidecarStorePath));
    } catch (err) {
      return {
        status: 'failed',
        error: `remediation failed closed: the analysis sidecar '${input.sidecarPath}' is missing, unreadable, or invalid — ${messageOf(err)}`,
      };
    }
    // ---- 2. Staleness: re-digest EVERY evidenced target; any drift (or a
    // target that has become unreadable) fails the whole sidecar as stale.
    for (const clusterEvidence of sidecar.evidence) {
      for (const target of clusterEvidence.targets) {
        let digest: string;
        try {
          digest = contentDigest(Buffer.from(await store.readBytes(target.file)).toString('utf8'));
        } catch (err) {
          return {
            status: 'failed',
            error: `stale sidecar: target '${target.file}' is no longer readable — ${messageOf(err)}; re-run analyze.renderAnalysisReport`,
          };
        }
        if (digest !== target.digest) {
          return {
            status: 'failed',
            error: `stale sidecar: '${target.file}' changed since analysis (analysis digest ${target.digest}, current ${digest}) — re-run analyze.renderAnalysisReport`,
          };
        }
      }
    }
    // ---- 3. Approval FIRST (missing decision → needs-human), then the
    // cluster id resolution (unknown id with a present decision → failed).
    // The flag is the DECLARED INTENT gate only; the grant is consumed at
    // the write (step 4), and this is why the refusal below still has to
    // happen first: an unapproved op must not even reach the authority.
    if (input.approved !== true || input.clusterId === undefined) {
      return {
        status: 'needs-human',
        reason: `remediation is never auto-applied — an explicit cluster id AND an explicit approval flag are required, for the dry-run preview as much as for the apply; pass { clusterId: "<id>", approved: true }. That flag is necessary but NOT sufficient: the apply's write also requires an approval token exercised and consumed at the mutation (ADR-0003)`,
      };
    }
    // Cluster selection, fail-closed on the FNV id collision: the id alone
    // is ambiguous when two distinct signatures share it (G1 pins a concrete
    // pair), so a multi-match REQUIRES the signature disambiguator —
    // addressing "the first" would be an accident of sort order.
    const matching = sidecar.report.clusters.filter(
      (candidate) => candidate.id === input.clusterId,
    );
    if (matching.length === 0) {
      return {
        status: 'failed',
        error: `unknown cluster id '${input.clusterId}' — the sidecar carries: ${sidecar.report.clusters.map((candidate) => candidate.id).join(', ') || '(no clusters)'}`,
      };
    }
    let cluster = matching[0] as (typeof matching)[number];
    if (input.signature !== undefined) {
      const bySignature = matching.find((candidate) => candidate.signature === input.signature);
      if (bySignature === undefined) {
        return {
          status: 'failed',
          error: `no cluster with id '${input.clusterId}' carries the given signature — the id's signature(s): ${matching.map((candidate) => candidate.signature).join(' | ')}`,
        };
      }
      cluster = bySignature;
    } else if (matching.length > 1) {
      return {
        status: 'failed',
        error: `ambiguous cluster id '${input.clusterId}' — ${matching.length} distinct clusters share this FNV-1a id; pass the cluster's signature as the disambiguator. Signature(s): ${matching.map((candidate) => candidate.signature).join(' | ')}`,
      };
    }
    // ---- 4. Scan → collision check → dry-run or apply.
    const targets = [
      ...new Set(
        cluster.failures
          .map((failure) => failure.file)
          .filter((file): file is string => file !== null),
      ),
    ].sort();
    // SHORT-CIRCUIT: a cluster whose members attributed NO file has nothing
    // to scan — return the honest empty result without invoking the runner
    // (the scan would be an unscoped or pointless subprocess).
    if (targets.length === 0) {
      return {
        status: 'ok',
        value: {
          mode: input.dryRun ? 'dry-run' : 'applied',
          clusterId: cluster.id,
          targets,
          plannedEdits: 0,
          unfixedMatches: 0,
          files: [],
          note: 'the cluster carries no target files (no member failure attributed a file) — there is nothing to remediate mechanically',
        },
      };
    }
    const current = new Map<string, Uint8Array>();
    for (const file of targets) {
      try {
        current.set(file, await store.readBytes(file));
      } catch (err) {
        return {
          status: 'failed',
          error: `remediation: could not read cluster target — ${messageOf(err)}`,
        };
      }
    }
    // OFFSET-FRESHNESS ANCHOR: the plan's byte offsets were computed against
    // THIS read, but ast-grep re-reads the files at SCAN time — drift in
    // between would splice a stale plan silently. The expected digests are
    // the SIDECAR EVIDENCE digests (the analysis-time anchor, already
    // verified pre-scan); after the scan and BEFORE anything is written,
    // each target is re-digested against them (dry-run included — a diff of
    // drifted bytes would mislead the same way). Residual, one sentence: a
    // concurrent write landing between this final freshness read and
    // store.writeBytes is still a lost update — a documented TOCTOU-class
    // residual of the same accepted window the analysis store's header
    // records for a single-consumer local tool.
    const expectedDigest = new Map(
      sidecar.evidence.flatMap((clusterEvidence) =>
        clusterEvidence.targets.map((target) => [target.file, target.digest] as const),
      ),
    );
    const scan = await makeAstGrepScan(run)({
      dir: storeRootOf(input),
      rule: input.rule,
      files: targets,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    });
    if (!scan.ok) return { status: 'failed', error: scan.fault };
    const collision = findCollision(scan.outcome.plannedEdits);
    if (collision !== null) return { status: 'failed', error: collision };
    for (const file of targets) {
      let fresh: Uint8Array;
      try {
        fresh = await store.readBytes(file);
      } catch (err) {
        return {
          status: 'failed',
          error: `remediation: file changed during remediation planning — '${file}' is no longer readable after the scan; nothing was written; re-run analyze.renderAnalysisReport (${messageOf(err)})`,
        };
      }
      const freshDigest = contentDigest(Buffer.from(fresh).toString('utf8'));
      if (freshDigest !== expectedDigest.get(file)) {
        return {
          status: 'failed',
          error: `remediation: file changed during remediation planning: '${file}' (analysis digest ${expectedDigest.get(file)}, after scan ${freshDigest}) — the scan re-reads at scan time, so the planned offsets may be stale; nothing was written; re-run analyze.renderAnalysisReport`,
        };
      }
      current.set(file, fresh);
    }
    const plannedEdits = scan.outcome.plannedEdits;
    const note =
      plannedEdits.length === 0
        ? 'nothing matched the rule (or it carries no fix) for this cluster — no remediation was applied and none was needed'
        : undefined;
    // THE EMPTY PLAN IS NOT A MUTATION: with no file to rewrite there is
    // nothing to approve, so the honest empty result is returned WITHOUT
    // touching the approval seam — consuming a human's token to rewrite
    // zero files would burn a decision for no write.
    if (pendingTargets(plannedEdits).length === 0) {
      return {
        status: 'ok',
        value: {
          mode: 'applied',
          clusterId: cluster.id,
          targets,
          plannedEdits: 0,
          unfixedMatches: scan.outcome.unfixedMatches,
          files: [],
          ...(note === undefined ? {} : { note }),
        },
      };
    }
    if (input.dryRun) {
      let files: RemediationFileDiff[];
      try {
        files = targets.map((file) => ({
          file,
          edits: plannedEdits.filter((edit) => edit.file === file).length,
          diff: renderUnifiedDiff(file, current.get(file) as Uint8Array, plannedEdits),
        }));
      } catch (err) {
        return {
          status: 'failed',
          error: `remediation: could not render the plan — ${messageOf(err)}`,
        };
      }
      return {
        status: 'ok',
        value: {
          mode: 'dry-run',
          clusterId: cluster.id,
          targets,
          plannedEdits: plannedEdits.length,
          unfixedMatches: scan.outcome.unfixedMatches,
          files,
          ...(note === undefined ? {} : { note }),
        },
      };
    }
    // SPLICING IS PREFLIGHTED: every target's remediated bytes (and diffs)
    // are computed — pure, no writes — before the write phase begins, so a
    // splice failure (stale offsets, out-of-bounds plan) happens with
    // NOTHING written and strands nothing. Only store WRITE faults can
    // strand files, and the write phase below rolls those back.
    const pending: Array<{ file: string; edits: number; after: Uint8Array; diff: string }> = [];
    for (const file of pendingTargets(plannedEdits)) {
      const edits = plannedEdits.filter((edit) => edit.file === file);
      const before = current.get(file) as Uint8Array;
      try {
        pending.push({
          file,
          edits: edits.length,
          after: applyEditsToBytes(before, edits),
          diff: renderUnifiedDiff(file, before, edits),
        });
      } catch (err) {
        return {
          status: 'failed',
          error: `remediation: could not apply the plan to '${file}' — ${messageOf(err)}`,
        };
      }
    }
    // THE MUTATION BOUNDARY (W4.3 / ADR-0003 §4c). Everything above is
    // pure or read-only; this is the first moment a byte can change, and it
    // is reached only through `withApprovedMutation`: the grant is
    // re-checked against the CURRENT workspace state and its nonce spent
    // in ONE critical section of the workspace mutation lock, which is held
    // through the whole write phase. A refusal here is `needs-human` with
    // an untouched workspace — the op never reaches the store without a
    // consumed grant, which is what makes a forged `approved: true`
    // (A16) and a commit that landed between planning and writing
    // (TOCTOU) both deny here instead of at some later, weaker check.
    const subject: ApprovalSubject = {
      op: 'analyze.applyRemediation',
      workspace: storeRootOf(input),
      targets: pending.map((item) => item.file),
      inputDigest: approvalInputDigest({
        sidecarPath: input.sidecarPath,
        dir: input.dir,
        clusterId: input.clusterId,
        signature: input.signature,
        rule: input.rule,
        dryRun: input.dryRun,
        timeoutMs: input.timeoutMs,
      }),
    };
    // Whether the approved WRITE was actually entered. The exercise happens
    // INSIDE the mutation lock, immediately before the write, so a fault
    // acquiring the lock has NOT spent the token while a fault releasing or
    // compromising it HAS. A catch clause cannot tell those apart by
    // inspection, so the phase is recorded as it happens rather than
    // guessed at in the message — claiming "spent" unconditionally would
    // assert a fact that is false for the acquire case, and "unspent" would
    // be false for the release case.
    let writeEntered = false;
    let approved: ApprovedMutation<RemediationFileApplied[]>;
    try {
      approved = await withApprovedMutation(approval, subject, async () => {
        // Entering this callback is proof the exercise granted, i.e. the
        // nonce is spent.
        writeEntered = true;
        const appliedFiles: RemediationFileApplied[] = [];
        for (const item of pending) {
          const file = item.file;
          try {
            await store.writeBytes(file, item.after);
          } catch (err) {
            // BEST-EFFORT ROLLBACK: partial multi-file apply is never stranded.
            // The faulted file itself may hold a PARTIAL write (the store's
            // writeFileSync is not atomic), and every target existed pre-apply —
            // so the faulted file AND every already-written file are restored
            // from the in-memory original bytes (`current`, verified unchanged
            // pre-scan) through the same store, newest first, before faulting.
            // When the rollback itself faults, the already-written wording
            // survives and the rollback failure is named — the caller always
            // knows the exact on-disk state. The fault is THROWN out of the
            // mutation (not returned as a value) so the approved write's
            // return type stays "the applied files or nothing", and the
            // lock is released on the way out.
            const rolledBack: string[] = [];
            const rollbackFaults: string[] = [];
            let faultedFileRestoreFailed = '';
            // The faulted file may hold a PARTIAL write — restore it best-effort
            // first; its failure is noted but strands no already-written file.
            try {
              await store.writeBytes(file, current.get(file) as Uint8Array);
            } catch (restoreErr) {
              faultedFileRestoreFailed = `; the faulted file's partial-write restore failed: ${messageOf(restoreErr)}`;
            }
            for (const applied of [...appliedFiles].reverse()) {
              try {
                await store.writeBytes(applied.file, current.get(applied.file) as Uint8Array);
                rolledBack.push(applied.file);
              } catch (rollbackErr) {
                rollbackFaults.push(`${applied.file} (${messageOf(rollbackErr)})`);
              }
            }
            if (rollbackFaults.length === 0) {
              const rolledBackNote =
                rolledBack.length === 0
                  ? 'no earlier files to roll back'
                  : `rolled back ${rolledBack.join(', ')} (original bytes restored)`;
              throw new ApplyWriteFault(
                `remediation: could not write '${file}' — ${messageOf(err)}; ${rolledBackNote}${faultedFileRestoreFailed}`,
              );
            }
            // BOTH lists, verbatim: what was restored AND what is stranded —
            // stranded means an applied file the rollback could NOT restore
            // (a restored file is listed only under restored).
            const restored = rolledBack.length === 0 ? 'none' : rolledBack.join(', ');
            const stranded = appliedFiles
              .map((applied) => applied.file)
              .filter((name) => !rolledBack.includes(name));
            throw new ApplyWriteFault(
              `remediation: could not write '${file}' — ${messageOf(err)}; rollback FAILED for ${rollbackFaults.join(', ')}; restored: ${restored}; already written (stranded): ${stranded.join(', ')}${faultedFileRestoreFailed}`,
            );
          }
          appliedFiles.push({
            file,
            edits: item.edits,
            diff: item.diff,
            digestAfter: contentDigest(Buffer.from(item.after).toString('utf8')),
          });
        }
        return appliedFiles;
      });
    } catch (err) {
      if (err instanceof ApplyWriteFault) return { status: 'failed', error: err.message };
      // A LOCK FAULT (waiter budget exhausted, release failed, artifact
      // compromised) is a RESULT, not an escape. The mutation lock is a real
      // filesystem primitive and it throws in ordinary situations; letting
      // that reject out of the op would hand the caller an exception with no
      // OpResult at all, while the applied set may be partially on disk.
      // So it becomes `failed` — the op's own machinery failing, which is
      // explicitly NOT an approval refusal and must not read as one.
      //
      // The token's fate is reported as the PHASE allows, never assumed:
      // `writeEntered` is true only once the exercise granted, so a fault
      // before the write means the nonce is still UNSPENT and re-approval
      // after a repair is possible, while a fault after it means the token
      // is spent and cannot be replayed. Either way the write set is named,
      // because a lock fault proves neither that those files were written
      // nor that they were not.
      const tokenFate = writeEntered
        ? 'the approval WAS exercised, so the token is spent (safe: a spent token cannot be replayed)'
        : 'the approval was NOT exercised (the fault hit before the write), so the token is UNSPENT and may be re-approved once the lock is healthy';
      return {
        status: 'failed',
        error: `remediation: the workspace mutation lock faulted during the approved apply — ${messageOf(err)}. ${tokenFate}, and the write set was ${pending.map((item) => `'${item.file}'`).join(', ')} — a LOCK FAULT is not a proof that any of them was written and not a proof that none was, so inspect the workspace before re-running; this is the op's machinery failing, NOT an approval refusal`,
      };
    }
    if (approved.status === 'needs-human') {
      return {
        status: 'needs-human',
        reason: `${approved.reason}; the remediation for cluster '${cluster.id}' was fully planned and NOTHING was written — re-approve against the current workspace state to apply it`,
      };
    }
    return {
      status: 'ok',
      value: {
        mode: 'applied',
        clusterId: cluster.id,
        targets,
        plannedEdits: plannedEdits.length,
        unfixedMatches: scan.outcome.unfixedMatches,
        files: approved.value,
        ...(note === undefined ? {} : { note }),
      },
    };
  };
}

/** The files a plan actually rewrites: the distinct targets carrying at least one edit. */
function pendingTargets(plannedEdits: Array<{ file: string }>): string[] {
  return [...new Set(plannedEdits.map((edit) => edit.file))].sort();
}

/** A write-phase fault (with its rollback evidence) thrown out of the approved mutation. */
class ApplyWriteFault extends Error {}

/**
 * The `dir` the scan runs in — the same resolution the registry-bound store
 * selector uses, so the subprocess cwd and the containment root agree (the
 * reported file paths are dir-relative either way).
 */
function storeRootOf(input: ApplyRemediationInput): string {
  return input.dir ?? dirname(input.sidecarPath);
}

// No default export here, deliberately: like the ledger family's make*
// ops, the registry importer COMPOSES this op from the named factory plus
// the dynamically-imported subprocess runner and path store (the gates
// runner seam + the registry-bound store seam, `dir` defaulted to the
// sidecar's directory). The plan runner's autonomous path never dispatches
// this op.

/** Error message of an unknown throwable, for `failed` results. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
