// fixReviewItem — E4 slice 1 (goal E4; ws-e item 4): the agentic fix half of
// the review loop. One review item in, one worker invocation out: the op
// composes the prompt, maps the harness config onto the frozen driver-seam
// policies, runs ONE isolated invocation through a DriverFactory-resolved
// driver (ADR-0002 §2.5 — the op never constructs a lane class; the caller/
// registry injects the factory, one resolve per op call, and the factory
// owns the served-model assertion), and folds the WorkerResult into the
// frozen OpResult taxonomy.
//
// Invariants honored here:
//   - I10 (vendor-neutral): prompts and the output contract speak only our
//     vocabulary — repo/pr, worktree, tool names read/edit/write/bash. No vendor
//     CLI or SDK words anywhere in composed text.
//   - R4 (harness policy is DATA): the tool allowlist and the prompt budget
//     are read from the input's HarnessConfig — never hardcoded. The
//     mapping is conservative (below); `defaultHarnessConfig` is the
//     default VALUE, not baked-in policy.
//   - R3 replaces the shipped default prompt AS DATA: `promptOverride`
//     REPLACES `defaultFixPrompt` wholesale (never extends it).
//   - The op never resolves or inspects git itself: `worktree` is resolved
//     upstream by prWorktree.resolvePrWorktree and trusted as the workspace
//     the worker is pointed at.
//
// THE CONSERVATIVE TOOL MAPPING (HarnessConfig → ToolPolicy): mode
// 'allowlist'; `allow` = 'read'/'edit'/'write' when each tool's `enabled` is
// true, plus 'bash' ONLY when bash.enabled AND commandPatterns is non-empty
// — the deny-all default (enabled with zero patterns) stays OUT of the allow
// list, because a tool that can never be exercised must not be advertised
// to the worker. sandboxPolicy is always 'workspace-write' (the harness
// tool surface is designed to pair with it — see harness/config.ts).
//
// PROMPT: system prompt = promptOverride ?? defaultFixPrompt, HEAD-CAPPED
// to harness.promptBudget.maxSystemPromptChars (the budget knob is the
// system-prompt cap, per R4 — enforced HERE, where the prompt is composed).
// The user prompt carries the thread context (repo/pr, item id, anchored
// path+line, item body, prior comments — each head-capped to
// MAX_COMMENT_CHARS — and the worktree path/branch) plus the OUTPUT
// CONTRACT: the worker must make the fix in the worktree, COMMIT it, and
// answer with a single line of JSON {"disposition", "summary", "commits",
// "evidence"} (THE FIX OUTCOME CONTRACT in ./internal/fixContract.ts): commits are
// the full shas it created, evidence the code an unchanged answer cites. The
// single prompt string is system + blank line + user (OpInvocation carries
// one prompt). `truncated: true` rides the ok result when ANY truncation
// fired — the system prompt cap or any comment cap — so a caller never
// mistakes a clipped context for the full one.
//
// THE INVOCATION (ADR-0002 §2.4/§2.3): the PR worktree rides as the
// invocation's workspace binding (the driver binds cwd and harness
// confinement to realpath(workspace.path) — no pre-created session record,
// so no sessionRef), the fix contract rides as the invocation's
// outputSchema (a schema-valid contract object or an 'output-invalid'
// error), and the governed signal rides RunOptions (§2.1). The invocation's
// modelSpec is the FACTORY-NORMALISED spec — a deprecated provider alias
// never reaches a lane or a journal. Session records a workspace-bound run
// creates follow the deployment's retention policy (normally 'keep' — session-log
// preservation plan item 1.2 flipped `retainSessions` to default-true on
// 2026-10-24, superseding round-3 item 14); a caller with a retention
// policy opts out explicitly with `retainSessions: false`. The run JOURNAL
// stays the verdict record; the session file now survives beside it.
//
// STOP-REASON → OpResult MAPPING (mechanical, total):
//   'complete' + parseable structured output (an object with EXACTLY the
//     contract keys and value shapes, or a string holding one JSON line)
//     → ok; a complete run whose structured output is missing, unparseable,
//     or wrong-shaped is a DEFINITIVE contract violation → failed (never a
//     guessed ok); a well-formed contract whose disposition is no outcome
//     (needs_human, no_outcome, or missing its evidence) → needs-human with
//     a NO_OUTCOME_REASON reason (THE FIX OUTCOME CONTRACT — nothing to post).
//   'budget' → budget-exhausted; 'error' → failed with the structured
//     errorClass named in the text for humans only (ADR-0002 §2.9 — the
//     class itself is forwarded nowhere); 'aborted' → indeterminate (no
//     verdict on partial work). A THROWN factory.resolve() or driver.run()
//     is mapped per §2.9: under an already-aborted governed signal it is
//     the governed cancellation (I8) → `indeterminate`; any other throw —
//     the seam's 'config'/'auth' dispatch classes (an unbound role/provider
//     binding, a missing key env, no host CLI for the provider's route) or
//     an UNCLASSIFIED throw — is a dispatch-time environment gap a human
//     must arrange → `needs-human`, never `failed` (which would claim a
//     definitive worker outcome the op never observed; baselineProbe's
//     crashed-runner precedent, review-debt #186).
//   On ok, WorkerResult.usage becomes result.usage, WorkerResult.costUSD
//   (when the driver's price map knew the model) becomes result.costUSD,
//   and denials pass through verbatim; on every other status the worker's
//   evidence has no result to ride (the frozen OpResult carries none) —
//   but its USAGE/COST is still reported to the governor through the job
//   context, so a bounded run's spend is observed (review-debt #185).
import type { DriverFactory } from '../../driver/factory.js';
import { deepFreeze } from '../../shared/deepFreeze.js';
import { defaultHarnessConfig, HarnessConfigSchema } from '../../harness/config.js';
import type { HarnessConfig } from '../../harness/config.js';
import type { Budget, ModelSpec, ToolDenial, Usage } from '../../driver/types.js';
import type { Op } from '../../kernel/types.js';
import type { ThreadComment } from './threads.js';
import type { Finding } from './findings.js';
import { FIX_DISPOSITIONS, NO_OUTCOME_REASON } from './internal/fixContract.js';
import type { FixEvidence } from './internal/fixContract.js';
import { runFixWorker } from './internal/fixWorker.js';
import type { FixWorkerRun } from './internal/fixWorker.js';

