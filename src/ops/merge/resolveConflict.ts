// resolveConflict — the merge family's conflict agent (goal F4, ws-f scope
// item 4; UC §3 row 44): the WRITE-CAPABLE worker that resolves a PR's merge
// conflict inside a prepared worktree and commits the resolution locally;
// THE OP THEN PUBLISHES the resolved branch itself, behind a fail-closed
// denylist scan (issue #1193 — the worker never pushes, so no upload path
// exists that has not passed the scan). It is the repo's FIRST
// driver-consuming op: the worker is reached only through the frozen Driver
// seam (src/driver/types.js — run(OpInvocation, RunOptions?) →
// WorkerResult), never through a vendor SDK, and the worker itself arrives
// through a DriverFactory (ADR-0002 §2.5 — the op never constructs a lane
// class; the factory binds role + provider → lane and owns the
// served-model assertion). Every other I/O surface (git/gh via
// MergeEffects, the prompt file, the output parser) arrives as an
// injectable dep — the whole flow below is testable with zero real
// processes, networks, or filesystems.
//
// THE SANDBOX TRAP (UC row 44, I11-adjacent — read before touching the
// invocation): the frozen SandboxPolicy carries an isolation LEVEL and no
// network field, and a lane MAY map workspace-write onto an egress-blocking
// sandbox — but this agent MUST fetch the base branch over the network
// (`git fetch origin <baseBranch>` is the resolution flow's step 1), so
// requesting workspace-write here would still be wrong at the seam level.
// Level 'none' — "no isolation requested" — is the only honest request for
// a network-needing op under this policy. It is not a grant of anarchy —
// but neither is it confinement: there is NO OS-level confinement on this
// seam. The worktree is bound as the invocation's workspace (the driver
// binds cwd and harness confinement to it); the bounds that remain are
// the allowlisted tool surface ({read, edit, bash}
// in allowlist mode), the prompt's hard constraints (no push at all — the
// publication is the op's; no force, no squash, no rebase, no amend, no
// protected-branch destination), and the wall-clock budget REQUEST
// (Budget.wallClockMs) — a request on the seam, not an enforcement: its
// wiring is deferred (review-debt #137), so it is not currently a bound on
// live paths. A future sandbox that does carry network semantics must
// re-derive this. RESIDUAL RISK (recorded, not solved, by #1193): bash
// remains in the worker's surface, so on a lane with ambient push
// credentials and no egress confinement a misbehaving worker could still
// push outside the gate — the gate removes the push from the worker's
// CONTRACT and makes the op's own publication path scanned; OS-level
// credential confinement stays the seam's deferred work.
//
// THE DECISION CONTRACT (the op's output vocabulary, UC row 44): the agent
// ends with EXACTLY ONE JSON line {"decision":"acted|escalate","summary":
// "…"}. parseMergeConflictDecision is the tolerant reader: the object form,
// or that line embedded in narration ('escalated' normalizes to 'escalate';
// the LAST valid line wins — the agent's final word). Fail-closed posture:
// prose with no valid decision line is a CONTRACT VIOLATION → 'failed',
// never a guessed success and never 'needs-human' — needs-human is
// reserved for a DECIDED escalation, because callers treat it as "a human
// owes a decision here", which garbled output does not establish. 'acted'
// MEANS: the resolution is committed on the prepared worktree's branch and
// nothing was pushed (the prompt defines it; the op verifies and publishes).
//
// THE FLOW (every worker/agent outcome lands in the frozen OpResult
// taxonomy; the op never throws for one — only a true bug may):
//   a. Input schema validation is the REGISTRY's job (the dispatch seam
//      re-parses through inputSchema before the op runs); the op enforces
//      only the RUNTIME requirement — reaching dispatch without
//      input.modelSpec is 'failed', never a fabricated vendor default
//      (the plan may bind the spec late; dispatch may not).
//   b. fetchRef(headRefFor(pr)) then validateRef(headRefFor(pr)) — the
//      fetch makes the head's truth local, the validate captures the
//      PRE-dispatch BASELINE sha the publication gate (h) scans against.
//      A nonzero fetch or a throwing validate → 'failed', fail
//      closed before any worktree exists; an UNRESOLVABLE head (validate
//      !ok) is unverifiable, not failed — the flow proceeds and the gate
//      later refuses publication (the change cannot be scoped).
//   c. withPreparedWorktree (effects.js) owns prepare → fn →
//      remove-in-finally; the op never calls worktreePrepare/Remove
//      itself. A throw out of it (spawn-level worktree failure, or a
//      fault inside fn) is an op OUTCOME here → 'failed'
//      with the message, not a crash. KNOWN WEDGE (review-debt #143): a
//      non-acted outcome after the agent started can leave a DIRTY tree,
//      which the frozen no-force worktreeRemove refuses (and which the
//      lifecycle swallows when fn itself resolved) — the wedge surfaces
//      LOUDLY at the next prepare for that pr (worktree add refuses the
//      existing path), but recovery until then is manual: git worktree
//      remove --force / prune. A guarded cleanup shape in the effects
//      allowlist is the deferred fix.
//   d. Inside: the prompt is rendered from prompts/conflict.default.md
//      with the seven vars.
//   e. ONE resolved.driver.run: toolPolicy allow ['read','edit','bash']
//      mode 'allowlist'; sandboxPolicy level 'none' (the trap above);
//      budget.wallClockMs default DEFAULT_RESOLVE_WALL_CLOCK_MS. The
//      invocation binds the prepared worktree as its workspace
//      (ADR-0002 §2.4 — the driver owns cwd and confinement; no
//      pre-created session record, so no sessionRef) and carries the
//      decision schema (§2.3 — a schema-valid decision object or an
//      'output-invalid' error). The governed signal rides RunOptions
//      (§2.1). DriverRequest.sessionRetention stays at its 'keep'
//      default: the session record a workspace-bound run creates is
//      worker evidence, and the failure payloads below point humans at
//      the WorkerResult's sessionId when the driver reported one.
//   f. stopReason mapped FIRST: aborted → 'indeterminate' (partial work
//      may exist in the worktree), budget → 'budget-exhausted', error →
//      'failed' (the errorClass named in the text for humans; denials as
//      the narration hint); only 'complete' reaches the parser.
//   g. parse(structuredOutput) — object or raw-text tolerant path; a
//      MergeConflictContractError → 'failed' (fail closed — silence is
//      never success).
//   h. decision 'escalate' → 'needs-human' with the summary as the reason
//      ('' → the default reason), short-circuiting BEFORE the gate.
//      Escalation NEVER lands in a value. decision 'acted' enters THE
//      PUBLICATION GATE (issue #1193, contract item 17 — no upload path
//      may publish unscanned content):
//        1. an unresolvable pre-dispatch baseline → the resolved change
//           cannot be scoped for the scan → 'needs-human', nothing
//           pushed;
//        2. the resolution commit is located on the prepared worktree's
//           branch (mergeWorktreeBranchFor — a ref the op derives, never
//           agent output): unresolvable → 'needs-human' (the commit
//           claim is unsubstantiated), still the baseline sha →
//           'indeterminate' (no commit was created — callers assume
//           neither success nor failure, the old unverifiable-acted
//           posture), a validating THROW → 'failed' (totality);
//        3. the publication TOPOLOGY is proven (review P1 rounds 2-3).
//           The prompt's own flow — fetch the base, merge FETCH_HEAD,
//           one normal merge commit — is a TWO-PARENT merge, so two
//           shapes are publishable: (A) exactly one parent equal to the
//           validated baseline, or (B) exactly two parents with
//           parent[0] === baseline — a merge of the prepared head with
//           the base — accepted only when the second parent is PUBLIC
//           base history: the forge-read base tip (readBaseRef's
//           baseTipSha) or an ancestor of it (isAncestor — the base may
//           have advanced after the worker's fetch). Everything else —
//           parent[0] ≠ baseline (the add-then-remove intermediate),
//           >2 parents, zero parents, unreadable topology, a second
//           parent that is not public, an unreadable forge base state —
//           refuses ('refusing to publish unscanned history') BEFORE
//           the diff read and any push; plumbing THROWS are 'failed'
//           (totality);
//        4. effects.diffPatch reads the zero-context patch
//           baseline..resolvedSha — EXACTLY the content the publication
//           push adds beyond the head's current public state. Nonzero or
//           throwing → 'failed' (the change is UNSCANNABLE — a partial
//           patch is never scanned, and unscannable is never published);
//        5. the patch's ADDED lines (what a push publishes; removed
//           lines leave the forge) are scanned through the
//           DiffSecretScanner seam (deps.scan; default
//           makeRepoDiffScanner(repoRoot) — the repo's own
//           policy/denylist/patterns.yml, lazily parsed, fail-closed).
//           ANY hit → 'needs-human' naming the rule ids and files
//           (matched content is never quoted); a scanner FAULT →
//           'needs-human' (the human arranges the scanner). NOTHING is
//           pushed on either path — refuse, not document;
//        6. clean → the op publishes: effects.pushRef('<resolvedSha>:
//           refs/heads/<headBranch>') from the worktree, through the
//           I3-guarded seam (no force, no deletion, never the protected
//           branch). Exit 0 IS the publication fact — git push exits 0
//           only when the forge moved the ref, which replaces the old
//           fetch-again-and-compare-sha self-report verification (the
//           attribution limit — a moved sha never proved the AGENT moved
//           it — is gone with the self-reported push). Nonzero →
//           'failed' with stderr; a THROW → 'failed' (totality).
//
// STATUS MAPPING FOR THROWS (ADR-0002 §2.9, normative): a thrown
// factory.resolve() or driver.run() under an already-aborted governed
// signal is the governed cancellation (I8) → 'indeterminate'; any other
// throw — the seam's 'config'/'auth' dispatch classes (an unknown
// provider/role binding, a missing key env) or an UNCLASSIFIED throw —
// is a misconfiguration or a lane bug the human arranges → 'needs-human'
// (review-debt #186). The op never rethrows a dispatch outcome.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createDriverFactory } from '../../driver/factory.js';
import type { DriverFactory, ResolvedDriver } from '../../driver/factory.js';
import { toOutputSchema } from '../../driver/common/structured.js';
import { boundedErrorText } from '../../driver/error-text.js';
import type { ModelSpec, Usage, WorkerResult } from '../../driver/types.js';
import type { HarnessConfig } from '../../harness/config.js';
import { currentJobContext } from '../../kernel/governor.js';
import { correlationInvocation } from '../../driver/correlationInvocation.js';
import { ModelSpecSchema } from '../../kernel/schema.js';
import type { Op, OpResult } from '../../kernel/types.js';
import type { GhResult } from '../../adapters/forge-github/gh.js';
import {
  headRefFor,
  mergeWorktreeBranchFor,
  realMergeEffects,
  withPreparedWorktree,
} from '../../adapters/forge-github/mergeEffects.js';
import type { MergeEffects } from '../../adapters/forge-github/mergeEffects.js';
import { addedLineComponents, makeRepoDiffScanner } from '../dev/denylist.js';
import type { ComponentScan, DiffSecretScanner } from '../dev/denylist.js';
import type { CqEnv } from '../../config/env.js';
import { bareBranch, stripRefsHeads } from '../../config/values.js';
import { assertProtectedBranchMirror } from './trustMirrors.js';

