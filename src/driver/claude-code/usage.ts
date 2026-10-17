// Shared worker accounting for the Claude Code lane — Phase 1.9 (ONE usage
// fold and ONE derived-only cost field for BOTH transports; consolidates the
// byte-identical folds the former subprocess and claude-agent lanes each
// carried, and closes the D-E′ spike's accounting gaps: per-model token
// folding, fold provenance, and resumed-session usage semantics).
//
// THE FROZEN USAGE SHAPE: `Usage` is one flat fold
// ({input, output, cacheRead, cacheWrite, reasoning?}) — the number
// Budget.maxTokens is classified against. Nothing here changes the shape.
//
// THE FOLD (precedence, first well-shaped channel wins):
//   1. `modelUsage` on the result frame — the substrate's PER-MODEL token
//      aggregates (a record keyed by model id). This is the vendor's
//      preferred accounting field and the only one that includes SUBAGENT
//      spend (the flat `usage` is main-loop-only), so when it is present
//      the fold takes its per-field SUM across models — TOKENS ONLY: cost
//      stays derived from the folded tokens by the one estimator, never
//      from any vendor USD figure (the SDK's total_cost_usd is still not
//      surfaced; DD-2 derived-only).
//   2. the result frame's flat `usage` — the main-loop total (subagent
//      spend NOT included — a documented undercount the provenance marker
//      makes observable).
//   3. the Σ of assistant-frame usage — the fallback when no result event
//      arrived (abort/crash mid-stream).
//   Absent numeric fields map to 0 (the honest zero); a numeric field that
//   is not a finite non-negative integer is a LYING measurement and is
//   treated as absent (never folded negative — issue #19's bypass).
//
// PROVENANCE: whenever the fold came from a NON-DEFAULT channel — the
// per-model aggregates (modelUsage) or the assistant fallback — the caller
// records the `usage-provenance` narration marker naming the channel (and
// the model ids when modelUsage won), persisted with the session evidence.
// A run with NO marker folded the historical default channel (the result
// frame's flat usage), so absence is the documented baseline, not a gap —
// and the session record's role-'tool' contract ("a tool ran") is not
// widened by routine bookkeeping (the conformance mode-none leg pins that
// record shape).
//
// RESUME SEMANTICS (version-gated, D-E′ F7): on a RESUMED session the
// substrate's reported usage is SESSION-CUMULATIVE on current pins
// (CLI ≥ 2.1.277 / matching SDK — resumed sessions start their totals at
// the carried-over sum) and PER-CALL on older pins (each resumed session
// started at zero). The lane CANNOT and DOES NOT version-sniff: it records
// the REPORTED figure as measured — never a fabricated delta — and adds
// the `resumed-usage-semantics` narration marker so the accepted
// per-call-versus-cumulative frames (version-labelled recorded fixtures in
// the test tree) stay distinguishable in evidence. Judging the reported
// figure against Budget.maxTokens is the CONSERVATIVE direction under
// either semantics: a cumulative figure can only over-classify 'budget',
// never under-classify it.
//
// UNMEASURED verdicts (spawn failure, abort before any frame) report the
// zero fold and NEVER a cost: 0 would be a fabricated fact. Errors and
// aborts that DID measure keep their measurement (and ride it into the
// derived cost when the price table knows the served model).
import { computeCostUSD } from '../pricing/index.js';
import type { PerMillionRates } from '../pricing/index.js';
import type { ModelSpec, Usage } from '../types.js';

/** Unmeasured usage: the honest zero (it means "not measured", never "nothing spent"). */
export function zeroUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

/**
 * Wire-reported numeric fields must be finite non-negative INTEGERS: a
 * negative or fractional "token count" is a lying measurement — accepting
 * it folded negative usage (→ negative cost) and a NEGATIVE token total
 * that could never trip the `>= maxTokens` budget check (the bypass,
 * issue #19). Invalid → undefined → the fold sites' `?? 0` maps it to an
 * honest zero.
 */
export function asWireInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The substrate usage vocabulary → frozen Usage (missing numeric fields map
 * to 0; an unshaped usage is NO measurement). `reasoning` is deliberately
 * NOT set by the Claude Code lane's own fold sites: the substrate's
 * thinkingTokens are ALREADY INCLUDED inside output_tokens, so a separate
 * field would double-count every total that sums the frozen Usage fields
 * (Budget.maxTokens classification) — the frozen field stays optional
 * precisely for lanes whose reasoning is additive.
 */
