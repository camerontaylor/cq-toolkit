/**
 * Offline C1 repair dispatch bridge.
 *
 * Lifecycle position: after `executeRepairPreparation` has persisted the
 * prepared job and queue record; before Python state publication, canonical
 * cutover or any real issuer pointer. This module consumes an EXPLICIT caller
 * selection and fresh in-memory scan evidence, rebuilds the pinned snapshot
 * from the source at THIS invocation, plans one `review.fixFinding` job on
 * the existing kernel `Plan`/`runPlan`, reads the retained
 * `job-finished.result` from the kernel journal, and returns a read-only typed
 * harvest.
 *
 * Artifact authority is the journal's `job-finished.result` read directly,
 * plus the actual `runPlan` `RunReport`; the bridge never infers artifact
 * authority or run absence from `observation.kernelRuns` or run descriptors.
 *
 * It adds no durable queue, no attestation store, no status/failure class, no
 * CLI/registry/op-contract change and no provider. The one job is the one
 * prepared F1 job; the existing same-plan lock serializes the same plan id
 * only and is never claimed as a global one-issuer mechanism.
 *
 * Failure honesty:
 * - A durable prepared job is NOT scan attestation. A fresh attempt requires
 *   clean source+guidance scan evidence bound to the exact content read now.
 * - `resume: true` alone never makes a moved tip fresh-dispatchable. The
 *   attempt class comes from the kernel's own journal fold: only a matching
 *   retained terminal artifact permits a resumed/retained attempt.
 * - A resumed (non-ok) attempt may run at the pinned source after the tip
 *   moves; a fresh attempt may not.
 * - The dispatch payload (prepared job, normalized finding path, source text,
 *   caller guidance and request context) is rebuilt to one manifest
 *   `inputsHash` at planning, again before the run, and once more inside the
 *   kernel's plan lease by the registry op wrapper. Any dispatch-relevant
 *   change is refused; the attempt class is re-folded under that same lease.
 * - The 32768 serialized invocation bound stays with `review.fixFinding`.
 *   This module never measures, precomputes or fakes it.
 * - Harvest is scoped to the exact `RunReport.runId` (not the latest run for
 *   the same input), parses the actual artifact through the canonical kernel
 *   schema and the op's typed report guard, re-reads the durable prepared job
 *   and re-observes the current tip/blob. It returns typed fields; it never
 *   infers a status from prose and never mutates the journal or state.
 */
import {
  assertNoSeqGap,
  candidateRunsForPlan,
  foldOrderRuns,
  openRunLog,
  type FoldRun,
} from '../../../kernel/journal.js';
import { makeManifest } from '../../../kernel/manifest.js';
import { runPlan, type OpRegistryView } from '../../../kernel/runner.js';
import type { JournalEvent, OpResultArtifact, Plan, RunReport } from '../../../kernel/types.js';
import { JsonObject, parseJsonValue, type JsonValue } from '../../../policy/crq/jsonValue.js';
import { receiptJsonDigest, sha256Hex } from '../../../policy/crq/pythonJson.js';
import {
  checkSha,
  findingDigest,
  pythonTruthy,
  sourcePath,
  type RepairRefusal,
} from '../../../policy/crq/repairBinding.js';
import {
  buildRepairRequest,
  type RepairRequestContext,
} from '../../../policy/crq/repairRequest.js';
import {
  buildRepairSnapshot,
  type RepairSnapshotRefusal,
} from '../../../policy/crq/repairSnapshot.js';
import type { RepairRequestRefusal } from '../../../policy/crq/repairRequest.js';
import type {
  FixFindingBinding,
  FixFindingFailureClass,
  FixFindingInput,
  FixFindingReport,
} from '../../review/fixFinding.js';
import {
  parseFixFindingArtifactText,
  reobservePreparedSource,
  verifyPreparedHarvest,
  type RepairSourceReobservation,
} from './repairPrepare.js';
import type { ValidatedFixFindingArtifact } from '../../../policy/crq/repairBinding.js';

/** The two immutable git reads plus the pinned-text read. All injected. */
export interface RepairDispatchGit {
  /** `git rev-parse origin/main`, lowercase 40-hex. */
  currentTip(): Promise<string>;
  /** `git rev-parse <sourceSha>:<path>`, lowercase 40-hex. */
  blobOid(sourceSha: string, path: string): Promise<string>;
  /** `git show <sourceSha>:<path>` decoded text at this attempt. */
  showFile(ref: string): Promise<string>;
}

export interface RepairDispatchEffects {
  readonly git: RepairDispatchGit;
  /** Exact text of `state/repair/inbox/<jobId>.json`; read-only. */
  readonly readPreparedJob: (jobId: string) => Promise<string>;
}

export interface RepairHarvestEffects {
  readonly git: RepairDispatchGit;
  readonly readPreparedJob: (jobId: string) => Promise<string>;
}

/**
 * Selection facts the bridge cannot observe. They are the caller's explicit
 * preconditions, not a persisted attestation. The bridge checks the enum
 * values and every fact it can recompute from the prepared job, then records
 * `selection: 'caller-asserted'` and keeps the caller-owned gates.
 */
export interface RepairSelectionContext {
  readonly state: 'queued' | 'not-queued' | 'unknown';
  readonly canonicalDelivery: 'verified' | 'unverified' | 'failed';
  readonly severity: 'repairable' | 'not-repairable' | 'unknown';
  /** Checked against the prepared job when present. */
  readonly base?: string;
  readonly jobs?: readonly string[];
  readonly originJob?: string;
  readonly revalidationSha256?: string;
}

/**
 * Fresh in-memory scan evidence from the same caller flow. A clean verdict is
 * bound to the exact content the bridge reads now; `unverified`/`failed`
 * stay explicit and are never inferred from a durable job's presence.
 */
export type RepairSourceScanEvidence =
  | {
      readonly verdict: 'clean';
      readonly sourceSha: string;
      readonly sourceBlobSha: string;
      /** SHA-256 of the full UTF-8 source text read at this attempt. */
      readonly sourceSha256: string;
    }
  | { readonly verdict: 'unverified' | 'failed'; readonly reason: string };

