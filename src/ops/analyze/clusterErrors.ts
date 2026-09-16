// Analyze lane G1 — error clustering with honest confidence: group one
// tool's typed failures by SIGNATURE — tool + ruleId + normalized message
// TEMPLATE — so a burst of the same rule firing the same shape across many
// files becomes one remediation unit instead of a flat wall of failures.
// Pure decision core: zero I/O, no clocks, no randomness.
//
// Invariants honored here:
//   - Determinism (the acceptance property): cluster ids are STABLE and
//     content-derived — FNV-1a 32-bit (the gates family's fnv1a32Hex) over
//     the canonical signature JSON — so the same failure set yields the
//     same ids in any presentation order (property-tested with seeded
//     shuffles). Clusters sort by id, signature breaking the (astronomically
//     rare) 32-bit id tie; members and noise sort by exact failure identity
//     (collectFailures' identity), making the whole report
//     order-invariant. As in fingerprint.ts, the full signature string is
//     the comparison unit carried on each cluster; the 8-hex id is its
//     compact stable handle.
//   - Template normalization is EXACTLY this pipeline, in this order:
//       0. straight apostrophes between word chars → curly (’), so a
//          contraction ("doesn't") can never open a quoted span
//       1. quoted spans ('…', "…", `…`)          → <str>
//       2. non-space runs containing / or \      → <path>  (posix + windows paths, URLs)
//       3. numbers (optional decimal part)       → <num>   (counts, line:col refs)
//       4. whitespace runs collapsed, trimmed
//     Case is PRESERVED (distinct identifiers that differ in case stay
//     distinct). Later rules see earlier placeholders: a quoted path is
//     <str>, a number inside a path is already inside <path>. The coarseness
//     is documented, like the fingerprint buckets: 'and/or' also abstracts
//     to <path>, and a message LITERALLY containing '<num>' could collide
//     with an abstracted digit — an accepted placeholder-collision class,
//     harmless to grouping-by-shape and impossible to hit without a same-rule
//     near-twin message.
//   - Confidence honesty: a cluster of ≥ 2 members agreeing on the exact
//     signature is 'high'; a singleton is 'low' — one sample cannot
//     distinguish signal from noise, and v1 NEVER merges clusters (so a
//     singleton is never silently absorbed by a look-alike). 'medium' exists
//     in the contract for a future similarity-merge path (a merged cluster
//     must drop to 'medium' and carry the merge explicitly); v1 never emits
//     it — cross-signature similarity merging is deliberately not in v1
//     (adopt-vs-build verdict: src/ops/analyze/NOTES.md).
//   - Ledger interplay (R2 D6): failures whose cluster signature is in
//     `ledger.knownNoise` do NOT cluster as signal — they are excluded from
//     clusters and reported in `noise`, so re-fixing known noise stays
//     suppressed (the ledger view semantics: knownNoise is exactly the list
//     dispatch must skip). Matching seam, DEFINED here because the frozen
//     ledger surface takes its signatures as caller-supplied opaque strings
//     and has no canonical CheckFailure→signature construction: the ledger
//     signature of a failure is exactly {@link clusterSignature}(failure,
//     tool) — the same canonical string this module clusters by. Record that
//     string through the ledger record op and the suppression matches;
//     anything else recorded simply never matches — no guessing, no fuzzy
//     matching. The view's needsHuman ⊆ knownNoise invariant is ENFORCED at
//     this boundary, not assumed from the ledger lane: a needsHuman
//     signature absent from knownNoise throws (the op maps it to `failed`)
//     — a hand-built view must not silently cluster escalated noise as
//     signal. The canonical signature is BOUNDED to the ledger's
//     SIGNATURE_MAX_CHARS by deterministic template truncation (a
//     prefix-collision coarseness, the same doctrine as the fingerprint
//     buckets), so the record seam stays usable for verbose diagnostics.
//   - All plain JSON-serializable data; the input is a FailureSet (one tool
//     — the family's unit, consistent with collectFailures' single-tool
//     policy; the signature needs the tool and a bare failure list has
//     none). An EMPTY set clusters to an empty report — clustering nothing
//     is honest and asserts nothing about cleanliness.
import type { LedgerView } from '../ledger/ledger.js';
// Runtime import of the ledger bound — ONE definition (the record boundary)
// decides what fits a ledger entry. Safe eagerly: the pure ledger decision
// module has zero runtime imports of its own.
import { SIGNATURE_MAX_CHARS } from '../ledger/ledger.js';
import type { Op } from '../../kernel/types.js';
import type { CheckFailure, FailureSet } from '../gates/checkRunner.js';
import { fnv1a32Hex } from '../gates/fingerprint.js';
import { sortByIdentity } from './collectFailures.js';