export function usageFromWire(raw: unknown): Usage | undefined {
  const rec = asRecord(raw);
  if (rec === undefined) return undefined;
  return {
    input: asWireInt(rec['input_tokens']) ?? 0,
    output: asWireInt(rec['output_tokens']) ?? 0,
    cacheRead: asWireInt(rec['cache_read_input_tokens']) ?? 0,
    cacheWrite: asWireInt(rec['cache_creation_input_tokens']) ?? 0,
  };
}

/** One channel's measured fold, with what the auditor needs to know about it. */
export interface MeasuredUsage {
  usage: Usage;
  /** Which channel won the fold (the provenance marker's fact). */
  channel: 'modelUsage' | 'result' | 'assistant';
  /** The model ids seen, modelUsage channel only (per-model aggregates). */
  models?: string[];
  /**
   * modelUsage channel only: true when the aggregate fold DIVERGES from the
   * flat main-loop usage on the same frame (subagent spend actually added
   * tokens) or no flat usage was present — the surprising fact the
   * provenance marker exists to record. False when the aggregate agrees
   * with the flat usage (no subagent spend), which is the ordinary shape
   * and stays unmarked.
   */
  includesSpendBeyondFlatUsage?: boolean;
}

/**
 * The substrate's PER-MODEL aggregate entry vocabulary (`modelUsage[id]`) →
 * frozen Usage. Unlike the flat usage channel, the modelUsage entries use
 * the SDK's camelCase fields (`inputTokens`, `outputTokens`,
 * `cacheReadInputTokens`, `cacheCreationInputTokens`); `thinkingTokens`
 * ride inside `outputTokens` (never lifted into `reasoning` — the flat
 * channel's rule) and the vendor's per-model `costUSD` is deliberately
 * ignored (DD-2: cost stays derived over the token fold). Returns
 * undefined for an unshaped entry (no recognizable token field at all).
 */
export function modelUsageEntryFromWire(raw: unknown): Usage | undefined {
  const rec = asRecord(raw);
  if (rec === undefined) return undefined;
  const shaped =
    rec['inputTokens'] !== undefined ||
    rec['outputTokens'] !== undefined ||
    rec['cacheReadInputTokens'] !== undefined ||
    rec['cacheCreationInputTokens'] !== undefined;
  if (!shaped) return undefined;
  return {
    input: asWireInt(rec['inputTokens']) ?? 0,
    output: asWireInt(rec['outputTokens']) ?? 0,
    cacheRead: asWireInt(rec['cacheReadInputTokens']) ?? 0,
    cacheWrite: asWireInt(rec['cacheCreationInputTokens']) ?? 0,
  };
}

/**
 * Measure the RESULT frame: the `modelUsage` per-model token aggregates
 * when well-shaped (per-field Σ across models — subagent spend included),
 * else the flat main-loop `usage`, else undefined (no measurement on the
 * frame). The `models` list is the provenance record of which model ids
 * contributed; per-model USD attribution stays the estimator's business
 * over the served id (the fold is deliberately token-only).
 */
export function measureResultUsage(
  result: Record<string, unknown> | undefined,
): MeasuredUsage | undefined {
  if (result === undefined) return undefined;
  const modelUsage = asRecord(result['modelUsage']);
  if (modelUsage !== undefined) {
    const models = Object.keys(modelUsage).sort();
    const total = zeroUsage();
    let shaped = false;
    for (const id of models) {
      const perModel = modelUsageEntryFromWire(modelUsage[id]);
      if (perModel === undefined) continue;
      shaped = true;
      total.input += perModel.input;
      total.output += perModel.output;
      total.cacheRead += perModel.cacheRead;
      total.cacheWrite += perModel.cacheWrite;
    }
    if (shaped) {
      const flat = usageFromWire(result['usage']);
      const diverges =
        flat === undefined ||
        flat.input !== total.input ||
        flat.output !== total.output ||
        flat.cacheRead !== total.cacheRead ||
        flat.cacheWrite !== total.cacheWrite;
      return {
        usage: total,
        channel: 'modelUsage',
        models,
        includesSpendBeyondFlatUsage: diverges,
      };
    }
  }
  const flat = usageFromWire(result['usage']);
  return flat === undefined ? undefined : { usage: flat, channel: 'result' };
}