// The fix-contract vocabulary is SHARED (./internal/fixContract.ts) so a second op can
// read the worker's typed disposition instead of the needs-human reason
// prose. Re-exported here because this module remains the review.fixItem
// surface its callers and tests import.
export {
  COMMIT_SHA_RE,
  FIX_DISPOSITIONS,
  FixOutputContractSchema as FixReviewItemOutputSchema,
  MAX_EVIDENCE,
  MAX_EVIDENCE_PATH_CHARS,
  MAX_FIX_COMMITS,
  MAX_SUMMARY_CHARS,
  NO_OUTCOME_REASON,
  parseFixContract,
} from './internal/fixContract.js';
export type {
  FixContractParse,
  FixDisposition,
  FixEvidence,
  FixNoOutcome,
  FixOutcome,
} from './internal/fixContract.js';
// The composed-context caps and the fence defanger live with the shared
// worker seam; re-exported here because this module remains the
// review.fixItem surface its callers and tests import.
export { MAX_COMMENT_CHARS, MAX_ITEM_BODY_CHARS, defangFenceLines } from './internal/fixWorker.js';

/**
 * The one review item a fixer worker fixes. Plain JSON, built from the
 * fetched thread vocabulary: the ClassifiedItem/PlannedBatch shapes carry
 * only the verdict routing (id/path/reason) — this is the richer payload
 * the PROMPT needs, so the loop maps the fetched thread/review data into it
 * alongside the planned batch.
 */
