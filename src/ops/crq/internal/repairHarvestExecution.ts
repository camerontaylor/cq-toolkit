/**
 * Injected execution seam for the crq repair harvest outcome.
 *
 * This is effect orchestration only: it performs Python's
 * `Inbox.recover`-then-`repair_outcome` order through the existing
 * `FindingInbox` lock/read/write seam and the publication seam, while every
 * disposition decision comes from `src/policy/crq/repairHarvest.ts` or from a
 * typed artifact field. It never reads reason prose and never re-observes the
 * source: the caller hands over the merged bridge's `RepairArtifactRead`,
 * which already carries the exact run's binding and harvest observation.
 *
 * Boundary: a malformed artifact never reaches this seam. `harvestRepairArtifact`
 * refuses it before a read exists, while Python's `harvest` persists queue
 * identity (`save_queue`) and only then records its terminal FAILED outcome.
 * That ordering belongs to the future caller/queue adapter, so this slice does
 * not invent the ledger half without the queue half.
 *
 * No real state root, lock file, outbox or model is bound here; the future
 * adapter supplies `RepairHarvestEffects`. No queue, ledger, status, schema or
 * kernel shape changes.
 */
import { JsonNumber, JsonObject, type JsonValue } from '../../../policy/crq/jsonValue.js';
import { ledgerCanonicalBytes, ledgerLoads } from '../../../policy/crq/ledger.js';
import {
  planRepairHarvest,
  type RepairHarvestAction,
  type RepairHarvestEvidence,
  type RepairHarvestFailureClass,
  type RepairHarvestRefusal,
  type RepairHarvestVerdict,
} from '../../../policy/crq/repairHarvest.js';
import type { RepairArtifactRead } from './repairDispatch.js';
import {
  FindingInbox,
  type FindingInboxFiles,
  type FindingPublication,
  type RecoverEvidence,
} from '../../review/internal/crq/findingInbox.js';

/** The same seams the finding inbox already uses; no new adapter surface. */
export interface RepairHarvestEffects {
  readonly files: FindingInboxFiles;
  readonly publication: FindingPublication;
}

export type RepairHarvestExecutionRefusal =
  | RepairHarvestRefusal
  | 'finding-row-missing'
  | 'finding-row-unreadable'
  | 'harvest-invocation-refused'
  | 'harvest-verdict-unrecognised'
  | 'fixed-binding-unverified';

export type RepairHarvestExecutionResult =
  | {
      readonly kind: 'written';
      readonly action: RepairHarvestAction;
      readonly eventId: JsonValue;
      readonly recovery: RecoverEvidence;
    }
  | {
      readonly kind: 'already-recorded';
      readonly action: RepairHarvestAction;
      readonly recovery: RecoverEvidence;
    }
  | {
      readonly kind: 'none';
      readonly reason: 'preserved-newer-generation' | 'fixed-requires-merge';
      /** Absent for a pre-merge FIXED artifact: the inbox is not touched. */
      readonly recovery?: RecoverEvidence;
    }
  | { readonly kind: 'refused'; readonly refusal: RepairHarvestExecutionRefusal };

type VerdictMapping =
  | { readonly kind: 'verdict'; readonly verdict: RepairHarvestVerdict; readonly reason: string }
  | { readonly kind: 'none'; readonly reason: 'harvest-invocation-refused' }
  | { readonly kind: 'refused'; readonly refusal: RepairHarvestExecutionRefusal };

function readEvidence(value: JsonValue | undefined): RepairHarvestEvidence[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const evidence: RepairHarvestEvidence[] = [];
  for (const entry of value) {
    if (!(entry instanceof JsonObject)) return undefined;
    const path = entry.get('path');
    const line = entry.get('line');
    if (typeof path !== 'string' || !(line instanceof JsonNumber) || line.integer === null) {
      return undefined;
    }
    const value = Number(line.integer);
    if (!Number.isSafeInteger(value)) return undefined;
    evidence.push({ path, line: value });
  }
  return evidence;
}

function readCommits(value: JsonValue | undefined): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const commits: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') return undefined;
    commits.push(entry);
  }
  return commits;
}

