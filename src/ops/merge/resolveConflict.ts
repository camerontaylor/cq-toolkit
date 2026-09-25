// resolveConflict — the merge family's conflict agent (goal F4, ws-f scope
// item 4; UC §3 row 44): the WRITE-CAPABLE worker that resolves a PR's merge
// conflict inside a prepared worktree and pushes the resolved branch. It is
// the repo's FIRST driver-consuming op: the worker is reached only through
// the frozen Driver seam (src/driver/types.js — run(OpInvocation) →
// WorkerResult), never through a vendor SDK, and every other I/O surface
// (git/gh via MergeEffects, the session store, the prompt file, the output
// parser) arrives as an injectable dep — the whole flow below is testable
// with zero real processes, networks, or filesystems.
//
// THE SANDBOX TRAP (UC row 44, I11-adjacent — read before touching the
// invocation): the frozen SandboxPolicy carries an isolation LEVEL and no
// network field, and a lane MAY map workspace-write onto an egress-blocking
// sandbox — but this agent MUST push the resolved branch over the network,
// so requesting workspace-write here would be wrong at the seam level.
// Level 'none' — "no isolation requested" — is the only honest request for
// a network-needing op under this policy. It is not a grant of anarchy —
// but neither is it confinement: there is NO OS-level confinement on this
// seam. The worktree cwd (the driver runs the CLI with cwd = the prepared
// worktree) is a CONVENTION the prompt enforces, not an OS bound; the
// bounds that remain are the allowlisted tool surface ({read, edit, run}
// in allowlist mode), the prompt's hard constraints (no force, no squash,
// no rebase, no amend, no protected-branch destination), and the
// wall-clock budget REQUEST (Budget.wallClockMs) — a request on the seam,
// not an enforcement: its wiring is deferred (review-debt #137), so it is
// not currently a bound on live paths. A future sandbox that does carry
// network semantics must re-derive this.
//
// THE DECISION CONTRACT (the op's output vocabulary, UC row 44): the agent
// ends with EXACTLY ONE JSON line {"decision":"acted|escalate","summary":
// "…"}. parseMergeConflictDecision is the tolerant reader: the object form,
// or that line embedded in narration ('escalated' normalizes to 'escalate';
// the LAST valid line wins — the agent's final word). Fail-closed posture:
// prose with no valid decision line is a CONTRACT VIOLATION → 'failed',
// never a guessed success and never 'needs-human' — needs-human is
// reserved for a DECIDED escalation, because callers treat it as "a human
// owes a decision here", which garbled output does not establish.
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
//      PRE-dispatch BASELINE sha the acted verification (h) compares
//      against. A nonzero fetch or a throwing validate → 'failed', fail
//      closed before any worktree exists; an UNRESOLVABLE head (validate
//      !ok) is unverifiable, not failed — the flow proceeds and the
//      verification is skipped.
//   c. withPreparedWorktree (effects.js) owns prepare → fn →
//      remove-in-finally; the op never calls worktreePrepare/Remove
//      itself. A throw out of it (spawn-level worktree failure, or a
//      session/prompt fault inside fn) is an op OUTCOME here → 'failed'
//      with the message, not a crash. KNOWN WEDGE (review-debt #143): a
//      non-acted outcome after the agent started can leave a DIRTY tree,
//      which the frozen no-force worktreeRemove refuses (and which the
//      lifecycle swallows when fn itself resolved) — the wedge surfaces
//      LOUDLY at the next prepare for that pr (worktree add refuses the
//      existing path), but recovery until then is manual: git worktree
//      remove --force / prune. A guarded cleanup shape in the effects
//      allowlist is the deferred fix.
//   d. Inside: a fresh session record is created in the worktree (its
//      sessionId is the OpInvocation.sessionRef; the driver runs the CLI
//      with cwd = that workspace) and the prompt is rendered from
//      prompts/conflict.default.md with the seven vars.
//   e. ONE driver.run: toolPolicy allow ['read','edit','run'] mode
//      'allowlist'; sandboxPolicy level 'none' (the trap above);
//      budget.wallClockMs default DEFAULT_RESOLVE_WALL_CLOCK_MS.
//   f. stopReason mapped FIRST: aborted → 'indeterminate' (partial work
//      may exist in the worktree), budget → 'budget-exhausted', error →
//      'failed' (denials as the narration hint); only 'complete' reaches
//      the parser.
//   g. parse(structuredOutput) — object or raw-text tolerant path; a
//      MergeConflictContractError → 'failed' (fail closed — silence is
//      never success).
//   h. decision 'escalate' → 'needs-human' with the summary as the reason
//      ('' → the default reason), short-circuiting BEFORE the verification.
//      decision 'acted' is a SELF-REPORT, so it is verified: fetch and
//      validate the head again — a moved sha → 'ok' {pr, decision:'acted',
//      summary}; an unchanged sha or an unresolvable-after head →
//      'indeterminate' (callers assume neither success nor failure); a
//      fetch/validate THROW in the verification → 'failed' (totality).
//      Escalation NEVER lands in a value, and an unverified acted is
//      never 'ok'.
//
// SESSIONS-DIR COUPLING: DEFAULT_RESOLVE_SESSIONS_DIR below MUST mirror
// the subprocess driver's internal defaultSessionsDir (module-private) —
// the default createSession writes records there and the default driver
// reads them from its own default; a caller-provided input.sessionsDir
// threads to BOTH sides, which is what keeps them aligned.
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { SubprocessDriver } from '../../driver/subprocess/index.js';
import { AiSdkDriver } from '../../driver/ai-sdk/index.js';
import { withServedModelAssertion } from '../../driver/served-model.js';
import type { Driver, ModelSpec, Usage, WorkerResult } from '../../driver/types.js';
import type { HarnessConfig } from '../../harness/config.js';
import { SessionStore } from '../../harness/session.js';
import { currentJobContext } from '../../kernel/governor.js';
import { ModelSpecSchema } from '../../kernel/schema.js';
import type { Op, OpResult } from '../../kernel/types.js';
import type { GhResult } from '../review/gh.js';
import {
  DEFAULT_PROTECTED_BRANCH,
  headRefFor,
  realMergeEffects,
  withPreparedWorktree,
} from './effects.js';
import type { MergeEffects } from './effects.js';

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
 * The worker-facing decision schema — the default driver's outputSchema
 * AND the parser's object gate. Deliberately NOT `.strict()`: unknown keys
 * are tolerated (zod strips them) exactly as the parser's object contract
 * demands — a strict mirror here would make the driver DROP decisions the
 * contract accepts, flipping a tolerable output into a fabricated failure.
 */