export type RepairGuidanceScanEvidence =
  | {
      readonly verdict: 'clean';
      /** SHA-256 of the exact guidance string, UTF-8. */
      readonly instructionsSha256: string;
    }
  | { readonly verdict: 'absent' }
  | { readonly verdict: 'unverified' | 'failed'; readonly reason: string };

export interface RepairDispatchCallerContext {
  readonly selectedJobId: string;
  readonly selection: RepairSelectionContext;
  readonly scans: {
    readonly source: RepairSourceScanEvidence;
    readonly guidance: RepairGuidanceScanEvidence;
  };
  /** Existing caller-owned config/workspace/model/budget for the op input. */
  readonly requestContext: RepairRequestContext;
}

export interface RepairAttemptContext {
  /** Existing kernel journal directory. Read-only while planning. */
  readonly journalDir: string;
  /** The caller's explicit request to consider a retained terminal. */
  readonly resume: boolean;
}

export type RepairAttempt = 'fresh' | 'resumed' | 'retained-ok';

export type RepairDispatchGate =
  | 'queue-selection'
  | 'canonical-delivery'
  | 'severity-selection'
  | 'scan-confirmation'
  | 'invocation-size-bound'
  | 'dispatch-execution'
  | 'harvest-disposition';

/**
 * Bridge-local precondition names. They are not kernel statuses and are not
 * persisted as worker failure classes. `RepairRefusal`, `RepairRequestRefusal`
 * and `RepairSnapshotRefusal` are reused verbatim where they already name the
 * condition.
 */
export type RepairDispatchRefusal =
  | RepairRefusal
  | RepairRequestRefusal
  | RepairSnapshotRefusal
  | 'selection-not-queued'
  | 'canonical-delivery-unverified'
  | 'selection-mismatch'
  | 'scan-unverified'
  | 'scan-source-sha-mismatch'
  | 'scan-source-blob-mismatch'
  | 'scan-source-hash-mismatch'
  | 'scan-guidance-mismatch'
  | 'scan-failed'
  | 'source-content-unreadable'
  | 'journal-unreadable'
  | 'retained-artifact-missing'
  | 'prepared-job-changed'
  | 'attempt-inconsistent'
  | 'run-failed';

export interface RepairDispatchPlan {
  readonly status: 'dispatch-planned';
  readonly selectedJobId: string;
  readonly attempt: RepairAttempt;
  readonly resume: boolean;
  /** The caller's journal dir; used by run and harvest without re-passing it. */
  readonly journalDir: string;
  /** The existing kernel plan: exactly one `review.fixFinding` job. */
  readonly plan: Plan;
  /**
   * The caller-owned request context the plan was built from. The invocation
   * wrapper rebuilds the request from current durable state and requires the
   * rebuilt input hash to equal `inputHash`, so any dispatch-relevant payload
   * change (including mechanical evidence and retry instructions) is refused.
   */
  readonly requestContext: RepairRequestContext;
  /** The manifest `inputsHash` of the planned job, byte-for-byte. */
  readonly inputHash: string;
  readonly binding: FixFindingBinding;
  readonly path: string;
  readonly source: {
    readonly sourceSha: string;
    readonly sourceBlobSha: string;
    readonly sourceSha256: string;
    readonly atTip: boolean;
    readonly blobMatches: boolean;
  };
  readonly preconditions: {
    readonly selection: 'caller-asserted';
    readonly scans: 'clean' | 'unverified';
    readonly binding: 'verified';
    readonly sourceBlob: 'verified';
  };
  /** Never empty; caller-owned work and the op's bound stay named. */
  readonly remainingGates: readonly RepairDispatchGate[];
}

export type PlanRepairDispatchResult =
  | { readonly ok: true; readonly value: RepairDispatchPlan }
  | { readonly ok: false; readonly refusal: RepairDispatchRefusal };

export type RepairArtifactHarvest =
  | { readonly status: 'ok'; readonly value: JsonValue }
  | {
      readonly status: 'failed';
      readonly failureClass: FixFindingFailureClass;
      readonly error: string;
      readonly report: FixFindingReport;
    }
  | {
      readonly status: 'needs-human';
      readonly failureClass: FixFindingFailureClass;
      readonly reason: string;
      readonly report: FixFindingReport;
    }
  | {
      readonly status: 'budget-exhausted';
      readonly failureClass: FixFindingFailureClass;
      readonly report: FixFindingReport;
    }
  | {
      readonly status: 'indeterminate';
      readonly failureClass: FixFindingFailureClass;
      readonly detail: string;
      readonly report: FixFindingReport;
    }
  | {
      /**
       * The bridge's own invocation guard refused before the repair op ran.
       * This is not a worker verdict and carries no fabricated report.
       */
      readonly status: 'guard-refused';
      readonly refusal: RepairDispatchRefusal;
    };

export interface RepairArtifactRead {
  readonly selectedJobId: string;
  /** The retained artifact's exact JSON text. */
  readonly artifactJson: string;
  /** The retained artifact parsed losslessly. */
  readonly artifact: JsonValue;
  /** The op's typed status/failure class, never prose-inferred. */
  readonly harvest: RepairArtifactHarvest;
  /**
   * `verified` only for an `ok` artifact whose complete binding echo matched.
   * A non-ok artifact has no echo; it is honestly reported as `not-ok`.
   */
  readonly binding: 'verified' | 'not-ok';
  /** The actual current-state observation at harvest. */
  readonly source: RepairSourceReobservation;
}

export type RepairArtifactReadResult =
  | { readonly ok: true; readonly value: RepairArtifactRead }
  | { readonly ok: false; readonly refusal: RepairDispatchRefusal };

export type RunRepairDispatchResult =
  | {
      readonly ok: true;
      readonly value: {
        readonly run: RunReport;
        readonly artifactJson: string;
        readonly artifact: JsonValue;
        /** Harvest of the retained journal artifact; may itself refuse. */
        readonly harvest: RepairArtifactReadResult;
      };
    }
  | {
      readonly ok: false;
      readonly refusal: RepairDispatchRefusal;
      /** Present when the kernel run completed but no retained artifact was usable. */
      readonly run?: RunReport;
    };

