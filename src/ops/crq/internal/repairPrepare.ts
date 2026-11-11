/**
 * Offline crq repair preparation over an INJECTED git seam.
 *
 * Lifecycle position: after the historical job, queue item, revalidation
 * evidence and round count are read by a caller; before any queue write,
 * secret scan, canonical handoff, stale marking or dispatch. The result is
 * PROPOSED preparation data with a VERIFIED binding, not a dispatch-ready
 * artifact. `pendingGates` names every effect this slice does not perform, so
 * no consumer can mistake a proposal for a completed enqueue.
 *
 * This module imports no subprocess, filesystem, clock or environment seam.
 * The only external facts are the two `RepairGit` reads; a rejected or
 * throwing read becomes a typed refusal without git prose.
 */
import {
  checkCanonicalFindingId,
  checkSha,
  findingDigest,
  legacyPythonResultRefusal,
  preparedIdentity,
  proposedPreparedJob,
  proposedRunRecord,
  pythonTruthy,
  severityRepairable,
  sourcePath,
  typedFixFindingResultRefusal,
  validateEvidenceBinding,
  validateInstructions,
  type RepairRefusal,
  type RepairRoundCount,
} from '../../../policy/crq/repairBinding.js';
import { JsonObject, parseJsonValue, type JsonValue } from '../../../policy/crq/jsonValue.js';
import type { FixFindingBinding } from '../../review/fixFinding.js';

/** The two immutable git facts, injected so this module performs no spawn. */
export interface RepairGit {
  /** `git rev-parse origin/main`, lowercase 40-hex. */
  currentTip(): Promise<string>;
  /** `git rev-parse <sourceSha>:<path>`, lowercase 40-hex. */
  blobOid(sourceSha: string, path: string): Promise<string>;
}

/** Every effect the caller still owns after a successful proposal. */
export type PendingPreparationGate =
  | 'full-source-secret-scan'
  | 'fix-instructions-secret-scan'
  | 'instruction-utf16-dispatch-check'
  | 'canonical-delivery-handoff'
  | 'old-record-stale-marking'
  | 'atomic-state-writes';

/**
 * A binding-verified proposal. `status` never claims delivery, secret
 * clearance or dispatch readiness; `pendingGates` lists what remains.
 */
export interface ProposedRepairPreparation {
  readonly status: 'binding-verified';
  /** True when this prepared run already existed; no new data was proposed. */
  readonly idempotent: boolean;
  readonly jobId: string;
  readonly run: string;
  readonly findingSha256: string;
  readonly revalidationSha256: string;
  readonly binding: FixFindingBinding;
  /** Present only when a new proposal was built (never on the idempotent path). */
  readonly job?: JsonObject;
  /** The existing prepared run record on the idempotent path. */
  readonly record?: JsonObject;
  readonly pendingGates: readonly PendingPreparationGate[];
}

export interface VerifyPreparedRepairInput {
  /** Exact text of `state/repair/inbox/<oldJobId>.json`. */
  readonly oldJobJson: string;
  readonly oldJobId: string;
  /** Exact text of the queue item whose `id == oldJob.item`. */
  readonly queueItemJson: string;
  readonly sourceSha: string;
  /** Exact text of the revalidation evidence JSON. */
  readonly evidenceJson: string;
  /** The caller's existing round count for this pin (typed evidence). */
  readonly roundCount: RepairRoundCount;
  readonly maxRoundsPerPin: number;
  readonly preserveWorktree?: boolean;
}

export type VerifyPreparedRepairResult =
  | { readonly ok: true; readonly value: ProposedRepairPreparation }
  | { readonly ok: false; readonly refusal: RepairRefusal };

/** The current-state observation at a prospective harvest check. */
export type RepairSourceReobservation =
  | {
      readonly observed: true;
      readonly currentTip: string;
      /** `null` means the blob was not observed (no path supplied/read). */
      readonly blobOid: string | null;
      readonly atTip: boolean;
      readonly blobMatches: boolean;
    }
  | { readonly observed: false };

export type VerifyPreparedHarvestInput =
  | {
      readonly format: 'legacy-python';
      readonly preparedJson: string;
      readonly artifactJson: string;
      readonly allowMissingPreparedSourceSha: boolean;
    }
  | {
      readonly format: 'fixFinding';
      readonly prepared: FixFindingBinding;
      readonly artifactJson: string;
      /** The prepared finding's repository-relative path; both reads use it. */
      readonly path: string;
    };

export type VerifyPreparedHarvestResult =
  | {
      readonly ok: true;
      readonly value: {
        readonly binding: 'verified';
        readonly source: RepairSourceReobservation;
      };
    }
  | { readonly ok: false; readonly refusal: RepairRefusal };

