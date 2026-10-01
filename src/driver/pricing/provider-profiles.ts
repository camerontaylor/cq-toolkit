// RS-14 provider-profile DATA — the inputs to admission decisions (0.2 plan §4,
// rows W2.6 and RS-14; ADR-0003 §2.6 slot C).
//
// Plain data, no behaviour and no network. Every field carries how it is known:
//   - `documented`: a vendor's own documentation, with the URL and fetch date
//     recorded in ./PROVENANCE.md;
//   - `rs14-capture`: a live response capture taken by the RS-14 lane under an
//     isolated HOME, with the evidence path and capture date;
//   - `community-db`: models.dev, which is acceptable for `data.ts` (DD-3) but
//     NOT for a `W_max` input (ADR-0003 §2.4 criterion 2 wants the provider's own
//     published limits).
// Nothing here is inferred. An unknown limit is left ABSENT, and absence is
// meaningful: it keeps the lane ADVISORY (ADR-0003 §2.4 "Unknown pricing, or
// limitsKnown: false … means ADVISORY") rather than inventing a cap.
//
// The profile is DATA, not a seam: ADR-0003 reserves the `ProviderProfile`
// interface itself (`id`, `accounting`, `limitsKnown`, `consult()`, and an
// optional `observe()`). This file supplies the reserved CONTENTS; the seam owner
// (W3.3/#238) types them. The one behaviour this module exposes is
// classifyProviderSignal in ./admission.js, which needs the lane→wire facts to
// be testable at all.
//
// Served-model aliases deliberately do NOT live here. ADR-0002 §2.6 makes
// `ServedModelPolicy.aliases` the single alias source of truth and leaves its
// built-in layer empty pending open point O-2; the evidence RS-14 collected for
// that layer is in ./candidate-aliases.ts. A copy of those lists under
// `modelLimits[*].servedAliases` would be exactly the second alias table ADR-0002
// forbids, so the profile names the candidate set instead of duplicating it.

/** How a profile's money is accounted: modelled list price, or a funded quota. */
export type ProviderAccounting = 'modeled-usd' | 'quota';

/** How a fact in this file was established. Never guessed; never inferred. */
export type ProvenanceKind = 'documented' | 'rs14-capture' | 'community-db';

/** The provenance of one field, with the source note a reviewer needs. */
export interface Provenance {
  readonly kind: ProvenanceKind;
  /** Primary URL (documented/community-db) or the RS-14 evidence file. */
  readonly source: string;
  /** ISO date (UTC) the fact was established. */
  readonly asOf: string;
  readonly note: string;
}

const DOC = 'https://platform.claude.com/docs/en/docs/about-claude/models/overview.md';
const DOC_RATE_LIMITS = 'https://platform.claude.com/docs/en/api/rate-limits';
const DOC_CODE_ERRORS = 'https://code.claude.com/docs/en/errors.md';
const DOC_CODE_COSTS = 'https://code.claude.com/docs/en/costs.md';
const DOC_ZAI = 'https://docs.z.ai/devpack/overview.md';
const DOC_DEEPSEEK_RL = 'https://api-docs.deepseek.com/quick_start/rate_limit';
const DOC_DEEPSEEK_ERR = 'https://api-docs.deepseek.com/quick_start/error_codes';
const DOC_DEEPSEEK_BAL = 'https://api-docs.deepseek.com/api_reference/get_user_balance';
const DOC_OPENAI_RL = 'https://platform.openai.com/docs/guides/rate-limits';
const DOC_OPENAI_SPEND = 'https://developers.openai.com/api/docs/guides/spend-limits';
const DOC_CODEX_PRICING = 'https://developers.openai.com/codex/pricing';
const DOC_OPENCODE_GO = 'https://opencode.ai/docs/go/';
const CAPTURES = 'research/research-20260925-v11/evidence/rs14/';