export interface RepairRunOptions {
  readonly resume: boolean;
  /** Caller-owned registry view. This module never edits the registry. */
  readonly registry: OpRegistryView;
}

interface PreparedRepairJob {
  readonly job: JsonObject;
  readonly binding: FixFindingBinding;
  readonly path: string;
  readonly guidance?: string;
}

type ReadPreparedResult =
  | { readonly ok: true; readonly value: PreparedRepairJob }
  | { readonly ok: false; readonly refusal: RepairDispatchRefusal };

function refusal(refusal: RepairDispatchRefusal): {
  readonly ok: false;
  readonly refusal: RepairDispatchRefusal;
} {
  return { ok: false, refusal };
}

const encoder = new TextEncoder();
const GUARD_PREFIX = 'repair-dispatch-guard:';

function utf8Sha256(text: string): string {
  return sha256Hex(encoder.encode(text));
}

function sameBinding(left: FixFindingBinding, right: FixFindingBinding): boolean {
  return (
    left.job === right.job &&
    left.sourceSha === right.sourceSha &&
    left.sourceBlobSha === right.sourceBlobSha &&
    left.findingSha256 === right.findingSha256 &&
    left.repairBase === right.repairBase
  );
}

/**
 * Read and validate the durable prepared job. This is the producer's shape,
 * not a second schema: the five binding fields, the canonical finding digest,
 * the pinned source/blob and the optional prepared guidance. Legacy jobs use
 * the top-level `source_blob_sha` branch, exactly as Python does.
 */
function readPreparedRepairJobText(jobId: string, text: string): ReadPreparedResult {
  let parsed: JsonValue;
  try {
    parsed = parseJsonValue(text);
  } catch {
    return refusal('prepared-job-unreadable');
  }
  if (!(parsed instanceof JsonObject)) return refusal('prepared-job-unreadable');
  if (parsed.get('job') !== jobId) return refusal('prepared-job-unreadable');

  const sourceSha = parsed.get('source_sha');
  if (typeof sourceSha !== 'string' || !checkSha(sourceSha)) {
    return refusal('source-sha-invalid');
  }
  const finding = parsed.get('finding');
  if (!(finding instanceof JsonObject)) return refusal('prepared-job-unreadable');
  const findingSha256 = findingDigest(finding);
  if (parsed.get('finding_sha256') !== findingSha256) return refusal('binding-mismatch');

  const repairBase = parsed.get('repair_base');
  if (typeof repairBase !== 'string' || !checkSha(repairBase) || repairBase !== sourceSha) {
    return refusal('binding-mismatch');
  }
  const path = sourcePath(finding);
  if (!path.ok) return refusal(path.refusal);

  const revalidation = parsed.get('revalidation');
  const prepared = pythonTruthy(revalidation);
  let sourceBlobSha: string;
  let guidance: string | undefined;
  if (prepared) {
    if (!(revalidation instanceof JsonObject)) return refusal('prepared-job-unreadable');
    const blob = revalidation.get('source_blob_sha');
    if (typeof blob !== 'string' || !checkSha(blob)) return refusal('source-blob-mismatch');
    sourceBlobSha = blob;
    if (revalidation.has('fix_instructions')) {
      const value = revalidation.get('fix_instructions');
      if (typeof value !== 'string') return refusal('prepared-job-unreadable');
      guidance = value;
    }
  } else {
    const blob = parsed.get('source_blob_sha');
    if (typeof blob !== 'string' || !checkSha(blob)) return refusal('source-blob-mismatch');
    sourceBlobSha = blob;
  }

  return {
    ok: true,
    value: {
      job: parsed,
      path: path.path,
      ...(guidance === undefined ? {} : { guidance }),
      binding: {
        job: jobId,
        sourceSha,
        sourceBlobSha,
        findingSha256,
        repairBase,
      },
    },
  };
}

async function loadPreparedJob(
  jobId: string,
  effects: RepairHarvestEffects,
): Promise<ReadPreparedResult> {
  let text: string;
  try {
    text = await effects.readPreparedJob(jobId);
  } catch {
    return refusal('prepared-job-unreadable');
  }
  return readPreparedRepairJobText(jobId, text);
}

interface DispatchContent {
  readonly prepared: PreparedRepairJob;
  readonly currentTip: string;
  readonly blobOid: string;
  readonly sourceSha256: string;
  readonly input: FixFindingInput;
  readonly inputHash: string;
}

type ReadDispatchContentResult =
  | { readonly ok: true; readonly value: DispatchContent }
  | { readonly ok: false; readonly refusal: RepairDispatchRefusal };

/**
 * Rebuild the exact dispatch request from current durable state and the
 * current source. This is the single definition of "the payload worth
 * dispatching": the prepared job (including `mechanical_evidence` and
 * `fix_instructions`), the normalized finding path, the pinned blob, the
 * full source text hash, the caller's guidance, and the caller-owned request
 * context. Any difference changes the manifest `inputsHash`, so callers can
 * compare one hash rather than enumerating fields.
 */
async function readDispatchContent(
  prepared: PreparedRepairJob,
  requestContext: RepairRequestContext,
  effects: RepairHarvestEffects,
): Promise<ReadDispatchContentResult> {
  let currentTip: string;
  try {
    currentTip = await effects.git.currentTip();
  } catch {
    return refusal('source-tip-unreadable');
  }
  let blobOid: string;
  try {
    blobOid = await effects.git.blobOid(prepared.binding.sourceSha, prepared.path);
  } catch {
    return refusal('source-blob-unreadable');
  }
  if (blobOid !== prepared.binding.sourceBlobSha) return refusal('source-blob-mismatch');

  let sourceText: string;
  try {
    sourceText = await effects.git.showFile(`${prepared.binding.sourceSha}:${prepared.path}`);
  } catch {
    return refusal('source-content-unreadable');
  }
  const sourceSha256 = utf8Sha256(sourceText);

  const snapshot = buildRepairSnapshot({
    job: prepared.job,
    blobOid,
    sourceText,
  });
  if (!snapshot.ok) return refusal(snapshot.refusal);

  const request = buildRepairRequest({
    prepared: {
      job: normalizedRequestJob(prepared),
      snapshot: snapshot.snapshot,
      binding: prepared.binding,
      ...(prepared.guidance === undefined ? {} : { scannedGuidance: prepared.guidance }),
    },
    context: requestContext,
  });
  if (!request.ok) return refusal(request.refusal);

  const inputHash = inputHashForJob('review.fixFinding', request.value.input);
  if (inputHash === undefined) return refusal('attempt-inconsistent');
  return {
    ok: true,
    value: {
      prepared,
      currentTip,
      blobOid,
      sourceSha256,
      input: request.value.input,
      inputHash,
    },
  };
}