/** Measure an assistant-frame usage fold (the no-result-event fallback). */
export function measureAssistantUsage(folded: Usage | undefined): MeasuredUsage | undefined {
  return folded === undefined ? undefined : { usage: folded, channel: 'assistant' };
}

/** Fold one usage observation into an accumulator. */
export function addUsage(a: Usage | undefined, b: Usage): Usage {
  if (a === undefined) return b;
  // No reasoning term: this lane's folds never produce one (thinking tokens
  // are a subset of output — never double-count).
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  };
}

/**
 * The `usage-provenance` narration marker: WHICH non-default channel
 * produced the measurement and what makes it worth recording — the
 * assistant fallback (no result event arrived), or the per-model
 * aggregates whose fold INCLUDES spend beyond the flat main-loop usage
 * (subagent tokens), naming the contributing model ids. Plain JSON in OUR
 * vocabulary — persisted with the session evidence. Not recorded when the
 * fold is the ordinary default shape (the result frame's flat usage, or a
 * modelUsage aggregate that agrees with it): absence is the documented
 * baseline (header).
 */
export function usageProvenanceMarker(measured: MeasuredUsage): string | undefined {
  if (measured.channel === 'result') return undefined;
  if (measured.channel === 'modelUsage' && measured.includesSpendBeyondFlatUsage !== true) {
    return undefined;
  }
  return JSON.stringify(
    measured.channel === 'modelUsage'
      ? { cq: 'usage-provenance', channel: measured.channel, models: measured.models ?? [] }
      : { cq: 'usage-provenance', channel: measured.channel },
  );
}

/**
 * The `resumed-usage-semantics` narration marker (version-gated, header):
 * the run resumed a substrate session, so the reported usage figure is
 * session-cumulative on current pins and per-call on older ones; the
 * recorded figure is the REPORTED measurement either way — never a
 * fabricated delta.
 */
export function resumedUsageSemanticsMarker(): string {
  return JSON.stringify({
    cq: 'resumed-usage-semantics',
    reportedAs: 'reported-verbatim',
    note: 'resumed-session usage is session-cumulative on CLI >=2.1.277 / matching SDK pins and per-call before; the reported figure is recorded as measured, never a delta',
  });
}

/** Σ of the frozen Usage fields — the fold Budget.maxTokens is checked against. */
export function totalTokensOf(usage: Usage): number {
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite + (usage.reasoning ?? 0);
}

/**
 * Derived-only cost field (DD-2): present only when the price lookup knows
 * the model. A present costUSD is labeled `costBasis: 'modeled'` — the
 * api-equivalent list-price figure for the tokens consumed, never a claim of
 * billed spend; an unpriced model gets neither field (never fabricate).
 */
export function costField(
  costUSDOf: (modelSpec: ModelSpec, usage: Usage) => number | undefined,
  modelSpec: ModelSpec,
  usage: Usage,
): { costUSD?: number; costBasis?: 'modeled' } {
  const costUSD = costUSDOf(modelSpec, usage);
  return costUSD === undefined ? {} : { costUSD, costBasis: 'modeled' as const };
}

/** Derived-only cost: computeCostUSD by default; the same fold over an injected price lookup. */
export function computeDerivedCost(
  pricingOverride: ((modelSpec: ModelSpec) => PerMillionRates | undefined) | undefined,
  modelSpec: ModelSpec,
  usage: Usage,
): number | undefined {
  if (pricingOverride === undefined) {
    return computeCostUSD(modelSpec, usage);
  }
  const rates = pricingOverride(modelSpec);
  if (rates === undefined) {
    return undefined; // unknown model — never fabricate
  }
  const perMillion = (tokens: number, rate: number | undefined): number =>
    rate === undefined ? 0 : (tokens / 1_000_000) * rate;
  return (
    perMillion(usage.input, rates.input) +
    perMillion(usage.output, rates.output) +
    perMillion(usage.cacheRead, rates.cacheRead) +
    perMillion(usage.cacheWrite, rates.cacheWrite)
  );
}