/** The native cap a provider enforces, as far as it is published. */
export interface ProviderCap {
  readonly kind: 'tier-monthly-usd' | 'plan-credits' | 'balance-usd' | 'none';
  /** USD per month, or the plan's credit pool. Absent when not published. */
  readonly amount?: number;
  /** Where a cap can be changed — never through the worker-facing credential. */
  readonly settableVia: 'console' | 'admin-api' | 'none';
  /** The HTTP verdict the provider answers with when the cap is reached. */
  readonly enforcedAs: 'http-429' | 'http-402' | 'http-400' | 'usage-credits' | 'quota-window';
  readonly provenance: Provenance;
}

/** One funded-allowance window on a quota-accounted lane. */
export interface QuotaWindowFact {
  readonly id: '5h' | 'weekly' | '7d' | 'monthly';
  readonly reset: 'rolling-since-consumption' | 'fixed-7d' | 'calendar-month';
  /** Share of the monthly allowance this window releases (documented where known). */
  readonly fractionOfMonthly?: number;
  readonly unit: 'credits' | 'model-family-share' | 'usd';
  readonly provenance: Provenance;
}

/** A documented time-of-day burn multiplier. Z.AI is the only provider with one. */
export interface PeakWindowFact {
  readonly days: 'mon-fri';
  readonly timezone: 'Asia/Singapore';
  readonly startHour: number;
  readonly endHour: number;
  readonly multiplier: number;
  readonly offPeakMultiplier: number;
  readonly provenance: Provenance;
}

/** The provider's own credit formula, when it publishes one. */
export interface CreditBurnModel {
  readonly divisor: number;
  readonly perMillion: {
    readonly input: number;
    readonly cachedInput: number;
    readonly output: number;
    readonly mcpCall?: number;
  };
  readonly provenance: Provenance;
}

/** How much of the remaining allowance a lane can actually observe. */
export interface Observability {
  readonly channel: 'headers' | 'endpoint' | 'cli-interactive' | 'console-only' | 'none';
  /** Header names carrying remaining allowance, when the lane can read them. */
  readonly headers?: readonly string[];
  /** A documented usage/balance endpoint. Never called by this module. */
  readonly usageEndpoint?: { readonly method: 'GET'; readonly url: string };
  readonly provenance: Provenance;
}

/**
 * Published per-model limits. These are the `W_max` inputs ADR-0003 §2.4
 * criterion 2 accepts. A limit this file could not confirm against a VENDOR page
 * is ABSENT — an absent limit keeps the lane ADVISORY, which is the required
 * behaviour (never a client default, never a community number).
 */
export interface ModelLimitFacts {
  readonly maxInputTokens?: number;
  readonly maxOutputTokens?: number;
  readonly rpm?: number;
  readonly itpm?: number;
  readonly otpm?: number;
  readonly provenance: Provenance;
}

/** One documented signal → `errorClass` rule for a lane (RS-14 §4). */
export interface ErrorSignalFact {
  /** Provider error code in the response body, when the vendor publishes one. */
  readonly providerCode?: string;
  readonly httpStatus?: number;
  /** A header whose PRESENCE discriminates this class (Claude unified quota). */
  readonly markerHeader?: string;
  readonly errorClass: 'rate-limit' | 'quota' | 'provider-error';
  readonly provenance: Provenance;
}

/**
 * One provider profile: the RS-14 slot-C contents. `limitsKnown: false` keeps the
 * lane ADVISORY for quota-aware admission no matter what the rest of the profile
 * says (ADR-0003 §2.4).
 */
export interface ProviderProfile {
  readonly id: string;
  /** Toolkit lanes that reach this surface (RS-14 §2 lane→wire map). */
  readonly lanes: readonly string[];
  readonly accounting: ProviderAccounting;
  readonly limitsKnown: boolean;
  readonly cap: ProviderCap;
  readonly quota?: {
    readonly windows: readonly QuotaWindowFact[];
    readonly peak?: PeakWindowFact;
    readonly burnModel?: CreditBurnModel;
  };
  readonly observability: Observability;
  readonly rateLimitHeaders: readonly string[];
  readonly errorSignals: readonly ErrorSignalFact[];
  readonly modelLimits?: Readonly<Record<string, ModelLimitFacts>>;
}