function readString(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Map one validated artifact to the typed harvest verdict. The ok value is
 * the shared fix contract's typed fields, not `review.fixItem`'s folded
 * reason: only `fixed` and evidence-bearing `unchanged_with_reason` are
 * outcomes; `needs_human` is the sole owner decision; `no_outcome`, the
 * legacy no-change form and evidence-less `unchanged_with_reason` are FAILED
 * with the exhausted class (plan D6 item 2).
 */
export function repairHarvestVerdictOf(read: RepairArtifactRead): VerdictMapping {
  const harvest = read.harvest;
  if (harvest.status === 'guard-refused') {
    return { kind: 'none', reason: 'harvest-invocation-refused' };
  }
  if (harvest.status === 'ok') {
    if (!(harvest.value instanceof JsonObject)) {
      return { kind: 'refused', refusal: 'harvest-verdict-unrecognised' };
    }
    const summary = readString(harvest.value.get('summary'));
    const disposition = harvest.value.get('disposition');
    const commits = readCommits(harvest.value.get('commits'));
    const evidence = readEvidence(harvest.value.get('evidence'));
    if (summary === undefined || commits === undefined || evidence === undefined) {
      return { kind: 'refused', refusal: 'harvest-verdict-unrecognised' };
    }
    if (typeof disposition !== 'string' && disposition !== null) {
      return { kind: 'refused', refusal: 'harvest-verdict-unrecognised' };
    }
    switch (disposition) {
      case 'fixed':
        return { kind: 'verdict', verdict: { verdict: 'fixed', commits }, reason: summary };
      case 'unchanged_with_reason': {
        const evidenceMissing = harvest.value.get('evidenceMissing');
        if (evidenceMissing === false && evidence.length > 0) {
          return { kind: 'verdict', verdict: { verdict: 'not-fixed', evidence }, reason: summary };
        }
        return {
          kind: 'verdict',
          verdict: { verdict: 'failed', failureClass: 'exhausted', reason: summary },
          reason: summary,
        };
      }
      case 'needs_human':
        return {
          kind: 'verdict',
          verdict: { verdict: 'failed', failureClass: 'owner-decision', reason: summary },
          reason: summary,
        };
      case 'no_outcome':
      case null:
        return {
          kind: 'verdict',
          verdict: { verdict: 'failed', failureClass: 'exhausted', reason: summary },
          reason: summary,
        };
      default:
        return { kind: 'refused', refusal: 'harvest-verdict-unrecognised' };
    }
  }
  // Non-ok artifacts carry a typed report and never an owner decision. A
  // pre-dispatch gap is a dispatch failure (plan D6 item 5).
  const failureClass: RepairHarvestFailureClass = harvest.failureClass;
  const reason =
    harvest.status === 'failed'
      ? harvest.error
      : harvest.status === 'needs-human'
        ? harvest.reason
        : harvest.status === 'budget-exhausted'
          ? 'repair budget exhausted'
          : harvest.detail;
  return { kind: 'verdict', verdict: { verdict: 'failed', failureClass, reason }, reason };
}

/**
 * Recover the retained finding chain, then plan and (when due) spool plus
 * write one canonical outcome under the existing findings lock.
 */
export async function executeRepairHarvest(
  input: {
    readonly findingId: string;
    /** The merged bridge's exact-run artifact read for this job. */
    readonly read: RepairArtifactRead;
    readonly at: string;
    readonly maxFindingRetries: number;
    /** The prepared job's pinned base, from the same durable job. */
    readonly repairBase?: string;
    readonly fixPr?: number | null;
    /** Present only when a merge actually landed; pre-merge FIXED is deferred. */
    readonly mergedCommit?: string;
  },
  effects: RepairHarvestEffects,
): Promise<RepairHarvestExecutionResult> {
  const mapped = repairHarvestVerdictOf(input.read);
  if (mapped.kind === 'none') return { kind: 'refused', refusal: mapped.reason };
  if (mapped.kind === 'refused') return mapped;
  // `mark_finding_outcome` returns before touching the inbox for an unmerged
  // FIXED artifact; do not run recovery or read the row for it either.
  if (mapped.verdict.verdict === 'fixed' && input.mergedCommit === undefined) {
    return { kind: 'none', reason: 'fixed-requires-merge' };
  }
  if (mapped.verdict.verdict === 'fixed' && input.read.binding !== 'verified') {
    return { kind: 'refused', refusal: 'fixed-binding-unverified' };
  }

  const retained = await effects.publication.retained();
  const inbox = new FindingInbox(effects.files);
  // Python repairs rows from acknowledged/retained events before it reads the
  // row for a new outcome; a crashed caller therefore cannot double-write.
  const recovery = await inbox.recover(retained);

  let outcome: RepairHarvestExecutionResult | undefined;
  await effects.files.withLock(async () => {
    const bytes = await effects.files.readTriage(input.findingId);
    if (bytes === null) {
      outcome = { kind: 'refused', refusal: 'finding-row-missing' };
      return;
    }
    let row: JsonValue;
    try {
      row = ledgerLoads(bytes);
    } catch {
      outcome = { kind: 'refused', refusal: 'finding-row-unreadable' };
      return;
    }
    if (!(row instanceof JsonObject)) {
      outcome = { kind: 'refused', refusal: 'finding-row-unreadable' };
      return;
    }
    const plan = planRepairHarvest({
      row,
      findingId: input.findingId,
      job: input.read.selectedJobId,
      verdict: mapped.verdict,
      reason: mapped.reason,
      at: input.at,
      maxFindingRetries: input.maxFindingRetries,
      retained,
      ...(input.repairBase === undefined ? {} : { repairBase: input.repairBase }),
      ...(input.fixPr === undefined ? {} : { fixPr: input.fixPr }),
      ...(input.mergedCommit === undefined ? {} : { mergedCommit: input.mergedCommit }),
    });
    switch (plan.kind) {
      case 'write': {
        const eventId = await effects.publication.spool(plan.event);
        await effects.files.writeTriage(input.findingId, ledgerCanonicalBytes(plan.row));
        outcome = { kind: 'written', action: plan.action, eventId, recovery };
        return;
      }
      case 'already-recorded':
        outcome = { kind: 'already-recorded', action: plan.action, recovery };
        return;
      case 'none':
        outcome = { kind: 'none', reason: plan.reason, recovery };
        return;
      case 'refused':
        outcome = plan;
        return;
    }
  });
  return outcome ?? { kind: 'refused', refusal: 'finding-row-missing' };
}