// ---------------------------------------------------------------------------
// The decision contract — pure, heavily tested
// ---------------------------------------------------------------------------

/** The conflict agent's decision vocabulary (UC row 44): 'acted' — the
 * resolved branch was pushed; 'escalate' — a human must resolve it. */
export type MergeConflictDecisionValue = 'acted' | 'escalate';

/** A parsed decision: the normalized value plus the agent's one-sentence
 * summary ('' when none was given). */
export interface MergeConflictDecision {
  decision: MergeConflictDecisionValue;
  summary: string;
}

/** The RAW worker-facing shape before normalization: 'escalated' is an
 * accepted alias for 'escalate'. Unknown keys are tolerated. */
export interface RawMergeConflictDecision {
  decision: 'acted' | 'escalate' | 'escalated';
  summary?: string;
}

/**
 * The worker-facing decision schema — the invocation's outputSchema (the
 * contract the lane enforces, §2.3) AND the parser's object gate.
 * Deliberately NOT `.strict()`: unknown keys are tolerated (zod strips
 * them) exactly as the parser's object contract demands — a strict mirror
 * here would make the lane DROP decisions the contract accepts, flipping a
 * tolerable output into a fabricated failure.
 */
export const MergeConflictDecisionSchema: z.ZodType<RawMergeConflictDecision> = z.object({
  decision: z.enum(['acted', 'escalate', 'escalated']),
  summary: z.string().exactOptional(),
});