/**
 * The bundled profiles. Id → profile, keyed by the RS-14 profile ids.
 * A lane with no profile here is treated as `limitsKnown: false` (ADVISORY) by
 * ./admission.js; it is never silently treated as unmetered.
 */
export const PROVIDER_PROFILES: Readonly<Record<string, ProviderProfile>> = {
  'anthropic-api': {
    id: 'anthropic-api',
    lanes: ['ai-sdk'],
    accounting: 'modeled-usd',
    limitsKnown: true,
    cap: {
      kind: 'tier-monthly-usd',
      settableVia: 'admin-api',
      enforcedAs: 'http-429',
      provenance: {
        kind: 'documented',
        source: DOC_RATE_LIMITS,
        asOf: '2026-09-25',
        note: 'Tier monthly spend caps (Start/Build/Scale/Custom), pausing at the cap until 00:00 UTC on the 1st. The Enterprise Admin API can read and WRITE spend limits, but never through the worker-facing API key a toolkit lane holds.',
      },
    },
    observability: {
      channel: 'headers',
      headers: [
        'anthropic-ratelimit-requests-limit',
        'anthropic-ratelimit-requests-remaining',
        'anthropic-ratelimit-tokens-remaining',
        'anthropic-ratelimit-input-tokens-remaining',
        'anthropic-ratelimit-output-tokens-remaining',
      ],
      provenance: {
        kind: 'documented',
        source: DOC_RATE_LIMITS,
        asOf: '2026-09-25',
        note: 'Per-minute limit/remaining/reset headers on every response; reset in RFC 3339.',
      },
    },
    rateLimitHeaders: ['retry-after', 'anthropic-ratelimit-requests-remaining'],
    errorSignals: [
      {
        providerCode: 'enforced_spend_limit_reached',
        httpStatus: 429,
        errorClass: 'quota',
        provenance: {
          kind: 'documented',
          source: DOC_RATE_LIMITS,
          asOf: '2026-09-25',
          note: 'Tier spend cap: 429 rate_limit_error with details.error_code enforced_spend_limit_reached and NO retry-after. Resolves at the named month reset, so it is quota, not rate-limit.',
        },
      },
      {
        httpStatus: 429,
        errorClass: 'rate-limit',
        provenance: {
          kind: 'documented',
          source: DOC_RATE_LIMITS,
          asOf: '2026-09-25',
          note: 'Rate-limit 429 carries retry-after and the anthropic-ratelimit-* header set.',
        },
      },
      {
        httpStatus: 400,
        errorClass: 'quota',
        provenance: {
          kind: 'documented',
          source: DOC_RATE_LIMITS,
          asOf: '2026-09-25',
          note: 'A self-set workspace spend limit answers HTTP 400 invalid_request_error beginning "You have reached your specified API usage limits".',
        },
      },
    ],
    modelLimits: {
      'claude-haiku-4-5': {
        maxInputTokens: 200_000,
        maxOutputTokens: 64_000,
        provenance: {
          kind: 'documented',
          source: DOC,
          asOf: '2026-10-01',
          note: 'Model table: context window 200K tokens, max output 64K tokens.',
        },
      },
    },
  },

  'claude-subscription': {
    id: 'claude-subscription',
    lanes: ['subprocess', 'claude-agent'],
    accounting: 'quota',
    limitsKnown: true,
    cap: {
      kind: 'plan-credits',
      settableVia: 'console',
      enforcedAs: 'quota-window',
      provenance: {
        kind: 'documented',
        source: DOC_CODE_COSTS,
        asOf: '2026-09-25',
        note: 'No dollar cap on the subscription itself: usage is a plan allowance of a rolling 5-hour window plus a weekly window, with additional per-model-family limits. Paid usage-credit overage is the only spend-capped extension.',
      },
    },
    quota: {
      windows: [
        {
          id: '5h',
          reset: 'rolling-since-consumption',
          unit: 'model-family-share',
          provenance: {
            kind: 'documented',
            source: DOC_CODE_ERRORS,
            asOf: '2026-09-25',
            note: 'Session limit resets five hours after consumption; both windows count at once.',
          },
        },
        {
          id: 'weekly',
          reset: 'fixed-7d',
          unit: 'model-family-share',
          provenance: {
            kind: 'documented',
            source: DOC_CODE_ERRORS,
            asOf: '2026-09-25',
            note: 'Weekly allowance can be exhausted before the 5-hour window resets.',
          },
        },
      ],
    },
    observability: {
      channel: 'headers',
      headers: [
        'anthropic-ratelimit-unified-5h-status',
        'anthropic-ratelimit-unified-5h-utilization',
        'anthropic-ratelimit-unified-5h-reset',
        'anthropic-ratelimit-unified-7d-status',
        'anthropic-ratelimit-unified-7d-utilization',
        'anthropic-ratelimit-unified-7d-reset',
      ],
      provenance: {
        kind: 'rs14-capture',
        source: `${CAPTURES}cc_out3.json`,
        asOf: '2026-09-25',
        note: 'Full unified quota header set captured on a live 429 (and on 200s after the window reset, cc_200.json): -status, -utilization, -reset (epoch seconds), plus overage-status and representative-claim.',
      },
    },
    rateLimitHeaders: ['anthropic-ratelimit-unified-status', 'retry-after', 'x-should-retry'],
    errorSignals: [
      {
        markerHeader: 'anthropic-ratelimit-unified-status',
        errorClass: 'quota',
        provenance: {
          kind: 'rs14-capture',
          source: `${CAPTURES}cc_out3.json`,
          asOf: '2026-09-25',
          note: 'Unified quota headers present ⇒ plan-window exhaustion (quota), and the unified -reset epoch is the defer-until time. The CLI reports it as "You\'ve hit your session limit · resets 3am" with api_error_status 429, is_error true and subtype still "success" — a failure the envelope does not type.',
        },
      },
      {
        httpStatus: 429,
        errorClass: 'rate-limit',
        provenance: {
          kind: 'documented',
          source: DOC_CODE_ERRORS,
          asOf: '2026-09-25',
          note: '"Server is temporarily limiting requests" is a plain throttle: 429 WITHOUT unified quota headers, retried automatically.',
        },
      },
    ],
  },

  'zai-glm-coding': {
    id: 'zai-glm-coding',
    lanes: ['ai-sdk'],
    accounting: 'quota',
    // Remaining allowance is console-only: no header, no endpoint. The lane can
    // model its own burn but cannot confirm the balance, so quota-aware
    // admission stays ADVISORY (ADR-0003 §2.4).
    limitsKnown: false,
    cap: {
      kind: 'plan-credits',
      amount: 28_000,
      settableVia: 'console',
      enforcedAs: 'quota-window',
      provenance: {
        kind: 'documented',
        source: DOC_ZAI,
        asOf: '2026-10-01',
        note: 'Plan credits: 5-hour and weekly allowances per tier (Lite 2,000/10,000; Pro 12,000/60,000; Max 28,000/140,000). The amount recorded here is the MAX tier pool, the widest a profile may be sized against. Managed in the console only; quota management is not API-settable.',
      },
    },
    quota: {
      windows: [
        {
          id: '5h',
          reset: 'rolling-since-consumption',
          unit: 'credits',
          provenance: {
            kind: 'documented',
            source: DOC_ZAI,
            asOf: '2026-10-01',
            note: '"5-hour credits: Dynamically refreshed; credit quota resets 5 hours after consumption."',
          },
        },
        {
          id: 'weekly',
          reset: 'fixed-7d',
          unit: 'credits',
          provenance: {
            kind: 'documented',
            source: DOC_ZAI,
            asOf: '2026-10-01',
            note: '"Weekly credits: activated upon subscription; resets every 7 days."',
          },
        },
      ],
      peak: {
        days: 'mon-fri',
        timezone: 'Asia/Singapore',
        startHour: 14,
        endHour: 18,
        multiplier: 1,
        offPeakMultiplier: 0.5,
        provenance: {
          kind: 'documented',
          source: DOC_ZAI,
          asOf: '2026-10-01',
          note: '"During off-peak hours, model usage is charged at 50% of the standard credit rate." Peak hours: Monday to Friday, 14:00-18:00 Singapore Standard Time (UTC+8). The dated campaign in that page (2026-09-25 to 2026-10-07, all hours off-peak) is deliberately NOT modelled: it expires.',
        },
      },
      burnModel: {
        divisor: 10_000,
        perMillion: { input: 2.3, cachedInput: 0.56, output: 8 },
        provenance: {
          kind: 'documented',
          source: DOC_ZAI,
          asOf: '2026-10-01',
          note: 'Credit usage = (Input x Input multiplier + Cached Input x Cached Input multiplier + Output x Output multiplier) / 10,000; MCP calls x output multiplier. The multipliers recorded are GLM-5.3-Flash (2.3 / 0.56 / 8); GLM-5.3 is 6.9 / 1.7 / 24 and is keyed per model by the seam owner.',
        },
      },
    },
    observability: {
      channel: 'console-only',
      provenance: {
        kind: 'rs14-capture',
        source: `${CAPTURES}zai_headers.txt`,
        asOf: '2026-09-25',
        note: 'A live 200 carried no quota headers (only x-request-id, x-log-id, acw_tc). Remaining allowance is visible only in the console, so the governed runner must model burn locally and never assume a check call.',
      },
    },
    rateLimitHeaders: [],
    errorSignals: [
      {
        httpStatus: 429,
        errorClass: 'quota',
        provenance: {
          kind: 'documented',
          source: `${CAPTURES}zai_headers.txt`,
          asOf: '2026-09-25',
          note: 'The coding wire answers 200 until the plan allowance is out; the pay-as-you-go wire rejects a plan key with 429 insufficient-balance BY DESIGN. So on this profile a 429 is quota-shaped with no retry-after, i.e. defer to the window reset rather than retry.',
        },
      },
    ],
    modelLimits: {
      'glm-5.3-flash': {
        maxInputTokens: 1_000_000,
        // maxOutputTokens deliberately ABSENT: not confirmed against a vendor page
        // in this lane, so the lane stays ADVISORY for output-bounded W_max.
        provenance: {
          kind: 'documented',
          source: 'https://docs.z.ai/guides/llm/glm-5.3-flash.md',
          asOf: '2026-10-01',
          note: 'Model guide states a 1M-token context window. A 128K output figure appears in the community database and in RS-14 but was not confirmed from a vendor page, so it is not recorded as a published limit.',
        },
      },
    },
  },

  deepseek: {
    id: 'deepseek',
    lanes: ['ai-sdk'],
    accounting: 'modeled-usd',
    limitsKnown: true,
    cap: {
      kind: 'balance-usd',
      settableVia: 'console',
      enforcedAs: 'http-402',
      provenance: {
        kind: 'documented',
        source: DOC_DEEPSEEK_ERR,
        asOf: '2026-09-25',
        note: 'Prepaid balance is the hard cap: HTTP 402 "Insufficient Balance" when empty. No amount is recorded — the balance is account state, not a published figure.',
      },
    },
    observability: {
      channel: 'endpoint',
      usageEndpoint: { method: 'GET', url: 'https://api.deepseek.com/user/balance' },
      provenance: {
        kind: 'documented',
        source: DOC_DEEPSEEK_BAL,
        asOf: '2026-09-25',
        note: 'GET /user/balance returns is_available plus balance_infos. Confirmed reachable with a 200 in the RS-14 capture. This module never calls it.',
      },
    },
    rateLimitHeaders: [],
    errorSignals: [
      {
        httpStatus: 402,
        errorClass: 'quota',
        provenance: {
          kind: 'documented',
          source: DOC_DEEPSEEK_ERR,
          asOf: '2026-09-25',
          note: '402 Insufficient Balance: the funded allowance is empty. Resolves on top-up, not by waiting.',
        },
      },
      {
        httpStatus: 429,
        errorClass: 'rate-limit',
        provenance: {
          kind: 'documented',
          source: DOC_DEEPSEEK_RL,
          asOf: '2026-09-25',
          note: '429 "Rate Limit Reached" is the CONCURRENCY model (deepseek-flash 2500 concurrent, deepseek-v4-pro 500), not a time window; a live 200 carried no rate-limit headers at all.',
        },
      },
    ],
  },

  'openai-api': {
    id: 'openai-api',
    lanes: ['ai-sdk'],
    accounting: 'modeled-usd',
    limitsKnown: true,
    cap: {
      kind: 'tier-monthly-usd',
      settableVia: 'console',
      enforcedAs: 'http-429',
      provenance: {
        kind: 'documented',
        source: DOC_OPENAI_SPEND,
        asOf: '2026-09-25',
        note: 'Usage-tier monthly cap plus org/project hard spend limits set in the dashboard. Not settable through the Messages API; retry-after is explicitly not meaningful on a quota 429.',
      },
    },
    observability: {
      channel: 'headers',
      headers: [
        'x-ratelimit-remaining-requests',
        'x-ratelimit-remaining-tokens',
        'x-ratelimit-reset-requests',
      ],
      provenance: {
        kind: 'documented',
        source: DOC_OPENAI_RL,
        asOf: '2026-09-25',
        note: 'Project-scoped x-ratelimit-* limit/remaining/reset headers; Retry-After on transient 429/503 only.',
      },
    },
    rateLimitHeaders: ['retry-after', 'x-ratelimit-remaining-requests'],
    errorSignals: [
      {
        providerCode: 'credit_balance_exhausted',
        httpStatus: 429,
        errorClass: 'quota',
        provenance: {
          kind: 'rs14-capture',
          source: `${CAPTURES}oa_body.json`,
          asOf: '2026-09-24',
          note: 'Live 429 {"type":"insufficient_quota","code":"credit_balance_exhausted"} with NO Retry-After and no x-ratelimit-* headers on the response. Dashboard hard-limit 429s use organization_/project_spend_limit_exceeded.',
        },
      },
      {
        httpStatus: 429,
        errorClass: 'rate-limit',
        provenance: {
          kind: 'documented',
          source: DOC_OPENAI_RL,
          asOf: '2026-09-25',
          note: 'Transient 429/503 carry Retry-After.',
        },
      },
    ],
  },

  'codex-chatgpt': {
    id: 'codex-chatgpt',
    lanes: ['subprocess'],
    accounting: 'quota',
    // The CLI surfaces remaining usage only in an interactive TUI; a JSON
    // `codex exec --json` event stream carries no quota fields (RS-14 capture).
    limitsKnown: false,
    cap: {
      kind: 'plan-credits',
      settableVia: 'none',
      enforcedAs: 'quota-window',
      provenance: {
        kind: 'documented',
        source: DOC_CODEX_PRICING,
        asOf: '2026-09-25',
        note: 'Shared ChatGPT plan allowance with daily/weekly/cumulative views; weekly limits may apply. Credits can be purchased, but nothing about the plan cap is API-settable.',
      },
    },
    observability: {
      channel: 'cli-interactive',
      provenance: {
        kind: 'rs14-capture',
        source: `${CAPTURES}cx_json.jsonl`,
        asOf: '2026-09-24',
        note: 'A live `codex exec --json` run reported turn.completed usage (input/cached/reasoning tokens) and NO rate-limit or quota fields. Unattended governed runs therefore cannot read remaining allowance.',
      },
    },
    rateLimitHeaders: [],
    errorSignals: [
      {
        errorClass: 'provider-error',
        provenance: {
          kind: 'rs14-capture',
          source: `${CAPTURES}cx_json.jsonl`,
          asOf: '2026-09-24',
          note: 'The exec stream carries no quota marker. Until the seam carries a codex-specific signal, a non-zero exit with usage but no result is classified provider-error, never silently as zero spend.',
        },
      },
    ],
  },

  'opencode-go': {
    id: 'opencode-go',
    lanes: ['subprocess'],
    accounting: 'quota',
    limitsKnown: true,
    cap: {
      kind: 'tier-monthly-usd',
      settableVia: 'console',
      enforcedAs: 'http-402',
      provenance: {
        kind: 'documented',
        source: DOC_OPENCODE_GO,
        asOf: '2026-09-25',
        note: 'Per-model monthly dollar limits released as windows: 5h = 20%, weekly = 50%, monthly = 100% of the model limit. Not API-settable.',
      },
    },
    quota: {
      windows: [
        {
          id: '5h',
          reset: 'rolling-since-consumption',
          fractionOfMonthly: 0.2,
          unit: 'usd',
          provenance: {
            kind: 'documented',
            source: DOC_OPENCODE_GO,
            asOf: '2026-09-25',
            note: 'The 5-hour window releases 20% of the model monthly limit.',
          },
        },
        {
          id: 'weekly',
          reset: 'fixed-7d',
          fractionOfMonthly: 0.5,
          unit: 'usd',
          provenance: {
            kind: 'documented',
            source: DOC_OPENCODE_GO,
            asOf: '2026-09-25',
            note: 'The weekly window releases 50% of the model monthly limit.',
          },
        },
        {
          id: 'monthly',
          reset: 'calendar-month',
          fractionOfMonthly: 1,
          unit: 'usd',
          provenance: {
            kind: 'documented',
            source: DOC_OPENCODE_GO,
            asOf: '2026-09-25',
            note: 'The monthly window is the whole per-model limit.',
          },
        },
      ],
    },
    observability: {
      channel: 'endpoint',
      usageEndpoint: { method: 'GET', url: 'https://opencode.ai/zen/go/v1/usage' },
      provenance: {
        kind: 'rs14-capture',
        source: `${CAPTURES}oc_bal.json`,
        asOf: '2026-09-24',
        note: 'GET /zen/go/v1/usage returned rolling/weekly/monthly status, percent used and resetsAt. Undocumented by the vendor; captured live with a 200.',
      },
    },
    rateLimitHeaders: ['x-opencode-endpoint-id', 'x-opencode-upstream-model-id'],
    errorSignals: [
      {
        httpStatus: 402,
        errorClass: 'quota',
        provenance: {
          kind: 'rs14-capture',
          source: `${CAPTURES}zen_body.json`,
          asOf: '2026-09-24',
          note: 'HTTP 402 {"type":"server_error","message":"Upstream request failed: Insufficient account funds"} observed on the ZEN wire. Known W2.6 hazard: the CLI routes paid models onto Zen even when a Go key is active, so a 402 can mean either allowance — classification must key off the ENDPOINT, not the status alone.',
        },
      },
    ],
  },
};

/** Look a profile up by id; `undefined` when the id is unknown. Never a default profile. */
export function providerProfile(id: string | undefined): ProviderProfile | undefined {
  return id === undefined ? undefined : PROVIDER_PROFILES[id];
}
