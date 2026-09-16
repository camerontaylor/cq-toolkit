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
//      sidecar actually carries.
//   4. Remediation — scan the cluster's target files (planned edits) →
//      collision check (any overlap blocks the WHOLE apply) → dryRun ?
//      { diffs, planned edit count, no writes } : apply and report the
//      per-file results with their after-digests. An EMPTY planned-edit set
//      is an honest `ok` with `plannedEdits: 0` and a `note` saying nothing
//      matched — an empty plan is a real outcome, never a silent success
//      story (the fields that are zero are right there in the result).
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
  /** The explicit approval flag; anything but `true` refuses the op (`needs-human`). */
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
 */
export function makeApplyRemediation(
  storeFor: (input: ApplyRemediationInput) => AnalyzeFileStore,
  run: RunCheck,
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
    if (input.approved !== true || input.clusterId === undefined) {
      return {
        status: 'needs-human',
        reason: `remediation is never auto-applied — an explicit cluster id AND an explicit approval flag are required, for the dry-run preview as much as for the apply; pass { clusterId: "<id>", approved: true }`,
      };
    }
    const cluster = sidecar.report.clusters.find((candidate) => candidate.id === input.clusterId);
    if (cluster === undefined) {
      return {
        status: 'failed',
        error: `unknown cluster id '${input.clusterId}' — the sidecar carries: ${sidecar.report.clusters.map((candidate) => candidate.id).join(', ') || '(no clusters)'}`,
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
    const scan = await makeAstGrepScan(run)({
      dir: storeRootOf(input),
      rule: input.rule,
      files: targets,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    });
    if (!scan.ok) return { status: 'failed', error: scan.fault };
    const collision = findCollision(scan.outcome.plannedEdits);
    if (collision !== null) return { status: 'failed', error: collision };
    const plannedEdits = scan.outcome.plannedEdits;
    const note =
      plannedEdits.length === 0
        ? 'nothing matched the rule (or it carries no fix) for this cluster — no remediation was applied and none was needed'
        : undefined;
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
    const appliedFiles: RemediationFileApplied[] = [];
    for (const file of targets) {
      const edits = plannedEdits.filter((edit) => edit.file === file);
      if (edits.length === 0) continue; // nothing to rewrite — the file is not part of the applied set
      const before = current.get(file) as Uint8Array;
      let after: Uint8Array;
      let diff: string;
      try {
        after = applyEditsToBytes(before, edits);
        diff = renderUnifiedDiff(file, before, edits);
      } catch (err) {
        return {
          status: 'failed',
          error: `remediation: could not apply the plan to '${file}' — ${messageOf(err)}`,
        };
      }
      try {
        await store.writeBytes(file, after);
      } catch (err) {
        // Partial multi-file apply is never silent: the fault names the
        // files ALREADY on disk in their remediated form, so the caller
        // knows the exact on-disk state this failure leaves behind.
        const alreadyWritten =
          appliedFiles.length === 0
            ? ''
            : `; already written: ${appliedFiles.map((applied) => applied.file).join(', ')}`;
        return {
          status: 'failed',
          error: `remediation: could not write '${file}' — ${messageOf(err)}${alreadyWritten}`,
        };
      }
      appliedFiles.push({
        file,
        edits: edits.length,
        diff,
        digestAfter: contentDigest(Buffer.from(after).toString('utf8')),
      });
    }
    return {
      status: 'ok',
      value: {
        mode: 'applied',
        clusterId: cluster.id,
        targets,
        plannedEdits: plannedEdits.length,
        unfixedMatches: scan.outcome.unfixedMatches,
        files: appliedFiles,
        ...(note === undefined ? {} : { note }),
      },
    };
  };
}

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