export interface FixableReviewItem {
  /**
   * The item's stable source id (GraphQL thread/review node id, or a REST
   * numeric id as a string). Referenced by the commit-message rule so the
   * fix stays traceable to its thread; never re-derived here.
   */
  id: string;
  /** The anchored file path, or null when the item is unanchored (a whole-review summary). */
  path: string | null;
  /** The anchored line, or null when unanchored/outdated. */
  line: number | null;
  /** The item's markdown body — the feedback to fix. */
  body: string;
  /** The prior conversation on the item (root already excluded), in order. */
  comments: ThreadComment[];
}

/**
 * JSON-serializable input of the `review.fixItem` op. Everything is data;
 * the only runtime seam (the Driver) is injected at factory time, NOT here.
 */
export interface FixReviewItemInput {
  /** Repository as "owner/name"; omitted → the prompt omits the repository line. */
  repo?: string;
  /** The pull request number the item was filed on. */
  pr?: number;
  /** The single review item to fix. */
  item: FixableReviewItem;
  /**
   * The resolved per-PR worktree the worker must fix and commit in —
   * resolved upstream by prWorktree.resolvePrWorktree. This op NEVER runs
   * git: it composes the worktree into the prompt, and it binds it as the
   * invocation's workspace (the driver owns cwd and harness confinement
   * there — ADR-0002 §2.4), nothing else.
   */
  worktree: { path: string; branch: string };
  /** Model identity as plain data (ModelSpec); resolved through the DriverFactory (the invocation carries the FACTORY-NORMALISED spec — a deprecated provider alias never reaches a lane or a journal). */
  driver: ModelSpec;
  /**
   * Per-op harness config (R4: the tool allowlist + prompt budget are
   * DATA). Default: `defaultHarnessConfig`.
   */
  harness?: HarnessConfig;
  /**
   * Replaces the shipped default system prompt WHOLESALE (R3 tunes prompts
   * as data) — the op never concatenates it with {@link defaultFixPrompt}.
   */
  promptOverride?: string;
  /** Budget caps for the invocation; passed through verbatim (default {}). */
  budget?: Budget;
}

/** Additive local finding variant; legacy thread callers retain their shape. */
export type FindingReviewItemInput = Omit<FixReviewItemInput, 'item'> & {
  item: { kind: 'finding'; finding: Finding };
};
export type ReviewFixInput = Omit<FixReviewItemInput, 'item'> & {
  item: FixReviewItemInput['item'] | FindingReviewItemInput['item'];
};
export function normalizeReviewFixInput(input: ReviewFixInput): FixReviewItemInput {
  if (!('kind' in input.item)) return input as FixReviewItemInput;
  const finding = input.item.finding;
  return {
    ...input,
    item: {
      id: finding.id,
      path: finding.file ?? null,
      line: finding.line ?? null,
      body: finding.text,
      comments: [],
    },
  };
}

/**
 * The fix report for an `ok` run: the contract triple (changed / summary /
 * commits) parsed from the worker's structured output, plus the worker
 * evidence that rides along. `truncated` is present (true) only when the
 * CONTEXT was clipped while composing — the system prompt, the item body,
 * or a prior comment — and is the loop's resolve-gate signal: a worker
 * that saw a clipped tail may have missed the actual constraint.
 * `summaryTruncated` reports the summary head-cap separately (the summary
 * is the loop's own output; its cap never clips worker context). Both
 * absent otherwise (exactOptionalPropertyTypes: never an explicit
 * undefined).
 */