async function readDispatchContentForJob(
  jobId: string,
  requestContext: RepairRequestContext,
  effects: RepairHarvestEffects,
): Promise<ReadDispatchContentResult> {
  const prepared = await loadPreparedJob(jobId, effects);
  if (!prepared.ok) return prepared;
  return readDispatchContent(prepared.value, requestContext, effects);
}

/**
 * The finding digest is canonical over the prepared finding, including the
 * caller's original path. Normalize ONLY the path handed to
 * `buildRepairRequest`/the snapshot; never rewrite the job or its digest.
 */
function normalizedRequestJob(prepared: PreparedRepairJob): JsonObject {
  const finding = prepared.job.get('finding');
  if (!(finding instanceof JsonObject)) return prepared.job;
  const rawPath = finding.get('path');
  if (typeof rawPath !== 'string' || rawPath === prepared.path) return prepared.job;
  const normalizedFinding = new JsonObject(
    finding.entries.map(([key, value]) => [key, key === 'path' ? prepared.path : value] as const),
  );
  return new JsonObject(
    prepared.job.entries.map(
      ([key, value]) => [key, key === 'finding' ? normalizedFinding : value] as const,
    ),
  );
}

function inputHashForJob(op: string, input: unknown): string | undefined {
  try {
    const manifest = makeManifest({
      id: 'repair-dispatch-revalidation',
      jobs: [{ id: 'job', op, input }],
    });
    return manifest.jobs[0]?.inputsHash;
  } catch {
    return undefined;
  }
}

function selectionRefusal(input: {
  readonly context: RepairDispatchCallerContext;
  readonly prepared: PreparedRepairJob;
}): RepairDispatchRefusal | undefined {
  const { context, prepared } = input;
  if (context.selection.state !== 'queued') return 'selection-not-queued';
  if (context.selection.canonicalDelivery !== 'verified') return 'canonical-delivery-unverified';
  if (context.selection.severity !== 'repairable') return 'severity-not-repairable';
  if (context.selectedJobId !== prepared.binding.job) return 'selection-mismatch';
  if (
    context.selection.base !== undefined &&
    context.selection.base !== prepared.binding.sourceSha
  ) {
    return 'selection-mismatch';
  }
  if (context.selection.jobs !== undefined) {
    const jobs = context.selection.jobs;
    if (jobs.length !== 1 || jobs[0] !== prepared.binding.job) return 'selection-mismatch';
  }
  if (context.selection.originJob !== undefined) {
    const originJob = prepared.job.get('origin_job');
    if (originJob !== context.selection.originJob) return 'selection-mismatch';
  }
  if (context.selection.revalidationSha256 !== undefined) {
    const revalidation = prepared.job.get('revalidation');
    if (
      !(revalidation instanceof JsonObject) ||
      receiptJsonDigest(revalidation) !== context.selection.revalidationSha256
    ) {
      return 'selection-mismatch';
    }
  }
  return undefined;
}

type ScanState =
  | { readonly ok: true; readonly value: 'clean' | 'unverified' }
  | { readonly ok: false; readonly refusal: RepairDispatchRefusal };

function scanState(input: {
  readonly context: RepairDispatchCallerContext;
  readonly binding: FixFindingBinding;
  readonly guidance: string | undefined;
  readonly sourceSha256: string;
}): ScanState {
  const source = input.context.scans.source;
  let sourceClean = false;
  if (source.verdict === 'clean') {
    if (source.sourceSha !== input.binding.sourceSha) {
      return refusal('scan-source-sha-mismatch');
    }
    if (source.sourceBlobSha !== input.binding.sourceBlobSha) {
      return refusal('scan-source-blob-mismatch');
    }
    if (source.sourceSha256 !== input.sourceSha256) {
      return refusal('scan-source-hash-mismatch');
    }
    sourceClean = true;
  }

  const guidanceScan = input.context.scans.guidance;
  let guidanceClean = false;
  if (input.guidance === undefined) {
    if (guidanceScan.verdict !== 'absent') return refusal('scan-guidance-mismatch');
    guidanceClean = true;
  } else if (guidanceScan.verdict === 'clean') {
    if (guidanceScan.instructionsSha256 !== utf8Sha256(input.guidance)) {
      return refusal('scan-guidance-mismatch');
    }
    guidanceClean = true;
  } else if (guidanceScan.verdict === 'absent') {
    return refusal('scan-guidance-mismatch');
  }

  return { ok: true, value: sourceClean && guidanceClean ? 'clean' : 'unverified' };
}

/**
 * `unverified` is retryable for a resumed attempt by design; an explicitly
 * failed scan is not evidence that a retry may dispatch. Retained-ok replay
 * never invokes the op, so it stays scan-free.
 */
function failedScanRefusal(
  context: RepairDispatchCallerContext,
): RepairDispatchRefusal | undefined {
  if (context.scans.source.verdict === 'failed') return 'scan-failed';
  if (context.scans.guidance.verdict === 'failed') return 'scan-failed';
  return undefined;
}

function gatesFor(attempt: RepairAttempt, scans: 'clean' | 'unverified'): RepairDispatchGate[] {
  const gates: RepairDispatchGate[] = [
    'queue-selection',
    'canonical-delivery',
    'severity-selection',
  ];
  if (attempt !== 'retained-ok') {
    if (scans !== 'clean') gates.push('scan-confirmation');
    gates.push('invocation-size-bound', 'dispatch-execution');
  }
  gates.push('harvest-disposition');
  return gates;
}