function parseObject(text: string): JsonObject | undefined {
  try {
    const value = parseJsonValue(text);
    return value instanceof JsonObject ? value : undefined;
  } catch {
    return undefined;
  }
}

function parseValue(text: string): JsonValue | undefined {
  try {
    return parseJsonValue(text);
  } catch {
    return undefined;
  }
}

function refusal(value: RepairRefusal): { readonly ok: false; readonly refusal: RepairRefusal } {
  return { ok: false, refusal: value };
}

/**
 * Every effect this proposal does not perform. A carried canonical identity
 * always names the handoff gate (preparation refuses a present invalid id,
 * so key presence and Python truthiness coincide on every proposal). The
 * stale-marking condition is Python's exact predicate:
 * `(canonical_finding_id or preserve_worktree)`, a single-job record, a
 * queued/ready/publish_failed state and no `fix_pr`.
 */
function pendingGates(input: {
  readonly oldJob: JsonObject;
  readonly oldRecord: JsonObject;
  readonly oldJobId: string;
  readonly instructions: boolean;
  readonly preserveWorktree: boolean;
}): PendingPreparationGate[] {
  const gates: PendingPreparationGate[] = ['full-source-secret-scan'];
  if (input.instructions) {
    gates.push('fix-instructions-secret-scan', 'instruction-utf16-dispatch-check');
  }
  const canonical = input.oldJob.has('canonical_finding_id');
  if (canonical) gates.push('canonical-delivery-handoff');
  const records = input.oldRecord.get('jobs');
  const singleJob = Array.isArray(records) && records.length === 1 && records[0] === input.oldJobId;
  const state = input.oldRecord.get('state');
  const stateEligible = state === 'queued' || state === 'ready' || state === 'publish_failed';
  if (
    (canonical || input.preserveWorktree) &&
    singleJob &&
    stateEligible &&
    !pythonTruthy(input.oldRecord.get('fix_pr'))
  ) {
    gates.push('old-record-stale-marking');
  }
  gates.push('atomic-state-writes');
  return gates;
}

function tipOnlyObservation(currentTip: string, sourceSha: string): RepairSourceReobservation {
  return {
    observed: true,
    currentTip,
    blobOid: null,
    atTip: currentTip === sourceSha,
    blobMatches: false,
  };
}

/**
 * Verify the historical-job binding and produce PROPOSED prepared job and
 * run-record data. Reads exactly the git facts Python reads, in Python's
 * order: source-sha grammar, current tip, severity, source path, blob oid.
 * Malformed input refuses before any git read.
 */
