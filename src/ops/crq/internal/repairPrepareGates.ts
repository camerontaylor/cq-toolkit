/**
 * Read-gate orchestration for C1 repair preparation.
 *
 * Lifecycle position: after the caller has loaded the historical job, queue
 * item, revalidation evidence and the current pin; before any write, enqueue,
 * handoff, dispatch or harvest. This module performs the remaining READ half
 * of the Python oracle and returns the exact mutations as data. It never
 * executes them.
 *
 * Effects are injected: git reads, triage-row/inbox/prepared-job reads and the
 * diff secret scanner. No subprocess, filesystem, clock or environment seam is
 * imported here.
 */
import {
  checkCanonicalFindingId,
  dispatchInstructionsRefusal,
  sourcePath,
  validateInstructions,
  type RepairRefusal,
  type RepairRoundCount,
} from '../../../policy/crq/repairBinding.js';
import { JsonObject, parseJsonValue } from '../../../policy/crq/jsonValue.js';
import { atomicJsonText, sha256Hex } from '../../../policy/crq/pythonJson.js';
import {
  applyPreparedQueue,
  canonicalHandoffRefusal,
  deriveRoundCount,
  fixInstructionsScanPatch,
  fullSourceScanPatch,
  staleMarkingFor,
} from '../../../policy/crq/repairGates.js';
import {
  verifyPreparedRepair,
  type ProposedRepairPreparation,
  type RepairGit,
} from './repairPrepare.js';

/** The two immutable git facts plus the pinned full-source read. */
export interface RepairGateGit extends RepairGit {
  /** Exact text of `<sourceSha>:<path>` (`git show`), or a rejection. */
  showFile(sourceSha: string, path: string): Promise<string>;
}

/** Every external read the read-gate orchestrator performs. */
export interface RepairPreparationState {
  /** `state/repair/inbox/<jobId>.json`, or undefined when absent. */
  readInboxJob(jobId: string): Promise<string | undefined>;
  /** `state/triage/<findingId>.json`, or undefined when absent. */
  readTriageRow(findingId: string): Promise<string | undefined>;
  /** `state/repair/inbox/<preparedJobId>.json`, or undefined when absent. */
  readPreparedJob(jobId: string): Promise<string | undefined>;
}

/** One diff's scanner result, before any redaction. */
export interface RepairScanResult {
  /** Typed boolean; never inferred from a truthy report. */
  readonly clean: boolean;
  readonly report: RepairScanReport;
}

/** Counts only; never matched content, secret text or remote state. */
export interface RepairScanReport {
  readonly denylistRules: number;
  readonly denylistHits: number;
  readonly gitleaks: 'clean' | 'hits' | 'not-run' | 'error';
  readonly gitleaksHits: number;
}

/** Injected scanner seam; the adapter owns the patch parse and local scan. */
export interface RepairScan {
  scanDiff(input: {
    readonly patch: string;
    readonly name: string;
    readonly base: string | null;
    readonly head: string;
  }): Promise<RepairScanResult>;
}

/** Redacted persisted/returned scan evidence. */
export interface RepairScanEvidence {
  readonly kind: 'full-source' | 'fix-instructions';
  readonly name: string;
  readonly patchSha256: string;
  /** Python `len(patch)` in code points. */
  readonly patchLength: number;
  readonly clean: boolean;
  readonly verdict: 'clean' | 'dirty' | 'skipped' | 'error';
  readonly report: RepairScanReport;
}

/** A mutation the caller still has to execute. Never executed here. */
export type RepairMutation =
  | { readonly kind: 'write-job'; readonly jobId: string; readonly bytes: string }
  | {
      readonly kind: 'handoff';
      readonly findingId: string;
      readonly previousTask: string;
      readonly preparedJobId: string;
    }
  | { readonly kind: 'write-queue'; readonly bytes: string };

/** Every effect the caller still owns after a successful read-gate pass. */
export type RemainingPreparationGate =
  | 'state-write-execution'
  | 'canonical-handoff-execution'
  | 'dispatch-request-construction'
  | 'enqueue-dispatch'
  | 'harvest-disposition';

export interface RepairHandoffPlan {
  readonly findingId: string;
  readonly previousTask: string;
  readonly preparedJobId: string;
  /** True when the row already names the prepared job; no mutation is emitted. */
  readonly alreadyHandedOff: boolean;
}