export interface FixReviewItemResult {
  /** Engine-owned execution identity; never accepted from vendor output. */
  observedHead?: string;
  /** The worker's outcome: only these two dispositions are ok (THE FIX OUTCOME CONTRACT). */
  disposition: 'fixed' | 'unchanged_with_reason';
  /** True exactly when the disposition is `fixed` (kept for v1 consumers such as crq). */
  changed: boolean;
  /** The worker's one-sentence account of what it fixed, or the reason nothing changed. */
  summary: string;
  /** Full shas of the commits the worker created, in worker-reported order. */
  commits: string[];
  /** The code the worker cites; at least one entry for `unchanged_with_reason`. */
  evidence: FixEvidence[];
  /** Present (true) only when the CONTEXT (system prompt / body / comments) was clipped. */
  truncated?: boolean;
  /** Present (true) only when the worker SUMMARY hit its own head-cap. */
  summaryTruncated?: boolean;
  /** Worker-reported tool denials, verbatim. */
  denials: ToolDenial[];
  /** Worker-reported token usage, verbatim (never driver-trusted for USD — callers price it). */
  usage?: Usage;
  /**
   * The worker's DERIVED-ONLY USD cost (DD-2), passed through verbatim from
   * the driver's WorkerResult when the driver's price map knew the model.
   * Absent for an unpriced model — never a fabricated 0. The same figure is
   * folded into the governor's run rollup through the job context
   * (review-debt #185), so a caller reads it here for per-item reporting
   * while the run-level total rides RunReport.costUSD.
   */
  costUSD?: number;
}

/**
 * The shipped fixer harness (round-3 item 9): defaultHarnessConfig with the
 * run allowlist narrowed to the git plumbing a fixer needs — add, commit,
 * status, diff, log, rev-parse — and NOTHING else (token-prefix patterns:
 * any other git subcommand, and any non-git command, is denied). The OP's
 * own default stays `defaultHarnessConfig` (conservative); the PLAN ships
 * this as data so the shipped loop can honestly produce a commit (R4).
 * Deep-frozen and schema-parsed like the shipped default.
 */
export const reviewFixHarness: HarnessConfig = deepFreeze(
  HarnessConfigSchema.parse({
    ...defaultHarnessConfig,
    tools: {
      ...defaultHarnessConfig.tools,
      bash: {
        ...defaultHarnessConfig.tools.bash,
        commandPatterns: [
          'git add',
          'git commit',
          'git status',
          'git diff',
          'git log',
          'git rev-parse',
        ],
      },
    },
  }),
);

/** The pinned ` (session X)` fragment; undefined means no fragment ('' included). */
const sessionOf = (sessionId: string | undefined): string =>
  sessionId === undefined ? '' : ` (session ${sessionId})`;

/** Preserve the pre-seam cancellation detail bytes for each dispatch phase. */
const cancelledDetail = (run: Extract<FixWorkerRun, { kind: 'cancelled' }>): string => {
  if (run.phase === 'resolve') {
    return `fixReviewItem: the fix worker could not be resolved (cancelled): ${run.message}`;
  }
  if (run.phase === 'prompt') {
    return `fixReviewItem: prompt preparation cancelled: ${run.message}`;
  }
  return `fixReviewItem: driver crashed: ${run.message}`;
};

/** Preserve the pre-seam pre-dispatch gap reason bytes for each phase. */
const dispatchGapReason = (run: Extract<FixWorkerRun, { kind: 'dispatch-gap' }>): string => {
  if (run.phase === 'resolve') {
    return `fixReviewItem: the fix worker could not dispatch: ${run.message}`;
  }
  if (run.phase === 'prompt') {
    return `fixReviewItem: invalid harness for prompt preparation: ${run.message}`;
  }
  return `fixReviewItem: driver could not dispatch the worker: ${run.message}`;
};

/**
 * Build the `review.fixItem` op over the injected DriverFactory (ADR-0002
 * §2.5 — the worker seam; the op never constructs a lane class and adds no
 * served-model assertion: the factory wraps every resolved driver). The op
 * is otherwise pure composition + parsing: it runs exactly one invocation
 * per call (I6 — a fresh isolated worker per item, no session reuse, no
 * retries; attempt policy is the caller's), resolves ONE DriverRequest per
 * call (role 'fixer', the input's ModelSpec, the input's harness, the
 * session-retention flag below), maps the stop reason per the module-doc
 * table, and on ok parses the structured output STRICTLY — a complete run
 * without a parseable fix contract (or with a changed↔commits
 * contradiction) is a definitive contract violation (`failed`), never a
 * guessed ok.
 */