/**
 * The normalized message TEMPLATE: the volatile fragments above replaced by
 * fixed placeholders, whitespace collapsed. Exported because the template
 * pipeline is the documented contract of the signature scheme (and is
 * pinned by tests, like the fingerprint vectors).
 */
export function messageTemplate(message: string): string {
  return message
    .replace(CONTRACTION_APOSTROPHE, '$1’$2')
    .replace(QUOTED_SPAN, '<str>')
    .replace(/\S+/g, (token) => (token.includes('/') || token.includes('\\') ? '<path>' : token))
    .replace(NUMBER_LIKE, '<num>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A straight apostrophe between two word chars is a CONTRACTION ("doesn't"),
 * never a quote-pair opener — rewritten to the curly form first so
 * {@link QUOTED_SPAN} cannot pair it with a LATER opening quote (which would
 * make the template depend on text after the contraction: an over-split
 * signature contract violation).
 */
const CONTRACTION_APOSTROPHE = /(\w)'(\w)/g;

/** Quoted spans of all three JS quote styles, non-greedy within one pair. */
const QUOTED_SPAN = /'[^']*'|"[^"]*"|`[^`]*`/g;

/** Numbers with an optional decimal part (codes, counts, line:col refs). */
const NUMBER_LIKE = /\d+(?:\.\d+)?/g;

/**
 * The canonical signature string of one failure within a tool namespace —
 * the ledger-matching form (record THIS through the ledger record op to
 * suppress the failure cluster-wide) and the pre-hash unit of the cluster
 * id. JSON tuple, like the gates' canonical keys, so no delimiter in a
 * component can forge a collision. A null ruleId is encoded as null, never
 * coerced to '' — the two stay distinct signatures, so a cluster's reported
 * ruleId is deterministic regardless of input order. BOUNDED to the
 * ledger's SIGNATURE_MAX_CHARS: an overflowing message template is
 * deterministically prefix-truncated with a marker, so the record seam
 * stays usable for verbose diagnostics — at the accepted coarseness that
 * two very long messages sharing a truncation prefix sign ONE signature
 * (fingerprint-bucket doctrine).
 */
export function clusterSignature(failure: CheckFailure, tool: string): string {
  const template = messageTemplate(failure.message);
  const canonical = JSON.stringify([tool, failure.ruleId, template]);
  if (canonical.length <= SIGNATURE_MAX_CHARS) {
    return canonical;
  }
  // The template is the only unbounded component: cut it until the
  // canonical form fits. The budget starts at the fixed overhead's share
  // and shrinks by the observed overage — an escaped character (a
  // surviving unpaired quote, say) costs more than one code unit, so a raw
  // cut of exactly the overage can still overflow; the loop terminates
  // because every removed character contributes at least one code unit.
  // Residual, documented: a tool+ruleId pair whose OWN JSON exceeds the
  // bound cannot be fitted by truncating the message — such a signature
  // stays over-bound and cannot pass the ledger record boundary.
  let budget =
    SIGNATURE_MAX_CHARS -
    JSON.stringify([tool, failure.ruleId, '']).length -
    TRUNCATED_TEMPLATE_MARKER.length;
  let signature = '';
  for (;;) {
    signature = JSON.stringify([
      tool,
      failure.ruleId,
      template.slice(0, Math.max(budget, 0)) + TRUNCATED_TEMPLATE_MARKER,
    ]);
    if (signature.length <= SIGNATURE_MAX_CHARS || budget <= 0) {
      return signature;
    }
    budget -= signature.length - SIGNATURE_MAX_CHARS;
  }
}

/** Appended to a template cut for the ledger bound — visually distinct, one code unit. */
const TRUNCATED_TEMPLATE_MARKER = '…';

/** Confidence vocabulary. v1 emits only 'high' and 'low' (see module header). */
export type ClusterConfidence = 'high' | 'medium' | 'low';

/** One signature cluster — plain data, stable id, honest confidence. */
export interface Cluster {
  /** FNV-1a 32-bit over the canonical signature JSON — content-derived, stable. */
  id: string;
  /** The full canonical signature — the comparison unit; the id is its handle. */
  signature: string;
  /** The cluster's tool (every member's set tool — one set, one tool). */
  tool: string;
  /** The members' shared rule id (null when the tool attributed none). */
  ruleId: string | null;
  /** 'high' for ≥ 2 agreeing members; 'low' for a singleton; never merged in v1. */
  confidence: ClusterConfidence;
  /** The member failures, sorted by exact identity (duplicates preserved — occurrence count is signal). */
  failures: CheckFailure[];
  /** Member count. */
  size: number;
}

/** The clustering report: signal clusters plus the separately-reported ledger noise. */
export interface ClusterErrorsReport {
  /** Clusters sorted by id. */
  clusters: Cluster[];
  /** Failures suppressed as known noise, sorted by exact identity — never inside `clusters`. */
  noise: CheckFailure[];
}

/** JSON-serializable input of the `analyze.clusterErrors` op. */
export interface ClusterErrorsInput {
  /** The failure set to cluster (one tool). */
  set: FailureSet;
  /**
   * The dispatch-facing ledger view: `knownNoise` is the suppression list;
   * its needsHuman ⊆ knownNoise invariant is ENFORCED here (a violating
   * view is a policy throw). Omit for no suppression.
   */
  ledger?: LedgerView;
}

/**
 * The `analyze.clusterErrors` clustering: group one FailureSet's failures by
 * canonical signature, exclude ledger noise, order everything
 * deterministically. An empty set yields an empty report; the ONE policy
 * throw is a ledger view violating needsHuman ⊆ knownNoise.
 */
export function clusterErrors(set: FailureSet, ledger?: LedgerView): ClusterErrorsReport {
  // The subset invariant is ENFORCED at this boundary, not assumed from the
  // ledger lane: a hand-built view that escalates a signature it does not
  // suppress would silently cluster ESCALATED noise as signal — the exact
  // re-fixing the ledger exists to prevent. Same policy-throw pattern as
  // collectFailures' tool policy; the op maps it to `failed`.
  if (ledger !== undefined) {
    const known = new Set(ledger.knownNoise);
    for (const escalated of ledger.needsHuman) {
      if (!known.has(escalated)) {
        throw new RangeError(
          `clusterErrors: invalid ledger view — needsHuman signature '${escalated}' is not in knownNoise (needsHuman ⊆ knownNoise; escalated noise must stay suppressed)`,
        );
      }
    }
  }
  const noiseSignatures = new Set(ledger?.knownNoise ?? []);
  const noise: CheckFailure[] = [];
  const groups = new Map<string, CheckFailure[]>();
  for (const failure of set.failures) {
    const signature = clusterSignature(failure, set.tool);
    if (noiseSignatures.has(signature)) {
      noise.push(failure);
      continue;
    }
    const members = groups.get(signature);
    if (members === undefined) {
      groups.set(signature, [failure]);
    } else {
      members.push(failure);
    }
  }
  const clusters: Cluster[] = [...groups.entries()].map(([signature, members]) => {
    // Signature equality implies an IDENTICAL ruleId (null is encoded, not
    // coerced), so any member yields the same value — the first is fine.
    const ruleId = (members[0] as CheckFailure).ruleId;
    return {
      id: fnv1a32Hex(signature),
      signature,
      tool: set.tool,
      ruleId,
      confidence: members.length >= 2 ? 'high' : 'low',
      failures: sortByIdentity(members, set.tool),
      size: members.length,
    };
  });
  // Ids are 32-bit FNV, so two DISTINCT signatures can collide on one id;
  // the signature breaks the tie so ordering never depends on map insertion
  // order (determinism acceptance check). No test contrives a real
  // collision — this comment is the pin of the documented rule.
  clusters.sort((a, b) =>
    a.id < b.id
      ? -1
      : a.id > b.id
        ? 1
        : a.signature < b.signature
          ? -1
          : a.signature > b.signature
            ? 1
            : 0,
  );
  return { clusters, noise: sortByIdentity(noise, set.tool) };
}

/**
 * The `analyze.clusterErrors` op: `ok` with the report, or `failed` when
 * the one policy throw fires (a ledger view violating needsHuman ⊆
 * knownNoise — the op ran and definitively could not honor the suppression
 * contract), the same policy-to-`failed` mapping as
 * {@link collectFailuresOp}.
 */
export const clusterErrorsOp: Op<ClusterErrorsInput, ClusterErrorsReport> = async (input) => {
  try {
    return { status: 'ok', value: clusterErrors(input.set, input.ledger) };
  } catch (err) {
    return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
  }
};