export async function verifyPreparedRepair(
  input: VerifyPreparedRepairInput,
  git: RepairGit,
): Promise<VerifyPreparedRepairResult> {
  const oldJob = parseObject(input.oldJobJson);
  if (oldJob === undefined) return refusal('old-job-unreadable');
  const item = parseObject(input.queueItemJson);
  if (item === undefined) return refusal('queue-item-unreadable');
  const evidence = parseObject(input.evidenceJson);
  if (evidence === undefined) return refusal('evidence-unreadable');

  if (oldJob.get('job') !== input.oldJobId) return refusal('old-job-identity-mismatch');
  if (!checkSha(input.sourceSha)) return refusal('source-sha-invalid');

  let currentTip: string;
  try {
    currentTip = await git.currentTip();
  } catch {
    return refusal('source-not-current-tip');
  }
  if (currentTip !== input.sourceSha) return refusal('source-not-current-tip');
  if (!severityRepairable(oldJob)) return refusal('severity-not-repairable');

  const path = sourcePath(oldJob.get('finding') ?? null);
  if (!path.ok) return refusal(path.refusal);

  let blobOid: string;
  try {
    blobOid = await git.blobOid(input.sourceSha, path.path);
  } catch {
    return refusal('source-blob-unreadable');
  }

  const bindingRefusal = validateEvidenceBinding({
    oldJob,
    sourceSha: input.sourceSha,
    evidence,
    observed: { currentTip, blobOid },
  });
  if (bindingRefusal !== undefined) return refusal(bindingRefusal);

  const instructionsResult = validateInstructions(evidence);
  if (!instructionsResult.ok) return refusal(instructionsResult.refusal);

  const oldItem = oldJob.get('item');
  if (typeof oldItem !== 'string' || item.get('id') !== oldItem) {
    return refusal('old-job-item-missing');
  }
  const oldRun = oldJob.get('run');
  if (typeof oldRun !== 'string') return refusal('old-job-unreadable');
  const runsValue = item.get('repair_runs');
  if (runsValue !== undefined && !(runsValue instanceof JsonObject)) {
    return refusal('queue-item-unreadable');
  }
  const runs = runsValue instanceof JsonObject ? runsValue : new JsonObject([]);
  const oldRecord = runs.get(oldRun);
  if (!(oldRecord instanceof JsonObject) || !pythonTruthy(oldRecord)) {
    return refusal('old-job-not-tick-owned');
  }
  const recordedJobs = oldRecord.get('jobs');
  if (!Array.isArray(recordedJobs) || !recordedJobs.includes(input.oldJobId)) {
    return refusal('old-job-not-tick-owned');
  }

  // Python preparation writes a job with a PRESENT invalid canonical id and
  // its selection gate refuses it. Fail closed here so no proposal is
  // produced that Python cannot select.
  let canonicalId: string | undefined;
  if (oldJob.has('canonical_finding_id')) {
    const value = oldJob.get('canonical_finding_id');
    if (!checkCanonicalFindingId(value)) return refusal('canonical-finding-id-invalid');
    canonicalId = value;
  }
  const canonical = canonicalId !== undefined;
  const oldSource = oldJob.get('source');
  if (oldSource !== undefined && !(oldSource instanceof JsonObject)) {
    return refusal('old-job-unreadable');
  }

  const finding = oldJob.get('finding');
  if (finding === undefined) return refusal('old-job-unreadable');
  const findingSha256 = findingDigest(finding);
  const identity = preparedIdentity({
    oldJobId: input.oldJobId,
    sourceSha: input.sourceSha,
    evidence,
    ...(input.preserveWorktree === true ? { preserveWorktree: true } : {}),
  });
  const sourceBlobSha = evidence.get('source_blob_sha');
  if (typeof sourceBlobSha !== 'string') return refusal('source-blob-mismatch');
  const binding: FixFindingBinding = {
    job: identity.jobId,
    sourceSha: input.sourceSha,
    sourceBlobSha,
    findingSha256,
    repairBase: input.sourceSha,
  };
  const gates = pendingGates({
    oldJob,
    oldRecord,
    oldJobId: input.oldJobId,
    instructions: instructionsResult.instructions !== undefined,
    preserveWorktree: input.preserveWorktree === true,
  });

  // Prepared-id idempotence precedes the round ceiling, exactly as Python
  // returns an existing prepared run before counting rounds.
  const existing = runs.get(identity.run);
  if (existing !== undefined && pythonTruthy(existing)) {
    if (!(existing instanceof JsonObject)) return refusal('queue-item-unreadable');
    return {
      ok: true,
      value: {
        status: 'binding-verified',
        idempotent: true,
        jobId: identity.jobId,
        run: identity.run,
        findingSha256,
        revalidationSha256: identity.revalidationSha256,
        binding,
        record: existing,
        pendingGates: gates,
      },
    };
  }

  if (input.roundCount.basis !== 'canonical-finding' && input.roundCount.basis !== 'pr-pin') {
    return refusal('round-count-invalid');
  }
  if (!Number.isSafeInteger(input.roundCount.count) || input.roundCount.count < 0) {
    return refusal('round-count-invalid');
  }
  if (canonical !== (input.roundCount.basis === 'canonical-finding')) {
    return refusal('round-count-invalid');
  }
  if (!Number.isFinite(input.maxRoundsPerPin) || input.maxRoundsPerPin < 0) {
    return refusal('round-count-invalid');
  }
  if (input.roundCount.count >= input.maxRoundsPerPin) return refusal('round-ceiling');

  const round = input.roundCount.count + 1;
  const job = proposedPreparedJob({
    oldJob,
    oldJobId: input.oldJobId,
    sourceSha: input.sourceSha,
    evidence,
    findingSha256,
    round,
    run: identity.run,
    jobId: identity.jobId,
    ...(input.preserveWorktree === true ? { preserveWorktree: true } : {}),
  });
  const record = proposedRunRecord({
    jobId: identity.jobId,
    sourceSha: input.sourceSha,
    round,
    originJobId: input.oldJobId,
    revalidationSha256: identity.revalidationSha256,
    ...(canonicalId === undefined ? {} : { canonicalFindingId: canonicalId }),
  });
  return {
    ok: true,
    value: {
      status: 'binding-verified',
      idempotent: false,
      jobId: identity.jobId,
      run: identity.run,
      findingSha256,
      revalidationSha256: identity.revalidationSha256,
      binding,
      job,
      record,
      pendingGates: gates,
    },
  };
}

/**
 * Re-observe the prepared source through the injected git seam. This is the
 * only route by which a caller may claim CURRENT state; preparation-time
 * facts never prove it. `blobOid: null` means the blob was not observed.
 */
