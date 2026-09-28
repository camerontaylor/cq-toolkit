// Per-lane budget classification (ADR-0003 §2.4, W2.3 / A12c) — the DATA the
// admission gate consults before any dispatch.
//
// A `(lane, provider, model)` is HARD for USD only when a conformance leg in
// CI has DEMONSTRATED it: an in-process cap mechanism, W_max from
// API-published limits, per-rate dominance, settle accuracy against the
// recording proxy, no ungated parallel requests, and proxy-observed gating
// with an additive `overshootUsd` (ADR-0003 §2.4 criteria 1–6). Anything
// else is ADVISORY — including every lane-less dispatch, which is all the
// kernel op seam can produce today (ops are data-in/data-out; the
// driver-seam invocation gate that carries lane/provider/model lands with
// W3.2/W3.3).
//
// At v1.1 NO leg has passed, so this table holds NO HARD rows: every
// governed dispatch classifies ADVISORY, and an unattended governed run is
// refused dispatch-by-dispatch unless the operator passes the escape
// (`allowAdvisory` on `Governance`; the CLI's `--allow-advisory-budget`).
// That is the ADR's stated v1.1 posture, not a placeholder to be relaxed
// quietly: a HARD row lands ONLY together with the proxy-leg evidence that
// justifies it (the row's `evidence` names it), and the table is versioned
// with that evidence.

/** The budget class of a dispatch: `hard` = cap enforced by demonstration, `advisory` = best-effort. */
export type BudgetClass = 'hard' | 'advisory';

/** One classification row: the (lane, provider, model) key plus its class and the evidence that earned it. */
export interface LaneClassificationRow {
  /** Driver lane id (the driver seam's `ResolvedDriver.lane`); absent = any lane. */
  lane?: string;
  /** Provider id; absent = any provider on the lane. */
  provider?: string;
  /** Canonical model id; absent = any model on the provider. */
  model?: string;
  /** The demonstrated class. Only 'hard' rows are meaningful here — unlisted keys are ADVISORY by default. */
  class: BudgetClass;
  /** What demonstrated a HARD row (the conformance leg / evidence id). Required for 'hard', absent for 'advisory'. */
  evidence?: string;
}

/**
 * THE CLASSIFICATION TABLE. Empty at v1.1: every lane is ADVISORY until a
 * proxy leg passes (ADR-0003 §2.4 — "At v1.1, every lane is ADVISORY").
 * First candidate per the ADR: the subprocess lane over an Anthropic model,
 * after W2.1 (driver settlement) and W3.5 (pricing normaliser).
 */
export const LANE_CLASSIFICATION: readonly LaneClassificationRow[] = [];

/**
 * Classify one dispatch key. Longest-specifying-row-wins (a model row beats
 * a provider row beats a lane row beats the default); no matching row — or
 * no key at all, the lane-less case, over an EMPTY table — is ADVISORY. A
 * row that claims 'hard' without evidence is table corruption and throws:
 * HARD is a demonstrated property, never a declaration. A NON-EMPTY table
 * with NO key throws too (W2.3 fix round, comp 3): every row's constraints
 * are vacuously satisfied by an absent key, so the winner is unresolvable —
 * and a future HARD row silently failing to match (the gate refusing the
 * dispatch as ADVISORY while the table promises HARD enforcement) is
 * exactly the inert-gate failure this module must never hide. The kernel op
 * seam is lane-less until W3.2/W3.3, so a populated table means the caller
 * must thread the key.
 */
export function classifyDispatch(
  key?: { lane?: string; provider?: string; model?: string },
  table: readonly LaneClassificationRow[] = LANE_CLASSIFICATION,
): BudgetClass {
  if (key === undefined && table.length > 0) {
    throw new Error(
      'lanes: the classification table has rows but no dispatch key was supplied — every row ' +
        'vacuously matches a key-less dispatch, so HARD enforcement could silently not bind; ' +
        'thread the (lane, provider, model) key or clear the table (the kernel op seam is ' +
        'lane-less until W3.2/W3.3)',
    );
  }
  let best: LaneClassificationRow | undefined;
  let bestSpecificity = -1;
  for (const row of table) {
    if (row.lane !== undefined && row.lane !== key?.lane) continue;
    if (row.provider !== undefined && row.provider !== key?.provider) continue;
    if (row.model !== undefined && row.model !== key?.model) continue;
    const specificity =
      (row.lane !== undefined ? 1 : 0) +
      (row.provider !== undefined ? 1 : 0) +
      (row.model !== undefined ? 1 : 0);
    if (specificity > bestSpecificity) {
      best = row;
      bestSpecificity = specificity;
    }
  }
  if (best === undefined) return 'advisory';
  if (best.class === 'hard' && best.evidence === undefined) {
    throw new Error(
      `lanes: corrupt classification table — a 'hard' row without evidence (${JSON.stringify({
        lane: best.lane,
        provider: best.provider,
        model: best.model,
      })})`,
    );
  }
  return best.class;
}
