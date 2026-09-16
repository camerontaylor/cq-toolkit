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
//     shuffles). Clusters sort by id; members and noise sort by exact
//     failure identity (collectFailures' identity), making the whole report
//     order-invariant. As in fingerprint.ts, the full signature string is
//     the comparison unit carried on each cluster; the 8-hex id is its
//     compact stable handle.
//   - Template normalization is EXACTLY this pipeline, in this order:
//       1. quoted spans ('…', "…", `…`)          → <str>
//       2. non-space runs containing / or \      → <path>  (posix + windows paths, URLs)
//       3. numbers (optional decimal part)       → <num>   (counts, line refs, codes)
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
//     matching. needsHuman ⊆ knownNoise in any ledger-derived view, so the
//     exclusion covers escalations; knownNoise is consulted because it is
//     the skip list.
//   - All plain JSON-serializable data; the input is a FailureSet (one tool
//     — the family's unit, consistent with collectFailures' single-tool
//     policy; the signature needs the tool and a bare failure list has
//     none). An EMPTY set clusters to an empty report — clustering nothing
//     is honest and asserts nothing about cleanliness.
import type { LedgerView } from '../ledger/ledger.js';
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
    .replace(QUOTED_SPAN, '<str>')
    .replace(PATH_LIKE, '<path>')
    .replace(NUMBER_LIKE, '<num>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Quoted spans of all three JS quote styles, non-greedy within one pair. */
const QUOTED_SPAN = /'[^']*'|"[^"]*"|`[^`]*`/g;

/** Any non-space run containing a path separator: paths, path fragments, URLs. */
const PATH_LIKE = /\S*[/\\]\S*/g;

/** Numbers with an optional decimal part (codes, counts, line:col refs). */
const NUMBER_LIKE = /\d+(?:\.\d+)?/g;

/**
 * The canonical signature string of one failure within a tool namespace —
 * the ledger-matching form (record THIS through the ledger record op to
 * suppress the failure cluster-wide) and the pre-hash unit of the cluster
 * id. JSON tuple, like the gates' canonical keys, so no delimiter in a
 * component can forge a collision.
 */
export function clusterSignature(failure: CheckFailure, tool: string): string {
  return JSON.stringify([tool, failure.ruleId ?? '', messageTemplate(failure.message)]);
}

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
  /** The dispatch-facing ledger view; only `knownNoise` is consulted. Omit for no suppression. */
  ledger?: LedgerView;
}

/**
 * The `analyze.clusterErrors` clustering: group one FailureSet's failures by
 * canonical signature, exclude ledger noise, order everything
 * deterministically. Total over valid typed input — an empty set yields an
 * empty report, and there is no throw path.
 */
export function clusterErrors(set: FailureSet, ledger?: LedgerView): ClusterErrorsReport {
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
    // Every member of the group shares the signature's ruleId slot; the
    // first member carries the original null-or-string value the signature
    // collapsed to ''.
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
  clusters.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { clusters, noise: sortByIdentity(noise, set.tool) };
}

/**
 * The `analyze.clusterErrors` op: `ok` with the report. Unlike
 * {@link collectFailuresOp} there is no try/catch: the clustering is total
 * over schema-validated input (no policy throws), mirroring the gates'
 * pure decision ops.
 */
export const clusterErrorsOp: Op<ClusterErrorsInput, ClusterErrorsReport> = async (input) => {
  return { status: 'ok', value: clusterErrors(input.set, input.ledger) };
};
