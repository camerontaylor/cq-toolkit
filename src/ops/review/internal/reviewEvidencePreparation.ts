// Pure evidence preparation and repair-state composition for the R3S additive
// evidence schema (`FindingEvidenceV1` in ../findings.ts), card R3W of
// plans/upcoming-20261027/reviewer-lane.md.
//
// R3S's `validateFindingEvidence` answers WHAT a payload proves against the
// pinned comparison; this module answers WHAT TO DO with a producer's
// submission: validate it, compose at most two bounded repair turns, and keep
// every raw candidate with its typed verdict whatever the outcome. It is
// pure: no git, filesystem, network, clock or driver access, so fixture tests
// exercise every outcome deterministically and the session/planner wiring
// (a later increment, after the writer handoff) can call it inside any
// budget without hidden state.
//
// Integrity, not truth, and never a clean claim: an `invalid` outcome here
// retains every raw candidate and reason so callers can persist survivors and
// block sources; nothing in this module can turn a bad candidate into a
// passing record or silently relocate a citation to a different path, line or
// repeated-quote occurrence.

import type { FindingEvidenceV1 } from '../findings.js';
import {
  validateFindingEvidence,
  type AnchorBlobInput,
  type AnchorInvalidReason,
  type AnchorValidationContext,
} from './findingAnchors.js';

/** Caller-supplied pins; identical shape and semantics to the R3S validator's. */
export type EvidencePreparationContext = AnchorValidationContext;

/**
 * The shared budget bounds repairs: the card fixes the maximum at TWO repair
 * opportunities per finding (`maxRepairs` defaults to it and cannot exceed
 * it), each consuming real session tokens from the caller's existing budget.
 */
export const MAX_EVIDENCE_REPAIRS = 2;

/** One granted repair turn: the engine's why plus the producer's raw answer. */
export interface EvidenceRepairTurn {
  /** Typed reasons of the candidate this repair was requested after. */
  requestedAfter: readonly AnchorInvalidReason[];
  /** The re-submitted payload, stored verbatim (never normalized). */
  evidence: FindingEvidenceV1;
  /** The repair's own verdict reasons; empty when it validated. */
  reasons: readonly AnchorInvalidReason[];
}

/** One evaluated candidate with its verdict, in submission order. */
export interface EvidenceCandidateRecord {
  evidence: FindingEvidenceV1;
  reasons: readonly AnchorInvalidReason[];
}

export type EvidencePreparationStep =
  | {
      status: 'valid';
      /** The winning payload, exactly as submitted. */
      evidence: FindingEvidenceV1;
      /** Evaluated candidates in order; the last is the winner. */
      candidates: readonly EvidenceCandidateRecord[];
      /** Granted repair turns; empty when the original validated. */
      repairs: readonly EvidenceRepairTurn[];
      /** Submitted repair payloads left unevaluated after the winner. */
      ignoredRepairSubmissions: number;
    }
  | {
      status: 'invalid';
      /** The final evaluated candidate's reasons, in validator order. */
      reasons: readonly AnchorInvalidReason[];
      /** Every evaluated raw candidate, first submission first. */
      candidates: readonly EvidenceCandidateRecord[];
      /** Full granted-repair history, original's trigger first. */
      repairs: readonly EvidenceRepairTurn[];
      /**
       * 'exhausted': all repair capacity was used and the outcome stayed invalid.
       * 'partial': at least one, but fewer than the allowed repairs were used.
       * 'unused': no repair was evaluated.
       */
      repairOutcome: 'exhausted' | 'partial' | 'unused';
      /** Submitted repair payloads beyond the cap: counted, never evaluated. */
      ignoredRepairSubmissions: number;
    };

/**
 * Prepare one producer evidence payload against the pinned comparison:
 * validate the original, then each bounded repair in order, stopping at the
 * first valid verdict. Inputs are never mutated; every evaluated candidate is
 * retained verbatim with its typed reasons. Submissions beyond
 * `maxRepairs` (at most `MAX_EVIDENCE_REPAIRS`) are ignored and counted, so a
 * producer cannot extend the bound by submitting more. A pre-persisted
 * `validation` marker on any candidate never influences its verdict: verdicts
 * describe anchors, not history (the R3S validator's own rule, inherited).
 */
export function prepareFindingEvidence(input: {
  candidate: FindingEvidenceV1;
  context: EvidencePreparationContext;
  /** Repair payloads in order; at most `maxRepairs` are evaluated. */
  repairs?: readonly FindingEvidenceV1[];
  /** Bounded repair allowance; defaults to the card maximum of two. */
  maxRepairs?: number;
}): EvidencePreparationStep {
  const maxRepairs = input.maxRepairs ?? MAX_EVIDENCE_REPAIRS;
  if (!Number.isInteger(maxRepairs) || maxRepairs < 0 || maxRepairs > MAX_EVIDENCE_REPAIRS)
    throw new Error(
      `evidence preparation: maxRepairs must be an integer between 0 and ` +
        `${String(MAX_EVIDENCE_REPAIRS)} (got ${String(maxRepairs)})`,
    );
  const candidates: EvidenceCandidateRecord[] = [];
  const repairs: EvidenceRepairTurn[] = [];
  const offered = input.repairs ?? [];
  const evaluated = offered.slice(0, maxRepairs);
  const verdictOf = (evidence: FindingEvidenceV1): readonly AnchorInvalidReason[] => {
    const verdict = validateFindingEvidence(evidence, input.context);
    return verdict.status === 'valid' ? [] : verdict.reasons;
  };
  let reasons = verdictOf(input.candidate);
  candidates.push({ evidence: input.candidate, reasons });
  if (reasons.length === 0)
    return {
      status: 'valid',
      evidence: input.candidate,
      candidates,
      repairs,
      ignoredRepairSubmissions: offered.length,
    };
  for (const evidence of evaluated) {
    const turnReasons = verdictOf(evidence);
    repairs.push({ requestedAfter: reasons, evidence, reasons: turnReasons });
    candidates.push({ evidence, reasons: turnReasons });
    if (turnReasons.length === 0)
      return {
        status: 'valid',
        evidence,
        candidates,
        repairs,
        ignoredRepairSubmissions: offered.length - repairs.length,
      };
    // The next repair request (if any) must cite the candidate just evaluated.
    reasons = turnReasons;
  }
  return {
    status: 'invalid',
    reasons,
    candidates,
    repairs,
    repairOutcome:
      evaluated.length === 0 ? 'unused' : evaluated.length === maxRepairs ? 'exhausted' : 'partial',
    ignoredRepairSubmissions: offered.length - evaluated.length,
  };
}

// Re-exported pin types so callers can build contexts without importing the
// validator module directly; the types are the same objects.
export type { AnchorBlobInput, AnchorInvalidReason, AnchorValidationContext };