interface PriorArtifact {
  readonly result?: OpResultArtifact<unknown>;
}

/**
 * Replicate the kernel's resume replay fold for one plan/job: only candidate
 * run ids with the exact plan prefix/tail, only runs whose `run-started`
 * names this plan, fold order, then the last `job-finished` (a later
 * `quarantine-released` deletes it). The match is op id plus the manifest's
 * exact `inputsHash`; a stale tip cannot match by run name alone.
 */
async function findPriorArtifact(input: {
  readonly journalDir: string;
  readonly plan: Plan;
  readonly jobId: string;
  readonly op: string;
  readonly inputsHash: string;
}): Promise<{ readonly ok: true; readonly value: PriorArtifact } | { readonly ok: false }> {
  try {
    const runLog = openRunLog(input.journalDir);
    const candidates = candidateRunsForPlan(await runLog.runs(), input.plan.id);
    const matching: FoldRun[] = [];
    for (const runId of candidates) {
      const events = await runLog.read(runId);
      const started = events.find(
        (event): event is Extract<JournalEvent, { type: 'run-started' }> =>
          event.type === 'run-started',
      );
      if (started === undefined || started.planId !== input.plan.id) continue;
      matching.push({ runId, events });
    }
    const ordered = foldOrderRuns(matching);
    let maxPriorSeq = 0;
    for (const run of ordered) {
      for (const event of run.events) {
        if (event.type === 'run-started' && event.seq !== undefined && event.seq > maxPriorSeq) {
          maxPriorSeq = event.seq;
        }
      }
    }
    await assertNoSeqGap(input.journalDir, input.plan.id, maxPriorSeq);

    const replay = new Map<string, Extract<JournalEvent, { type: 'job-finished' }>>();
    for (const run of ordered) {
      for (const event of run.events) {
        if (event.type === 'job-finished') {
          // A bridge invocation-guard refusal means the repair op never ran.
          // It is journal evidence of a refused dispatch, not a terminal
          // attempt that makes a later resume eligible.
          if (!isInvocationGuardResult(event.result)) replay.set(event.jobId, event);
        } else if (event.type === 'quarantine-released') replay.delete(event.jobId);
      }
    }
    const prior = replay.get(input.jobId);
    if (prior === undefined || prior.opId !== input.op || prior.inputsHash !== input.inputsHash) {
      return { ok: true, value: {} };
    }
    return { ok: true, value: { result: prior.result } };
  } catch {
    return { ok: false };
  }
}

function planJob(plan: Plan): { readonly op: string; readonly inputsHash: string } | undefined {
  if (plan.jobs.length !== 1) return undefined;
  let manifest;
  try {
    manifest = makeManifest(plan);
  } catch {
    return undefined;
  }
  const job = manifest.jobs[0];
  if (job === undefined) return undefined;
  return { op: job.op, inputsHash: job.inputsHash };
}

/**
 * Plan one dispatch from explicit caller context and fresh reads.
 *
 * The snapshot is rebuilt from the text read at this invocation. The attempt
 * class comes from the kernel journal fold only when `resume` was requested:
 * a matching `ok` terminal is `retained-ok`, a matching non-ok terminal is
 * `resumed`, and everything else is `fresh` and must satisfy the current-tip
 * and clean-scan preconditions. No durable prepared job is treated as scan
 * attestation.
 */
export async function planRepairDispatch(
  input: {
    readonly context: RepairDispatchCallerContext;
    readonly attempt: RepairAttemptContext;
  },
  effects: RepairDispatchEffects,
): Promise<PlanRepairDispatchResult> {
  const preparedResult = await loadPreparedJob(input.context.selectedJobId, effects);
  if (!preparedResult.ok) return preparedResult;
  const prepared = preparedResult.value;

  const bindingRefusal = selectionRefusal({ context: input.context, prepared });
  if (bindingRefusal !== undefined) return refusal(bindingRefusal);

  const contentResult = await readDispatchContent(prepared, input.context.requestContext, effects);
  if (!contentResult.ok) return contentResult;
  const content = contentResult.value;
  const currentTip = content.currentTip;
  const sourceSha256 = content.sourceSha256;

  const scans = scanState({
    context: input.context,
    binding: prepared.binding,
    guidance: prepared.guidance,
    sourceSha256,
  });
  if (!scans.ok) return scans;

  const plan: Plan = {
    id: `crq-repair-dispatch-${prepared.binding.job}`,
    jobs: [
      {
        id: prepared.binding.job,
        op: 'review.fixFinding',
        input: content.input,
      },
    ],
  };
  const manifestJob = planJob(plan);
  if (manifestJob === undefined) return refusal('attempt-inconsistent');
  if (manifestJob.inputsHash !== content.inputHash) return refusal('attempt-inconsistent');

  const prior: { readonly ok: true; readonly value: PriorArtifact } | { readonly ok: false } = input
    .attempt.resume
    ? await findPriorArtifact({
        journalDir: input.attempt.journalDir,
        plan,
        jobId: prepared.binding.job,
        op: manifestJob.op,
        inputsHash: manifestJob.inputsHash,
      })
    : { ok: true, value: {} };
  if (!prior.ok) return refusal('journal-unreadable');

  const matchingTerminal = prior.value.result !== undefined;
  const attempt: RepairAttempt =
    input.attempt.resume && matchingTerminal
      ? prior.value.result?.status === 'ok'
        ? 'retained-ok'
        : 'resumed'
      : 'fresh';

  const atTip = currentTip === prepared.binding.sourceSha;
  if (attempt !== 'retained-ok') {
    const failedScan = failedScanRefusal(input.context);
    if (failedScan !== undefined) return refusal(failedScan);
  }
  if (attempt === 'fresh') {
    if (!atTip) return refusal('source-not-current-tip');
    if (scans.value !== 'clean') return refusal('scan-unverified');
  }

  return {
    ok: true,
    value: {
      status: 'dispatch-planned',
      selectedJobId: prepared.binding.job,
      attempt,
      resume: input.attempt.resume,
      journalDir: input.attempt.journalDir,
      plan,
      requestContext: input.context.requestContext,
      inputHash: content.inputHash,
      binding: prepared.binding,
      path: prepared.path,
      source: {
        sourceSha: prepared.binding.sourceSha,
        sourceBlobSha: prepared.binding.sourceBlobSha,
        sourceSha256,
        atTip,
        blobMatches: true,
      },
      preconditions: {
        selection: 'caller-asserted',
        scans: scans.value,
        binding: 'verified',
        sourceBlob: 'verified',
      },
      remainingGates: gatesFor(attempt, scans.value),
    },
  };
}