export interface VerifiedRepairPreparation {
  readonly status: 'read-gates-verified';
  readonly idempotent: boolean;
  readonly proposal: ProposedRepairPreparation;
  /** Present only on the idempotent canonical path. */
  readonly preparedJob?: JsonObject;
  /** Present only on the new path. */
  readonly roundCount?: RepairRoundCount;
  readonly scans: readonly RepairScanEvidence[];
  /** Present only when the historical job carries a canonical finding id. */
  readonly handoff?: RepairHandoffPlan;
  /** Present only on the new path; `bytes` is the exact queue file content. */
  readonly queue?: {
    readonly bytes: string;
    readonly stale?: { readonly state: 'stale'; readonly error: string };
  };
  readonly mutations: readonly RepairMutation[];
  readonly remainingGates: readonly RemainingPreparationGate[];
}

export interface PrepareRepairGatesInput {
  readonly oldJobJson: string;
  readonly oldJobId: string;
  readonly queueJson: string;
  readonly sourceSha: string;
  readonly evidenceJson: string;
  readonly maxRoundsPerPin: number;
  readonly preserveWorktree?: boolean;
}

export interface RepairGateEffects {
  readonly git: RepairGateGit;
  readonly state: RepairPreparationState;
  readonly scan: RepairScan;
}

export type PrepareRepairGatesResult =
  | { readonly ok: true; readonly value: VerifiedRepairPreparation }
  | { readonly ok: false; readonly refusal: RepairRefusal };

const REMAINING_GATES: readonly RemainingPreparationGate[] = [
  'state-write-execution',
  'canonical-handoff-execution',
  'dispatch-request-construction',
  'enqueue-dispatch',
  'harvest-disposition',
];

function refusal(value: RepairRefusal): { readonly ok: false; readonly refusal: RepairRefusal } {
  return { ok: false, refusal: value };
}

function parseObject(text: string): JsonObject | undefined {
  try {
    const value = parseJsonValue(text);
    return value instanceof JsonObject ? value : undefined;
  } catch {
    return undefined;
  }
}

function isScanReport(value: unknown): value is RepairScanReport {
  if (value === null || typeof value !== 'object') return false;
  const report = value as Record<string, unknown>;
  const count = (field: unknown): field is number =>
    typeof field === 'number' && Number.isSafeInteger(field) && field >= 0;
  return (
    count(report.denylistRules) &&
    count(report.denylistHits) &&
    count(report.gitleaksHits) &&
    (report.gitleaks === 'clean' ||
      report.gitleaks === 'hits' ||
      report.gitleaks === 'not-run' ||
      report.gitleaks === 'error')
  );
}

/** Validate the seam's typed result; never trust a truthy object. */
function isScanResult(value: unknown): value is RepairScanResult {
  if (value === null || typeof value !== 'object') return false;
  const result = value as Record<string, unknown>;
  return typeof result.clean === 'boolean' && isScanReport(result.report);
}

/** Classify a validated scanner result without ever treating not-run as clean. */
function scanVerdict(result: RepairScanResult): RepairScanEvidence['verdict'] | 'inconsistent' {
  const { report } = result;
  const hasHits = report.denylistHits > 0 || report.gitleaks === 'hits';
  if (report.gitleaks === 'error') return 'error';
  if (result.clean === hasHits) return 'inconsistent';
  if (result.clean && report.gitleaks === 'not-run') return 'skipped';
  return result.clean ? 'clean' : 'dirty';
}

async function scanPatch(
  scan: RepairScan,
  input: {
    readonly kind: RepairScanEvidence['kind'];
    readonly name: string;
    readonly patch: string;
    readonly base: string | null;
    readonly head: string;
  },
): Promise<
  | { readonly ok: true; readonly value: RepairScanEvidence }
  | { readonly ok: false; readonly refusal: RepairRefusal }
> {
  let result: RepairScanResult;
  try {
    const raw: unknown = await scan.scanDiff({
      patch: input.patch,
      name: input.name,
      base: input.base,
      head: input.head,
    });
    if (!isScanResult(raw)) return refusal('secret-scan-unavailable');
    result = raw;
  } catch {
    return refusal('secret-scan-unavailable');
  }
  const verdict = scanVerdict(result);
  if (verdict === 'error' || verdict === 'inconsistent') {
    return refusal('secret-scan-unavailable');
  }
  return {
    ok: true,
    value: {
      kind: input.kind,
      name: input.name,
      patchSha256: sha256Hex(Buffer.from(input.patch, 'utf8')),
      patchLength: [...input.patch].length,
      clean: result.clean,
      verdict,
      report: {
        denylistRules: result.report.denylistRules,
        denylistHits: result.report.denylistHits,
        gitleaks: result.report.gitleaks,
        gitleaksHits: result.report.gitleaksHits,
      },
    },
  };
}