/**
 * The invocation's structured-output contract (ADR-0002 §2.3): the SAME
 * tolerant schema the parser judges, rendered once as plain data. The
 * lane must settle a schema-valid decision object or an
 * 'output-invalid' error — either way the op's own strict parse (g)
 * stays the output gate.
 */
const RESOLVE_DECISION_OUTPUT_SCHEMA = toOutputSchema(
  'merge.resolveConflict/v1',
  MergeConflictDecisionSchema,
);

/** The contract text every violation message states (the UC row 44 output
 * contract), so an operator reading the error sees the required shape. */
const DECISION_CONTRACT =
  'a single JSON line {"decision":"acted|escalate","summary":"…"} (or an object with decision acted|escalate|escalated and an optional string summary)';

/** A ≤200-char prefix of `text` — over-long agent output must not bloat an
 * OpResult error. */
const bounded = (text: string): string => (text.length <= 200 ? text : `${text.slice(0, 200)}…`);

/** The offending input as bounded text for an error message (non-strings
 * are JSON-stringified; unserializable values fall back to String). */
const textOfRaw = (raw: unknown): string => {
  if (typeof raw === 'string') return raw;
  try {
    return JSON.stringify(raw) ?? String(raw);
  } catch {
    return String(raw);
  }
};

/**
 * Thrown by parseMergeConflictDecision when the agent's output cannot be
 * read as a decision. Carries a bounded prefix of the offending text.
 * Callers map this to 'failed' — fail closed, never a guessed success.
 */
export class MergeConflictContractError extends Error {
  /** Bounded (≤200 chars) prefix of the offending text. */
  readonly rawPrefix: string;

  constructor(rawText: string) {
    const prefix = bounded(rawText);
    super(
      `merge conflict decision contract violated — expected ${DECISION_CONTRACT}; got: ${prefix}`,
    );
    this.name = 'MergeConflictContractError';
    this.rawPrefix = prefix;
  }
}

/** The decision an object carries when it satisfies the contract (unknown
 * keys tolerated, 'escalated' normalized), else undefined. */
const decisionFromObject = (candidate: unknown): MergeConflictDecision | undefined => {
  const parsed = MergeConflictDecisionSchema.safeParse(candidate);
  if (!parsed.success) return undefined;
  return {
    decision: parsed.data.decision === 'escalated' ? 'escalate' : parsed.data.decision,
    summary: parsed.data.summary ?? '',
  };
};

/**
 * THE TOLERANT READER (UC row 44): accept the decision object directly, or
 * find it in raw worker text — line by line, non-JSON lines are narration
 * and skipped silently, every parsed line is probed against the contract,
 * and the LAST valid one wins (the agent's final word). Prose with no
 * valid decision line throws MergeConflictContractError, as does any
 * non-object, non-string input.
 */
export function parseMergeConflictDecision(raw: unknown): MergeConflictDecision {
  if (typeof raw === 'string') {
    let last: MergeConflictDecision | undefined;
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      let candidate: unknown;
      try {
        candidate = JSON.parse(trimmed);
      } catch {
        continue; // narration, not a decision
      }
      const decision = decisionFromObject(candidate);
      if (decision !== undefined) last = decision;
    }
    if (last !== undefined) return last;
    throw new MergeConflictContractError(raw);
  }
  const decision = decisionFromObject(raw);
  if (decision !== undefined) return decision;
  throw new MergeConflictContractError(textOfRaw(raw));
}

// ---------------------------------------------------------------------------
// Input — the registry-time mirror + the runtime input
// ---------------------------------------------------------------------------

/**
 * A CONSERVATIVE git refname (project branch names), enforced at the JSON
 * boundary on headBranch/baseBranch: must start with a letter, digit, '_',
 * or '.', continue with only [A-Za-z0-9._/-], contain no '..' sequence, and
 * stay within 250 characters. Conservative BY DESIGN — legal-but-exotic
 * refnames are rejected (fail closed). The injection class this kills is
 * shell metacharacters interpolated into the prompt's example commands
 * (topic$(touch x)); the guarded-seam push alternative is deferred
 * (review-debt #141).
 */
const REFNAME_REASON = 'must be a conservative git refname (project branch names)';
const conservativeRefname = (): z.ZodString =>
  z
    .string()
    .max(250, `${REFNAME_REASON}: longer than 250 characters`)
    .regex(
      /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/,
      `${REFNAME_REASON}: must start with a letter, digit, '_' or '.', and use only [A-Za-z0-9._/-] — never a leading '-', a space, or a shell metacharacter ('~', '^', ':', '?', '*', '[', '\\', '$', '@{')`,
    )
    .regex(/^(?!.*\.\.).*$/, `${REFNAME_REASON}: must not contain the '..' sequence`);