export const MergeConflictDecisionSchema: z.ZodType<RawMergeConflictDecision> = z.object({
  decision: z.enum(['acted', 'escalate', 'escalated']),
  summary: z.string().exactOptional(),
});

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
  /** The branch the agent may never push to (prompt constraint); default
   * 'main'. */
  protectedBranch?: string;
  /** SessionStore dir — must match what the driver reads. */
  sessionsDir?: string;
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
    sessionsDir: z.string().min(1).exactOptional(),
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
 * The default sessions dir — MUST mirror the subprocess driver's internal
 * defaultSessionsDir() (module-private there): the default createSession
 * writes session records here and the default driver reads them from ITS
 * default when no caller sessionsDir is given. The two stay equal by
 * contract, not by import; a divergence would make the op create sessions
 * the driver cannot find. A caller-provided sessionsDir threads to both
 * sides, which is the alignment mechanism when it is overridden.
 */
export const DEFAULT_RESOLVE_SESSIONS_DIR = join(tmpdir(), 'cq-harness', 'sessions');

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

/** The ok value: the resolved branch was pushed. Escalation NEVER lands in
 * a value — it IS needs-human. */
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
  /** Default: realMergeEffects({ repoRoot: input.repoRoot, protectedBranch? })
   * built lazily per call. */
  effects?: MergeEffects;
  /** Default: provider 'ai-sdk' → an in-process AiSdkDriver, else a
   * SubprocessDriver, both bound to MergeConflictDecisionSchema (the
   * caller's sessionsDir threads through when given). */
  driver?: Driver;
  /**
   * Harness config threaded to the default SubprocessDriver (tool surface
   * plus the sandbox/path restrictions the harness maps per lane). The
   * SHIPPED default is `defaultHarnessConfig` — run-deny-all: on an
   * in-process lane the agent cannot execute git commands; on the
   * subprocess lane tool execution rides the HOST CLI's own permission
   * model (`--allowedTools` carries names only). A live-capable config is
   * wired by the caller (F5 exercises the scripted-agent path via
   * `deps.driver`).
   */
  harnessConfig?: HarnessConfig;
  /** SessionStore dir for the default createSession; default
   * DEFAULT_RESOLVE_SESSIONS_DIR (mirrors the driver's own default). */
  sessionsDir?: string;
  /** Default: SessionStore(sessionsDir).create(workspace) →
   * record.sessionId. */
  createSession?: (workspace: string) => Promise<string>;
  /** Default: reads prompts/conflict.default.md beside this module. */
  loadPrompt?: () => Promise<string>;
  /** Default: the real tolerant parser. */
  parse?: typeof parseMergeConflictDecision;
}