function harvestOf(artifact: ValidatedFixFindingArtifact): RepairArtifactHarvest {
  switch (artifact.status) {
    case 'ok':
      return { status: 'ok', value: artifact.value };
    case 'failed':
      return {
        status: 'failed',
        failureClass: artifact.report.failureClass,
        error: artifact.error,
        report: artifact.report,
      };
    case 'needs-human':
      return {
        status: 'needs-human',
        failureClass: artifact.report.failureClass,
        reason: artifact.reason,
        report: artifact.report,
      };
    case 'budget-exhausted':
      return {
        status: 'budget-exhausted',
        failureClass: artifact.report.failureClass,
        report: artifact.report,
      };
    case 'indeterminate':
      return {
        status: 'indeterminate',
        failureClass: artifact.report.failureClass,
        detail: artifact.detail,
        report: artifact.report,
      };
  }
}

function parseArtifact(artifactJson: string): JsonValue | undefined {
  try {
    return parseJsonValue(artifactJson);
  } catch {
    return undefined;
  }
}

/**
 * Harvest one artifact against the CURRENT prepared job and source
 * observation. The actual artifact is parsed through the canonical kernel
 * schema and the op's typed report guard; an `ok` artifact must echo the
 * complete binding. Non-ok artifacts have no echo and are reported as
 * `not-ok` with their typed status/failure class. Read-only: no journal,
 * prepared-job or worktree write.
 */
export async function harvestRepairArtifact(
  input: {
    readonly expectedBinding: FixFindingBinding;
    readonly path: string;
    readonly artifactJson: string;
  },
  effects: RepairHarvestEffects,
): Promise<RepairArtifactReadResult> {
  const prepared = await loadPreparedJob(input.expectedBinding.job, effects);
  if (!prepared.ok) return prepared;
  if (!sameBinding(prepared.value.binding, input.expectedBinding)) {
    return refusal('prepared-job-changed');
  }
  if (prepared.value.path !== input.path) return refusal('prepared-job-changed');

  const parsed = parseFixFindingArtifactText(input.artifactJson);
  if (!parsed.ok) return refusal(parsed.refusal);
  const artifact = parsed.value;
  const artifactValue = parseArtifact(input.artifactJson);
  if (artifactValue === undefined) return refusal('fixfinding-result-envelope-invalid');

  if (artifact.status !== 'ok') {
    const source = await reobservePreparedSource(
      {
        sourceSha: prepared.value.binding.sourceSha,
        sourceBlobSha: prepared.value.binding.sourceBlobSha,
        path: prepared.value.path,
      },
      effects.git,
    );
    return {
      ok: true,
      value: {
        selectedJobId: prepared.value.binding.job,
        artifactJson: input.artifactJson,
        artifact: artifactValue,
        harvest: harvestOf(artifact),
        binding: 'not-ok',
        source,
      },
    };
  }

  const verified = await verifyPreparedHarvest(
    {
      format: 'fixFinding',
      prepared: prepared.value.binding,
      artifactJson: input.artifactJson,
      path: prepared.value.path,
    },
    effects.git,
  );
  if (!verified.ok) return refusal(verified.refusal);
  return {
    ok: true,
    value: {
      selectedJobId: prepared.value.binding.job,
      artifactJson: input.artifactJson,
      artifact: artifactValue,
      harvest: harvestOf(artifact),
      binding: 'verified',
      source: verified.value.source,
    },
  };
}

/**
 * Read the last retained terminal artifact for this exact plan/job/input from
 * the kernel journal and harvest it. This is the read-only route; it never
 * dispatches or writes.
 */
export async function readRetainedRepairArtifact(
  input: {
    readonly journalDir: string;
    readonly plan: Plan;
    readonly binding: FixFindingBinding;
    readonly path: string;
  },
  effects: RepairHarvestEffects,
): Promise<RepairArtifactReadResult> {
  const manifestJob = planJob(input.plan);
  if (manifestJob === undefined || input.plan.jobs[0]?.id !== input.binding.job) {
    return refusal('attempt-inconsistent');
  }
  const prior = await findPriorArtifact({
    journalDir: input.journalDir,
    plan: input.plan,
    jobId: input.binding.job,
    op: manifestJob.op,
    inputsHash: manifestJob.inputsHash,
  });
  if (!prior.ok) return refusal('journal-unreadable');
  if (prior.value.result === undefined) return refusal('retained-artifact-missing');
  return harvestRepairArtifact(
    {
      expectedBinding: input.binding,
      path: input.path,
      artifactJson: JSON.stringify(prior.value.result),
    },
    effects,
  );
}

/** Convenience: harvest the retained artifact for a planned dispatch. */
export async function harvestRepairDispatch(
  dispatch: RepairDispatchPlan,
  effects: RepairHarvestEffects,
): Promise<RepairArtifactReadResult> {
  const content = await readDispatchContentForJob(
    dispatch.binding.job,
    dispatch.requestContext,
    effects,
  );
  if (!content.ok) return content;
  const stale = contentRefusal(content.value, dispatch);
  if (stale !== undefined) return refusal(stale);
  return readRetainedRepairArtifact(
    {
      journalDir: dispatch.journalDir,
      plan: dispatch.plan,
      binding: dispatch.binding,
      path: dispatch.path,
    },
    effects,
  );
}

/**
 * The exact run's retained `job-finished` artifact. Unlike the all-run
 * replay fold used for a standalone retained read, this is scoped to ONE
 * `RunReport.runId`: the caller gets run A's artifact even when run B, later
 * and with the opposite outcome, is the newest run for the same plan/input.
 */
