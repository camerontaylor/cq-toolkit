// W3.5 candidate served-model alias layer — EVIDENCE, NOT POLICY.
//
// READ THIS FIRST: this table is NOT the built-in alias layer and nothing in the
// toolkit reads it at runtime. ADR-0002 §2.6 makes
// `ServedModelPolicy.aliases` the ONE alias source of truth and leaves the
// BUILT-IN layer deliberately EMPTY while reconciliation open point O-2
// ("which vendor remaps ship built in") is undecided. This file records the
// primary-source evidence that O-2's decision will need, in the exact structural
// shape the seam table uses, so the owner can turn a subset of it into the
// built-in layer without re-deriving the evidence.
//
// It exports the alias shape (lane → provider → requested id → served ids) and
// three groups of candidates. Each entry cites its primary source and its
// verification status; see ./PROVENANCE.md for the fetch dates, HTTP statuses
// and the drift findings (including one that makes the anthropic group
// UNUSABLE for reservation as-is).
//
// Every entry is a CANDIDATE. Turning any of them on is an O-2 decision for the
// owner/Sol, not a pricing-lane edit.
import type { ServedAliasTable } from './normalize.js';

/**
 * Anthropic: the dateless id is a convenience ALIAS that resolves to the dated
 * API ID, so a response may report the dated id for a dateless request.
 *
 * Primary source (fetched 2026-10-01, HTTP 200):
 * https://platform.claude.com/docs/en/docs/about-claude/models/overview.md —
 * model table: "Claude API ID `claude-haiku-4-5-20251001`", "Claude API alias
 * `claude-haiku-4-5`"; and the footnote "For models before the 4.6 generation,
 * the alias is a convenience pointer that resolves to the dated ID. Dateless IDs
 * are their own pinned snapshot; the alias row repeats them."
 *
 * Verification status: DOCUMENTED (primary, re-fetched in this lane). Not
 * observed on the wire in this lane.
 *
 * ⚠ Reservation consequence (see ./PROVENANCE.md §Drift): the dated id is NOT a
 * key in ./data.ts, so admitting this alias makes `worstCaseRates` incomplete
 * for that lane — which is the correct fail-closed answer, but it means the
 * anthropic group cannot enable a HARD reservation until the price table gains
 * the dated row (or the alias group is excluded).
 */
export const CANDIDATE_ANTHROPIC_DATED_ALIASES: ServedAliasTable = {
  subprocess: {
    anthropic: {
      'claude-haiku-4-5': ['claude-haiku-4-5-20251001'],
    },
  },
  'claude-agent': {
    anthropic: {
      'claude-haiku-4-5': ['claude-haiku-4-5-20251001'],
    },
  },
  'ai-sdk': {
    anthropic: {
      'claude-haiku-4-5': ['claude-haiku-4-5-20251001'],
    },
  },
};

/**
 * DeepSeek: the documented request ids `deepseek-chat`/`deepseek-reasoner` are
 * absent from the current documentation, and a live 200 captured on 2026-09-24
 * served `deepseek-flash` for a `deepseek-chat` request.
 *
 * Primary source (fetched 2026-10-01, HTTP 200):
 * https://api-docs.deepseek.com/quick_start/rate_limit — the model table lists
 * only `deepseek-flash` and `deepseek-v4-pro`; `deepseek-chat` appears nowhere
 * on the page. https://models.dev/api.json (fetched 2026-10-01, HTTP 200) lists
 * `deepseek-flash` under `deepseek` and no `deepseek-chat`/`deepseek-reasoner`.
 * Live served-id observation: RS-14 evidence `ds_body.json` (2026-09-24 15:54
 * UTC), retained at research branch
 * `origin/research/rs14-provider-limits@ab671be`, file
 * `research/research-20260925-v11/evidence/rs14/ds_body.json`.
 *
 * Verification status for the `chat` → `flash` remap: OBSERVED + DOCS-SILENT
 * (documented absence, one capture). For `reasoner`: UNVERIFIED — see the note
 * below, which is why no reasoner candidate is shipped here.
 */