/** The conflict prompt template, read beside this module. */
const defaultLoadPrompt = async (): Promise<string> =>
  readFile(fileURLToPath(new URL('./prompts/conflict.default.md', import.meta.url)), 'utf8');

/**
 * The default driver: provider 'ai-sdk' (the self-host config's DRIVER
 * handle — review-debt #186) binds the in-process AiSdkDriver, which needs
 * no host CLI; any other provider binds a SubprocessDriver bound to the
 * decision schema. Both share the caller's sessionsDir/harnessConfig; under
 * exactOptionalPropertyTypes an absent option is OMITTED so the driver
 * falls back to ITS OWN default — the dir DEFAULT_RESOLVE_SESSIONS_DIR
 * mirrors by contract, and the harness default is defaultHarnessConfig
 * (run-deny-all; see ResolveConflictDeps.harnessConfig).
 */
const defaultDriver = (
  sessionsDir: string | undefined,
  harnessConfig: HarnessConfig | undefined,
  modelSpec: ModelSpec,
): Driver => {
  const common = {
    outputSchema: MergeConflictDecisionSchema,
    ...(sessionsDir !== undefined ? { sessionsDir } : {}),
    ...(harnessConfig !== undefined ? { harnessConfig } : {}),
  };
  return modelSpec.provider === 'ai-sdk'
    ? withServedModelAssertion(new AiSdkDriver(common), 'default')
    : withServedModelAssertion(new SubprocessDriver(common), 'default');
};

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
    const { modelSpec } = input;
    if (modelSpec === undefined) {
      return {
        status: 'failed',
        error:
          'resolveConflict: input.modelSpec is required to dispatch the conflict agent — bind a ModelSpec in the plan input (none is fabricated)',
      };
    }
    // (a, cont.) STRUCTURAL, before ANY effect: the head branch must never
    // BE the protected branch — dispatching a push-capable agent whose
    // destination IS the protected branch is refused outright (a
    // cross-field rule the schema cannot express). BOTH spellings count
    // (codex review): a bare name and its refs/heads/<name> form name the
    // same ref, and the prompt's push refspec takes the headBranch
    // verbatim — `HEAD:refs/heads/main` would target the protected branch
    // through a bare-name-only comparison.
    const bareBranch = (ref: string): string => ref.replace(/^refs\/heads\//, '');
    if (
      bareBranch(input.headBranch) === bareBranch(input.protectedBranch ?? DEFAULT_PROTECTED_BRANCH)
    ) {
      return {
        status: 'failed',
        error: 'headBranch equals the protected branch — refusing to dispatch a push-capable agent',
      };
    }

    const callerSessionsDir = input.sessionsDir ?? deps.sessionsDir;
    const sessionsDir = callerSessionsDir ?? DEFAULT_RESOLVE_SESSIONS_DIR;
    const wallClockMs = input.wallClockMs ?? DEFAULT_RESOLVE_WALL_CLOCK_MS;
    const protectedBranch = input.protectedBranch ?? DEFAULT_PROTECTED_BRANCH;
    const parse = deps.parse ?? parseMergeConflictDecision;
    const loadPrompt = deps.loadPrompt ?? defaultLoadPrompt;
    const createSession =
      deps.createSession ??
      (async (workspace: string): Promise<string> => {
        const record = await new SessionStore(sessionsDir).create(workspace);
        return record.sessionId;
      });
    const driver = withServedModelAssertion(
      deps.driver ?? defaultDriver(callerSessionsDir, deps.harnessConfig, modelSpec),
      'default',
    );

    // (b) Truth first: fetch the PR head ref. A nonzero exit means the
    // truth is unavailable — fail closed before any worktree exists.
    const ref = headRefFor(input.pr);
    const effects =
      deps.effects ??
      realMergeEffects({
        repoRoot: input.repoRoot,
        ...(input.protectedBranch !== undefined ? { protectedBranch: input.protectedBranch } : {}),
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
          // (d) A fresh session in the worktree (the sessionRef the driver
          // continues; the CLI's cwd is this workspace), then the prompt.
          const sessionRef = await createSession(worktree);
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
          // UC-row-44 trap). The worktree cwd is a prompt-enforced
          // convention, NOT an OS bound — the bounds that remain are this
          // allowlist, the prompt's constraints, and the wall-clock
          // budget request.
          let result: WorkerResult;
          try {
            result = await driver.run({
              prompt,
              modelSpec,
              toolPolicy: { allow: ['read', 'edit', 'run'], mode: 'allowlist' },
              sandboxPolicy: { level: 'none' },
              sessionRef,
              budget: { wallClockMs },
            });
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
                ? `${result.denials.length} tool use(s) denied by policy (see the session record for narration)`
                : 'no denials recorded (see the session record for narration)';
            return {
              status: 'failed',
              error: `conflict agent failed: ${hint}${sessionSuffix(result)}`,
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
          // (h, cont.) ACTED IS A SELF-REPORT — verify the head actually
          // moved before believing it: fetch the truth again, then
          // validate. Unchanged sha or an unresolvable-after head →
          // 'indeterminate' (the resolution may or may not have landed —
          // callers assume neither success nor failure; never ok, never
          // needs-human). An UNRESOLVABLE PRE baseline makes the check
          // impossible → 'indeterminate' as well (unverifiable is never
          // ok). A fetch/validate THROW here is a 'failed' outcome
          // (totality).
          //
          // ATTRIBUTION LIMIT: the sha-moved check proves the head MOVED,
          // not that the AGENT moved it — a concurrent push by the PR
          // author inside the window reads as acted success. Downstream
          // harm is bounded: pass 2 re-classifies whatever actually
          // landed, and the forge-side merge gate re-checks mergeability
          // before any server-side merge.
          if (baselineSha === undefined) {
            // Unverifiable is never ok: without a pre-dispatch baseline
            // the self-report cannot be checked at all.
            return {
              status: 'indeterminate',
              detail:
                'conflict agent reported acted but the head ref was unverifiable (pre-dispatch baseline unresolvable)',
            };
          }
          let verifyFetch: GhResult;
          try {
            verifyFetch = await effects.fetchRef(ref);
          } catch (err) {
            return {
              status: 'failed',
              error: `resolveConflict: verification fetch ${ref} for pr ${input.pr} threw: ${errorMessage(err)}${sessionSuffix(result)}`,
            };
          }
          let moved: { ok: boolean; sha?: string };
          try {
            moved = await effects.validateRef(ref);
          } catch (err) {
            return {
              status: 'failed',
              error: `resolveConflict: verification validateRef ${ref} for pr ${input.pr} threw: ${errorMessage(err)}${sessionSuffix(result)}`,
            };
          }
          if (
            verifyFetch.code !== 0 ||
            !moved.ok ||
            moved.sha === undefined ||
            moved.sha === baselineSha
          ) {
            return {
              status: 'indeterminate',
              detail: `conflict agent reported acted but the head ref ${ref} did not move (baseline ${baselineSha})${sessionSuffix(result)}`,
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