async function readExactRunArtifact(input: {
  readonly journalDir: string;
  readonly runId: string;
  readonly plan: Plan;
  readonly jobId: string;
  readonly op: string;
  readonly inputsHash: string;
}): Promise<
  | { readonly ok: true; readonly result: OpResultArtifact<unknown> }
  | { readonly ok: false; readonly refusal: RepairDispatchRefusal }
> {
  let events: readonly JournalEvent[];
  try {
    events = await openRunLog(input.journalDir).read(input.runId);
  } catch {
    return refusal('journal-unreadable');
  }
  const started = events.find(
    (event): event is Extract<JournalEvent, { type: 'run-started' }> =>
      event.type === 'run-started',
  );
  if (started === undefined || started.planId !== input.plan.id) {
    return refusal('attempt-inconsistent');
  }
  let finished: Extract<JournalEvent, { type: 'job-finished' }> | undefined;
  for (const event of events) {
    if (event.type === 'job-finished' && event.jobId === input.jobId) finished = event;
  }
  if (finished === undefined) return refusal('retained-artifact-missing');
  if (finished.opId !== input.op || finished.inputsHash !== input.inputsHash) {
    return refusal('attempt-inconsistent');
  }
  return { ok: true, result: finished.result };
}

function contentRefusal(
  content: DispatchContent,
  dispatch: RepairDispatchPlan,
): RepairDispatchRefusal | undefined {
  if (!sameBinding(content.prepared.binding, dispatch.binding)) return 'prepared-job-changed';
  if (content.prepared.path !== dispatch.path) return 'prepared-job-changed';
  if (content.blobOid !== dispatch.binding.sourceBlobSha) return 'source-blob-mismatch';
  if (content.sourceSha256 !== dispatch.source.sourceSha256) return 'scan-source-hash-mismatch';
  if (content.inputHash !== dispatch.inputHash) return 'prepared-job-changed';
  return undefined;
}

/**
 * Harvest the artifact belonging to exactly `runId`, after re-rebuilding the
 * dispatch payload. The exact run event must carry this plan's op and input
 * hash; an ok artifact must still echo the complete binding.
 */
export async function harvestRepairRunArtifact(
  dispatch: RepairDispatchPlan,
  runId: string,
  effects: RepairHarvestEffects,
): Promise<RepairArtifactReadResult> {
  const manifestJob = planJob(dispatch.plan);
  if (manifestJob === undefined || dispatch.plan.jobs[0]?.id !== dispatch.binding.job) {
    return refusal('attempt-inconsistent');
  }
  if (manifestJob.inputsHash !== dispatch.inputHash) return refusal('attempt-inconsistent');
  const exact = await readExactRunArtifact({
    journalDir: dispatch.journalDir,
    runId,
    plan: dispatch.plan,
    jobId: dispatch.binding.job,
    op: manifestJob.op,
    inputsHash: manifestJob.inputsHash,
  });
  if (!exact.ok) return refusal(exact.refusal);

  const artifactJson = JSON.stringify(exact.result);
  if (isInvocationGuardResult(exact.result)) {
    const artifact = parseArtifact(artifactJson);
    if (artifact === undefined) return refusal('fixfinding-result-envelope-invalid');
    const guardRefusal = guardRefusalOf(exact.result);
    if (guardRefusal === undefined) return refusal('attempt-inconsistent');
    return {
      ok: true,
      value: {
        selectedJobId: dispatch.binding.job,
        artifactJson,
        artifact,
        harvest: { status: 'guard-refused', refusal: guardRefusal },
        binding: 'not-ok',
        source: await reobservePreparedSource(
          {
            sourceSha: dispatch.binding.sourceSha,
            sourceBlobSha: dispatch.binding.sourceBlobSha,
            path: dispatch.path,
          },
          effects.git,
        ),
      },
    };
  }

  const content = await readDispatchContentForJob(
    dispatch.binding.job,
    dispatch.requestContext,
    effects,
  );
  if (!content.ok) return content;
  const stale = contentRefusal(content.value, dispatch);
  if (stale !== undefined) return refusal(stale);

  return harvestRepairArtifact(
    {
      expectedBinding: dispatch.binding,
      path: dispatch.path,
      artifactJson,
    },
    effects,
  );
}

/**
 * Preflight the dispatch immediately before the kernel run. This is a fast,
 * non-atomic refusal of a stale plan; it deliberately does NOT re-classify
 * the attempt, because that decision must be made under the kernel's plan
 * lease at invocation (see `revalidateAtInvocation`). The full rebuilt
 * payload hash catches mechanical evidence, retry instructions, prepared
 * guidance and request-context changes that a guidance-only check misses.
 */
async function preflightBeforeRun(
  dispatch: RepairDispatchPlan,
  effects: RepairHarvestEffects,
): Promise<RepairDispatchRefusal | undefined> {
  const prepared = await loadPreparedJob(dispatch.binding.job, effects);
  if (!prepared.ok) return prepared.refusal;
  if (!sameBinding(prepared.value.binding, dispatch.binding)) return 'prepared-job-changed';
  if (prepared.value.path !== dispatch.path) return 'prepared-job-changed';
  const content = await readDispatchContentForJob(
    dispatch.binding.job,
    dispatch.requestContext,
    effects,
  );
  if (!content.ok) return content.refusal;
  const stale = contentRefusal(content.value, dispatch);
  if (stale !== undefined) return stale;
  if (dispatch.attempt === 'fresh') {
    if (content.value.currentTip !== dispatch.binding.sourceSha) {
      return 'source-not-current-tip';
    }
    if (dispatch.preconditions.scans !== 'clean') return 'scan-unverified';
  }
  return undefined;
}

/**
 * The attempt class is a journal fold, not a plan promise. Re-fold inside
 * the kernel's own plan lease (this runs from the registry `op.run` wrapper,
 * after the kernel has acquired the lease and decided not to replay), so a
 * non-ok terminal that appeared after planning is seen at the exact moment
 * the kernel would invoke. A new `ok` terminal is refused rather than paid
 * for, and a retained-ok plan whose artifact vanished is refused instead of
 * turning into an unplanned fresh dispatch.
 */