/**
 * Perform the remaining read gates and return the exact mutations as data.
 * Refusals carry no raw source, instruction, patch or secret text.
 */
export async function prepareRepairGates(
  input: PrepareRepairGatesInput,
  effects: RepairGateEffects,
): Promise<PrepareRepairGatesResult> {
  const oldJob = parseObject(input.oldJobJson);
  if (oldJob === undefined) return refusal('old-job-unreadable');
  const queue = parseObject(input.queueJson);
  if (queue === undefined) return refusal('queue-item-unreadable');
  const evidence = parseObject(input.evidenceJson);
  if (evidence === undefined) return refusal('evidence-unreadable');

  const oldItemId = oldJob.get('item');
  const items = queue.get('items');
  const item =
    typeof oldItemId === 'string' && Array.isArray(items)
      ? items.find(
          (entry): entry is JsonObject =>
            entry instanceof JsonObject && entry.get('id') === oldItemId,
        )
      : undefined;
  const itemText = item === undefined ? '{}' : atomicJsonText(item);

  const canonicalValue = oldJob.get('canonical_finding_id');
  const canonicalId = checkCanonicalFindingId(canonicalValue) ? canonicalValue : undefined;
  let roundCount: RepairRoundCount | undefined;
  const roundCountSource = async (): Promise<
    | { readonly ok: true; readonly value: RepairRoundCount }
    | { readonly ok: false; readonly refusal: RepairRefusal }
  > => {
    const result = await deriveRoundCount({
      queue,
      ...(canonicalId === undefined ? {} : { canonicalFindingId: canonicalId }),
      pin: input.sourceSha,
      item: item ?? new JsonObject([]),
      readInboxJob: (jobId) => effects.state.readInboxJob(jobId),
    });
    if (result.ok) roundCount = result.value;
    return result;
  };

  const verified = await verifyPreparedRepair(
    {
      oldJobJson: input.oldJobJson,
      oldJobId: input.oldJobId,
      queueItemJson: itemText,
      sourceSha: input.sourceSha,
      evidenceJson: input.evidenceJson,
      roundCount: roundCountSource,
      maxRoundsPerPin: input.maxRoundsPerPin,
      ...(input.preserveWorktree === true ? { preserveWorktree: true } : {}),
    },
    effects.git,
  );
  if (!verified.ok) return verified;

  if (verified.value.idempotent) {
    if (canonicalId === undefined) {
      return {
        ok: true,
        value: {
          status: 'read-gates-verified',
          idempotent: true,
          proposal: verified.value,
          scans: [],
          mutations: [],
          remainingGates: REMAINING_GATES,
        },
      };
    }
    const preparedJobText = await effects.state.readPreparedJob(verified.value.jobId);
    if (preparedJobText === undefined) return refusal('prepared-job-unreadable');
    const preparedJob = parseObject(preparedJobText);
    if (preparedJob === undefined) return refusal('prepared-job-unreadable');
    const rowText = await effects.state.readTriageRow(canonicalId);
    const handoff = canonicalHandoffRefusal({
      rowText,
      job: preparedJob,
      findingId: canonicalId,
      previousTask: input.oldJobId,
      preparedJobId: verified.value.jobId,
    });
    if (!handoff.ok) return handoff;
    const plan: RepairHandoffPlan = {
      findingId: canonicalId,
      previousTask: input.oldJobId,
      preparedJobId: verified.value.jobId,
      alreadyHandedOff: handoff.alreadyHandedOff,
    };
    const mutations: RepairMutation[] = handoff.alreadyHandedOff
      ? []
      : [
          {
            kind: 'handoff',
            findingId: canonicalId,
            previousTask: input.oldJobId,
            preparedJobId: verified.value.jobId,
          },
        ];
    return {
      ok: true,
      value: {
        status: 'read-gates-verified',
        idempotent: true,
        proposal: verified.value,
        preparedJob,
        scans: [],
        handoff: plan,
        mutations,
        remainingGates: REMAINING_GATES,
      },
    };
  }

  const proposal = verified.value;
  if (proposal.job === undefined) return refusal('old-job-unreadable');
  const path = sourcePath(proposal.job.get('finding') ?? null);
  if (!path.ok) return path;
  let sourceText: string;
  try {
    sourceText = await effects.git.showFile(input.sourceSha, path.path);
  } catch {
    return refusal('source-read-unavailable');
  }
  if (typeof sourceText !== 'string') return refusal('source-read-unavailable');

  const sourceScan = await scanPatch(effects.scan, {
    kind: 'full-source',
    name: `${proposal.run}-secret-scan.json`,
    patch: fullSourceScanPatch(path.path, sourceText),
    base: null,
    head: input.sourceSha,
  });
  if (!sourceScan.ok) return sourceScan;
  if (sourceScan.value.verdict === 'dirty') return refusal('source-secret-scan-failed');
  const scans: RepairScanEvidence[] = [sourceScan.value];

  const instructions = validateInstructions(evidence);
  if (!instructions.ok) return refusal(instructions.refusal);
  if (instructions.instructions !== undefined) {
    const instructionsScan = await scanPatch(effects.scan, {
      kind: 'fix-instructions',
      name: `${proposal.run}-instructions-scan.json`,
      patch: fixInstructionsScanPatch(instructions.instructions),
      base: null,
      head: input.sourceSha,
    });
    if (!instructionsScan.ok) return instructionsScan;
    if (instructionsScan.value.verdict === 'dirty') {
      return refusal('instructions-secret-scan-failed');
    }
    scans.push(instructionsScan.value);
    const dispatchRefusal = dispatchInstructionsRefusal(instructions.instructions);
    if (dispatchRefusal !== undefined) return refusal(dispatchRefusal);
  }

  let handoff: RepairHandoffPlan | undefined;
  if (canonicalId !== undefined) {
    const rowText = await effects.state.readTriageRow(canonicalId);
    const result = canonicalHandoffRefusal({
      rowText,
      job: proposal.job,
      findingId: canonicalId,
      previousTask: input.oldJobId,
      preparedJobId: proposal.jobId,
    });
    if (!result.ok) return result;
    handoff = {
      findingId: canonicalId,
      previousTask: input.oldJobId,
      preparedJobId: proposal.jobId,
      alreadyHandedOff: result.alreadyHandedOff,
    };
  }

  const oldRun = oldJob.get('run');
  if (typeof oldRun !== 'string') return refusal('old-job-unreadable');
  const runs = item?.get('repair_runs');
  const oldRecord = runs instanceof JsonObject ? runs.get(oldRun) : undefined;
  if (!(oldRecord instanceof JsonObject)) return refusal('old-job-not-tick-owned');
  const stale = staleMarkingFor({
    oldJob,
    oldRecord,
    oldJobId: input.oldJobId,
    oldRun,
    preparedJobId: proposal.jobId,
    preserveWorktree: input.preserveWorktree === true,
  });
  if (proposal.record === undefined) return refusal('old-job-unreadable');
  if (typeof oldItemId !== 'string') return refusal('old-job-item-missing');
  const applied = applyPreparedQueue({
    queue,
    itemId: oldItemId,
    oldRun,
    run: proposal.run,
    record: proposal.record,
    stale,
  });
  if (!applied.ok) return applied;
  const queueBytes = atomicJsonText(applied.queue);
  const jobBytes = atomicJsonText(proposal.job);
  const mutations: RepairMutation[] = [
    { kind: 'write-job', jobId: proposal.jobId, bytes: jobBytes },
  ];
  if (canonicalId !== undefined && handoff !== undefined && !handoff.alreadyHandedOff) {
    mutations.push({
      kind: 'handoff',
      findingId: canonicalId,
      previousTask: input.oldJobId,
      preparedJobId: proposal.jobId,
    });
  }
  mutations.push({ kind: 'write-queue', bytes: queueBytes });
  return {
    ok: true,
    value: {
      status: 'read-gates-verified',
      idempotent: false,
      proposal,
      ...(roundCount === undefined ? {} : { roundCount }),
      scans,
      ...(handoff === undefined ? {} : { handoff }),
      queue: {
        bytes: queueBytes,
        ...(stale === undefined ? {} : { stale: { state: stale.state, error: stale.error } }),
      },
      mutations,
      remainingGates: REMAINING_GATES,
    },
  };
}