/** The conflict agent's input (UC row 44). */
export interface ResolveConflictInput {
  /** The PR whose conflict is resolved (the worktree checks out
   * refs/pull/<pr>/head). */
  pr: number;
  /** Absolute path of the checked-out repository (the effects target). */
  repoRoot: string;
  /** The PR's head branch name — the push destination for the resolved
   * branch. A conservative git refname (schema-gated; see
   * conservativeRefname). */
  headBranch: string;
  /** The branch the PR stacks onto — what the agent merges INTO the
   * worktree. A conservative git refname (schema-gated; see
   * conservativeRefname). */
  baseBranch: string;
  /** Optional seeded conflict file list surfaced to the agent. */
  conflictFiles?: string[];
  /**
   * REQUIRED AT RUNTIME when the agent is dispatched; optional at the
   * schema boundary so the plan can bind it late (runPrs, slice 2). An op
   * call that reaches dispatch without one fails — never a fabricated
   * vendor default.
   */
  modelSpec?: ModelSpec;
  /** Per-invocation wall-clock budget; default DEFAULT_RESOLVE_WALL_CLOCK_MS
   * (UC row 44's 20-minute bound). */
  wallClockMs?: number;
  /** The branch the agent may never push to (prompt constraint). Must equal the
   * resolved CQ_MERGE_PROTECTED_BRANCH (default 'main') or be absent; a
   * difference fails with `config`. */
  protectedBranch?: string;
}

/**
 * Registry-time mirror of {@link ResolveConflictInput}: the full input, and
 * only it. `modelSpec` stays OPTIONAL here (a plan binds it late) while the
 * op itself fails at dispatch when it is absent — the schema admits the
 * late-bound shape, the op enforces the runtime requirement.
 */