async function revalidateAtInvocation(
  dispatch: RepairDispatchPlan,
  effects: RepairHarvestEffects,
  actualInput: unknown,
): Promise<RepairDispatchRefusal | undefined> {
  const prepared = await loadPreparedJob(dispatch.binding.job, effects);
  if (!prepared.ok) return prepared.refusal;
  if (!sameBinding(prepared.value.binding, dispatch.binding)) return 'prepared-job-changed';
  if (prepared.value.path !== dispatch.path) return 'prepared-job-changed';
  const content = await readDispatchContentForJob(
    dispatch.binding.job,
    dispatch.requestContext,
    effects,
  );
  if (!content.ok) return content.refusal;
  const stale = contentRefusal(content.value, dispatch);
  if (stale !== undefined) return stale;

  const manifestJob = planJob(dispatch.plan);
  if (manifestJob === undefined) return 'attempt-inconsistent';
  if (inputHashForJob(manifestJob.op, actualInput) !== dispatch.inputHash) {
    return 'attempt-inconsistent';
  }

  const prior = await findPriorArtifact({
    journalDir: dispatch.journalDir,
    plan: dispatch.plan,
    jobId: dispatch.binding.job,
    op: manifestJob.op,
    inputsHash: manifestJob.inputsHash,
  });
  if (!prior.ok) return 'journal-unreadable';
  const currentAttempt: RepairAttempt =
    prior.value.result === undefined
      ? 'fresh'
      : prior.value.result.status === 'ok'
        ? 'retained-ok'
        : 'resumed';

  if (dispatch.attempt === 'retained-ok') return 'attempt-inconsistent';
  if (dispatch.resume && currentAttempt === 'retained-ok') return 'attempt-inconsistent';
  if (dispatch.attempt === 'fresh' || currentAttempt === 'fresh') {
    if (content.value.currentTip !== dispatch.binding.sourceSha) {
      return 'source-not-current-tip';
    }
    if (dispatch.preconditions.scans !== 'clean') return 'scan-unverified';
  }
  return undefined;
}

/**
 * Compose the guard with the existing registry entry so the op the kernel
 * actually invokes is wrapped. No second lock: the kernel's plan lease is
 * already held when this wrapper runs, and a retained-ok replay never calls
 * the importer at all (so reuse stays idempotent and scan-free).
 */
function withInvocationGuard(
  dispatch: RepairDispatchPlan,
  registry: OpRegistryView,
  effects: RepairHarvestEffects,
): OpRegistryView {
  const entry = registry.get('review.fixFinding');
  if (entry === undefined) return registry;
  return {
    get(name) {
      if (name !== 'review.fixFinding') return registry.get(name);
      return {
        ...entry,
        importer: async (wiring) => {
          const op = await entry.importer(wiring);
          return async (input) => {
            const guard = await revalidateAtInvocation(dispatch, effects, input);
            if (guard !== undefined) {
              return { status: 'failed', error: `${GUARD_PREFIX}${guard}` };
            }
            return op(input);
          };
        },
      };
    },
  };
}

/**
 * Recognise only this bridge's invocation-guard marker. The wrapper writes
 * values from `RepairDispatchRefusal`; the cast is the trust boundary at
 * which the kernel's plain failed result is mapped back to the typed union.
 */
function isInvocationGuardResult(
  result: OpResultArtifact<unknown> | undefined,
): result is Extract<OpResultArtifact<unknown>, { status: 'failed' }> {
  return (
    result !== undefined && result.status === 'failed' && result.error.startsWith(GUARD_PREFIX)
  );
}

function guardRefusalOf(
  result: OpResultArtifact<unknown> | undefined,
): RepairDispatchRefusal | undefined {
  if (!isInvocationGuardResult(result)) return undefined;
  const value = result.error.slice(GUARD_PREFIX.length);
  return value.length === 0 ? 'attempt-inconsistent' : (value as RepairDispatchRefusal);
}

/**
 * Run the planned job through the existing kernel and read the journal's
 * retained terminal artifact. The dispatch plan's attempt/scans/tip are
 * enforced here, so a caller cannot bypass the fresh-attempt gates by
 * mutating only the run options.
 */
export async function runRepairDispatch(
  dispatch: RepairDispatchPlan,
  options: RepairRunOptions,
  effects: RepairHarvestEffects,
): Promise<RunRepairDispatchResult> {
  if (options.resume !== dispatch.resume) return refusal('attempt-inconsistent');
  if (dispatch.plan.jobs.length !== 1) return refusal('attempt-inconsistent');
  const manifestJob = planJob(dispatch.plan);
  if (
    manifestJob === undefined ||
    manifestJob.op !== 'review.fixFinding' ||
    manifestJob.inputsHash !== dispatch.inputHash ||
    dispatch.plan.jobs[0]?.id !== dispatch.binding.job
  ) {
    return refusal('attempt-inconsistent');
  }
  if (dispatch.attempt === 'fresh') {
    if (dispatch.preconditions.scans !== 'clean') return refusal('scan-unverified');
    if (!dispatch.source.atTip) return refusal('source-not-current-tip');
  } else if (!options.resume) {
    return refusal('attempt-inconsistent');
  }

  const preflight = await preflightBeforeRun(dispatch, effects);
  if (preflight !== undefined) return refusal(preflight);

  const run = await runPlan(
    dispatch.plan,
    {
      concurrency: 1,
      stopOnError: true,
      journalDir: dispatch.journalDir,
      resume: options.resume,
    },
    withInvocationGuard(dispatch, options.registry, effects),
  );

  const guard = guardRefusalOf(run.jobs[0]?.result);
  if (guard !== undefined) return { ...refusal(guard), run };

  const retained = await harvestRepairRunArtifact(dispatch, run.runId, effects);
  if (!retained.ok) return { ...refusal(retained.refusal), run };
  return {
    ok: true,
    value: {
      run,
      artifactJson: retained.value.artifactJson,
      artifact: retained.value.artifact,
      harvest: retained,
    },
  };
}