export function makeFixReviewItem(deps: {
  /**
   * The worker seam: the factory resolves ONE request per op call —
   * role 'fixer', the input's ModelSpec, the harness below, the retention
   * flag below — to the constructed, served-model-wrapped lane. The
   * factory's default binding puts the 'fixer' role on the ai-sdk lane for
   * the default providers; a provider that is neither a default provider
   * nor bound for the role throws 'config' pre-dispatch (the op folds it
   * to `needs-human`, module doc).
   */
  drivers: DriverFactory;
  /**
   * Keep the fresh session record a workspace-bound run created. Default
   * follows the factory deployment policy when absent (normally keep): the
   * session file is evidence and the default location is now durable
   * (item 1.1), so the store keeps it. Reaping is an explicit opt-out —
   * `retainSessions: false` maps to DriverRequest sessionRetention
   * 'reap-on-settle' for callers with a retention policy. (Was FALSE until
   * 2026-10-24: the default dir was tmpfs and the run JOURNAL was deemed
   * the only audit trail — round-3 item 14. The journal still carries the
   * verdict; the session file now survives beside it.)
   */
  retainSessions?: boolean;
}): Op<ReviewFixInput, FixReviewItemResult> {
  return async (raw: ReviewFixInput) => {
    const input = normalizeReviewFixInput(raw);
    const run = await runFixWorker(input, deps);
    if (run.kind === 'cancelled') {
      return { status: 'indeterminate', detail: cancelledDetail(run) };
    }
    if (run.kind === 'dispatch-gap') {
      return { status: 'needs-human', reason: dispatchGapReason(run) };
    }
    if (run.kind === 'request-refused') {
      // review.fixItem never sets a request bound; this branch is defensive
      // so the typed seam is total.
      return {
        status: 'failed',
        error: `fixReviewItem: prepared request exceeded an unexpected ${run.maxChars}-character dispatch bound`,
      };
    }
    if (run.kind === 'budget') {
      return { status: 'budget-exhausted' };
    }
    if (run.kind === 'aborted') {
      return {
        status: 'indeterminate',
        detail: `fixReviewItem: driver aborted the run${sessionOf(run.worker.sessionId)}`,
      };
    }
    if (run.kind === 'error') {
      const detail = run.errorText === undefined ? '' : `: ${run.errorText}`;
      // ADR-0002 §2.9: EVERY error verdict → 'failed', with the structured
      // class named in the text (errorClass=<x>) for humans only — the
      // structured class itself is forwarded nowhere (the invocation gate
      // records it on reservation-settled).
      const classText = run.errorClass === undefined ? '' : `; errorClass=${run.errorClass}`;
      return {
        status: 'failed',
        error: `fixReviewItem: driver reported an error stop${sessionOf(run.worker.sessionId)}${classText}${detail}`,
      };
    }
    const parsed = run.contract;
    const session = sessionOf(run.worker.sessionId);
    if (parsed.kind === 'invalid') {
      return {
        status: 'failed',
        error: `fixReviewItem: complete run carried no parseable fix contract — structured output must be an object with exactly the keys disposition/summary/commits/evidence (disposition one of ${FIX_DISPOSITIONS.join('|')}; commits only for fixed) or a single JSON line with them${session}`,
      };
    }
    // NO OUTCOME (module doc on THE FIX OUTCOME CONTRACT): nothing to post,
    // and no commits, so the loop leaves the thread unsettled without
    // withholding its siblings.
    if (parsed.kind === 'no-outcome') {
      return {
        status: 'needs-human',
        reason: `${NO_OUTCOME_REASON} — ${parsed.reason.slice(0, 200)}${session}`,
      };
    }
    return {
      status: 'ok',
      value: {
        disposition: parsed.disposition,
        changed: parsed.disposition === 'fixed',
        summary: parsed.summary,
        commits: parsed.commits,
        evidence: parsed.evidence,
        ...(run.contextTruncated ? { truncated: true } : {}),
        ...(parsed.summaryTruncated ? { summaryTruncated: true } : {}),
        denials: run.worker.denials,
        usage: run.worker.usage,
        ...(run.worker.costUSD !== undefined ? { costUSD: run.worker.costUSD } : {}),
      },
    };
  };
}