export async function reobservePreparedSource(
  input: { readonly sourceSha: string; readonly sourceBlobSha: string; readonly path: string },
  git: RepairGit,
): Promise<RepairSourceReobservation> {
  const normalized = sourcePath(new JsonObject([['path', input.path]]));
  if (!normalized.ok) return { observed: false };
  let currentTip: string;
  try {
    currentTip = await git.currentTip();
  } catch {
    return { observed: false };
  }
  if (!checkSha(input.sourceSha)) return tipOnlyObservation(currentTip, input.sourceSha);
  let blobOid: string | null = null;
  try {
    blobOid = await git.blobOid(input.sourceSha, normalized.path);
  } catch {
    blobOid = null;
  }
  return {
    observed: true,
    currentTip,
    blobOid,
    atTip: currentTip === input.sourceSha,
    blobMatches: blobOid !== null && blobOid === input.sourceBlobSha,
  };
}

async function observeTipOnly(
  sourceSha: string,
  git: RepairGit,
): Promise<RepairSourceReobservation> {
  try {
    const currentTip = await git.currentTip();
    return tipOnlyObservation(currentTip, sourceSha);
  } catch {
    return { observed: false };
  }
}

/**
 * Typed-harvest reobservation: the path is validated, then BOTH reads are
 * mandatory. A failed read refuses; it never reports a verified binding with
 * an unobserved blob.
 */
async function reobservePreparedSourceStrict(
  input: { readonly sourceSha: string; readonly sourceBlobSha: string; readonly path: string },
  git: RepairGit,
): Promise<
  | { readonly ok: true; readonly source: Extract<RepairSourceReobservation, { observed: true }> }
  | { readonly ok: false; readonly refusal: RepairRefusal }
> {
  const normalized = sourcePath(new JsonObject([['path', input.path]]));
  if (!normalized.ok) return { ok: false, refusal: normalized.refusal };
  if (!checkSha(input.sourceSha)) return { ok: false, refusal: 'source-sha-invalid' };
  let currentTip: string;
  try {
    currentTip = await git.currentTip();
  } catch {
    return { ok: false, refusal: 'source-not-current-tip' };
  }
  let blobOid: string;
  try {
    blobOid = await git.blobOid(input.sourceSha, normalized.path);
  } catch {
    return { ok: false, refusal: 'source-blob-unreadable' };
  }
  return {
    ok: true,
    source: {
      observed: true,
      currentTip,
      blobOid,
      atTip: currentTip === input.sourceSha,
      blobMatches: blobOid === input.sourceBlobSha,
    },
  };
}

/**
 * The prospective harvest check. Artifact binding is verified against the
 * prepared data, then the current tip/blob is re-observed. The observation is
 * reported, never used to rewrite history or to claim a preparation-time fact
 * is still current.
 */
export async function verifyPreparedHarvest(
  input: VerifyPreparedHarvestInput,
  git: RepairGit,
): Promise<VerifyPreparedHarvestResult> {
  if (input.format === 'legacy-python') {
    const prepared = parseObject(input.preparedJson);
    if (prepared === undefined) return refusal('old-job-unreadable');
    const artifact = parseValue(input.artifactJson);
    if (artifact === undefined) return refusal('result-not-object');
    const bindingRefusal = legacyPythonResultRefusal({
      prepared,
      result: artifact,
      allowMissingPreparedSourceSha: input.allowMissingPreparedSourceSha,
    });
    if (bindingRefusal !== undefined) return refusal(bindingRefusal);

    const sourceSha = prepared.get('source_sha');
    if (typeof sourceSha !== 'string' || !checkSha(sourceSha)) {
      return { ok: true, value: { binding: 'verified', source: { observed: false } } };
    }
    const path = sourcePath(prepared.get('finding') ?? null);
    if (!path.ok) return refusal(path.refusal);
    const revalidation = prepared.get('revalidation');
    const sourceBlobSha =
      revalidation instanceof JsonObject ? revalidation.get('source_blob_sha') : undefined;
    if (typeof sourceBlobSha !== 'string') {
      return {
        ok: true,
        value: { binding: 'verified', source: await observeTipOnly(sourceSha, git) },
      };
    }
    return {
      ok: true,
      value: {
        binding: 'verified',
        source: await reobservePreparedSource({ sourceSha, sourceBlobSha, path: path.path }, git),
      },
    };
  }

  const artifact = parseValue(input.artifactJson);
  if (artifact === undefined) return refusal('result-not-object');
  const bindingRefusal = typedFixFindingResultRefusal({
    prepared: input.prepared,
    artifact,
  });
  if (bindingRefusal !== undefined) return refusal(bindingRefusal);
  const source = await reobservePreparedSourceStrict(
    {
      sourceSha: input.prepared.sourceSha,
      sourceBlobSha: input.prepared.sourceBlobSha,
      path: input.path,
    },
    git,
  );
  if (!source.ok) return refusal(source.refusal);
  return {
    ok: true,
    value: {
      binding: 'verified',
      source: source.source,
    },
  };
}

/** Re-exported for callers that gate the op's UTF-16 instruction bound. */
export { dispatchInstructionsRefusal } from '../../../policy/crq/repairBinding.js';