export const MergeConflictInputSchema: z.ZodType<ResolveConflictInput> = z
  .object({
    pr: z.number().int().positive(),
    repoRoot: z.string().min(1),
    headBranch: conservativeRefname(),
    baseBranch: conservativeRefname(),
    conflictFiles: z.array(z.string().min(1)).exactOptional(),
    modelSpec: ModelSpecSchema.exactOptional(),
    wallClockMs: z.number().int().positive().exactOptional(),
    protectedBranch: z.string().min(1).exactOptional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Prompt rendering + constants
// ---------------------------------------------------------------------------

/**
 * The default per-invocation wall-clock budget (UC row 44's 20-minute
 * conflict-agent bound), forwarded as Budget.wallClockMs.
 */
export const DEFAULT_RESOLVE_WALL_CLOCK_MS = 20 * 60 * 1000;

/**
 * Render the conflict prompt: a simple global `{{key}}` replace, no
 * dependency. Unknown placeholders in the template are left as-is; vars
 * with no placeholder in the template are ignored.
 */
export function renderConflictPrompt(template: string, vars: Record<string, string>): string {
  // ONE pass, inert by construction: a value containing a LATER
  // placeholder must never be re-rendered (second-order injection) — the
  // replacement callback maps each key exactly once. Unknown placeholders
  // are left as-is; vars with no placeholder in the template are ignored.
  const keys = Object.keys(vars);
  if (keys.length === 0) return template;
  const escapedKeys = keys.map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const placeholder = new RegExp(`\\{\\{(${escapedKeys.join('|')})\\}\\}`, 'g');
  return template.replace(placeholder, (_match, key: string) => vars[key] ?? _match);
}

// ---------------------------------------------------------------------------
// The op factory
// ---------------------------------------------------------------------------

/** The ok value: the resolved branch was pushed — by the OP, after the
 * fail-closed pre-push scan (issue #1193); never by the worker. Escalation
 * NEVER lands in a value — it IS needs-human, and so does every scan
 * refusal (a scan hit or scanner fault stops publication before any
 * push). */
export interface ConflictResolutionValue {
  pr: number;
  decision: 'acted';
  summary: string;
  /**
   * The worker's token usage, verbatim (DD-2: never driver-trusted for
   * USD). Absent when the driver reported none; also reported to the run
   * governor through the job context (review-debt #185).
   */
  usage?: Usage;
  /**
   * The worker's DERIVED-ONLY USD cost, when the driver's price map knew
   * the served model; absent for an unpriced model, never a fabricated 0.
   * Folded into the run governor's rollup through the job context so the
   * merge plan's spend is observable (review-debt #185).
   */
  costUSD?: number;
}

/** Injectable seams — every default is production-real; every override is
 * a test seam (fakes give the whole flow zero real I/O). */
export interface ResolveConflictDeps {
  /** The resolved config snapshot the protectedBranch mirror is checked against. Default: readCqEnv(). */
  cqEnv?: CqEnv;
  /** Default: realMergeEffects({ repoRoot: input.repoRoot, protectedBranch? })
   * built lazily per call. */
  effects?: MergeEffects;
  /**
   * The worker seam (ADR-0002 §2.5): the factory resolves ONE request per
   * op call — role 'conflict-resolver', the input's modelSpec, the harness
   * below — to the constructed, served-model-wrapped lane. Default:
   * createDriverFactory() (the conservative bindings: every default
   * provider on the ai-sdk lane; an unbound provider throws 'config').
   */
  drivers?: DriverFactory;
  /**
   * The deprecated-alias notice sink carried onto the DEFAULT factory's
   * DriverFactoryConfig (PR #238 review P2) — the dispatch wiring the
   * registry importer binds. Inert when `drivers` is supplied (an explicit
   * factory IS the notice surface). Default: none — the library default,
   * one stderr line.
   */
  onDeprecatedAlias?: (message: string) => void;
  /**
   * Harness config carried on the DriverRequest (tool surface plus the
   * sandbox/path restrictions the harness maps per lane). The SHIPPED
   * default is `defaultHarnessConfig` — run-deny-all. A live-capable
   * config is wired by the caller (F5 exercises the scripted-agent path
   * via a factory bound to the fixture lane).
   */
  harnessConfig?: HarnessConfig;
  /** Default: reads prompts/conflict.default.md beside this module. */
  loadPrompt?: () => Promise<string>;
  /** Default: the real tolerant parser. */
  parse?: typeof parseMergeConflictDecision;
  /**
   * The PRE-PUSH denylist scanner (issue #1193): called with the resolved
   * change's added-line components before ANY push; any hit or a thrown
   * fault stops publication (needs-human, nothing pushed). Default:
   * makeRepoDiffScanner(input.repoRoot) — the TARGET REPO's own
   * policy/denylist/patterns.yml (the rules the repo runs on itself),
   * lazily read+parsed on the scanner's first call, so a missing or
   * malformed file faults the gate at publication time — a refused push,
   * never an unscanned one. SDK callers compose more nets on this seam
   * (composeScanners(gitleaksDefaults, repoRules) — the dev lane's
   * pattern) without touching the op.
   */
  scan?: DiffSecretScanner;
}

/** The conflict prompt template, read beside this module. */
const defaultLoadPrompt = async (): Promise<string> =>
  readFile(fileURLToPath(new URL('./prompts/conflict.default.md', import.meta.url)), 'utf8');

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** stderr as a message suffix (empty stderr adds nothing). */
const stderrSuffix = (stderr: string): string => {
  const trimmed = stderr.trim();
  return trimmed === '' ? '' : `: ${trimmed}`;
};

/** The session handle appended to failure/indeterminate payloads that
 * follow a completed driver run — an operator locates the session record
 * with it. Absent session → empty suffix (pre-driver failures carry
 * none). */
const sessionSuffix = (result: WorkerResult): string =>
  result.sessionId === undefined ? '' : ` (session ${result.sessionId})`;

/**
 * Build the conflict agent op (the family's first driver consumer). See the
 * module doc for the flow and the sandbox trap; every outcome maps into the
 * frozen OpResult taxonomy and the op never throws for a worker/agent
 * outcome.
 */
export function makeResolveConflictOp(
  deps: ResolveConflictDeps = {},
): Op<ResolveConflictInput, ConflictResolutionValue> {
  return async (input): Promise<OpResult<ConflictResolutionValue>> => {
    // (a) The registry owns schema validation; the op enforces only the
    // RUNTIME requirement: dispatch without a ModelSpec fails — a vendor
    // default is never fabricated.
    const resolvedProtected = assertProtectedBranchMirror(
      'merge.resolveConflict',
      input.protectedBranch,
      deps.cqEnv,
    );
    const { modelSpec } = input;
    if (modelSpec === undefined) {
      return {
        status: 'failed',
        error:
          'resolveConflict: input.modelSpec is required to dispatch the conflict agent — bind a ModelSpec in the plan input (none is fabricated)',
      };
    }
    // (a, cont.) STRUCTURAL, before ANY effect: the head branch must never
    // BE the protected branch — resolving a conflict whose PUBLICATION
    // destination IS the protected branch is refused outright (a
    // cross-field rule the schema cannot express). BOTH spellings count
    // (codex review): a bare name and its refs/heads/<name> form name the
    // same ref, and the gate's publication refspec builds on headBranch —
    // `HEAD:refs/heads/main` would target the protected branch
    // through a bare-name-only comparison.
    if (
      bareBranch(input.headBranch) === resolvedProtected ||
      stripRefsHeads(input.headBranch) === resolvedProtected
    ) {
      return {
        status: 'failed',
        error:
          'headBranch equals the protected branch — refusing to resolve a conflict whose publication destination is the protected branch',
      };
    }

    const wallClockMs = input.wallClockMs ?? DEFAULT_RESOLVE_WALL_CLOCK_MS;
    const protectedBranch = resolvedProtected;
    const parse = deps.parse ?? parseMergeConflictDecision;
    const loadPrompt = deps.loadPrompt ?? defaultLoadPrompt;
    // RESOLVE ONCE, BEFORE ANY EFFECT (ADR-0002 §2.5): role + provider →
    // the constructed, served-model-wrapped lane. The factory wraps the
    // served-model assertion itself, so the op adds none. A resolve throw
    // is a PRE-DISPATCH failure carrying a structured class (an unbound
    // provider/role is 'config') — mapped by the §2.9 throw rows: under an
    // already-aborted governed signal the dispatch died before it started
    // → 'indeterminate'; any other throw is a misconfiguration or a lane
    // bug the human arranges → 'needs-human'. Fail-closed ordering: this
    // precedes the truth fetch, so an unresolvable binding never creates a
    // worktree.
    let resolved: ResolvedDriver;
    try {
      resolved = (
        deps.drivers ??
        createDriverFactory(
          // The dispatch wiring's alias-notice sink (PR #238 review P2)
          // rides the DEFAULT factory's config; absent, the library default
          // — one stderr line — is unchanged.
          {
            ...(deps.onDeprecatedAlias !== undefined
              ? { onDeprecatedAlias: deps.onDeprecatedAlias }
              : {}),
            // The same entry snapshot the protected-branch mirror uses; the
            // default factory's session-logs and CQ_SESSIONS_DIR reads bind to it.
            ...(deps.cqEnv !== undefined ? { cqEnv: deps.cqEnv } : {}),
          },
        )
      ).resolve({
        role: 'conflict-resolver',
        modelSpec,
        ...(deps.harnessConfig !== undefined ? { harness: deps.harnessConfig } : {}),
      });
    } catch (err) {
      if (currentJobContext()?.signal.aborted === true) {
        return {
          status: 'indeterminate',
          detail: `resolveConflict: the conflict agent could not be resolved for pr ${input.pr} (cancelled): ${errorMessage(err)}`,
        };
      }
      return {
        status: 'needs-human',
        reason: `resolveConflict: the conflict agent could not dispatch for pr ${input.pr}: ${errorMessage(err)}`,
      };
    }

    // (b) Truth first: fetch the PR head ref. A nonzero exit means the
    // truth is unavailable — fail closed before any worktree exists.
    const ref = headRefFor(input.pr);
    const effects =
      deps.effects ??
      realMergeEffects({
        repoRoot: input.repoRoot,
        protectedBranch: resolvedProtected,
      });
    let fetched: GhResult;
    try {
      fetched = await effects.fetchRef(ref);
    } catch (err) {
      return {
        status: 'failed',
        error: `resolveConflict: fetchRef ${ref} for pr ${input.pr} threw: ${errorMessage(err)}`,
      };
    }
    if (fetched.code !== 0) {
      return {
        status: 'failed',
        error: `resolveConflict: fetch ${ref} failed (exit ${fetched.code})${stderrSuffix(fetched.stderr)} — the head's truth is unavailable`,
      };
    }
    // (b, cont.) The PRE-dispatch baseline sha: what the acted verification
    // (h) compares against. Unresolvable here is UNVERIFIABLE, not failed —
    // the flow proceeds and the verification is skipped.
    let baselineSha: string | undefined;
    try {
      const baseline = await effects.validateRef(ref);
      if (baseline.ok && baseline.sha !== undefined) baselineSha = baseline.sha;
    } catch (err) {
      return {
        status: 'failed',
        error: `resolveConflict: validateRef ${ref} for pr ${input.pr} threw: ${errorMessage(err)}`,
      };
    }

    // (c) The worktree lifecycle (prepare → fn → remove-in-finally) is
    // withPreparedWorktree's; the op never calls worktreePrepare/Remove
    // itself. A throw out of it is an op OUTCOME — 'failed', not a crash.
    try {
      return await withPreparedWorktree(
        effects,
        input.pr,
        ref,
        async (worktree): Promise<OpResult<ConflictResolutionValue>> => {
          // (d) The prompt — rendered from the template with the seven
          // vars. No pre-created session record: the worktree below rides
          // the invocation as its workspace binding (e).
          const prompt = renderConflictPrompt(await loadPrompt(), {
            pr: String(input.pr),
            headBranch: input.headBranch,
            baseBranch: input.baseBranch,
            baseRef: `origin/${input.baseBranch}`,
            conflictFiles:
              input.conflictFiles !== undefined && input.conflictFiles.length > 0
                ? input.conflictFiles.map((file) => `- ${file}`).join('\n')
                : '(not enumerated)',
            protectedBranch,
            worktree,
          });

          // (e) THE INVOCATION — the write-capable surface. sandboxPolicy
          // level 'none' means "no isolation requested" — the only honest
          // request for a network-needing op under the frozen policy,
          // which carries no network field and whose workspace-write a
          // lane MAY map onto an egress-blocking sandbox (the recorded
          // UC-row-44 trap). The worktree rides as the workspace binding —
          // the driver binds cwd and confinement to it (ADR-0002 §2.4) —
          // so that convention is now data on the seam, not just prompt
          // text. The decision schema rides the invocation (§2.3); the
          // governed signal rides RunOptions (§2.1). modelSpec is the
          // FACTORY-NORMALISED spec — a deprecated provider alias never
          // reaches a lane or a journal.
          let result: WorkerResult;
          try {
            result = await resolved.driver.run(
              {
                prompt,
                modelSpec: resolved.modelSpec,
                toolPolicy: { allow: ['read', 'edit', 'bash'], mode: 'allowlist' },
                sandboxPolicy: { level: 'none' },
                workspace: { path: worktree },
                outputSchema: RESOLVE_DECISION_OUTPUT_SCHEMA,
                budget: { wallClockMs },
                // Session-log correlation (items 1.3–1.5): forward the
                // runner's minted work identity onto the invocation so the
                // lane stamps the child's CQ_* env. Absent outside a
                // governed dispatch — the un-governed op behaves exactly
                // as before. The shared driver helper stays pure over the
                // correlation value (ADR-0002 one-directional rule).
                ...correlationInvocation(currentJobContext()?.info?.correlation),
              },
              { signal: currentJobContext()?.signal },
            );
          } catch (err) {
            // A THROWN run() with the governor's signal aborted is the
            // governed cancellation (I8): no verdict on partial work →
            // indeterminate. Otherwise it is a PRE-DISPATCH misconfiguration
            // (unknown model, a missing key env, no host CLI for the
            // provider's route) — the human's to arrange, so `needs-human`
            // (review-debt #186); `failed` would claim the agent ran and
            // broke.
            if (currentJobContext()?.signal.aborted === true) {
              return {
                status: 'indeterminate',
                detail: `resolveConflict: conflict agent dispatch for pr ${input.pr} was cancelled: ${errorMessage(err)}`,
              };
            }
            return {
              status: 'needs-human',
              reason: `resolveConflict: the conflict agent could not dispatch for pr ${input.pr}: ${errorMessage(err)}`,
            };
          }

          // SPEND EVIDENCE (review-debt #185): the op maps the driver's
          // WorkerResult into its own value shape, so the governor's
          // completion-time fold cannot see the usage/cost. Report the SAME
          // evidence through the job context in ONE fold (governor
          // observeResult — the DD-9 rollups and the unpriced-usage
          // fail-loud trip apply exactly as they would there). Before the
          // stop-reason mapping so every outcome's spend is observed.
          currentJobContext()?.reportResult({
            usage: result.usage,
            ...(result.costUSD !== undefined ? { costUSD: result.costUSD } : {}),
          });

          // (f) stopReason FIRST — only 'complete' reaches the parser.
          if (result.stopReason === 'aborted') {
            return {
              status: 'indeterminate',
              detail: `conflict agent aborted before completing; partial work may exist in the worktree${sessionSuffix(result)}`,
            };
          }
          if (result.stopReason === 'budget') {
            return { status: 'budget-exhausted' };
          }
          if (result.stopReason === 'error') {
            const hint =
              result.denials.length > 0
                ? `${result.denials.length} tool use(s) denied (see the session record for narration)`
                : 'no denials recorded (see the session record for narration)';
            // ADR-0002 §2.9: EVERY error verdict → 'failed', with the
            // structured class named in the text (errorClass=<x>) for
            // humans only — the structured class itself is forwarded
            // nowhere (the invocation gate records it on
            // reservation-settled).
            const classText =
              result.errorClass === undefined ? '' : `; errorClass=${result.errorClass}`;
            return {
              status: 'failed',
              error: `conflict agent failed: ${hint}${classText}${result.error === undefined ? '' : `; ${boundedErrorText(result.error)}`}${sessionSuffix(result)}`,
            };
          }

          // (g) Parse the decision — fail closed on a contract violation
          // (silence is never success). Any other throw is a true bug.
          let decision: MergeConflictDecision;
          try {
            decision = parse(result.structuredOutput);
          } catch (err) {
            if (err instanceof MergeConflictContractError) {
              return {
                status: 'failed',
                error: `conflict agent output violates the decision contract: ${err.message}${sessionSuffix(result)}`,
              };
            }
            throw err;
          }

          // (h) 'escalate' → needs-human, short-circuiting BEFORE the
          // verification (a decided escalation needs no head check).
          // NEVER ok for an escalation; and an unparseable output NEVER
          // becomes needs-human — that status is for a DECIDED escalation
          // only.
          if (decision.decision === 'escalate') {
            return {
              status: 'needs-human',
              reason:
                decision.summary === ''
                  ? 'conflict agent escalated; no summary given'
                  : decision.summary,
            };
          }
          // (h, cont.) ACTED IS STILL A SELF-REPORT — of a LOCAL commit
          // now, never of a push: the worker no longer publishes (issue
          // #1193). The op verifies the claim, scans the resolved change,
          // and ONLY THEN pushes. Fail-closed at every rung: any refusal
          // below leaves the branch unpublished.
          if (baselineSha === undefined) {
            // Gate rung 1: without a pre-dispatch baseline the resolved
            // change cannot be SCOPED for the scan — an unscannable
            // change is never published. A human decides (the resolution
            // exists in the worktree; the caller may re-run after the
            // head's truth is restored).
            return {
              status: 'needs-human',
              reason: `conflict agent reported acted but the pre-dispatch head ${ref} was unresolvable — the resolved change cannot be scoped for the pre-push scan; NOTHING was pushed${sessionSuffix(result)}`,
            };
          }
          // Gate rung 2: locate the resolution commit on the prepared
          // worktree's branch — a ref the op derives from its own pr
          // number (the branch `worktree add -B` put the worktree on,
          // shared through the repo's common refs), NEVER from agent
          // output.
          const branchRef = mergeWorktreeBranchFor(input.pr);
          let resolution: { ok: boolean; sha?: string };
          try {
            resolution = await effects.validateRef(branchRef);
          } catch (err) {
            return {
              status: 'failed',
              error: `resolveConflict: validating the resolution branch ${branchRef} for pr ${input.pr} threw: ${errorMessage(err)}${sessionSuffix(result)}`,
            };
          }
          if (!resolution.ok || resolution.sha === undefined) {
            return {
              status: 'needs-human',
              reason: `conflict agent reported acted but no resolution commit is on ${branchRef} — there is nothing to publish; NOTHING was pushed${sessionSuffix(result)}`,
            };
          }
          if (resolution.sha === baselineSha) {
            // The branch still names the pre-dispatch head: the agent's
            // commit claim is contradicted by the fact. Callers assume
            // neither success nor failure (the old unverifiable-acted
            // posture) — never ok.
            return {
              status: 'indeterminate',
              detail: `conflict agent reported acted but ${branchRef} still names the pre-dispatch head (${baselineSha}) — no resolution commit was created; NOTHING was pushed${sessionSuffix(result)}`,
            };
          }
          // Gate rung 3: prove the publication TOPOLOGY before the
          // payload scan means anything (review P1, PR #1628 rounds 2-3).
          // The endpoint diff baseline..resolution covers ALL pushed
          // content ONLY for two shapes — and the PROMPT'S OWN FLOW
          // (fetch the base, merge FETCH_HEAD, one normal merge commit)
          // is the merge shape, so it must be ACCEPTED, not refused:
          //   A) exactly one parent, equal to the validated baseline (a
          //      single resolution commit stacked on the prepared head);
          //   B) exactly two parents with parent[0] === baseline — a
          //      merge of the prepared head with the base — ACCEPTED ONLY
          //      when the second parent is PUBLIC base history: equal to
          //      the forge-read base tip, or an ancestor of it (a base
          //      tip the worker fetched before the base advanced is still
          //      public). Everything else is unscannable history and
          //      refuses BEFORE the diff read and any push: parent[0] ≠
          //      baseline (the add-a-credential-then-remove-it
          //      intermediate), >2 parents, zero parents, an unreadable
          //      topology, or a second parent that is not public. A
          //      worker reporting acted is believed about the TIP commit
          //      only; the base side is verified against the FORGE
          //      (readBaseRef's baseTipSha), never a local ref.
          let topology: { ok: boolean; parents?: string[] };
          try {
            topology = await effects.commitParents(resolution.sha);
          } catch (err) {
            return {
              status: 'failed',
              error: `resolveConflict: reading the topology of the resolution commit ${resolution.sha} for pr ${input.pr} threw: ${errorMessage(err)}${sessionSuffix(result)}`,
            };
          }
          if (!topology.ok || topology.parents === undefined) {
            return {
              status: 'needs-human',
              reason: `conflict agent reported acted but the resolution commit's topology could not be read for pr ${input.pr} — refusing to publish unscanned history; NOTHING was pushed${sessionSuffix(result)}`,
            };
          }
          const parents = topology.parents;
          const firstOnBaseline = parents.length >= 1 && parents[0] === baselineSha;
          const singleCommitShape = parents.length === 1 && firstOnBaseline;
          const mergeShape = parents.length === 2 && firstOnBaseline;
          if (!singleCommitShape && !mergeShape) {
            return {
              status: 'needs-human',
              reason: `resolution topology is not publishable (parents: ${parents.join(', ') || 'none'}; expected one commit on the prepared baseline ${baselineSha}, or a merge of it with public base history) for pr ${input.pr} — refusing to publish unscanned history; NOTHING was pushed${sessionSuffix(result)}`,
            };
          }
          if (mergeShape) {
            // Shape B: the second parent must be PUBLIC base history,
            // verified against the FORGE's answer, never a local ref the
            // worker could have mutated.
            const secondParent = parents[1] as string;
            let base: { ok: boolean; baseRefName?: string; baseTipSha?: string };
            try {
              base = await effects.readBaseRef(input.pr);
            } catch (err) {
              return {
                status: 'failed',
                error: `resolveConflict: reading the forge base state for pr ${input.pr} threw: ${errorMessage(err)}${sessionSuffix(result)}`,
              };
            }
            if (!base.ok || base.baseTipSha === undefined) {
              return {
                status: 'needs-human',
                reason: `the merge resolution's second parent ${secondParent} cannot be verified as public base history (the forge base state for pr ${input.pr} is unreadable or lacks a tip OID) — refusing to publish unscanned history; NOTHING was pushed${sessionSuffix(result)}`,
              };
            }
            if (secondParent !== base.baseTipSha) {
              // Not the current tip: public only if an ancestor of it
              // (the base advanced between the worker's fetch and now).
              let ancestry: GhResult;
              try {
                ancestry = await effects.isAncestor(secondParent, base.baseTipSha);
              } catch (err) {
                return {
                  status: 'failed',
                  error: `resolveConflict: reading the ancestry of the merge parent ${secondParent} for pr ${input.pr} threw: ${errorMessage(err)}${sessionSuffix(result)}`,
                };
              }
              if (ancestry.code !== 0 && ancestry.code !== 1) {
                return {
                  status: 'failed',
                  error: `resolveConflict: the ancestry read of the merge parent ${secondParent} for pr ${input.pr} failed (exit ${ancestry.code})${stderrSuffix(ancestry.stderr)} — refusing to publish unverified history${sessionSuffix(result)}`,
                };
              }
              if (ancestry.code !== 0) {
                return {
                  status: 'needs-human',
                  reason: `the merge resolution's second parent ${secondParent} is not public base history (forge base tip ${base.baseTipSha} for pr ${input.pr}) — refusing to publish unscanned history; NOTHING was pushed${sessionSuffix(result)}`,
                };
              }
            }
          }
          // Gate rung 4: read the resolved change — the zero-context
          // patch of exactly what the publication push would add beyond
          // the head's current public state. Nonzero or throwing → the
          // change is UNSCANNABLE: a partial patch is never scanned, and
          // unscannable is never published ('failed', mirroring the (b)
          // truth-unavailable rows).
          let patch: GhResult;
          try {
            patch = await effects.diffPatch(baselineSha, resolution.sha);
          } catch (err) {
            return {
              status: 'failed',
              error: `resolveConflict: reading the resolved change ${baselineSha}..${resolution.sha} for pr ${input.pr} threw: ${errorMessage(err)}${sessionSuffix(result)}`,
            };
          }
          if (patch.code !== 0) {
            return {
              status: 'failed',
              error: `resolveConflict: the resolved change ${baselineSha}..${resolution.sha} for pr ${input.pr} is unreadable (exit ${patch.code})${stderrSuffix(patch.stderr)} — refusing to publish an unscannable change${sessionSuffix(result)}`,
            };
          }
          // Gate rung 5: scan the patch's ADDED lines through the
          // denylist seam. ANY hit refuses; so does a scanner FAULT (a
          // gate that cannot run cannot clear — the human arranges the
          // scanner). Matched content is never quoted (the denylist
          // doctrine — inspect locally without printing secrets).
          const scan = deps.scan ?? makeRepoDiffScanner(input.repoRoot);
          let components: ComponentScan[];
          try {
            components = await scan(
              addedLineComponents(patch.stdout, 'resolveConflict pre-push scan'),
            );
          } catch (err) {
            return {
              status: 'needs-human',
              reason: `secret-scan fault before publishing pr ${input.pr} — NOTHING was pushed: ${errorMessage(err)}${sessionSuffix(result)}`,
            };
          }
          const hits = components.filter((component) => component.hits.length > 0);
          if (hits.length > 0) {
            const ruleIds = [
              ...new Set(hits.flatMap((component) => component.hits.map((hit) => hit.ruleId))),
            ].join(', ');
            const files = hits.map((component) => component.component).join(', ');
            return {
              status: 'needs-human',
              reason: `the resolved change for pr ${input.pr} carries denylist hits (rules: ${ruleIds}; files: ${files}) — the branch was NOT pushed; scrub or review the findings before publishing${sessionSuffix(result)}`,
            };
          }
          // Gate rung 6: the publication — the OP pushes the resolution
          // commit to the head branch through the I3-guarded seam (no
          // force, no deletion, never the protected branch — the guard
          // refuses all three shapes regardless of this call site). Exit
          // 0 IS the publication fact: git push exits 0 only when the
          // forge moved the ref, which replaces the old fetch-again
          // sha-moved check (that check's attribution limit — a moved
          // sha never proved the AGENT moved it — is gone with the
          // self-reported push).
          // The destination is the head branch's BARE form: the input
          // schema admits the refs/heads/<name> spelling (a conservative
          // refname), and a prefix-blind concatenation would publish
          // refs/heads/refs/heads/<name> — a different branch — while
          // reporting ok (review P2, PR #1628). Exactly one leading
          // refs/heads/ is stripped, per stripRefsHeads's contract.
          const refspec = `${resolution.sha}:refs/heads/${stripRefsHeads(input.headBranch)}`;
          let pushed: GhResult;
          try {
            pushed = await effects.pushRef(refspec, worktree);
          } catch (err) {
            return {
              status: 'failed',
              error: `resolveConflict: publishing pr ${input.pr} (${refspec}) threw: ${errorMessage(err)}${sessionSuffix(result)}`,
            };
          }
          if (pushed.code !== 0) {
            return {
              status: 'failed',
              error: `resolveConflict: the publication push of pr ${input.pr} to ${input.headBranch} failed (exit ${pushed.code})${stderrSuffix(pushed.stderr)} — the resolution is committed locally but unpublished${sessionSuffix(result)}`,
            };
          }
          return {
            status: 'ok',
            value: {
              pr: input.pr,
              decision: 'acted',
              summary: decision.summary,
              usage: result.usage,
              ...(result.costUSD !== undefined ? { costUSD: result.costUSD } : {}),
            },
          };
        },
      );
    } catch (err) {
      return {
        status: 'failed',
        error: `resolveConflict: pr ${input.pr} merge worktree flow failed: ${errorMessage(err)}`,
      };
    }
  };
}

/** The production op: every dep at its default. */
export default makeResolveConflictOp();