export const CANDIDATE_DEEPSEEK_SERVED_ALIASES: ServedAliasTable = {
  'ai-sdk': {
    deepseek: {
      'deepseek-chat': ['deepseek-flash'],
    },
  },
};

/**
 * Z.AI: the coding-plan wire auto-routes two retired generation ids onto the
 * current ones, so a lane that requests them is served a different model than
 * it asked for.
 *
 * Primary source (fetched 2026-10-01, HTTP 200):
 * https://docs.z.ai/devpack/overview.md §"Supported Models" — "All plans support
 * GLM-5.3, GLM-5.3-Flash. Requests for GLM-5.2/GLM-5.1 will be automatically
 * routed to GLM-5.3, requests for GLM-4.7 will automatically be routed to
 * GLM-5.3-Flash."
 *
 * Verification status: DOCUMENTED (primary, re-fetched in this lane), but the
 * routed ids are NOT keys in ./data.ts, so any run that requests GLM-4.7/5.1/5.2
 * is unpriced and therefore ADVISORY. The entries exist so the served-id
 * mismatch is recognised as a DECLARED remap rather than an unexplained one —
 * they buy narration, not a price.
 */
export const CANDIDATE_ZAI_ROUTING_ALIASES: ServedAliasTable = {
  'ai-sdk': {
    zai: {
      'glm-4.7': ['glm-5.3-flash'],
      'glm-5.1': ['glm-5.3'],
      'glm-5.2': ['glm-5.3'],
    },
  },
};

/**
 * Every candidate above, merged WITHOUT clobbering.
 *
 * The groups each carry an `ai-sdk` key, so a shallow object spread silently
 * keeps only the LAST group's `ai-sdk` map and loses the anthropic and deepseek
 * entries — a merged table that looks populated and is missing half of what went
 * into it. This merge therefore descends lane → provider → requested, and a test
 * asserts every group survives the merge.
 */
export const CANDIDATE_SERVED_ALIASES: ServedAliasTable = Object.freeze(
  [
    CANDIDATE_ANTHROPIC_DATED_ALIASES,
    CANDIDATE_DEEPSEEK_SERVED_ALIASES,
    CANDIDATE_ZAI_ROUTING_ALIASES,
  ].reduce<ServedAliasTable>((merged, group) => {
    const lanes: Record<string, Record<string, Record<string, readonly string[]>>> = { ...merged };
    for (const [lane, byProvider] of Object.entries(group)) {
      const byModel: Record<string, Record<string, readonly string[]>> = { ...(lanes[lane] ?? {}) };
      for (const [provider, byRequested] of Object.entries(byProvider)) {
        byModel[provider] = { ...(byModel[provider] ?? {}), ...byRequested };
      }
      lanes[lane] = byModel;
    }
    return lanes;
  }, {}),
);

/**
 * Candidates deliberately NOT recorded, and why (an omission here is a finding,
 * not a gap):
 *
 * - `deepseek-reasoner` → any current id. The documentation no longer lists the
 *   request id at all, and no capture in this repository shows what the wire
 *   serves for it. Claiming a remap from a retired id to a live one with no
 *   evidence is exactly the fabrication the price map refuses to make, so the
 *   candidate is left absent. A single credential-cheap capture on the owning
 *   host would close it.
 * - OpenCode Go's `x-opencode-upstream-model-id` routing header (RS-14
 *   `oc_headers.txt`, 2026-09-24). It names the UPSTREAM provider's id, not the
 *   model the provider served, and the same capture shows the CLI routing paid
 *   models onto a different wire entirely. Not a served-id alias; recording it as
 *   one would price the wrong model.
 * - ACP's `builtin:<provider>\<model>` form. ADR-0002 §2.6 already defines lane
 *   normalisation for that namespace (strip one prefix, case-fold); it is a
 *   normalisation rule, not a wire remap, and ADR-0002 §2.6 records a normalised
 *   acp mismatch as a finding rather than something to alias away.
 */
